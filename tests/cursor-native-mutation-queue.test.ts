import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CursorNativeMutationQueue, type CursorMutationRequest, type CursorMutationTransport, type CursorDispatchReceipt, type CursorCommitReceipt } from '../src/core/cursor-native-mutation-queue';

const binding = { nativeId: randomUUID(), workspace: path.resolve('.'), backendId: 'verified-project-host' };
const prompt = (source: 'native' | 'workbench' = 'workbench', text = 'queued intent'): CursorMutationRequest => ({ requestId: randomUUID(), source, kind: 'prompt', text });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const sent: Array<{ request: Readonly<CursorMutationRequest>; receipt: CursorDispatchReceipt; contextRevision: number }> = [];
  const commits = new Map<string, ReturnType<typeof deferred<CursorCommitReceipt>>>();
  let revision = 0;
  const transport: CursorMutationTransport = {
    async dispatch(owner, request) {
      const receipt = { ...owner, requestId: request.requestId, executionId: randomUUID() };
      sent.push({ request, receipt, contextRevision: revision });
      commits.set(request.requestId, deferred()); return receipt;
    },
    async waitCommitted(receipt) { return commits.get(receipt.requestId)!.promise; },
    async reconcile() { return { status: 'unknown' }; },
  };
  function complete(requestId: string, status: CursorCommitReceipt['status'] = 'completed') {
    const item = sent.find(entry => entry.request.requestId === requestId)!;
    const receipt = { ...item.receipt, status, checkpointId: 'committed-' + ++revision };
    commits.get(requestId)!.resolve(receipt); return receipt;
  }
  return { sent, commits, transport, complete, queue: new CursorNativeMutationQueue(binding, transport) };
}

test('both entry sources execute in FIFO order only after the prior native state is committed', async () => {
  const h = harness(), first = prompt('native'), second = prompt(), third = prompt('native');
  const tickets = [first, second, third].map(request => h.queue.enqueue(request));
  await tick(); assert.equal(h.sent.length, 1);
  assert.equal(h.queue.snapshot().phase, 'awaiting-commit');
  assert.deepEqual(h.queue.snapshot().waiting.map(entry => entry.requestId), [second.requestId, third.requestId]);
  h.complete(first.requestId); await tickets[0].completion; await tick();
  assert.equal(h.sent[1].request.requestId, second.requestId);
  assert.equal(h.sent[1].contextRevision, 1); // Latest native state, not an enqueue-time context copy.
  h.complete(second.requestId); await tickets[1].completion; await tick();
  assert.equal(h.sent[2].request.requestId, third.requestId); assert.equal(h.sent[2].contextRevision, 2);
  h.complete(third.requestId); await tickets[2].completion; assert.equal(h.queue.snapshot().phase, 'idle');
});

test('request acceptance and pending user/tool approvals do not start the next queued mutation', async () => {
  const h = harness(), first = prompt(), next = prompt('native');
  const a = h.queue.enqueue(first), b = h.queue.enqueue(next);
  await tick(); await tick(); assert.equal(h.sent.length, 1); assert.equal(h.queue.cancelQueued(first.requestId), false);
  h.complete(first.requestId); await a.completion; await tick(); h.complete(next.requestId); await b.completion;
});

test('manual compaction uses the same queue and the following prompt receives its committed state', async () => {
  const h = harness(), first = prompt(), compact: CursorMutationRequest = { requestId: randomUUID(), source: 'native', kind: 'compact' }, next = prompt();
  const a = h.queue.enqueue(first), b = h.queue.enqueue(compact), c = h.queue.enqueue(next);
  await tick(); h.complete(first.requestId); await a.completion; await tick(); assert.equal(h.sent[1].request.kind, 'compact');
  h.complete(compact.requestId); await b.completion; await tick(); assert.equal(h.sent[2].contextRevision, 2);
  h.complete(next.requestId); await c.completion;
});

test('cancelled queued messages never reach native execution and remaining order is preserved', async () => {
  const h = harness(), first = prompt(), second = prompt(), third = prompt();
  const a = h.queue.enqueue(first), b = h.queue.enqueue(second), c = h.queue.enqueue(third);
  assert.equal(h.queue.cancelQueued(second.requestId), true); assert.deepEqual(await b.completion, { status: 'cancelled' });
  await tick(); h.complete(first.requestId); await a.completion; await tick();
  assert.deepEqual(h.sent.map(item => item.request.requestId), [first.requestId, third.requestId]);
  h.complete(third.requestId); await c.completion;
});

test('duplicate submissions share one ticket and changed content cannot reuse its request ID', async () => {
  const h = harness(), request = prompt(), a = h.queue.enqueue(request);
  assert.equal(h.queue.enqueue({ kind: 'prompt', text: 'queued intent', source: 'workbench', requestId: request.requestId }), a);
  assert.throws(() => h.queue.enqueue({ ...request, kind: 'prompt', text: 'different' }), /不同内容/);
  await tick(); assert.equal(h.sent.length, 1); h.complete(request.requestId); await a.completion;
  assert.equal(h.queue.enqueue(request), a); assert.equal(h.sent.length, 1);
});

test('lost dispatch acknowledgement holds successors and reconciliation never resends the original', async () => {
  const h = harness(), first = prompt(), next = prompt();
  const dispatch = h.transport.dispatch;
  h.transport.dispatch = async (owner, request) => { const receipt = await dispatch(owner, request); if (request.requestId === first.requestId) throw new Error('ack lost'); return receipt; };
  const a = h.queue.enqueue(first), b = h.queue.enqueue(next);
  await tick(); assert.equal(h.queue.snapshot().phase, 'uncertain'); assert.equal(h.sent.length, 1);
  assert.equal(await h.queue.reconcile(), false); assert.equal(h.sent.length, 1);
  const committed = h.complete(first.requestId);
  h.transport.reconcile = async () => ({ status: 'committed', receipt: committed });
  assert.equal(await h.queue.reconcile(), true); await a.completion; await tick();
  assert.deepEqual(h.sent.map(item => item.request.requestId), [first.requestId, next.requestId]);
  h.complete(next.requestId); await b.completion;
});

test('unconfirmed persistence and foreign backend/execution receipts cannot release the queue', async () => {
  const h = harness(), first = prompt(), next = prompt();
  const a = h.queue.enqueue(first), b = h.queue.enqueue(next); await tick();
  const receipt = h.sent[0].receipt;
  h.commits.get(first.requestId)!.resolve({ ...receipt, backendId: 'other-host', checkpointId: 'old', status: 'completed' });
  await tick(); assert.equal(h.queue.snapshot().phase, 'uncertain'); assert.equal(h.sent.length, 1);
  h.transport.reconcile = async () => ({ status: 'committed', receipt: { ...receipt, executionId: randomUUID(), checkpointId: 'other-turn', status: 'completed' } });
  assert.equal(await h.queue.reconcile(), false);
  h.transport.reconcile = async () => ({ status: 'not-started', receipt: { ...binding, requestId: first.requestId } });
  assert.equal(await h.queue.reconcile(), false); // Cannot contradict the confirmed native execution.
  h.transport.reconcile = async () => ({ status: 'committed', receipt: { ...receipt, checkpointId: 'saved', status: 'error' } });
  assert.equal(await h.queue.reconcile(), true); await a.completion; await tick(); h.complete(next.requestId); await b.completion;
});

test('only scoped proof of a request never starting allows following work without replay', async () => {
  const h = harness(), first = prompt(), next = prompt(), dispatch = h.transport.dispatch;
  h.transport.dispatch = async (owner, request) => { if (request.requestId === first.requestId) throw new Error('connection failed'); return dispatch(owner, request); };
  const a = h.queue.enqueue(first), b = h.queue.enqueue(next); await tick();
  h.transport.reconcile = async () => ({ status: 'not-started', receipt: { ...binding, backendId: 'wrong', requestId: first.requestId } });
  assert.equal(await h.queue.reconcile(), false); assert.equal(h.sent.length, 0);
  h.transport.reconcile = async () => ({ status: 'not-started', receipt: { ...binding, requestId: first.requestId } });
  assert.equal(await h.queue.reconcile(), true); assert.deepEqual(await a.completion, { status: 'not-started' });
  await tick(); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].request.requestId, next.requestId);
  h.complete(next.requestId); await b.completion;
});

test('different native sessions proceed independently; queue limits preserve current work', async () => {
  const h = harness(), other = harness(), first = prompt(), second = prompt();
  const q = new CursorNativeMutationQueue(binding, h.transport, 1);
  const independent = new CursorNativeMutationQueue({ ...binding, nativeId: randomUUID() }, other.transport);
  const a = q.enqueue(first), b = q.enqueue(second), independentRequest = prompt(), c = independent.enqueue(independentRequest);
  assert.throws(() => q.enqueue(prompt()), /队列已满/);
  await tick(); assert.equal(h.sent.length, 1); assert.equal(other.sent.length, 1);
  h.complete(first.requestId); await a.completion; await tick(); h.complete(second.requestId); await b.completion;
  other.complete(independentRequest.requestId); await c.completion;
});

test('closing a window cancels queued drafts but never invents completion of its active native turn', async () => {
  const h = harness(), first = prompt(), next = prompt();
  const a = h.queue.enqueue(first), b = h.queue.enqueue(next); await tick(); h.queue.close();
  assert.deepEqual(await b.completion, { status: 'cancelled' }); assert.equal(h.queue.snapshot().activeRequestId, first.requestId);
  assert.throws(() => h.queue.enqueue(prompt()), /已关闭/);
  h.complete(first.requestId); assert.equal((await a.completion).status, 'committed'); assert.equal(h.sent.length, 1);
});

for (const status of ['aborted', 'error'] as const) {
  test(`a native ${status} turn commits before continuation, and an aborted turn also needs explicit queue resume`, async () => {
    const h = harness(), first = prompt('native'), next = prompt();
    const a = h.queue.enqueue(first), b = h.queue.enqueue(next);
    await tick();
    assert.equal(h.queue.cancelQueued(first.requestId), false);
    assert.equal(h.sent.length, 1);
    const receipt = h.complete(first.requestId, status);
    assert.deepEqual(await a.completion, { status: 'committed', receipt });
    if (status === 'aborted') {
      await tick(); assert.equal(h.sent.length, 1);
      assert.equal(h.queue.snapshot().phase, 'paused');
      assert.equal(h.queue.snapshot().waiting[0].requestId, next.requestId);
      assert.equal(h.queue.resume(), true);
    }
    await tick();
    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[1].request.requestId, next.requestId);
    assert.equal(h.sent[1].contextRevision, 1);
    h.complete(next.requestId); await b.completion;
    assert.deepEqual(h.sent.map(item => item.request.requestId), [first.requestId, next.requestId]);
  });
}

test('losing the completion reply keeps the queue suspended while a waiting prompt can still be cancelled', async () => {
  const h = harness(), first = prompt(), cancelled = prompt('native'), next = prompt();
  const a = h.queue.enqueue(first), b = h.queue.enqueue(cancelled), c = h.queue.enqueue(next);
  await tick();
  h.commits.get(first.requestId)!.reject(new Error('native task ended but checkpoint reply was lost'));
  await tick(); assert.equal(h.queue.snapshot().phase, 'uncertain');
  assert.equal(h.queue.resume(), false); // An explicit resume cannot bypass unknown native state.
  assert.equal(h.queue.cancelQueued(cancelled.requestId), true);
  assert.deepEqual(await b.completion, { status: 'cancelled' });
  h.transport.reconcile = async () => ({ status: 'running' });
  const one = h.queue.reconcile(), two = h.queue.reconcile();
  assert.equal(one, two); assert.equal(await one, false); assert.equal(h.sent.length, 1);
  const receipt = { ...h.sent[0].receipt, checkpointId: 'persisted-after-error', status: 'error' as const };
  h.transport.reconcile = async () => ({ status: 'committed', receipt });
  assert.equal(await h.queue.reconcile(), true); await a.completion; await tick();
  assert.deepEqual(h.sent.map(item => item.request.requestId), [first.requestId, next.requestId]);
  h.complete(next.requestId); await c.completion;
});

test('cancelling a paused draft or adding another request never restarts the stopped native task', async () => {
  const h = harness(), first = prompt(), next = prompt(), replacement = prompt('native');
  const a = h.queue.enqueue(first), b = h.queue.enqueue(next);
  await tick(); h.complete(first.requestId, 'aborted'); await a.completion; await tick();
  assert.equal(h.queue.cancelQueued(next.requestId), true); assert.deepEqual(await b.completion, { status: 'cancelled' });
  const c = h.queue.enqueue(replacement); await tick();
  assert.equal(h.queue.snapshot().phase, 'paused'); assert.equal(h.sent.length, 1);
  assert.equal(h.queue.resume(), true); await tick();
  assert.deepEqual(h.sent.map(item => item.request.requestId), [first.requestId, replacement.requestId]);
  assert.equal(h.sent[1].contextRevision, 1);
  h.complete(replacement.requestId); await c.completion;
  h.queue.close(); assert.throws(() => h.queue.resume(), /已关闭/);
});
