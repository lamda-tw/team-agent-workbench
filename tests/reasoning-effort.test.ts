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

const until = async (check: () => boolean | Promise<boolean>) => { const end = Date.now() + 15000; while (!await check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };

test('codex reasoning effort is sent on the next turn and can be changed without leaving the thread', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-effort-'));
  const fixture = await authLauncher(root, { status: 'ready', turn: 'success' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId);
    await assert.rejects(wb.changeReasoningEffort(session.id, 'not valid'), /有效/);
    const cursor = await wb.createSession('cursor', root, offlineProjectId);
    await assert.rejects(wb.changeReasoningEffort(cursor.id, 'high'), /只有 Codex/);
    await wb.changeReasoningEffort(session.id, 'high');
    await wb.send(session.id, '先按高努力程度处理'); await until(() => session.status === 'idle');
    const started = (await calls()).filter(call => call.method === 'thread/start' || call.method === 'turn/start');
    assert.equal(started.find(call => call.method === 'thread/start').params.config.model_reasoning_effort, 'high');
    assert.equal(started.find(call => call.method === 'turn/start').params.effort, 'high');
    await wb.changeMode(session.id, 'plan');
    await wb.changeReasoningEffort(session.id, 'low');
    await wb.send(session.id, '计划也沿用这次选择'); await until(() => session.status === 'idle');
    const resumed = (await calls()).filter(call => call.method === 'thread/resume' || call.method === 'turn/start');
    assert.equal(resumed.filter(call => call.method === 'thread/resume').at(-1).params.config.model_reasoning_effort, 'low');
    const turn = resumed.filter(call => call.method === 'turn/start').at(-1);
    assert.equal(turn.params.effort, 'low');
    assert.equal(turn.params.collaborationMode.settings.reasoning_effort, 'low');
    assert.equal(turn.params.threadId, session.nativeId);
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init();
    assert.equal(reopened.sessions.find(item => item.id === session.id)?.reasoningEffort, 'low');
    await wb.closeSession(session.id);
    await assert.rejects(wb.changeReasoningEffort(session.id, 'medium'), /已关闭/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});
