import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentRuntime } from '../src/core/agents';
import type { AgentRpc, RpcMessage } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';
import { NativeDesktopControls } from '../src/renderer/native-desktop-controls';

class FixtureRpc extends EventEmitter implements AgentRpc {
  replies: RpcMessage[] = [];
  calls: { method: string; params: any }[] = [];
  reads = 0;
  onRead?: () => Promise<any>;
  onResume?: () => void;
  policy: any = { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } };
  async request(method: string, params?: any) {
    this.calls.push({ method, params });
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'account/read') return { requiresOpenaiAuth: false };
    if (method === 'thread/read') { this.reads++; return this.onRead?.() || { thread: this.thread('idle') }; }
    if (method === 'thread/resume') { this.onResume?.(); return { thread: this.thread('active'), ...this.policy }; }
    if (method === 'turn/start') { this.policy = { approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: params.sandboxPolicy }; return { turn: { id: 'turn' } }; }
    return {};
  }
  thread(status: string) { return { id: 'thread', path: 'C:/fixture/rollout.jsonl', status: { type: status }, turns: [] }; }
  notify() {}
  respond(id: number | string, result: unknown) { this.replies.push({ id, result }); }
  reject(id: number | string) { this.replies.push({ id, error: { code: -1, message: 'rejected' } }); }
  async close() {}
}
function setup() {
  const session = { id: 'session', provider: 'codex', purpose: 'work', cwd: 'C:/fixture', permissionMode: 'inherit', nativeId: 'thread', codexDesktop: true, nativeLive: true, status: 'idle', messages: [], approvals: [], sources: [] } as unknown as AgentSession;
  const runtime = new AgentRuntime(session, 'unused', { changed: () => {}, event: () => {}, done: () => {} }, { home: 'C:/fixture', sourceHome: 'C:/fixture', args: [], env: {}, sharedEndpoint: 'ws://unused', sharedApprovalRouting: true });
  const rpc = new FixtureRpc(), original = runtime.rpc;
  for (const name of original.eventNames()) for (const listener of original.listeners(name)) rpc.on(name, listener as (...args: any[]) => void);
  original.removeAllListeners(); runtime.rpc = rpc;
  return { session, runtime, rpc, emit: (method: string, params: any, id?: string) => rpc.emit('message', { method, params, ...(id ? { id } : {}) }) };
}
test('joining mid-turn hydrates a prefix, replays authoritative completion, and excludes other threads', async () => {
  const f = setup();
  f.rpc.onResume = () => f.emit('item/agentMessage/delta', { threadId: 'other', itemId: 'foreign', delta: 'must not appear' });
  f.rpc.onRead = async () => {
    f.emit('item/agentMessage/delta', { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: 'tail' });
    f.emit('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text: 'prefix tail' } });
    f.emit('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
    return { thread: { ...f.rpc.thread('active'), turns: [{ items: [{ id: 'reply', type: 'agentMessage', text: 'prefix ' }] }] } };
  };
  try { await f.runtime.ensureStarted(); assert.deepEqual(f.session.messages.map(m => m.text), ['prefix tail']); assert.equal(f.session.status, 'idle'); assert.equal(f.session.desktopSyncPending, false); }
  finally { await f.runtime.close(); }
});
test('an idle authoritative snapshot releases a joined turn even if its completion notification was missed', async () => {
  const f = setup();
  try { await f.runtime.ensureStarted(); assert.equal(f.session.status, 'idle'); assert.equal(f.session.desktopSyncPending, false); }
  finally { await f.runtime.close(); }
});
test('observer approvals never generate a decision; routed resolved requests expire', async () => {
  const f = setup();
  try {
    await f.runtime.ensureStarted();
    const params = { threadId: 'thread', turnId: 'turn', itemId: 'cmd', command: 'fixture' };
    f.emit('item/commandExecution/requestApproval', params, 'unrouted');
    assert.equal(f.rpc.replies.length, 0); assert.equal(f.session.approvals.length, 0); assert.equal(f.session.desktopWaitingApproval, true);
    f.emit('item/commandExecution/requestApproval', params, 'wb-approval:one');
    assert.equal(f.session.approvals.length, 1); const id = f.session.approvals[0].id;
    f.emit('serverRequest/resolved', { threadId: 'thread', requestId: 'wb-approval:one' });
    assert.equal(f.session.approvals.length, 0); assert.throws(() => f.runtime.answer(id, 'accept'), /过期/); assert.equal(f.rpc.replies.length, 0);
  } finally { await f.runtime.close(); }
});
test('failed snapshot remains visibly pending; late reconciliation cannot revive a closed runtime', async () => {
  const f = setup(); let complete: ((value: any) => void) | undefined;
  f.rpc.onRead = async () => { if (f.rpc.reads === 1) throw Error('temporary'); return new Promise(resolve => { complete = resolve; }); };
  try {
    await f.runtime.ensureStarted(); assert.equal(f.session.desktopSyncPending, true);
    await new Promise(resolve => setTimeout(resolve, 1100)); assert(complete);
    await f.runtime.close(); complete!({ thread: { ...f.rpc.thread('idle'), turns: [{ items: [{ id: 'late', type: 'agentMessage', text: 'late' }] }] } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.messages.length, 0); assert.equal(f.session.desktopSyncPending, false);
  } finally { await f.runtime.close(); }
});
test('snapshot plan items preserve UI identity when live deltas and completion arrive', async () => {
  const f = setup();
  f.session.messages.push({ id: 'native:plan', role: 'assistant', text: '前半', createdAt: 'now' });
  try {
    await f.runtime.ensureStarted(); f.emit('item/plan/delta', { threadId: 'thread', itemId: 'plan', delta: '后半' });
    f.emit('item/completed', { threadId: 'thread', item: { id: 'plan', type: 'plan', text: '完整方案' } });
    assert.equal(f.session.messages[0].id, 'native:plan'); assert.equal(f.session.proposedPlan?.messageId, 'native:plan'); assert.equal(f.session.messages.length, 1);
  } finally { await f.runtime.close(); }
});
test('changing a loaded shared thread applies permissions on the next turn without interrupting or replacing it', async () => {
  const f = setup(); f.session.permissionMode = 'review';
  try {
    await f.runtime.ensureStarted();
    f.emit('turn/completed', { threadId: 'thread', turn: { id: 'previous' } });
    assert.equal(await f.runtime.prompt('task'), true);
    const start = f.rpc.calls.find(call => call.method === 'turn/start')!;
    assert.equal(start.params.threadId, 'thread'); assert.equal(start.params.approvalPolicy, 'on-request'); assert.equal(start.params.approvalsReviewer, 'user');
    assert.equal(start.params.sandboxPolicy.type, 'workspaceWrite'); assert.equal(f.session.permissions?.approval, 'on-request');
    assert.equal(f.rpc.calls.filter(call => ['turn/interrupt', 'thread/start', 'thread/fork'].includes(call.method)).length, 0);
  } finally { await f.runtime.close(); }
});
test('native controls offer explicit recovery and read-only status without exposing approval buttons', () => {
  const f = setup(); f.session.status = 'error'; f.session.desktopSyncPending = true; f.session.desktopWaitingApproval = true;
  const html = renderToStaticMarkup(React.createElement(NativeDesktopControls, { session: f.session, run: () => {} }));
  assert.match(html, /恢复同步/); assert.match(html, /正在补齐对话/); assert.match(html, /发起任务的窗口/); assert.doesNotMatch(html, /允许本次|拒绝/);
  f.session.closedAt = 'now'; assert.equal(renderToStaticMarkup(React.createElement(NativeDesktopControls, { session: f.session, run: () => {} })), '');
});

test('native controls restore idle associations for either provider and suppress recovery while connected', () => {
  const f = setup(); f.session.status='idle';
  const render=()=>renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:f.session,run:()=>{}}));
  assert.match(render(),/尚未同步/);assert.match(render(),/恢复同步/);
  f.session.desktopSyncState='connected';assert.match(render(),/同步中/);assert.doesNotMatch(render(),/恢复同步/);
  f.session.codexDesktop=false;f.session.provider='cursor';f.session.cursorNative={managed:true,descriptorFile:'fixture'};f.session.desktopSyncState='disconnected';
  assert.match(render(),/记录未连接/);assert.match(render(),/重新读取/);assert.match(render(),/无法让 CLI 与 Agents 共用完整历史和上下文/);assert.doesNotMatch(render(),/同步中|恢复同步|CLI 请求失败/);
  f.session.nativeId=undefined;assert.doesNotMatch(render(),/重新读取/);
});
