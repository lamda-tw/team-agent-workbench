import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { sessionContext } from '../src/core/session-context';
import { mergeSharedThread } from '../src/core/codex-live-thread';
import type { AgentRpc } from '../src/core/rpc';
import type { AgentSession } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const hostId = 'remote-ssh-discovered:research', remoteCwd = '/work/research', home = '/home/research/.codex';
const rollout = (id: string) => home + '/sessions/rollout-' + id + '.jsonl';
class Backend {
  readonly rootId = randomUUID();
  readonly threads = new Map<string, any>([[this.rootId, {
    id: this.rootId, path: rollout(this.rootId), cwd: remoteCwd, status: { type: 'idle' },
    turns: [{ id: 'original-turn', status: 'completed', items: [
      { id: 'original-user', type: 'userMessage', content: [{ type: 'text', text: '比较两个方案' }] },
      { id: 'original-reply', type: 'agentMessage', text: '已经验证的原始上下文' },
    ] }],
  }]]);
  calls: { method: string; params: any }[] = [];
  forkError?: string;
  projectionMissing = false;
  projectionReady = false;
  overrideFork?: (thread: any) => any;
  beforeForkReply?: () => Promise<void>;
  rpc() {
    const backend = this;
    return new class extends EventEmitter implements AgentRpc {
      async request(method: string, params?: any) {
        backend.calls.push({ method, params });
        if (method === 'account/read') return { requiresOpenaiAuth: false };
        if (method === 'thread/read' || method === 'thread/resume') {
          const thread = backend.threads.get(params.threadId); assert(thread, 'must resume an existing remote identity');
          return { thread: structuredClone(thread), approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [remoteCwd] } };
        }
        if (method === 'thread/turns/list') { backend.projectionReady = true; return { data: [] }; }
        if (method === 'thread/fork') {
          if (backend.forkError) throw new Error(backend.forkError);
          if (backend.projectionMissing && !backend.projectionReady) throw new Error('failed to prepare paginated fork: missing projection state for paginated thread parent');
          const parent = backend.threads.get(params.threadId); assert(parent);
          const id = randomUUID(), thread = { ...structuredClone(parent), id, path: rollout(id), forkedFromId: parent.id, status: { type: 'idle' } };
          thread.turns.forEach((turn: any) => { if (turn.status === 'inProgress') turn.status = 'interrupted'; });
          backend.threads.set(id, thread);
          await backend.beforeForkReply?.();
          return { thread: backend.overrideFork?.(thread) || thread };
        }
        if (method === 'turn/start') return { turn: { id: randomUUID() } };
        if (method === 'thread/start' || method === 'command/exec' || method === 'turn/interrupt') throw new Error('unexpected parent mutation or local fallback: ' + method);
        return {};
      }
      notify() {}
      respond() {}
      reject() { throw new Error('unexpected native request'); }
      async close() {}
    }();
  }
}

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-remote-child-')), backend = new Backend();
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  t.after(async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await wb.store.init(); grantTestWorkspace(wb, root);
  wb.store.settings.providerPaths.codex = path.join(root, 'no-local-codex.exe');
  Object.defineProperty(wb, 'codexRemote', { value: {
    resolve: async () => [{ nativeId: backend.rootId, name: '远程根会话', cwd: remoteCwd, nativePath: rollout(backend.rootId),
      remote: { hostId, hostName: 'research', cwd: remoteCwd, nativePath: rollout(backend.rootId), home },
      messages: mergeSharedThread([], backend.threads.get(backend.rootId)) }],
    rpc: async (id: string) => { assert.equal(id, hostId); return backend.rpc(); },
    read: async (s: AgentSession) => mergeSharedThread(s.messages, backend.threads.get(s.nativeId!)),
  } });
  const [parent] = await wb.linkNativeSelections('codex', [{ hostId, nativeId: backend.rootId }], offlineProjectId);
  await wb.restoreDesktopSync(parent.id);
  return { root, wb, backend, parent };
}

test('remote child is created on the original backend, persists its identity and accepts its first question', async t => {
  const { wb, backend, parent } = await fixture(t), selected = '解释这个方案的取舍';
  const child = await wb.forkSubsession(parent.id, '方案比较', selected);
  assert.notEqual(child.nativeId, parent.nativeId); assert.equal(child.parentId, parent.id);
  assert.deepEqual(child.codexRemote, { ...parent.codexRemote, nativePath: rollout(child.nativeId!) });
  assert.notEqual(child.codexRemote, parent.codexRemote);
  assert.equal(child.nativeLive, true); assert.equal(child.codexDesktop, undefined); assert.equal(child.codexStorage, undefined);
  assert.equal(child.fork?.workspaceRoot, remoteCwd); assert.equal(child.fork?.nativeFork, true);
  assert.equal(wb.store.inputs[child.id].text, selected);
  assert.equal(backend.calls.filter(call => call.method === 'turn/start').length, 0, 'creation does not submit the editable question');
  const fork = backend.calls.find(call => call.method === 'thread/fork')!;
  assert.equal(fork.params.threadId, parent.nativeId); assert.equal(fork.params.cwd, remoteCwd); assert.equal(fork.params.excludeTurns, true);
  assert.equal(fork.params.lastTurnId, undefined, 'includes native history while the parent is streaming');
  await wb.send(child.id, selected);
  const turn = backend.calls.find(call => call.method === 'turn/start')!;
  assert.equal(turn.params.threadId, child.nativeId);
  const prompt = turn.params.input[0].text;
  assert.match(prompt, /解释这个方案的取舍/); assert.match(prompt, /已继承创建时的原生上下文/);
  assert(!prompt.includes(parent.cwd)); assert(!prompt.includes(child.handoffPath)); assert(!prompt.includes('本地快照：'));
  assert.equal(parent.nativeId, backend.rootId); assert.equal(parent.nativePath, rollout(backend.rootId));
  const restored = new Store(wb.store.root); await restored.init();
  assert.deepEqual(restored.sessions.find(session => session.id === child.id)?.codexRemote, child.codexRemote);
  assert.equal(restored.sessions.find(session => session.id === child.id)?.fork?.remoteContext, child.fork?.remoteContext);
  assert.doesNotMatch(sessionContext(restored.sessions.find(session => session.id === child.id)!, '重启后继续', []).text, /子会话创建快照/);
});

test('forking a streaming remote parent freezes visible deltas, leaves it running and sends the snapshot only once', async t => {
  const { wb, backend, parent } = await fixture(t);
  parent.status = 'running'; parent.messages.at(-1)!.text = '创建时已经显示的半句';
  backend.threads.get(parent.nativeId!).status = { type: 'active' };
  backend.beforeForkReply = async () => { parent.messages.at(-1)!.text += '，这是创建以后生成的'; };
  const child = await wb.forkSubsession(parent.id, '并行探索');
  assert.equal(parent.status, 'running'); assert(child.fork?.parentWasRunning);
  assert.match(child.fork!.remoteContext!, /创建时已经显示的半句/);
  assert.doesNotMatch(child.fork!.remoteContext!, /创建以后生成的/);
  assert.equal((await wb.subsessionHistory(child.id)).at(-1)?.text, '创建时已经显示的半句');
  const input = sessionContext(child, '先分析这里', [child.fork!.sourceId]);
  assert.equal(input.sources.length, 0); assert.match(input.text, /创建时已经显示的半句/);
  assert.equal(input.context.sourceHashes[child.fork!.sourceId], child.fork!.snapshotHash);
  await wb.send(child.id, '先分析这里');
  assert.doesNotMatch(sessionContext(child, '继续', []).text, /子会话创建快照|创建时已经显示的半句/);
  assert.equal(backend.calls.filter(call => call.method === 'turn/interrupt').length, 0);
});

test('idle remote forks can repair a missing native history projection without changing the remote identity', async t => {
  const { wb, backend, parent } = await fixture(t);
  backend.projectionMissing = true;
  const child = await wb.forkSubsession(parent.id, '恢复历史索引');
  assert.equal(backend.calls.filter(call => call.method === 'thread/fork').length, 2);
  assert.equal(backend.calls.filter(call => call.method === 'thread/turns/list').length, 1);
  assert.equal(child.codexRemote?.hostId, hostId);
  assert.equal(child.codexRemote?.nativePath, rollout(child.nativeId!));
  await wb.send(child.id, '继续分析');
  assert.equal(backend.calls.find(call => call.method === 'turn/start')?.params.threadId, child.nativeId);
});

test('a running remote parent does not retry a missing-history fork at a later boundary', async t => {
  const { wb, backend, parent } = await fixture(t);
  backend.projectionMissing = true;
  parent.status = 'running';
  await assert.rejects(wb.forkSubsession(parent.id, '保持分叉时点'), /missing projection state/);
  assert.equal(backend.calls.filter(call => call.method === 'thread/fork').length, 1);
  assert.equal(backend.calls.filter(call => call.method === 'thread/turns/list').length, 0);
  assert.equal(wb.store.sessions.length, 1);
});

test('nested remote children retain an unsent ancestor snapshot without adding local file references', async t => {
  const { wb, parent } = await fixture(t);
  parent.status = 'running'; parent.messages.at(-1)!.text = '祖先尚未发送到子会话的片段';
  const child = await wb.forkSubsession(parent.id, '第一层');
  const grandchild = await wb.forkSubsession(child.id, '第二层');
  const input = sessionContext(grandchild, '分析继承片段', []);
  assert.match(input.text, /祖先尚未发送到子会话的片段/);
  assert.equal(input.text.match(/祖先尚未发送到子会话的片段/g)?.length, 1);
  assert.equal(input.sources.length, 0); assert.equal(grandchild.sources.length, 1);
  assert(!input.text.includes(child.cwd));
  await wb.send(grandchild.id, '分析继承片段');
});

test('remote children still reject ordinary local attachments before any model turn is sent', async t => {
  const { wb, backend, parent, root } = await fixture(t);
  const child = await wb.forkSubsession(parent.id, '附件边界'), id = randomUUID();
  const localPath = path.join(root, 'private.txt'); await fs.writeFile(localPath, '本机附件内容');
  child.sources.push({ id, name: '本机资料', localPath, sourcePath: 'local:private.txt', sha256: 'abc', size: 10, fetchedAt: '', userAttachment: true });
  await assert.rejects(wb.send(child.id, '继续', [id]), /暂不支持附带本机参考文件/);
  assert.equal(backend.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('a compressed remote child resumes by its own ID when native history materializes as JSONL', async t => {
  const { wb, backend, parent } = await fixture(t);
  backend.overrideFork = thread => ({ ...thread, path: thread.path + '.zst' });
  const child = await wb.forkSubsession(parent.id, '压缩历史');
  assert.equal(child.codexRemote?.nativePath, rollout(child.nativeId!) + '.zst');
  await wb.send(child.id, '从压缩历史继续');
  const resume = backend.calls.find(call => call.method === 'thread/resume' && call.params.threadId === child.nativeId)!;
  assert.equal(resume.params.path, undefined);
  assert.equal(child.codexRemote?.nativePath, rollout(child.nativeId!));
  assert.equal(backend.calls.find(call => call.method === 'turn/start')?.params.threadId, child.nativeId);
});

test('invalid remote fork identities, history paths or origins never register a local substitute', async t => {
  const { wb, backend, parent } = await fixture(t);
  const cases = [
    (thread: any) => ({ ...thread, id: parent.nativeId }),
    (thread: any) => ({ ...thread, id: 'invalid-id' }),
    (thread: any) => ({ ...thread, path: rollout(parent.nativeId!) }),
    (thread: any) => ({ ...thread, path: '/other/home/sessions/other.jsonl' }),
    (thread: any) => ({ ...thread, path: home + '/sessions/' }),
    (thread: any) => ({ ...thread, path: rollout(randomUUID()) }),
    (thread: any) => ({ ...thread, path: 'C:/local/cache/child.jsonl' }),
    (thread: any) => ({ ...thread, cwd: '/other/project' }),
    (thread: any) => ({ ...thread, forkedFromId: randomUUID() }),
  ];
  for (const override of cases) {
    backend.overrideFork = override;
    await assert.rejects(wb.forkSubsession(parent.id, '无效分叉'), /未返回.*(独立分支|远程子会话)/);
    assert.equal(wb.store.sessions.length, 1); assert.equal(parent.nativeId, backend.rootId);
  }
  assert.equal(backend.calls.filter(call => ['thread/start', 'turn/start', 'turn/interrupt', 'command/exec'].includes(call.method)).length, 0);
});

test('remote fork and persistence failures retain the parent, input and existing session tree', async t => {
  const { wb, backend, parent } = await fixture(t);
  wb.store.inputs[parent.id] = { text: '父会话未发送的问题', sourceIds: [], answers: {} };
  backend.forkError = 'SSH fork unavailable';
  await assert.rejects(wb.forkSubsession(parent.id, '断线'), /SSH fork unavailable/);
  assert.equal(wb.store.sessions.length, 1);
  backend.forkError = undefined;
  const save = wb.store.save.bind(wb.store); wb.store.save = async () => { throw new Error('disk-full'); };
  try { await assert.rejects(wb.forkSubsession(parent.id, '保存失败'), /disk-full/); }
  finally { wb.store.save = save; }
  assert.equal(wb.store.sessions.length, 1); assert.equal(parent.nativeId, backend.rootId);
  assert.equal(wb.store.inputs[parent.id].text, '父会话未发送的问题');
  assert.equal(Object.keys(wb.store.inputs).length, 1);
  delete parent.nativeId;
  await assert.rejects(wb.forkSubsession(parent.id, '缺少标识'), /远程父会话标识缺失/);
});
