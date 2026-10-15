import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { codexModels, cursorModels, codexQuota, inspectCatalog } from '../src/core/provider-catalog';
import { codexAuth, cursorAuth } from '../src/core/provider-auth';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
async function until(predicate: () => boolean) { const end = Date.now() + 15000; while (!predicate()) { if (Date.now() > end) throw new Error('test timed out'); await new Promise(r => setTimeout(r, 25)); } }
async function cleanup(root: string) { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }

test('identity whitelist and quota parser preserve unavailable fields and prefer multiple account buckets', () => {
  const auth = codexAuth({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'member@example.com', planType: 'pro', token: 'secret' } });
  assert.equal(auth.identity, 'member@example.com'); assert.equal(auth.plan, 'pro'); assert(!JSON.stringify(auth).includes('secret'));
  assert.equal(codexAuth({ requiresOpenaiAuth: true, account: { type: 'apiKey', email: 'wrong-identity' } }).identity, undefined);
  assert.equal(cursorAuth(JSON.stringify({ status: 'authenticated', isAuthenticated: true, userInfo: { email: 'cursor@example.com', accessToken: 'secret' } }), 0).identity, 'cursor@example.com');
  assert.deepEqual(codexQuota({}), []);
  const windows = codexQuota({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { a: { primary: { usedPercent: null }, secondary: { usedPercent: 12 } }, b: { primary: { usedPercent: 200, resetsAt: 1800000000 } } } });
  assert.equal(windows.length, 2); assert.equal(windows[0].usedPercent, 12); assert.equal(windows[0].resetsAt, undefined); assert.equal(windows[1].usedPercent, 100);
  const parsed = codexModels({ data: [{ id: 'opaque', model: 'real-model', displayName: 'Visible', defaultReasoningEffort: 'nope', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '  Deeper  ' }, 'low', { reasoningEffort: 'not valid' }, { reasoningEffort: 'high' }] }, { model: 'hidden', hidden: true }] });
  assert.deepEqual(parsed.map(m => m.id), ['real-model']);
  assert.deepEqual(parsed[0].reasoningEfforts, [{ id: 'high', description: 'Deeper' }, { id: 'low' }]);
  assert.equal(parsed[0].defaultReasoningEffort, undefined);
  assert.deepEqual(cursorModels('\x1b[90mAvailable models\x1b[0m\n\nmodel-a - Model A (current, default)\nmodel-b - Model B\nTip: ignore - this').map(m => [m.id, m.isDefault]), [['model-a', true], ['model-b', false]]);
});

test('live protocol catalogs: pagination, independent quota failure, Cursor fallback, timeout and no inference', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-catalog-'));
  const f = await authLauncher(root, { status: 'ready' });
  try {
    const gpt = await inspectCatalog('codex', f.launcher, root);
    assert.deepEqual(gpt.models.map(m => m.id), ['gpt-fixture', 'gpt-fixture-2']); assert.equal(gpt.quota.windows[0].usedPercent, 23);
    assert.deepEqual(gpt.models[0].reasoningEfforts?.map(item => item.id), ['low', 'medium', 'high']); assert.equal(gpt.models[0].defaultReasoningEffort, 'medium');
    assert.deepEqual(gpt.models[1].reasoningEfforts?.map(item => item.id), ['low']);
    await f.write({ status: 'ready', quota: 'error' });
    const partial = await inspectCatalog('codex', f.launcher, root);
    assert.equal(partial.models.length, 2); assert.equal(partial.quota.windows.length, 0); assert.match(partial.quota.detail, /不代表额度为零/);
    const cursor = await inspectCatalog('cursor', f.launcher, root); assert.equal(cursor.models[0].id, 'cursor-fixture'); assert.match(cursor.quota.url, /cursor.com\/dashboard\/spending/);
    await f.write({ status: 'ready', catalog: 'error' });
    for (const provider of ['codex', 'cursor'] as const) { const result = await inspectCatalog(provider, f.launcher, root); assert(result.modelError); assert(!JSON.stringify(result).includes('DO_NOT_FORWARD')); }
    await f.write({ status: 'ready', catalog: 'hang' });
    assert((await inspectCatalog('cursor', f.launcher, root, undefined, 1000)).modelError);
    const calls = await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8'); assert(!calls.includes('turn/start')); assert(!calls.includes('session/new'));
  } finally { await cleanup(root); }
});

for (const provider of ['codex', 'cursor'] as const) test(provider + ': model propagation, preparation failures/retry/cancel, close/reopen and persistence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-lifecycle-'));
  const f = await authLauncher(root, { status: 'ready', turn: 'success' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths[provider] = f.launcher;
    const s = await wb.createSession(provider, root, offlineProjectId, 'work', undefined, 'chosen-model');
    await wb.send(s.id, 'work'); await until(() => s.status === 'idle');
    await wb.closeSession(s.id); assert(s.closedAt); assert.equal(s.messages.filter(m => m.role === 'assistant').length, 1);
    await assert.rejects(wb.send(s.id, 'closed'), /已关闭/);
    await wb.reopenSession(s.id); await wb.send(s.id, 'resume'); await until(() => s.status === 'idle');
    let calls = (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const selection = calls.filter(c => c.method === (provider === 'codex' ? 'thread/resume' : 'session/set_model'));
    assert(selection.length); assert(selection.every(c => (c.params.model || c.params.modelId) === 'chosen-model'));
    await f.write({ status: 'ready', turn: 'network' });
    const [d, same] = await Promise.all([wb.prepare(s.id), wb.prepare(s.id)]); assert.equal(d.id, same.id);
    await until(() => d.generation === 'error'); assert.match(d.generationError!, /网络连接中断/);
    assert.equal(d.generatedBody, undefined); assert.equal(s.status, 'idle');
    await wb.saveDraftSupplement(d.id, 'Human edits stay intact', 'https://github.com/owner/repo');
    const attempt = d.prepareSessionId;
    await f.write({ status: 'ready', turn: 'success' }); await wb.retryPreparation(d.id); await until(() => d.generation === 'ready');
    assert.notEqual(d.prepareSessionId, attempt); assert(d.generatedBody); assert.equal(d.supplement, 'Human edits stay intact'); assert.match(d.body, /已经达到的成果/);
    assert.equal(wb.session(d.prepareSessionId!).model, 'chosen-model');
    await f.write({ status: 'ready', turn: 'crash' }); await wb.retryPreparation(d.id); await until(() => d.generation === 'error'); assert.match(d.generationError!, /CLI 意外停止/);
    const canceledRetry = wb.retryPreparation(d.id); await wb.cancelPreparation(d.id); await canceledRetry;
    assert.equal(d.generation, 'canceled', 'cancel during retry setup must not start a later model task');
    await f.write({ status: 'ready', turn: 'hang' }); await wb.retryPreparation(d.id); const internal = wb.session(d.prepareSessionId!);
    await until(() => internal.status === 'running'); await wb.cancelPreparation(d.id); assert.equal(d.generation, 'canceled'); assert(internal.closedAt);
    // Stop a real running CLI, keep native identity and all past messages for reopening.
    const pending = wb.send(s.id, 'long running'); await until(() => s.status === 'running'); const native = s.nativeId;
    await wb.closeSession(s.id); await pending; assert.equal(s.nativeId, native); assert.equal(s.status, 'idle');
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init();
    assert.equal(reopened.sessions.find(x => x.id === s.id)?.model, 'chosen-model'); assert(reopened.sessions.find(x => x.id === s.id)?.closedAt);
    assert.equal(reopened.drafts[0].supplement, 'Human edits stay intact');
    assert(!JSON.stringify(reopened.sessions).includes('fake@example.com'));
  } finally { await wb.close(); await cleanup(root); }
});

test('closing while authentication is pending prevents CLI work; restart marks interrupted preparation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-close-pending-'));
  const f = await authLauncher(root, { status: 'ready', delay: 800, turn: 'success' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = f.launcher;
    const s = await wb.createSession('codex', root, offlineProjectId);
    const pending = wb.send(s.id, 'should never run'); const rejected = assert.rejects(pending, /已关闭/);
    await until(() => s.status === 'starting'); await wb.closeSession(s.id); await rejected;
    assert.equal(s.nativeId, undefined); assert.equal(s.messages.length, 0); assert.equal(s.status, 'idle');
    const d = await wb.prepare(s.id); d.generation = 'running'; await wb.store.save();
    const store = new Store(wb.store.root); await store.init(); assert.equal(store.drafts[0].generation, 'error'); assert.match(store.drafts[0].generationError!, /中断/);
    await wb.cancelPreparation(d.id);
  } finally { await wb.close(); await cleanup(root); }
});
