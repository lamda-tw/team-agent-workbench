import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { AgentRuntime } from '../src/core/agents';
import { CodexSshRpc } from '../src/core/codex-ssh-rpc';
import { codexTurnPermissionParams } from '../src/core/permissions';
import { nativeSelectionKey } from '../src/shared/native-sessions';
import { workRecordInstructions } from '../src/shared/session-context-text';
import type { AgentSession } from '../src/shared/types';
import type { AgentRpc } from '../src/core/rpc';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import type { RemoteImportSource } from '../src/core/codex-remote-sessions';

const host = 'remote-ssh-discovered:research';
const source = (id: string, hostId = host): RemoteImportSource => ({ nativeId: id, name: '远程对话', cwd: '/work/research', nativePath: '/home/user/.codex/sessions/rollout-' + id + '.jsonl',
  remote: { hostId, hostName: 'research', cwd: '/work/research', nativePath: '/home/user/.codex/sessions/rollout-' + id + '.jsonl', home: '/home/user/.codex' },
  messages: [{ id: 'old', role: 'assistant', text: '原有上下文', createdAt: new Date(0).toISOString() }] });

test('remote batch import preserves host and history, persists across restarts and deduplicates closed chats per host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-remote-import-'));
  const wb = new Workbench(root, () => {}, () => {}), id = randomUUID(), other = randomUUID();
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const calls: string[][] = [];
    Object.defineProperty(wb, 'codexRemote', { value: { resolve: async (hostId: string, ids: string[]) => { calls.push(ids); return ids.map(id => source(id, hostId)); } } });
    const imported = await wb.linkNativeSelections('codex', [{ hostId: host, nativeId: id }, { hostId: host, nativeId: other }], offlineProjectId);
    assert.equal(imported.length, 2); assert.deepEqual(calls, [[id, other]], 'one validation per host, before local registration');
    assert.equal(imported[0].nativeId, id); assert.equal(imported[0].codexRemote?.hostId, host);
    assert.equal(imported[0].codexRemote?.cwd, '/work/research'); assert(imported[0].cwd.startsWith(root));
    assert.equal(imported[0].messages[0].text, '原有上下文'); assert.equal(imported[0].codexDesktop, undefined); assert.equal(imported[0].codexStorage, undefined);
    const copy = new Store(root); await copy.init(); assert.equal(copy.sessions.find(session => session.id === imported[0].id)?.codexRemote?.hostId, host);
    await wb.closeSession(imported[0].id);
    await assert.rejects(wb.linkNativeSelections('codex', [{ hostId: host, nativeId: id.toUpperCase() }], offlineProjectId), /不能重复导入/);
    assert.equal(calls.length, 1);
    const sameIdOtherHost = await wb.linkNativeSelections('codex', [{ hostId: 'remote-ssh-discovered:other', nativeId: id }], offlineProjectId);
    assert.equal(sameIdOtherHost.length, 1); assert.notEqual(nativeSelectionKey({ nativeId: id, hostId: host }), nativeSelectionKey({ nativeId: id, hostId: 'remote-ssh-discovered:other' }));
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a stale or unreachable remote selection rejects a mixed batch before registering any session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-remote-reject-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    Object.defineProperty(wb, 'codexRemote', { value: { resolve: async () => { throw Error('SSH connection unavailable'); } } });
    await assert.rejects(wb.linkNativeSelections('codex', [{ hostId: host, nativeId: randomUUID() }], offlineProjectId), /SSH/);
    assert.equal(wb.store.sessions.length, 0);
    await assert.rejects(wb.linkNativeSelections('cursor', [{ hostId: host, nativeId: randomUUID() }], offlineProjectId), /仅 Codex/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

class RemoteRpc extends EventEmitter implements AgentRpc {
  calls: { method: string; params: any }[] = []; replies: unknown[] = [];
  active = false; mismatched = false;
  constructor(readonly id: string) { super(); }
  thread() { return { id: this.mismatched ? 'another-thread' : this.id, path: source(this.id).nativePath, cwd: '/work/research', status: { type: this.active ? 'active' : 'idle' }, turns: [{ id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'old-reply', text: '原有上下文' }] }] }; }
  async request(method: string, params?: any) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { requiresOpenaiAuth: false };
    if (method === 'thread/resume') return { thread: this.thread(), approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } };
    if (method === 'thread/read') return { thread: this.thread() };
    if (method === 'turn/start') return { turn: { id: 'new-turn' } };
    return {};
  }
  notify() {}
  respond(id: string | number, result: unknown) { this.replies.push({ id, result }); }
  reject() { throw Error('unexpected request rejection'); }
  async close() {}
}

function remoteRuntime() {
  const id = randomUUID(), original = source(id), rpc = new RemoteRpc(id);
  const session = { id: randomUUID(), nativeId: id, provider: 'codex', purpose: 'work', cwd: 'C:/local/cache', handoffPath: 'C:/local/cache/handoff.md', nativePath: original.nativePath, nativeLive: true, codexRemote: original.remote, status: 'idle', messages: [], approvals: [], sources: [], permissionMode: 'review' } as unknown as AgentSession;
  const runtime = new AgentRuntime(session, 'NO_LOCAL_EXECUTABLE', { changed: () => {}, event: () => {}, done: () => {} }, undefined, {}, rpc);
  return { session, runtime, rpc };
}

test('remote continuation resumes the original thread in its remote cwd and routes approvals without invoking a local CLI', async () => {
  const f = remoteRuntime();
  try {
    await f.runtime.ensureStarted();
    assert.equal(f.rpc.calls.find(call => call.method === 'thread/resume')?.params.cwd, '/work/research');
    assert.equal(f.session.nativeId, f.rpc.id); assert.equal(f.session.desktopSyncState, 'connected');
    assert(f.session.messages.some(message => message.text === '原有上下文'));
    assert.equal(f.rpc.calls.filter(call => ['thread/start', 'thread/fork', 'command/exec'].includes(call.method)).length, 0);
    assert.deepEqual(codexTurnPermissionParams(f.session).sandboxPolicy?.writableRoots, ['/work/research']);
    assert(!workRecordInstructions(f.session).includes('C:/local/cache'));
    await f.runtime.prompt('继续原任务');
    const start = f.rpc.calls.find(call => call.method === 'turn/start')!;
    assert.equal(start.params.threadId, f.rpc.id); assert.deepEqual(start.params.sandboxPolicy.writableRoots, ['/work/research']);
    f.rpc.emit('message', { id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: f.rpc.id, turnId: 'new-turn', command: 'pwd' } });
    assert.equal(f.session.approvals.length, 1); f.runtime.answer(f.session.approvals[0].id, 'decline');
    assert.deepEqual(f.rpc.replies[0], { id: 99, result: { decision: 'decline' } });
  } finally { await f.runtime.close(); }
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/interrupt').length, 0, 'disconnecting leaves native remote work running');
});

test('remote identity mismatch and an already-running native turn cannot create a replacement or send a duplicate task', async () => {
  const mismatch = remoteRuntime(); mismatch.rpc.mismatched = true;
  try { await assert.rejects(mismatch.runtime.ensureStarted(), /没有继续写原来的会话文件/); }
  finally { await mismatch.runtime.close(); }
  const busy = remoteRuntime(); busy.rpc.active = true;
  try {
    await busy.runtime.ensureStarted(); await assert.rejects(busy.runtime.prompt('不得重复发送'), /仍在运行|正在.*运行/);
    assert.equal(busy.rpc.calls.filter(call => ['thread/start', 'thread/fork', 'turn/start'].includes(call.method)).length, 0);
  } finally { await busy.runtime.close(); }
});

test('SSH transport carries native WebSocket frames over stdio, including large payloads and server notifications', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-ssh-ws-'));
  const fixture = path.join(root, 'proxy.cjs'), wsPath = require.resolve('ws');
  await fs.writeFile(fixture, `const {Duplex}=require('node:stream'),http=require('node:http'),{WebSocketServer}=require(${JSON.stringify(wsPath)});const stream=new Duplex({read(){process.stdin.resume()},write(c,e,cb){process.stdout.write(c,e,cb)}});process.stdin.on('data',c=>{if(!stream.push(c))process.stdin.pause()});process.stdin.on('end',()=>stream.push(null));Object.assign(stream,{setTimeout:()=>stream,setNoDelay:()=>stream,setKeepAlive:()=>stream});const server=http.createServer(),wss=new WebSocketServer({noServer:true});server.on('upgrade',(r,s,h)=>wss.handleUpgrade(r,s,h,ws=>{ws.on('message',d=>{const m=JSON.parse(String(d));ws.send(JSON.stringify({method:'fixture/notice',params:{ok:true}}));if(m.id)ws.send(JSON.stringify({id:m.id,result:{echo:m.params}}));});}));server.emit('connection',stream);`);
  const rpc = new CodexSshRpc([], root, fixture); let notices = 0; rpc.on('message', message => { if (message.method === 'fixture/notice') notices++; });
  try {
    const text = '原会话上下文'.repeat(10000), response = await rpc.request('fixture/echo', { text }, 5000);
    assert.equal(response.echo.text, text); await new Promise(resolve => setImmediate(resolve)); assert(notices > 0);
  } finally { await rpc.close(); await fs.rm(root, { recursive: true, force: true }); }
});
