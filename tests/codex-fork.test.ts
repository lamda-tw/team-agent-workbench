import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexForkError, forkCodexHistory } from '../src/core/codex-fork';

const missingProjection = () => Object.assign(new Error('failed to prepare paginated fork: missing projection state for paginated thread parent'), { code: -32603 });
const params = { threadId: 'parent', cwd: 'C:/work', approvalPolicy: 'on-request' };

test('missing history projection is prepared once with native pagination before a single fork retry', async () => {
  const calls: { method: string; params: any; timeout?: number }[] = [];
  let ready = false, recovered = 0;
  const rpc = { request: async (method: string, params?: any, timeout?: number) => {
    calls.push({ method, params, timeout });
    if (method === 'thread/turns/list') { ready = true; return { data: [], nextCursor: 'more-history' }; }
    if (!ready) throw missingProjection();
    return { thread: { id: 'child', path: 'child.jsonl' } };
  } };
  assert.equal((await forkCodexHistory(rpc, params, { canRepair: () => true, recovered: () => recovered++ })).thread.id, 'child');
  assert.deepEqual(calls.map(call => call.method), ['thread/fork', 'thread/turns/list', 'thread/fork']);
  assert.deepEqual(calls[0].params, { ...params, excludeTurns: true });
  assert.deepEqual(calls[0].params, calls[2].params);
  assert.deepEqual(calls[1].params, { threadId: 'parent', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  assert.equal(calls[1].timeout, 15000); assert.equal(recovered, 1);
});

test('ordinary forks remain a single request without extra history reads or model calls', async () => {
  const calls: string[] = [];
  const result = await forkCodexHistory({ request: async method => { calls.push(method); return { thread: { id: 'child' } }; } }, params, { canRepair: () => false });
  assert.equal(result.thread.id, 'child'); assert.deepEqual(calls, ['thread/fork']);
});

test('timeouts, unknown outcomes and missing lineage never replay a potentially completed fork', async () => {
  for (const message of ['thread/fork 超时', 'connection lost', 'failed to prepare paginated fork: prepare_fork failed to resolve fork lineage: missing source', 'failed to prepare windows sandbox wrapper']) {
    let calls = 0;
    await assert.rejects(forkCodexHistory({ request: async () => { calls++; throw Error(message); } }, params, { canRepair: () => true }), error => error instanceof CodexForkError && error.stage === 'fork' && error.originalMessage === message);
    assert.equal(calls, 1);
  }
});

test('active source and changes during index preparation preserve the original fork boundary', async () => {
  for (const change of ['already-active', 'changed-during-read', 'native-in-progress']) {
    const calls: string[] = []; let stable = change !== 'already-active';
    const rpc = { request: async (method: string) => {
      calls.push(method);
      if (method === 'thread/fork') throw missingProjection();
      if (change === 'changed-during-read') stable = false;
      return { data: change === 'native-in-progress' ? [{ status: 'inProgress' }] : [] };
    } };
    await assert.rejects(forkCodexHistory(rpc, params, { canRepair: () => stable }), CodexForkError);
    assert.deepEqual(calls, change === 'already-active' ? ['thread/fork'] : ['thread/fork', 'thread/turns/list']);
  }
});

test('failed index reads and repeat failures retain both original diagnostics with a strict retry limit', async () => {
  for (const mode of ['unsupported', 'invalid-page', 'repeat-failure']) {
    let forks = 0;
    const rpc = { request: async (method: string) => {
      if (method === 'thread/fork') { forks++; throw missingProjection(); }
      if (mode === 'unsupported') throw Object.assign(Error('Method not found'), { code: -32601 });
      return mode === 'invalid-page' ? {} : { data: [] };
    } };
    await assert.rejects(forkCodexHistory(rpc, params, { canRepair: () => true }), error => {
      assert(error instanceof CodexForkError);
      assert.match(error.message, /missing projection state/);
      assert.equal(error.stage, mode === 'repeat-failure' ? 'fork' : 'history');
      assert.equal(error.code, mode === 'unsupported' ? -32601 : mode === 'repeat-failure' ? -32603 : undefined);
      return true;
    });
    assert.equal(forks, mode === 'repeat-failure' ? 2 : 1);
  }
});
