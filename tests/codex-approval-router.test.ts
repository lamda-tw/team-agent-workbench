import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexApprovalRouter } from '../src/core/codex-approval-router';
import type { RpcMessage } from '../src/core/rpc';

function fixture() {
  const router = new CodexApprovalRouter(), clients = new Map<string, { received: RpcMessage[]; replies: RpcMessage[] }>();
  const add = (id: string, actor = id) => { const value = { received: [] as RpcMessage[], replies: [] as RpcMessage[] }; clients.set(id, value); router.add({ id, send: m => value.received.push(m), upstream: m => value.replies.push(m) }); router.client(id, { id: 0, method: 'initialize', params: { clientInfo: { name: actor } } }); return value; };
  const start = (id: string, turnId = 'turn', threadId = 'thread') => { assert.equal(router.client(id, { id: 1, method: 'turn/start', params: { threadId } }), false); router.server(id, { id: 1, result: { turn: { id: turnId } } }); };
  const approval = (id: string, requestId: number, turnId = 'turn', itemId = 'command') => router.server(id, { id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId, itemId, command: 'fixture' } });
  return { router, add, start, approval, clients };
}
test('broadcast approval is delivered once to its origin; observers cannot answer or reject it', () => {
  const f = fixture(), owner = f.add('work', 'team_agent_workbench_session'), desktop = f.add('desktop'), observer = f.add('observer', 'team_agent_workbench_other');
  f.start('work'); f.approval('desktop', 10); f.approval('work', 10); f.approval('observer', 10);
  const requests = owner.received.filter(m => m.id !== undefined); assert.equal(requests.length, 1); const alias = requests[0].id!;
  assert.equal(desktop.received.length, 0); assert.equal(observer.received.filter(m => m.id !== undefined).length, 0);
  f.router.client('observer', { id: alias, result: { decision: 'accept' } }); assert.equal(desktop.replies.length, 0);
  f.router.client('work', { id: alias, result: { decision: 'decline' } }); f.router.client('work', { id: alias, result: { decision: 'accept' } });
  assert.equal(desktop.replies.length, 1); assert.equal(desktop.replies[0].id, 10); assert.equal((desktop.replies[0].result as any).decision, 'decline');
  f.router.server('desktop', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 10 } });
  assert(owner.received.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === alias));
  f.router.client('work', { id: alias, result: { decision: 'accept' } }); assert.equal(desktop.replies.length, 1);
});
test('desktop-origin tasks approve only in the desktop and competing turn starts are refused', () => {
  const f = fixture(), desktop = f.add('desktop'), work = f.add('work', 'team_agent_workbench_x'); f.start('desktop');
  assert.equal(f.router.client('work', { id: 2, method: 'turn/start', params: { threadId: 'thread' } }), true);
  f.approval('work', 3); f.approval('desktop', 3);
  assert.equal(desktop.received.filter(m => m.method?.includes('requestApproval')).length, 1);
  assert.equal(work.received.filter(m => m.method?.includes('requestApproval')).length, 0);
  assert(work.received.some(m => m.method === 'workbench/approvalPendingElsewhere'));
  f.router.server('desktop', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } });
  assert.equal(f.router.client('work', { id: 4, method: 'turn/start', params: { threadId: 'thread' } }), false);
});
test('approval arriving before the turn-start acknowledgement is held until its owner is known', () => {
  const f = fixture(), owner = f.add('owner'); f.add('observer');
  f.router.client('owner', { id: 1, method: 'turn/start', params: { threadId: 'thread' } }); f.approval('observer', 7);
  assert.equal(owner.received.length, 0);
  f.router.server('owner', { id: 1, result: { turn: { id: 'turn' } } }); assert.equal(owner.received.length, 1);
  f.approval('owner', 7); assert.equal(owner.received.length, 1);
});
test('unknown provenance cannot be approved by a workbench observer', () => {
  const f = fixture(), work = f.add('work', 'team_agent_workbench_x');
  assert.equal(f.approval('work', 7), true); assert.equal(work.replies.length, 0);
  assert.equal(work.received.filter(m => m.id !== undefined).length, 0);
});

test('dynamic tool execution stays at its registered native host', () => {
  const f = fixture(), work = f.add('work', 'team_agent_workbench_x'); f.add('desktop');
  const request = { id: 1, method: 'item/tool/call', params: { threadId: 'thread' } };
  assert.equal(f.router.server('work', request), true);
  assert.equal(f.router.server('desktop', request), false);
  assert.equal(work.replies.length, 0);
});

test('an interrupted start can reconcile to idle without leaving a permanent ownership lock', () => {
  const f = fixture(); f.add('owner', 'stable');
  f.router.client('owner', { id: 1, method: 'turn/start', params: { threadId: 'thread' } });
  f.router.remove('owner'); f.add('new', 'stable');
  f.router.client('new', { id: 2, method: 'thread/resume', params: { threadId: 'thread' } });
  f.router.server('new', { id: 2, result: { thread: { id: 'thread', status: { type: 'idle' } } } });
  assert.equal(f.router.client('new', { id: 3, method: 'turn/start', params: { threadId: 'thread' } }), false);
});

test('resolving one request keeps the observer hint while another is still pending', () => {
  const f = fixture(); f.add('owner'); const observer = f.add('observer', 'team_agent_workbench_x');
  f.start('owner'); f.approval('observer', 3, 'turn', 'one'); f.approval('observer', 4, 'turn', 'two');
  f.router.server('observer', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 3 } });
  assert.equal(observer.received.at(-1)?.params?.stillPending, true);
  f.router.server('observer', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 4 } });
  assert.equal(observer.received.at(-1)?.params?.stillPending, false);
});
test('a reconnecting owner resumes before pending approvals are redelivered; dead upstream requests expire', async () => {
  const f = fixture(), owner = f.add('owner', 'stable'), observer = f.add('observer'); f.start('owner'); f.approval('observer', 3);
  f.router.remove('owner'); const next = f.add('new', 'stable'); assert.equal(next.received.length, 0);
  f.router.client('new', { id: 9, method: 'thread/resume', params: { threadId: 'thread' } });
  f.router.server('new', { id: 9, result: { thread: { id: 'thread', status: { type: 'active' } } } });
  await new Promise<void>(resolve => queueMicrotask(() => resolve())); assert.equal(next.received.filter(m => m.id !== undefined).length, 1);
  f.router.remove('observer'); const alias = next.received.find(m => m.id !== undefined)!.id!;
  f.router.client('new', { id: alias, result: { decision: 'accept' } }); assert.equal(observer.replies.length, 0);
  assert.equal(owner.received.filter(m => m.id !== undefined).length, 1);
});

test('a request arriving while its owner is disconnected is delivered after that owner resumes', async () => {
  const f = fixture(); f.add('owner', 'stable'); f.add('observer'); f.start('owner'); f.router.remove('owner');
  f.approval('observer', 12); const next = f.add('new', 'stable');
  f.router.client('new', { id: 9, method: 'thread/resume', params: { threadId: 'thread' } });
  f.router.server('new', { id: 9, result: { thread: { id: 'thread', status: { type: 'active' } } } });
  await new Promise<void>(resolve => queueMicrotask(() => resolve()));
  assert.equal(next.received.filter(message => message.id !== undefined).length, 1);
});
