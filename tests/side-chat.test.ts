import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import { CodexSideRpc } from '../src/core/codex-side-rpc';
import { Workbench } from '../src/core/workbench';
import type { AgentSession } from '../src/shared/types';
import type { AgentRpc, RpcMessage } from '../src/core/rpc';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

class Rpc extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = [];
  replies: { id: number | string; result: unknown }[] = [];
  closed = 0;
  forkCount = 0;
  ephemeral = true;
  failInjection = false;
  holdFork?: () => Promise<void>;
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === 'thread/fork') { await this.holdFork?.(); return { thread: { id: 'side-' + ++this.forkCount, ephemeral: this.ephemeral }, model: 'fixture', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }; }
    if (method === 'thread/inject_items' && this.failInjection) throw new Error('inject failed');
    if (method === 'turn/start') return { turn: { id: 'turn-' + params.threadId, status: 'inProgress' } };
    return {};
  }
  notify() {}
  respond(id: number | string, result: unknown) { this.replies.push({ id, result }); }
  reject(id: number | string, message?: string) { this.replies.push({ id, result: message }); }
  async close() { this.closed++; this.emit('closed', new Error('connection closed')); }
  event(method: string, threadId: string, extra = {}) { this.emit('message', { method, params: { threadId, ...extra } }); }
}
function session(id = 'parent'): AgentSession {
  return { id, title: id, provider: 'codex', nativeId: id, cwd: 'C:/fixture', purpose: 'work', createdAt: '', status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: '' };
}
function runtime(parent: AgentSession, rpc: Rpc, events: unknown[] = []) {
  const value = new AgentRuntime(parent, '', { changed() {}, event: event => events.push(event), done() {} }, undefined, {}, rpc);
  Object.assign(value, { initialized: true, codexConnected: true });
  return value;
}
const hooks = { changed() {}, event() {}, done() {} };

test('side chats fork a running parent once, inject a boundary, and never initialize or resume another CLI', async () => {
  const rpc = new Rpc(), parent = session(), events: unknown[] = [], source = runtime(parent, rpc, events);
  parent.status = 'running';
  const child = session('child');
  const fork = await source.createSideChat(child, hooks, () => '捕获的半句');
  assert.deepEqual(rpc.calls.map(call => call.method), ['thread/fork', 'thread/inject_items']);
  assert.equal(rpc.calls[0].params.ephemeral, true); assert.equal(rpc.calls[0].params.excludeTurns, true);
  assert.equal(rpc.calls[0].params.lastTurnId, undefined);
  assert.match(rpc.calls[1].params.items[0].content[0].text, /捕获的半句/);
  assert.equal(child.nativePath, undefined, 'ephemeral fork does not need a rollout path');
  assert.equal(parent.status, 'running'); assert.equal(parent.nativeId, 'parent');
  await fork.prompt('解释这个选择');
  rpc.event('item/agentMessage/delta', child.nativeId!, { itemId: 'answer', delta: '子回复' });
  rpc.event('item/agentMessage/delta', parent.nativeId!, { itemId: 'parent-answer', delta: '主回复' });
  assert.equal(child.messages.at(-1)?.text, '子回复');
  assert.equal(parent.messages.at(-1)?.text, '主回复');
  assert(!JSON.stringify(events).includes('子回复'), 'side chat output never reaches the parent log');
  await fork.close();
  assert.equal(rpc.closed, 0); assert.equal(parent.status, 'running');
  assert.equal(rpc.calls.at(-1)?.params.threadId, child.nativeId);
  assert(!rpc.calls.some(call => /initialize|thread\/resume|compact/.test(call.method)));
  await source.close();
});

test('two side chats route approvals and stop only their own turns; connection loss expires both', async () => {
  const rpc = new Rpc(), source = runtime(session(), rpc);
  const a = await source.createSideChat(session('a'), hooks, () => ''), b = await source.createSideChat(session('b'), hooks, () => '');
  await a.prompt('A'); await b.prompt('B');
  const request: RpcMessage = { id: 73, method: 'item/commandExecution/requestApproval', params: { threadId: a.session.nativeId, itemId: 'cmd', command: 'git status' } };
  rpc.emit('message', request);
  assert.equal(a.session.approvals.length, 1); assert.equal(b.session.approvals.length, 0); assert.equal(source.session.approvals.length, 0);
  a.answer(a.session.approvals[0].id, 'decline');
  assert.equal(rpc.replies.length, 1); assert.equal(rpc.replies[0].id, 73);
  await b.cancel(); assert.equal(rpc.calls.at(-1)?.params.threadId, b.session.nativeId);
  rpc.emit('closed', new Error('lost'));
  assert.equal(a.session.status, 'error'); assert.equal(b.session.status, 'error');
  assert.match(a.session.error!, /侧边提问已失效/);
  await assert.rejects(a.prompt('不能重建'), /失效/);
  assert.equal(rpc.closed, 0);
  await source.close();
});

test('failed setup releases only the accepted child, and unknown fork failure is never retried', async () => {
  const rpc = new Rpc(), source = runtime(session(), rpc);
  rpc.failInjection = true;
  await assert.rejects(source.createSideChat(session('child'), hooks, () => ''), /inject failed/);
  assert.equal(rpc.calls.at(-1)?.method, 'thread/unsubscribe'); assert.equal(rpc.closed, 0);
  rpc.holdFork = async () => { throw new Error('timeout'); };
  await assert.rejects(source.createSideChat(session('second'), hooks, () => ''), /timeout/);
  assert.equal(rpc.calls.filter(call => call.method === 'thread/fork').length, 2);
  await source.close();
});

test('borrowed connections cannot answer another chat request or shut down the shared transport', async () => {
  const rpc = new Rpc(), a = new CodexSideRpc(rpc, 'a'), b = new CodexSideRpc(rpc, 'b');
  rpc.emit('message', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
  b.respond(1, 'wrong'); a.respond(1, 'right'); a.respond(1, 'duplicate');
  assert.deepEqual(rpc.replies, [{ id: 1, result: 'right' }]);
  await assert.rejects(a.request('turn/start', { threadId: 'b' }), /不属于/);
  await a.close(); await b.close(); assert.equal(rpc.closed, 0);
  assert.equal(rpc.listenerCount('message'), 0); assert.equal(rpc.listenerCount('closed'), 0);
});

test('temporary chats retain selections and drafts without entering sessions, logs or account snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-sidechat-'));
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const parent = await wb.createSession('codex', root, offlineProjectId);
    parent.nativeId = 'parent'; parent.status = 'running';
    parent.messages.push({ id: randomUUID(), role: 'assistant', text: '捕获之前', createdAt: '' });
    const rpc = new Rpc(), source = runtime(parent, rpc);
    (wb as any).runtime = async () => source;
    const pending = wb.createSideChat(parent.id, '  选中文字\n原样保留');
    const chat = await pending;
    parent.messages[0].text += '捕获以后';
    assert(!JSON.stringify(rpc.calls).includes('捕获以后'));
    assert.equal(chat.draft, '  选中文字\n原样保留');
    wb.sideChatDraft(chat.id, '新的问题');
    await wb.sendSideChat(chat.id, '新的问题');
    assert.equal(wb.snapshot().sideChats?.[0].draft, '');
    assert.equal(wb.store.sessions.length, 1);
    await wb.store.save();
    assert(!JSON.stringify(await fs.readFile(path.join(root, 'sessions.json'), 'utf8')).includes('新的问题'));
    await assert.rejects(fs.stat(wb.store.sessionDir(chat.session.id)), { code: 'ENOENT' });
    const profile = wb.store.settings.workspaceSnapshot!.profile;
    const username = profile.username; profile.username = 'someone-else';
    assert.equal(wb.snapshot().sideChats?.length, 0);
    await assert.rejects(wb.sendSideChat(chat.id, '越界'), /当前账号|会话/);
    profile.username = username;
    await wb.closeSideChat(chat.id);
    assert.equal(wb.snapshot().sideChats?.length, 0); assert.equal(rpc.closed, 0);
    parent.status = 'idle';
    await wb.createSideChat(parent.id);
    await wb.closeSession(parent.id);
    await wb.deleteSession(parent.id);
    assert.equal((wb as any).sideChats.size, 0, 'deleting the parent clears its temporary records');
    await source.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('closing a parent during creation cannot publish a temporary chat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-sidechat-race-'));
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const parent = await wb.createSession('codex', root, offlineProjectId), rpc = new Rpc(), source = runtime(parent, rpc);
    parent.nativeId = 'parent'; (wb as any).runtime = async () => source;
    rpc.holdFork = async () => { parent.closedAt = new Date().toISOString(); };
    await assert.rejects(wb.createSideChat(parent.id), /已改变/);
    assert.equal(wb.snapshot().sideChats?.length, 0); assert.equal(rpc.calls.at(-1)?.method, 'thread/unsubscribe');
    await source.close();
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
