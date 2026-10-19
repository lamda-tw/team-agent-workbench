import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { codexDefaultModel, defaultModelLabel, codexModelUnavailableMessage } from '../src/shared/model-selection';
import { inspectCatalog } from '../src/core/provider-catalog';
import { AgentRuntime } from '../src/core/agents';
import type { AgentSession, ProviderCatalog } from '../src/shared/types';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const catalog: ProviderCatalog = { models: [{ id: 'recommended-model', name: 'Recommended', isDefault: true }, { id: 'configured-model', name: 'Configured' }], checkedAt: '', quota: { windows: [], detail: '', url: '' } };
test('configured CLI model takes precedence over catalog recommendation, without inventing an alias', () => {
  assert.equal(codexDefaultModel({ model: 'configured-model' }, catalog), 'configured-model');
  assert.equal(codexDefaultModel({}, catalog), 'recommended-model');
  assert.equal(codexDefaultModel({ model: 'custom-provider-model' }, catalog), 'custom-provider-model');
  assert.match(defaultModelLabel({ ...catalog, defaultModel: 'configured-model' }), /Configured/);
  assert.equal(defaultModelLabel(undefined), '沿用 CLI 默认模型');
});
test('unavailable-model errors explain recovery without conflating network, login or file errors', () => {
  for (const error of ['The model `gpt-6.1-sol` does not exist or you do not have access to it.', 'model_not_found', '模型不存在']) assert.match(codexModelUnavailableMessage(error, 'gpt-6.1-sol')!, /选择模型.*已有对话保留/);
  for (const error of ['ECONNRESET', '403 Forbidden', 'login expired', 'model.py file not found']) assert.equal(codexModelUnavailableMessage(error), undefined);
});
test('catalog reports the effective configured model and flags unlisted defaults without dropping options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-catalog-'));
  const fixture = await authLauncher(root, { status: 'ready', defaultModel: 'gpt-fixture-2' });
  try {
    const configured = await inspectCatalog('codex', fixture.launcher, root);
    assert.equal(configured.defaultModel, 'gpt-fixture-2'); assert.equal(configured.models.find(m => m.isDefault)!.id, 'gpt-fixture');
    await fixture.write({ status: 'ready', defaultModel: 'unavailable-model' });
    const missing = await inspectCatalog('codex', fixture.launcher, root);
    assert.equal(missing.defaultModel, 'unavailable-model'); assert.match(missing.defaultModelWarning!, /未出现在当前列表/); assert.equal(missing.models.length, 2);
    const calls = await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8'); assert(!calls.includes('turn/start'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
for (const phase of ['start', 'turn'] as const) test(`model unavailable at ${phase} is actionable and keeps the same conversation for recovery`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-recovery-'));
  const error = 'The model `missing-model` does not exist or you do not have access to it.';
  const fixture = await authLauncher(root, { status: 'ready', runtimeModel: 'missing-model', [phase === 'start' ? 'modelErrorOnStart' : 'modelErrorOnTurn']: error });
  const session: AgentSession = { id: randomUUID(), provider: 'codex', title: 'History', cwd: root, createdAt: new Date().toISOString(), purpose: 'work', status: 'idle', messages: [{ id: 'past', role: 'assistant', text: '保留已有约定', createdAt: new Date().toISOString() }], approvals: [], sources: [], autoUpload: false, handoffPath: '' };
  let authFailures = 0;
  const runtime = new AgentRuntime(session, fixture.launcher, { changed() {}, done() {}, event() {}, authFailed() { authFailures++; } });
  try {
    if (phase === 'start') await assert.rejects(runtime.ensureStarted(), /选择模型/);
    else { await runtime.prompt('继续'); assert.equal(session.resolvedModel, 'missing-model'); }
    assert.match(session.error!, /选择模型/); assert.equal(authFailures, 0); assert.equal(session.messages[0].text, '保留已有约定');
    const nativeId = session.nativeId;
    await fixture.write({ status: 'ready', runtimeModel: 'gpt-fixture', turn: 'success' }); session.model = 'gpt-fixture';
    await runtime.prompt('继续');
    const deadline = Date.now() + 5000; while (session.status !== 'idle') { if (Date.now() > deadline) throw Error('recovery timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
    if (nativeId) assert.equal(session.nativeId, nativeId);
    assert.equal(session.messages[0].text, '保留已有约定'); assert.equal(session.error, undefined);
    const calls = (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(c => c.method === 'turn/start').length, phase === 'turn' ? 2 : 1, 'no automatic model retry');
    assert.equal(calls.filter(c => c.method === 'turn/start').at(-1).params.model, 'gpt-fixture');
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
