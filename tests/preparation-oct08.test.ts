import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import type { Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error test-only JavaScript protocol fixture
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function finish(draft: Draft) {
  const until = Date.now() + 20000;
  while (draft.generation === 'running') {
    if (Date.now() > until) throw new Error('preparation timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(draft.generation, 'ready', draft.generationError || 'preparation must finish');
}

test('October 8 categories and per-category directions survive generation and edited results can be reorganized', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-restore-oct08-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', preparationResult: { artifacts: [
      { category: 'exploration', title: '边界复测记录', body: '普通样例通过，长尾仍需复测。' },
      { category: 'todo', title: '补充长尾复测', body: '对公开长尾样例复测并保留证据。' },
    ] } });
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId);
    session.messages.push({ id: 'first', role: 'user', text: '普通样例验证已通过，还需补充长尾测试并记录边界。', createdAt: new Date().toISOString() });
    // A previous project-profile record must not reserve or lock this project.
    wb.store.drafts.push({ id: 'old-profile', sessionId: 'old-session', binding: structuredClone(session.binding),
      organizationFormat: 'project-profile-v1', organizationEdited: true, generation: 'ready',
      title: '旧项目概览', body: '已由人修改的旧版内容', files: [], inputDir: '', outputPath: '', createdAt: '' } as Draft);
    const directions = { exploration: '强调边界与未验证条件', todo: '逐条保留独立的复测动作', capability: '未选择的内容不要带入' };
    const draft = await wb.prepare(session.id, [], ['exploration', 'todo'], 'full', directions);
    await finish(draft);
    assert.equal(draft.organizationFormat, undefined);
    assert.deepEqual(draft.resultRules!.categories, ['exploration', 'todo']);
    assert.deepEqual(draft.preparationDirections, { exploration: directions.exploration, todo: directions.todo });
    assert.deepEqual(draft.artifacts!.map(item => item.category), ['exploration', 'todo']);
    const prompt = wb.session(draft.prepareSessionId!).messages.find(item => item.role === 'user')!.text;
    assert(prompt.includes(directions.exploration) && prompt.includes(directions.todo));
    assert(!prompt.includes(directions.capability));
    assert(!prompt.includes('每个项目只整理一条'));
    assert.throws(() => wb.prepare(session.id, [], ['project_goal']), /整理方面仅支持/);
    assert.throws(() => wb.prepare(session.id, [], ['project_material']), /整理方面仅支持/);

    await wb.editDraftArtifact(draft.id, draft.artifacts![0].id, '人工修订边界', '已核对普通样例，长尾仍待验证。');
    session.messages.push({ id: 'later', role: 'user', text: '增加了新的长尾样例，还需继续验证。', createdAt: new Date().toISOString() });
    await fixture.write({ status: 'ready', turn: 'success', preparationResult: { artifacts: [
      { category: 'todo', title: '验证新增长尾样例', body: '保留独立输入及对应的复测日志。' },
    ] } });
    const next = await wb.reorganizePreparation(draft.id, 'incremental', ['todo'], { todo: '只记录本轮新增事项' });
    await finish(next);
    assert.equal(next.organizationFormat, undefined);
    assert.deepEqual(next.preparationDirections, { todo: '只记录本轮新增事项' });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(next.inputDir, 'conversation.json'), 'utf8')).map((item: { id: string }) => item.id), ['later']);
    assert.equal(draft.artifacts![0].body, '已核对普通样例，长尾仍待验证。');
    const full = await wb.reorganizePreparation(next.id, 'full', ['todo']);
    await finish(full);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(full.inputDir, 'conversation.json'), 'utf8')).map((item: { id: string }) => item.id), ['first', 'later']);
    const legacy = wb.store.drafts.find(item => item.id === 'old-profile')!;
    legacy.sessionId = session.id;
    const migrated = await wb.reorganizePreparation(legacy.id, 'full', ['todo'], { todo: '从旧概览重新提取独立待办' });
    await finish(migrated);
    assert.equal(migrated.organizationFormat, undefined);
    assert.deepEqual(migrated.resultRules!.categories, ['todo']);
    assert.deepEqual(migrated.preparationDirections, { todo: '从旧概览重新提取独立待办' });
    assert.equal(legacy.body, '已由人修改的旧版内容');
  } finally {
    await wb.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
