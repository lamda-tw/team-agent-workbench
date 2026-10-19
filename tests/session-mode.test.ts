import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { planExecuteSchema, planReviseSchema, planSteps } from '../src/shared/session-mode';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
const until = async (check: () => boolean | Promise<boolean>) => { const end = Date.now() + 15000; while (!await check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 20)); } };

for (const provider of ['codex', 'cursor'] as const) test(provider + ': native planning mode preserves thread, draft, permissions and active reply', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-mode-'));
  const fixture = await authLauncher(root, { status: 'ready', turn: 'success', turnDelay: 1500, permissionRuntime: true });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths[provider] = fixture.launcher;
    const session = await wb.createSession(provider, root, offlineProjectId, 'work', undefined, 'selected-model', 'full');
    const first = wb.send(session.id, 'Existing work'); await until(() => session.status === 'running');
    const native = session.nativeId;
    const draft = { text: '尚未发送', sourceIds: [], answers: {}, capabilities: [] }; wb.store.inputs[session.id] = draft;
    await wb.changeMode(session.id, 'plan');
    assert.equal(session.status, 'running'); assert.equal(session.settingsPending, true); assert.equal(session.permissionMode, 'full'); assert.equal(session.nativeId, native);
    assert.deepEqual(wb.store.inputs[session.id], draft);
    await first; await until(() => session.status === 'idle');
    await fixture.write({ status: 'ready', turn: 'success', proposedPlan: '# Plan\n\n1. Review\n2. Build', permissionRuntime: true });
    if (provider === 'codex') {
      await wb.send(session.id, 'Make the plan'); await until(() => session.status === 'idle' && !!session.proposedPlan?.ready);
      assert.equal(session.proposedPlan?.text, '# Plan\n\n1. Review\n2. Build');
      assert.equal(session.messages.find(m => m.id === session.proposedPlan?.messageId)?.text, session.proposedPlan?.text, 'completed plan replaces partial deltas');
      const planned = (await calls()).find(c => c.method === 'turn/start' && c.params.collaborationMode?.mode === 'plan');
      assert.equal(planned.params.collaborationMode.settings.model, 'selected-model');
      assert.equal(planned.params.collaborationMode.settings.developer_instructions, null);
      await assert.rejects(wb.executePlan(session.id, 'stale-plan'), /不能执行/);
      const previousPlanId = session.proposedPlan!.messageId;
      await fixture.write({ status: 'ready', turn: 'success', proposedPlan: '# Revised plan', permissionRuntime: true });
      assert.equal(await wb.revisePlan(session.id, previousPlanId, 'Review first, then build'), true);
      await until(() => session.status === 'idle' && session.proposedPlan?.text === '# Revised plan');
      assert.notEqual(session.proposedPlan?.messageId, previousPlanId);
      await assert.rejects(wb.executePlan(session.id, previousPlanId), /不能执行/);
      assert.equal(await wb.executePlan(session.id, session.proposedPlan!.messageId), true);
      await until(() => session.status === 'idle');
      assert.equal(session.mode, 'default'); assert.equal(session.proposedPlan?.accepted, true);
      await assert.rejects(wb.executePlan(session.id, session.proposedPlan!.messageId), /不能执行/);
    } else {
      const turn = wb.send(session.id, 'Make the plan'); await until(() => session.status === 'approval');
      assert.equal(session.approvals[0].method, 'cursor/create_plan');
      await wb.answer(session.id, session.approvals[0].id, 'accept'); await turn; await until(() => session.status === 'idle');
      assert.equal(session.mode, 'default');
      assert((await calls()).some(c => c.method === 'session/set_mode' && c.params.modeId === 'plan'));
      await wb.changeMode(session.id, 'ask'); assert.equal(session.mode, 'ask');
    }
    assert.equal(session.nativeId, native); assert.deepEqual(wb.store.inputs[session.id], draft); assert.equal(session.permissionMode, 'full');
    await wb.store.save(); const store = new Store(wb.store.root); await store.init(); assert.equal(store.sessions.find(s => s.id === session.id)?.mode, session.mode);
    await wb.closeSession(session.id); await assert.rejects(wb.changeMode(session.id, 'plan'), /不支持/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('unsupported Plan mode is reported without changing conversation state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-mode-old-')); const fixture = await authLauncher(root, { status: 'ready', noPlan: true });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId);
    await assert.rejects(wb.changeMode(session.id, 'plan'), /更新 CLI/); assert.equal(session.mode, undefined); assert.equal(session.messages.length, 0);
    await assert.rejects(wb.changeMode(session.id, 'ask'), /更新 CLI|不支持/);
    await fixture.write({ status: 'ready', noPlan: true, turn: 'success' });
    await wb.changeMode(session.id, 'default'); assert.equal(await wb.send(session.id, 'Ordinary work still works'), true); await until(() => session.status === 'idle');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('plan actions accept Codex item ids and still require a session uuid', () => {
  const sessionId = '6f0c2a1e-7b4d-4c3a-9e1f-2a8b5d6c7e90';
  assert.equal(planExecuteSchema.parse({ id: sessionId, messageId: 'plan-4821' }).messageId, 'plan-4821');
  assert.equal(planReviseSchema.parse({ id: sessionId, messageId: 'plan-4821', text: '  先核对接口  ' }).text, '先核对接口');
  assert.throws(() => planExecuteSchema.parse({ id: sessionId, messageId: '' }));
  assert.throws(() => planReviseSchema.parse({ id: 'plan-4821', messageId: 'plan-4821', text: '修订' }));
});
test('native plan progress maps both providers without claiming unfinished work is complete', () => {
  assert.deepEqual(planSteps([{ step: 'A', status: 'inProgress' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'cancelled' }, { step: 'D', status: 'new' }, {}]).map(s => s.status), ['inProgress', 'inProgress', 'cancelled', 'pending']);
});
