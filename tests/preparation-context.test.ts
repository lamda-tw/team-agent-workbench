import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPreparationContext, cachedPreparationBrief, personalContextResults, preparationContextLimit, type ContextResult } from '../src/core/preparation-context';
import { preparationCategoriesSchema, preparationRuleSnapshot } from '../src/shared/result-rules';
import { projectBriefMarkdown } from '../src/shared/project-brief';
import { preparationPrompt } from '../src/core/preparation-prompt';
import { applyPreparation } from '../src/core/preparation';
import { Workbench } from '../src/core/workbench';
import type { Draft, Project, ProjectConclusion } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Test-only protocol implementation, no real models.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const project: Project = { id: 'p', name: '格式转换', groupName: 'competition', remoteRoot: '/p', uploadPath: '/p/submissions/a', historyPath: '/p/trajectories/a' };
const entry = (id: string, overrides: Partial<ContextResult> = {}): ContextResult => ({ projectId: project.id, scope: 'personal', id, title: '量化误差分析', category: 'exploration', version: 1, state: 'current', content: '误差受转换方式影响，尚未覆盖长尾样本。', updatedAt: new Date().toISOString(), ...overrides });
async function finish(draft: Draft) {
  const end = Date.now() + 18000;
  while (draft.generation === 'running') { if (Date.now() > end) throw new Error('模拟整理超时'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('user selections default to three aspects, reject unavailable or repeated choices, and constrain extraction', () => {
  assert.deepEqual(preparationRuleSnapshot().categories, ['capability', 'exploration', 'todo']);
  assert.deepEqual(preparationRuleSnapshot(['todo']).categories, ['todo']);
  for (const categories of [[], ['project_goal'], ['project_material'], ['finding'], ['todo', 'todo']]) assert.equal(preparationCategoriesSchema.safeParse(categories).success, false);
  const draft = { binding: { project }, inputDir: '/snapshot', files: [], resultRules: preparationRuleSnapshot(['todo']), preparationEvidenceIds: ['message:m'], snapshot: { messageCount: 1, conversationHash: 'hash' } } as unknown as Draft;
  const output = (category: string) => JSON.stringify({ artifacts: [{ category, topic: '长尾验证', title: '补充长尾验证', body: '补充样例覆盖后再验证误差。', origin: 'project', evidenceIds: ['message:m'] }], sourceReview: { status: 'complete', inputCount: 1, conversationHash: 'hash' } });
  assert.throws(() => applyPreparation(draft, output('capability')), /未选择/);
  assert.throws(() => applyPreparation(draft, output('project_goal')), /未选择/);
  applyPreparation(draft, output('todo')); assert.equal(draft.artifacts![0].category, 'todo');
  const prompt = preparationPrompt(draft, []);
  assert(prompt.includes('本次用户选择的整理方面：["todo"]'));
  assert(prompt.includes('独立')); assert(prompt.includes('不擅自完成')); assert(prompt.includes('本项目 → 所选类别 → 具体对象或问题'));
  assert(!prompt.includes('分类组合'));
});

test('related reference context stays within 6000 serialized characters and eight results, excludes other projects and unrelated text', () => {
  const candidates = Array.from({ length: 30 }, (_, n) => entry('id-' + n, { content: '量化误差边界'.repeat(500), scope: n % 2 ? 'team' : 'personal' }));
  candidates.unshift(entry('foreign', { projectId: 'another-project' }));
  candidates.push(entry('unrelated', { title: '账户登录页面', content: '登录界面的布局调整。' }));
  const before = structuredClone(candidates);
  const context = buildPreparationContext(project, '量化误差分析', candidates, { background: '背景'.repeat(6000), objectives: '提升质量'.repeat(6000), acceptance: '误差阈值'.repeat(6000), constraints: '禁止外部数据'.repeat(6000) });
  assert(context.results.length > 0 && context.results.length <= 8);
  assert(JSON.stringify(context).length <= preparationContextLimit);
  assert(context.results.every(item => item.id !== 'foreign' && item.id !== 'unrelated' && item.excerpt));
  assert(context.results.every(item => item.content.length <= 700));
  assert.equal(context.brief.objectives!.length, 400); assert.equal(context.brief.background!.length, 150);
  assert.deepEqual(candidates, before);
  assert.equal(buildPreparationContext(project, 'ssh 登录验证', [entry('only')]).results.length, 0);
});

test('archived, previous and completed evidence remains explicit and cannot overwrite a current personal ability', () => {
  const conclusion = { id: randomUUID(), projectId: 'p', title: '量化误差分析', category: 'capability', content: '当前误差可统计。', version: 3, updatedAt: '', archived: false, sources: [], versions: [{ version: 2, title: '量化误差分析', category: 'capability', content: '旧版只统计均值。', updatedAt: '', sources: [] }] } as ProjectConclusion;
  const todo: ProjectConclusion = { ...conclusion, id: randomUUID(), category: 'todo', resultStatus: 'completed', versions: [] };
  const candidates = personalContextResults([conclusion, todo, { ...conclusion, id: 'deleted', deletedAt: 'now' }]);
  assert(!candidates.some(item => item.id === 'deleted'));
  assert(candidates.some(item => item.version === 2 && item.state === 'history'));
  assert(candidates.some(item => item.id === todo.id && item.resultStatus === 'completed'));
  const draft = { binding: { project }, files: [], inputDir: '/snapshot', resultRules: preparationRuleSnapshot(['capability']), preparationEvidenceIds: ['message:m', 'result:team:original:1'], snapshot: { messageCount: 1, conversationHash: 'hash' } } as unknown as Draft;
  const result = { category: 'capability', topic: '量化误差分析', title: '支持误差统计', body: '统计均值和长尾误差，仅覆盖指定样本。', origin: 'project', updateId: conclusion.id, evidenceIds: ['message:m'] };
  const output = () => JSON.stringify({ artifacts: [result], sourceReview: { status: 'complete', inputCount: 1, conversationHash: 'hash' } });
  for (const candidate of [{ scope: 'team', state: 'current' }, { scope: 'personal', state: 'history' }] as const) {
    draft.preparationExistingResults = [{ id: conclusion.id, title: conclusion.title, category: 'capability', version: 3, ...candidate }];
    assert.throws(() => applyPreparation(draft, output()), /当前个人能力版本/);
  }
  draft.preparationExistingResults = [{ id: conclusion.id, title: conclusion.title, category: 'capability', version: 3, scope: 'personal', state: 'current' }];
  applyPreparation(draft, output()); assert.equal(draft.artifacts![0].updateTarget!.version, 3);
  result.evidenceIds = ['result:team:original:1']; assert.throws(() => applyPreparation(draft, output()), /本次对话或材料/);
});

test('failed retry reuses the frozen conversation, project brief and historical references while new work continues', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-context-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', preparationRaw: 'malformed result' });
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId);
    session.messages.push({ id: 'original', role: 'user', text: '量化误差分析需要补充长尾验证', createdAt: new Date().toISOString() });
    const conclusion = await wb.createConclusion(offlineProjectId, '量化误差分析', '上一轮只覆盖均值误差。', 'exploration');
    const brief = { background: '比赛格式转换', objectives: '减小量化误差', acceptance: '覆盖长尾样例', scope: '格式转换', constraints: '只用公开样例', deliverables: '', resources: '', collaboration: '' };
    const briefFile = path.join(root, '项目说明.md'); await fs.writeFile(briefFile, projectBriefMarkdown('格式转换', brief, 'alice', 'now'));
    await wb.attachLocal(session.id, [briefFile]);
    // Simulate the automatic protected project reference, rather than a user-selected document.
    session.sources.at(-1)!.sourcePath = session.binding!.project.remoteRoot + '/项目说明.md';
    const draft = await wb.prepare(session.id, [], ['todo'], 'full'); await finish(draft);
    assert.equal(draft.generation, 'error');
    const file = path.join(draft.inputDir, 'preparation-context.json'), frozen = await fs.readFile(file, 'utf8'), context = JSON.parse(frozen);
    assert.equal(context.brief.objectives, brief.objectives); assert(context.results.some((item: ContextResult) => item.id === conclusion.id));
    const index = JSON.parse(await fs.readFile(path.join(draft.inputDir, 'source-index.json'), 'utf8'));
    assert.equal(index.files[0].contextOnly, 'project-brief'); assert.deepEqual(index.files[0].readPaths, []);
    const conversation = await fs.readFile(path.join(draft.inputDir, 'conversation.json'), 'utf8');
    session.messages.push({ id: 'later', role: 'user', text: '后续改用其他方案', createdAt: new Date().toISOString() });
    await wb.saveConclusion(conclusion.id, conclusion.title, '后续探索修改了原观点。');
    await fs.writeFile(briefFile, '新的项目目标');
    assert.throws(() => wb.prepare(session.id, [], ['project_material']), /整理方面仅支持/);
    assert.throws(() => wb.reorganizePreparation(draft.id, 'full', ['project_goal']), /整理方面仅支持/);
    await fixture.write({ status: 'ready', turn: 'success', preparationResult: { artifacts: [{ category: 'todo', title: '补充长尾验证', body: '补充公开样例，核对长尾误差。' }] } });
    await wb.retryPreparation(draft.id); await finish(draft);
    assert.equal(draft.generation, 'ready', draft.generationError || '应完成模拟整理'); assert.deepEqual(draft.resultRules!.categories, ['todo']);
    assert.equal(await fs.readFile(file, 'utf8'), frozen); assert.equal(await fs.readFile(path.join(draft.inputDir, 'conversation.json'), 'utf8'), conversation);
    const attempt = wb.session(draft.prepareSessionId!);
    assert(attempt.messages.some(item => item.role === 'user' && item.text.includes('每个项目只整理一条') && item.text.includes('上一轮只覆盖均值误差。') && !item.text.includes('后续探索修改了原观点。')));
    assert.equal(draft.organizationFormat,'project-profile-v1');
    assert.deepEqual(cachedPreparationBrief(projectBriefMarkdown('转换', brief, 'alice', 'now')).objectives, brief.objectives);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
