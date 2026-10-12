import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function until(predicate: () => boolean | Promise<boolean>) { const end = Date.now() + 20000; while (!(await predicate())) { if (Date.now() > end) throw new Error('test timed out'); await new Promise(r => setTimeout(r, 25)); } }
for (const provider of ['codex', 'cursor'] as const) test(provider + ': switch model and permission without interrupting the current turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-settings-'));
  const fixture = await authLauncher(root, { status: 'ready', turn: 'success', turnDelay: 100, permissionRuntime: true });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths[provider] = fixture.launcher;
    const session = await wb.createSession(provider, root, offlineProjectId, 'work', undefined, 'first-model', 'inherit');
    await wb.send(session.id, 'Remember the project plan'); await until(() => session.status === 'idle' && session.messages.filter(m => m.role === 'assistant').length === 1);
    const native = session.nativeId, history = structuredClone(session.messages), input = { text: '未发送的草稿', sourceIds: [], answers: {} };
    wb.store.inputs[session.id] = input;
    // Background helpers also use the same CLI; count only this original work session.
    const workPrompt = (c: any) => c.method === 'turn/start' ? c.params.threadId === native : c.method === 'session/prompt' && c.params.sessionId === native;
    const turns = (await calls()).filter(workPrompt).length;
    const changing = wb.changeModel(session.id, 'second-model');
    await assert.rejects(wb.send(session.id, 'Do not race a settings change'), /正在切换/);
    await assert.rejects(wb.changePermissions(session.id, 'full'), /正在切换/);
    await changing;
    assert.equal(session.nativeId, native); assert.equal(session.model, 'second-model'); assert.equal(session.permissionMode, 'inherit');
    assert.deepEqual(session.messages, history); assert.deepEqual(wb.store.inputs[session.id], input);
    assert.equal((await calls()).filter(workPrompt).length, turns);
    await wb.send(session.id, 'Continue the same plan'); await until(() => session.status === 'idle');
    const changedCalls = await calls();
    if (provider === 'codex') {
      assert(changedCalls.some(c => c.method === 'thread/resume' && c.params.threadId === native && c.params.model === 'second-model'));
      assert(changedCalls.some(c => c.method === 'turn/start' && c.params.model === 'second-model'));
    } else {
      assert(changedCalls.some(c => c.method === 'session/load' && c.params.sessionId === native));
      assert(changedCalls.some(c => c.method === 'session/set_model' && c.params.sessionId === native && c.params.modelId === 'second-model'));
    }
    const users = session.messages.filter(m => m.role === 'user'); assert.equal(users.length, 2);
    assert.equal(users[1].context?.workRecord, false, 'model switching must keep reference injection history');
    await assert.rejects(wb.changeModel(session.id, 'bad\nmodel'), /有效/);
    await assert.rejects(wb.changeModel(session.id, ''), /有效/);
    await fixture.write({ status: 'ready', turn: 'success', turnDelay: 5000, permissionRuntime: true });
    const send = wb.send(session.id, 'Long-running work'); await until(() => session.status === 'running');
    await until(async () => (await calls()).filter(workPrompt).length === 3);
    const beforeSwitch = (await calls()).filter(workPrompt).length;
    const runningSince = Date.now();
    await wb.changeModel(session.id, 'third-model');
    await wb.changePermissions(session.id, 'full');
    assert.equal(session.status, 'running', 'changing settings must not cancel the active turn');
    assert.equal(session.settingsPending, true);
    assert.equal(session.nativeId, native);
    assert.equal((await calls()).filter(workPrompt).length, beforeSwitch);
    assert.deepEqual(wb.store.inputs[session.id], input);
    await send; await until(() => session.status === 'idle');
    assert(Date.now() - runningSince >= 3000, 'the current turn must finish on its own, not be canceled by switching');
    assert.equal(session.settingsPending, true, 'the next turn has not started yet');
    assert.equal(session.model, 'third-model'); assert.equal(session.permissionMode, 'full');
    assert.equal(session.nativeId, native);
    await fixture.write({ status: 'ready', turn: 'success', permissionRuntime: true });
    await wb.send(session.id, 'Continue after switching'); await until(() => session.status === 'idle');
    const resumed = await calls();
    if (provider === 'codex') {
      assert(resumed.some(c => c.method === 'thread/resume' && c.params.threadId === native && c.params.model === 'third-model' && c.params.approvalPolicy === 'never' && c.params.sandbox === 'danger-full-access'));
      assert(resumed.some(c => c.method === 'turn/start' && c.params.model === 'third-model'));
    } else {
      assert(resumed.some(c => c.method === 'session/load' && c.params.sessionId === native));
      assert(resumed.some(c => c.method === 'session/set_model' && c.params.sessionId === native && c.params.modelId === 'third-model'));
    }
    assert.equal(session.messages.filter(m => m.role === 'user').length, 4);
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init();
    assert.equal(reopened.sessions.find(s => s.id === session.id)?.model, 'third-model');
    assert.equal(reopened.sessions.find(s => s.id === session.id)?.permissionMode, 'full');
    await wb.closeSession(session.id); await assert.rejects(wb.changeModel(session.id, 'fourth-model'), /已关闭/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});
