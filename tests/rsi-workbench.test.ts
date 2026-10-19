import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture(run: (workbench: Workbench, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-workbench-'));
  const workbench = new Workbench(path.join(root, 'store'), () => {}, () => {});
  try { await workbench.store.init(); grantTestWorkspace(workbench, root); await run(workbench, root); }
  finally { await workbench.close(); await fs.rm(root, { recursive: true, force: true }); }
}
test('workbench collects explicit requirements, model inferences, tool evidence and project results independently', async () => fixture(async (workbench, root) => {
  const session = await workbench.createSession('codex', root, offlineProjectId, 'work', undefined, 'fixture-model');
  session.messages.push({ id: randomUUID(), role: 'user', text: '开发集 F1 达到 0.9 才算完成', createdAt: new Date().toISOString() }, { id: randomUUID(), role: 'assistant', text: '我推测 F1 达到了 0.95，但尚未测量', createdAt: new Date().toISOString() });
  await workbench.store.event(session.id, { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'evaluate', exitCode: 0, aggregatedOutput: 'F1=0.71' } } });
  await workbench.createConclusion(offlineProjectId, '边界实验', '独立检查发现边界错误');
  await workbench.rsi.collect(offlineProjectId); const view = await workbench.rsi.view(offlineProjectId);
  assert(view.evidence.some(item => item.source === 'session' && item.assertion === 'explicit' && item.text.includes('0.9')));
  assert(view.evidence.some(item => item.assertion === 'inferred' && item.text.includes('0.95')));
  assert(view.evidence.some(item => item.source === 'execution' && item.text.includes('0.71')));
  assert(view.evidence.some(item => item.source === 'project' && item.text.includes('独立检查')));
}));
test('other project/session histories and unknown accounts do not enter the current assistant', async () => fixture(async (workbench, root) => {
  const profile = workbench.store.settings.workspaceSnapshot!.profile;
  profile.projects.push({ ...profile.projects[0], id: 'other-project', name: '其他项目' });
  const a = await workbench.createSession('codex', root, offlineProjectId), b = await workbench.createSession('cursor', root, 'other-project');
  a.messages.push({ id: randomUUID(), role: 'user', text: 'ALICE_PROJECT_A', createdAt: new Date().toISOString() });
  b.messages.push({ id: randomUUID(), role: 'user', text: 'PRIVATE_PROJECT_B', createdAt: new Date().toISOString() });
  await workbench.rsi.collect(offlineProjectId); assert(!JSON.stringify(await workbench.rsi.view(offlineProjectId)).includes('PRIVATE_PROJECT_B'));
  profile.username = 'bob'; await workbench.rsi.collect(offlineProjectId);
  assert(!JSON.stringify(await workbench.rsi.view(offlineProjectId)).includes('ALICE_PROJECT_A'));
  profile.projects = []; await assert.rejects(workbench.rsi.collect(offlineProjectId), /项目/);
}));
test('default-on shadow analysis stays asynchronous without changing the conversation or fabricating feedback', async () => fixture(async (workbench, root) => {
  const session = await workbench.createSession('codex', root, offlineProjectId, 'work');
  session.resolvedModel = 'fixture-model'; // CLI has resolved the inherited default for the completed turn.
  assert.equal((await workbench.rsi.view(offlineProjectId)).config.enabled, true);
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  workbench.rsi.runText = async (_s, prompt) => { await waiting; const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]); return JSON.stringify({ state: { progress: '等待测试', blockers: [], unknowns: ['F1'], evidenceIds: [data.evidence[0].id] }, suggestions: [{ title: '验证指标', action: '独立评估 F1', reason: '只有模型自述', evidenceIds: [data.evidence[0].id], conditions: [], uncertainty: '效果未知', priority: 0.8 }] }); };
  session.messages.push({ id: randomUUID(), role: 'assistant', text: '实验成功', createdAt: new Date().toISOString() });
  const before = structuredClone(session), inputs = structuredClone(workbench.store.inputs), results = structuredClone(workbench.store.conclusions);
  await workbench.rsi.completed(offlineProjectId);
  for (let index = 0; index < 30 && !workbench.rsi.busy; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(session.status, 'idle'); assert.equal(workbench.rsi.busy, true);
  release(); await workbench.rsi.settled(); const view = await workbench.rsi.view(offlineProjectId);
  assert.equal(view.events.length, 0); assert.equal(view.suggestions.length, 1);
  assert.match(view.runs.at(-1)!.decision!, /仅作后台记录/);
  assert.deepEqual(session, before); assert.deepEqual(workbench.store.inputs, inputs); assert.deepEqual(workbench.store.conclusions, results);
  const saved = JSON.parse(await fs.readFile(path.join(workbench.store.root, 'rsi-v2.json'), 'utf8'));
  assert.equal(saved.projects[view.scope.key].suggestions.length, 1);
}));
