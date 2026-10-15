import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { applyPreparation, contributionDirectory, discoverDestinations, preparationFieldContract, preparationWritingGuide } from '../src/core/preparation';
import { contributionCategories, contributionCategoryFields, contributionTitle } from '../src/shared/content';
import { applyContentMerge } from '../src/core/content-merge';
import type { Draft, RemoteBinding } from '../src/shared/types';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { diskPath } from '../src/core/local-space';
import { preparationSnapshot } from '../src/core/preparation-snapshot';
import { randomUUID } from 'node:crypto';
// @ts-expect-error JS protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';
// @ts-expect-error JS SFTP fixture.
import { teamServer } from './fixtures/team-server.mjs';
async function until(fn: () => boolean) { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw new Error('test timed out'); await new Promise(r => setTimeout(r, 20)); } }
const binding: RemoteBinding = { connectionId: 'c', host: 'local', port: 22, username: 'alice', fingerprint: 'f', project: { id: 'p', name: '项目', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } };
const result = { title: '更新说明', body: '已完成的验证与限制。', repoUrl: 'https://github.com/owner/repo', destinationId: 'default' };

test('new summaries use at most three category fields without truncating verification limits or old results', () => {
  for (const category of contributionCategories) {
    const contract = preparationFieldContract([category]); assert.deepEqual(Object.keys(contract), [category]);
    assert.equal(contract[category].length, 3);
    assert(contract[category].every((field: string) => contributionCategoryFields[category].includes(field)));
  }
  const draft = { id: 'concise', binding, files: [], sessionId: 's', title: '', body: '', inputDir: '', outputPath: '', createdAt: '' } as Draft;
  applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'experiment_result', title: 'v29 Q-head 候选', fields: {
    change: '在 v28 上改为 16 个 Q heads，K、V、Linear 不变。',
    result: '静态编译通过；无 PyTorch，尚未运行 self_check，未证明精度和耗时收益。',
    nextSteps: '在比赛环境比较 5 个 Attention 样本的 MSE、最差退化和耗时。'
  } }] }));
  assert.equal(draft.body.match(/^## /gm)?.length, 3);
  assert.match(draft.body, /未证明精度和耗时收益/);
  applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'experiment_result', title: '旧版验证', fields: { result: '静态通过', limitations: '未运行官方 self_check', evidence: '编译记录' } }] }));
  assert.match(draft.body, /未运行官方 self_check/); assert.match(draft.body, /编译记录/);
});

test('result names stay in the draft until personal save and never rewrite submitted titles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-rename-result-')), fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId), draft = await wb.prepare(session.id);
    await until(() => draft.generation === 'ready');
    assert(wb.session(draft.prepareSessionId!).messages.some(message => message.role === 'user' && message.text.includes(preparationWritingGuide)));
    const artifact = draft.artifacts![0], body = artifact.body, selected = artifact.selected;
    await wb.renameDraftResult(draft.id, '人工修改的短名称', artifact.id);
    assert.match(artifact.title, /人工修改的短名称$/); assert.equal(draft.title, artifact.title);
    assert.equal(artifact.body, body); assert.equal(artifact.selected, selected);
    assert.equal(wb.conclusions(offlineProjectId).length, 0);
    await wb.saveDraftPersonal(draft.id, [artifact.id]);
    assert(wb.conclusions(offlineProjectId).some(item => item.title === contributionTitle('finding','人工修改的短名称')));
    assert.throws(() => wb.renameDraftResult(draft.id, '  ', artifact.id), /名称/);
    await assert.rejects(wb.renameDraftResult(draft.id, '名字', 'missing'), /不存在/);
    const originalTitle = artifact.title; draft.submitted = artifact.submitted = 'frozen-transfer';
    await wb.renameDraftResult(draft.id, '我的本地名称', artifact.id);
    assert.equal(artifact.title, originalTitle); assert.equal(artifact.titleAlias, '我的本地名称'); assert.equal(draft.titleAlias, '我的本地名称');
    const restored = new Store(wb.store.root); await restored.init();
    assert.equal(restored.drafts[0].artifacts![0].titleAlias, '我的本地名称');
    draft.generation = 'running'; await assert.rejects(wb.renameDraftResult(draft.id, '不能修改', artifact.id), /等待整理完成/); draft.generation = 'ready';
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('semantic content merge preserves consensus, conflicts, evidence and source traceability', () => {
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  const draft = { title: '', body: '', mergeSources: [
    { id: first, revision: 2, title: '实验结论', author: 'alice', updatedAt: '2026-09-20T01:00:00.000Z' },
    { id: second, revision: 1, title: '风险复核', author: 'bob', updatedAt: '2026-09-20T02:00:00.000Z' }
  ] } as Draft;
  applyContentMerge(draft, JSON.stringify({
    title: '项目统一结论', overview: '当前证据支持灰度推进。', consensus: ['两份材料都支持补充验证。'],
    conflicts: [{ topic: '上线范围', positions: [{ sourceIds: [first], statement: '可以全量上线。' }, { sourceIds: [second], statement: '应先灰度。' }], requiresDecision: true }],
    evidence: [{ claim: '覆盖率仍需补齐。', sourceIds: [second] }], scope: '当前数据集', unresolved: ['确认灰度比例。']
  }));
  assert.equal(draft.title, '【综合整理】 项目统一结论');
  assert.match(draft.body, /综合分析/); assert.match(draft.body, /共同认识/); assert.match(draft.body, /差异与冲突/); assert.match(draft.body, /仍需组管理员确认/);
  assert.match(draft.body, /风险复核（bob · v1）/); assert.match(draft.resultSourceDetails!, /来源记录/); assert.doesNotMatch(draft.body, /11111111-1111|22222222-2222/);
  assert.throws(() => applyContentMerge(draft, JSON.stringify({ title: '错误引用', overview: '无效', consensus: [], conflicts: [], evidence: [{ claim: '伪造', sourceIds: ['33333333-3333-4333-8333-333333333333'] }], unresolved: [] })), /未选择的来源/);
});

test('structured results classify independent artifacts, keep only category fields and use fixed paths', () => {
  const d = { id: 'draft', binding, files: [], sessionId: 's', title: '', inputDir: '', outputPath: '', createdAt: '', body: '', supplement: '人补充的说明', repoUrlOverride: 'https://github.com/human/repo', preparationVersion: 3 } as Draft;
  applyPreparation(d, '```json\n' + JSON.stringify({ artifacts: [
    { category: 'experiment_result', title: '阈值实验', fields: { objective: '验证阈值', result: 'F1 提升 1.2', unknown: '不得保留' }, repoUrl: 'https://github.com/owner/repo' },
    { category: 'baseline_change_proposal', title: '调整验收阈值', fields: { baselineItem: 'F1 下限', proposedValue: '0.91', rationale: '新数据分布' } }
  ] }) + '\n```');
  assert.equal(d.artifacts?.length, 2); assert.equal(d.artifacts?.[0].target, '/p/submissions/alice/experiments'); assert.equal(d.artifacts?.[1].target, '/p/submissions/alice/baseline-change-proposals');
  assert.equal(d.artifacts?.[0].title, '【项目经验】 阈值实验'); assert.equal(d.artifacts?.[1].title, '【改进建议】 调整验收阈值');
  assert.equal(d.artifacts?.[0].fields.unknown, undefined); assert.match(d.artifacts?.[0].body || '', /F1 提升/); assert.equal(d.supplement, '人补充的说明'); assert.equal(d.repoUrlOverride, 'https://github.com/human/repo');
  applyPreparation(d, JSON.stringify({ ...result, repoUrl: 'https://github.com/owner/repo/pull/123' })); assert.equal(d.repoUrl, ''); assert.equal(d.target, '/p/submissions/alice/findings');
  assert.throws(() => applyPreparation(d, 'A partial or malformed answer'), /格式不完整/);
  for (const p of ['/outside', '/p/../other', '/p/trajectories', '/p/submissions/bob', '/p/.workbench']) assert.throws(() => contributionDirectory(binding, p));
});

test('structured results reject categories that the user did not request', () => {
  const d = { id: 'selected-categories', binding, files: [], sessionId: 's', title: '', inputDir: '', outputPath: '', createdAt: '', body: '', preparationVersion: 3, requestedCategories: ['finding'] } as Draft;
  applyPreparation(d, JSON.stringify({ artifacts: [{ category: 'finding', title: '覆盖率结论', fields: { statement: '覆盖率需要补齐。' } }] }));
  assert.equal(d.artifacts?.[0].category, 'finding');
  assert.throws(() => applyPreparation(d, JSON.stringify({ artifacts: [{ category: 'issue', title: '额外风险', fields: { problem: '不应生成' } }] })), /未选择的“问题与风险”/);
});

test('reorganization creates preserved incremental or full tasks from an exact message boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-scope-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId);
    session.messages.push(
      { id: 'before-user', role: 'user', text: '第一阶段问题', createdAt: '2026-09-20T01:00:00.000Z' },
      { id: 'before-answer', role: 'assistant', text: '第一阶段结论', createdAt: '2026-09-20T01:01:00.000Z' }
    );
    const original = await wb.prepare(session.id); await until(() => original.generation === 'ready');
    session.messages.push(
      { id: 'after-user', role: 'user', text: '第二阶段新增问题', createdAt: '2026-09-20T02:00:00.000Z' },
      { id: 'after-answer', role: 'assistant', text: '第二阶段新增结论', createdAt: '2026-09-20T02:01:00.000Z' }
    );
    const incremental = await wb.reorganizePreparation(original.id, 'incremental');
    assert.notEqual(incremental.id, original.id); assert.equal(incremental.baseDraftId, original.id); assert.equal(incremental.preparationScope, 'incremental');
    const incrementalConversation = JSON.parse(await fs.readFile(path.join(incremental.inputDir, 'conversation.json'), 'utf8'));
    assert.deepEqual(incrementalConversation.map((message: { id: string }) => message.id), ['after-user', 'after-answer']);
    assert.equal(incremental.snapshot?.messageCount, 2); assert.equal(incremental.snapshot?.totalMessageCount, 4);
    await until(() => incremental.generation === 'ready');
    await assert.rejects(wb.reorganizePreparation(incremental.id, 'incremental'), /没有新增消息/);
    const full = await wb.reorganizePreparation(incremental.id, 'full');
    const fullConversation = JSON.parse(await fs.readFile(path.join(full.inputDir, 'conversation.json'), 'utf8'));
    assert.deepEqual(fullConversation.map((message: { id: string }) => message.id), ['before-user', 'before-answer', 'after-user', 'after-answer']);
    assert.equal(full.preparationScope, 'full'); assert.equal(full.snapshot?.messageCount, 4); assert.equal(wb.store.drafts.length, 3);
    await until(() => full.generation === 'ready');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('legacy category drafts on local storage retain upload, immutable packages, teammate visibility, merges and permission checks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-local-')), share = path.join(root, 'share'); await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {}), wb = new Workbench(path.join(root, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(root, 'bob'), () => {}, () => {});
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', turnDelay: 500 });
  try {
    await admin.connect({ mode: 'local', localRoot: share, root: '/srv/teamspace', host: 'local', port: 22, username: 'admin', fingerprint: '' }, 'admin-password', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'prepare' });
    for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: 'member-password', groups: ['local_prepare'], contentAdminGroups: username === 'alice' ? ['local_prepare'] : [] });
    const profile = (username: string) => memberProfile(admin.snapshot.profile!, admin.snapshot.state!, username, 'local_prepare');
    await wb.store.init(); wb.store.settings.providerPaths.codex = fixture.launcher;
    await wb.configureWorkspace(profile('alice'), 'member-password', root, async () => false);
    const p = await wb.createProject('整理成果测试'), dir = p.remoteRoot + '/方案说明';
    const diskDir = await diskPath(share, dir, true); await fs.mkdir(diskDir); await fs.writeFile(path.join(diskDir, 'README.md'), '此目录接收设计与方案修改说明。');
    const candidates = await discoverDestinations(wb.remote, wb.remote.binding(p.id), () => true);
    const selected = candidates.destinations.find(x => x.path === dir)!; assert(selected); assert.match(selected.description, /设计与方案/);
    assert(!candidates.destinations.some(x => x.path.includes('trajectories')));
    await fixture.write({ status: 'ready', turn: 'success', turnDelay: 800, preparationResult: { ...result, destinationId: selected.id } });
    const s = await wb.createSession('codex', root, p.id); await wb.renameSession(s.id, '覆盖率验证会话'); assert.equal(s.title, '覆盖率验证会话');
    await wb.saveHandoff(s.id, '# 已完成\nhttps://github.com/owner/repo\n材料原始内容');
    // A saved category-format draft from the earlier release must still finish,
    // upload and merge without being converted to the new one-project profile.
    const legacyId=randomUUID(),legacyBase=path.join(wb.store.root,'drafts',legacyId),legacyInput=path.join(legacyBase,'input');
    const frozen=await preparationSnapshot(s,legacyInput);
    wb.store.drafts.push({id:legacyId,sessionId:s.id,sourceSessionTitle:s.title,title:'待恢复的旧版分类整理',body:'',files:frozen.files,snapshot:frozen.snapshot,binding:structuredClone(s.binding),inputDir:legacyInput,outputPath:path.join(legacyBase,'draft.md'),createdAt:new Date().toISOString(),generation:'error',preparationVersion:3,resultRules:{contract:4,categories:['capability','exploration','todo']}});
    await wb.store.save();
    const [d, same] = await Promise.all([wb.prepare(s.id), wb.prepare(s.id)]); assert.equal(d.id, same.id);
    assert.equal(d.id,legacyId);await wb.retryPreparation(d.id);
    await wb.saveDraftSupplement(d.id, '人工补充：下轮补充边界用例。', '');
    await assert.rejects(wb.submitDraft(d.id));
    await until(() => d.generation === 'ready'); assert.equal(d.target, p.uploadPath + '/explorations'); assert.equal(wb.store.transfers.length, 0); assert(d.generationStartedAt); assert(d.generationFinishedAt);
    assert.equal(wb.conclusions(p.id).length, 0, 'preparation remains a draft until the user explicitly saves it');
    assert.equal((await wb.prepare(s.id)).id, d.id, 'ready contribution opens the same panel');
    await assert.rejects(wb.submitDraft(d.id, p.remoteRoot + '/trajectories/alice'), /不能在提交时改变/);
    // Refresh from the latest handoff only when explicitly regenerating completed work.
    await wb.saveHandoff(s.id, '# 新材料\n用户继续推进后的交接');
    await wb.retryPreparation(d.id); await until(() => d.generation === 'ready');
    const index = JSON.parse(await fs.readFile(path.join(d.inputDir, 'source-index.json'), 'utf8'));
    assert.match(await fs.readFile(index.handoff.localPath, 'utf8'), /继续推进/);
    assert.match(d.supplement!, /人工补充/);
    await fixture.write({ status: 'ready', turn: 'success', preparationResult: { artifacts: [
      { category: 'finding', title: '方向性结论', fields: { statement: '建议先验证数据覆盖率。', evidence: '当前材料显示收益尚未验证。' }, repoUrl: '' },
      { category: 'issue', title: '覆盖率风险', fields: { problem: '数据覆盖不足', impact: '收益判断可能失真' } }
    ] } });
    await wb.retryPreparation(d.id); await until(() => d.generation === 'ready'); assert.equal(d.repoUrl, ''); assert.equal(d.artifacts?.length, 2);
    assert.equal(wb.conclusions(p.id).length, 0, 'retry does not save draft results');
    const savedPersonal = await wb.saveDraftPersonal(d.id, d.artifacts!.map(item => item.id));
    assert.equal(savedPersonal.length, 2); assert.equal(wb.conclusions(p.id).length, 2);
    assert(savedPersonal.every(item => item.sources.some(source => source.kind === 'session')));
    assert.deepEqual((await wb.saveDraftPersonal(d.id, d.artifacts!.map(item => item.id))).map(item => item.id), savedPersonal.map(item => item.id), 'personal save is idempotent');
    const transfer = await wb.submitDraft(d.id); await until(() => wb.store.transfers.slice(0, 2).every(item => !['queued', 'running'].includes(item.status))); assert.equal(transfer.status, 'done', transfer.error || '');
    assert.equal(wb.conclusions(p.id).length, 2, 'team submission does not create another personal result');
    assert.deepEqual(new Set(wb.store.transfers.slice(0, 2).map(item => path.posix.dirname(item.target))), new Set([p.uploadPath + '/explorations', p.uploadPath + '/todos']));
    const zip = JSON.parse(execFileSync('python', ['-c', 'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', transfer.localPath], { encoding: 'utf8' }));
    const manifest = JSON.parse(zip['manifest.json']);
    assert.deepEqual(Object.keys(zip).sort(), ['README.md', 'manifest.json']); assert.match(zip['README.md'], /建议先验证数据覆盖率/); assert.equal('repoUrl' in manifest, false); assert.equal(manifest.schemaVersion, 4); assert.equal(manifest.category, 'exploration'); assert.equal(manifest.snapshotHash, d.snapshot?.conversationHash); assert.match(zip['README.md'], /人工补充/); assert(!JSON.stringify(zip).includes('材料原始内容'));
    assert.throws(() => wb.saveDraftSupplement(d.id, 'late', ''), /已提交/);
    const savedConclusions = structuredClone(wb.conclusions(p.id));
    await wb.deleteDraft(d.id); assert(!wb.store.drafts.some(item => item.id === d.id));
    assert.deepEqual(wb.conclusions(p.id), savedConclusions); await fs.access(transfer.localPath);
    await bob.store.init(); await bob.configureWorkspace(profile('bob'), 'member-password', root, async () => false);
    assert((await bob.remote.list(bob.remote.binding(p.id), p.uploadPath + '/explorations')).some(x => x.path === transfer.target));
    const shared = await bob.remote.contentList(bob.remote.binding(p.id)); assert.deepEqual(new Set(shared.filter(x => x.kind === 'contribution').map(x => x.category)), new Set(['exploration', 'todo'])); assert(shared.every(item => item.sourceSessionTitle === '覆盖率验证会话'));
    await wb.saveContentAlias(p.id, shared[0].id, '我本机的验收结论');
    assert.equal(wb.store.settings.contentAliases?.[`${p.id}:${shared[0].id}`], '我本机的验收结论');
    const aliasedSource = await wb.attachContent(s.id, shared[0].id); assert.match(aliasedSource.name, /^我本机的验收结论 · v\d+$/);
    await wb.saveContentAlias(p.id, shared[0].id, ''); assert.equal(wb.store.settings.contentAliases?.[`${p.id}:${shared[0].id}`], undefined);
    const ownHistory = await wb.syncContentUpdates(); assert.equal(ownHistory.length, 2, 'the first scan keeps the current user operations in history'); assert(ownHistory.every(item => item.updatedBy === 'alice' && item.readAt), 'own operations are historical, not pending alerts');
    const teammateFile = path.join(root, 'teammate.md'); await fs.writeFile(teammateFile, 'Bob 的新结论');
    await bob.remote.upload(bob.remote.binding(p.id), teammateFile, bob.remote.binding(p.id).project.uploadPath + '/findings/teammate.md', () => {}, { kind: 'contribution', category: 'finding', fields: { statement: 'Bob 的新结论' }, title: '队友新成果', description: '用于验证后台提醒' });
    const updates = await wb.syncContentUpdates(), teammateUpdate = updates.find(item => item.title === '队友新成果'); assert.equal(updates.length, 3); assert(teammateUpdate); assert.equal(teammateUpdate.updatedBy, 'bob'); assert.equal(teammateUpdate.change, 'new'); assert.equal(teammateUpdate.readAt, undefined);
    const sameUpdates = await wb.syncContentUpdates(); assert.equal(sameUpdates.length, 3, 'the same revisions are retained in history without being duplicated'); assert.equal(sameUpdates.find(item => item.title === '队友新成果')?.eventId, teammateUpdate.eventId);
    await bob.syncContentUpdates(); await bob.markContentUpdates(); const archived = await bob.clearReadContentUpdates(); assert(archived.every(item => item.readAt), 'archived dynamics remain in history');
    await fixture.write({ status: 'ready', turn: 'success', mergeResult: { title: '统一项目结论', overview: '融合而非拼接的综合判断。', consensus: ['两项材料可共同支撑后续验证。'], conflicts: [], evidence: [], scope: '当前项目', unresolved: ['补齐回归数据。'] } });
    await assert.rejects(wb.prepareContentMerge(p.id, s.id, shared.map(item => item.id)), /同一分类/);
    const todoIndex = shared.findIndex(item => item.category === 'todo');
    shared[todoIndex] = (await wb.remote.contentEdit(wb.remote.binding(p.id), { id: shared[todoIndex].id, revision: shared[todoIndex].revision, action: 'save', title: shared[todoIndex].title, description: shared[todoIndex].description, category: 'exploration', curate: true, merge: [] }))!;
    const mergeDraft = await wb.prepareContentMerge(p.id, s.id, shared.map(item => item.id)); await until(() => mergeDraft.generation === 'ready');
    assert.match(mergeDraft.body, /融合而非拼接的综合判断/); assert.doesNotMatch(mergeDraft.body, /^## /m); assert.equal((await wb.prepareContentMerge(p.id, s.id, shared.map(item => item.id))).id, mergeDraft.id);
    await wb.saveContentMerge(mergeDraft.id, '人工复核后的统一结论', mergeDraft.body + '\n\n人工确认：保留冲突记录。');
    const teamBeforePersonalSave = await wb.remote.contentList(wb.remote.binding(p.id));
    const privateMerge = await wb.saveContentMergePersonal(mergeDraft.id);
    assert.deepEqual(privateMerge.derivedFrom, shared.map(item => ({ scope: 'team', projectId: p.id, id: item.id, version: item.revision })));
    assert.equal((await wb.saveContentMergePersonal(mergeDraft.id)).id, privateMerge.id, 'saving the same merge draft is idempotent');
    assert.deepEqual((await wb.remote.contentList(wb.remote.binding(p.id))).map(item => item.id), teamBeforePersonalSave.map(item => item.id), 'personal save leaves team results alone');
    const merged = await wb.commitContentMerge(mergeDraft.id, shared.map(item => item.id)); assert.equal(merged.title, '【探索记录】 人工复核后的统一结论'); assert.equal(mergeDraft.mergeResultPath, merged.path); assert.equal(merged.sourceSessionTitle, '覆盖率验证会话');
    assert.equal((await wb.remote.contentList(wb.remote.binding(p.id))).filter(item => shared.some(source => source.id === item.id)).length, 0);
    assert(!shared.some(source => source.id === merged.id));
    const frozenSources = await wb.remote.contentHistory(wb.remote.binding(p.id));
    assert.deepEqual(new Set(frozenSources.filter(item => item.supersededBy?.id === merged.id).map(item => item.id)), new Set(shared.map(item => item.id)));
    assert(frozenSources.filter(item => item.supersededBy?.id === merged.id).every(item => item.description && item.revision === shared.find(source => source.id === item.id)!.revision));
    assert.equal(merged.provenance?.length, 2); assert.deepEqual(new Set(merged.provenance?.map(item => item.id)), new Set(shared.map(item => item.id)));
    const mergeUpdates = await bob.syncContentUpdates(), mergeUpdate = mergeUpdates.find(item => item.change === 'merged'); assert(mergeUpdate); assert.equal(mergeUpdate.title, merged.title); assert.equal(mergeUpdate.sourceTitles?.length, 2); assert.equal(mergeUpdate.sourceSessionTitle, '覆盖率验证会话');
    assert.deepEqual(new Set(mergeUpdates.filter(item => item.change === 'superseded' && item.replacedBy?.id === merged.id).map(item => item.id)), new Set(shared.map(item => item.id)));
    await bob.markContentUpdates([mergeUpdate.eventId]); assert((await bob.contentUpdates()).find(item => item.eventId === mergeUpdate.eventId)?.readAt);
    const teamCopy = (await wb.importContentConclusion(p.id, merged.id, merged.revision)).conclusion;
    const privateC = await wb.createConclusion(p.id, '个人路线 C', '我自己的补充论据，与团队来源有交集也不改变团队原件。');
    const personalDraft = await wb.prepareConclusionMerge(p.id, s.id, [privateC.id, teamCopy.id], '保留各自的验证边界');
    await until(() => personalDraft.generation === 'ready');
    await wb.saveContentMerge(personalDraft.id, '下一轮个人路线 E', '结合 C 与 D 个人副本后的新判断');
    const personalE = await wb.commitConclusionMerge(personalDraft.id, [privateC.id, teamCopy.id]);
    assert.deepEqual(personalE.derivedFrom, [{ scope: 'personal', projectId: p.id, id: privateC.id, version: privateC.version }, { scope: 'personal', projectId: p.id, id: teamCopy.id, version: teamCopy.version }]);
    assert(privateC.archived && teamCopy.archived);
    assert.equal((await wb.remote.contentList(wb.remote.binding(p.id))).find(item => item.id === merged.id)?.id, merged.id, 'personal processing leaves team D current');
    await wb.editSharedContent(p.id, { id: merged.id, revision: merged.revision, action: 'delete', curate: true, merge: [] });
    const ownDeleteUpdate = (await wb.contentUpdates()).find(item => item.change === 'deleted' && item.id === merged.id); assert(ownDeleteUpdate); assert.equal(ownDeleteUpdate.readAt, undefined, 'a retained local copy still needs an explicit choice, even for the deleting administrator'); assert(wb.deletedContentConclusions(ownDeleteUpdate.eventId).length > 0); assert.equal(ownDeleteUpdate.updatedBy, 'alice');
    const deleteUpdates = await bob.syncContentUpdates(), deleteUpdate = deleteUpdates.find(item => item.change === 'deleted' && item.id === merged.id); assert(deleteUpdate); assert.equal(deleteUpdate.title, merged.title); assert.equal(deleteUpdate.path, undefined); assert(deleteUpdates.some(item => item.eventId === mergeUpdate.eventId && item.readAt && item.unavailableAt), 'processed history survives removal with its original handling record'); assert.equal(deleteUpdates.filter(item => item.id === merged.id && !item.readAt).length, 1, 'only the deletion decision remains pending');
    const privateCount = wb.conclusions(p.id).length;
    const teamOnly = await wb.prepare(s.id); await until(() => teamOnly.generation === 'ready');
    await wb.submitDraft(teamOnly.id); await until(() => teamOnly.artifacts!.every(item => wb.store.transfers.some(transfer => transfer.id === item.submitted && !['queued', 'running'].includes(transfer.status))));
    assert.equal(wb.conclusions(p.id).length, privateCount, 'team-only submission does not save a personal copy');
    const localA = await wb.createConclusion(p.id, '个人方案 A', '第一组依据');
    const localB = await wb.createConclusion(p.id, '个人方案 B', '第二组依据');
    const personalTeamDraft = await wb.prepareConclusionMerge(p.id, s.id, [localA.id, localB.id], '合并两组依据，形成团队可复核的判断');
    await until(() => personalTeamDraft.generation === 'ready');
    await wb.saveContentMerge(personalTeamDraft.id, '团队复核方案', '对两组依据的综合判断');
    const beforeDirectTeamSubmit = wb.conclusions(p.id).length;
    const directTeamTransfer = await wb.submitConclusionMerge(personalTeamDraft.id);
    await until(() => !['queued', 'running'].includes(directTeamTransfer.status));
    assert.equal(directTeamTransfer.status, 'done', directTeamTransfer.error || '');
    assert.equal(wb.conclusions(p.id).length, beforeDirectTeamSubmit, 'submitting a personal merge draft to the team does not save a personal result');
    assert(!localA.archived && !localB.archived, 'team submission leaves personal sources current');
    assert((await wb.remote.contentList(wb.remote.binding(p.id))).some(item => item.path === directTeamTransfer.target), 'team members can find the submitted result');
    const next = await wb.prepare(s.id); await until(() => next.generation === 'ready'); assert.notEqual(next.id, d.id);
    await admin.operation({ op: 'group_member', username: 'alice', group: 'local_prepare', role: 'remove', handoffs: { local_prepare: 'bob' } });
    const denied = await wb.submitDraft(next.id); await until(() => denied.status === 'error'); assert.match(denied.error!, /不属于|项目入口配置已改变/);
    const original = await diskPath(share, bob.remote.binding(p.id).project.uploadPath + '/findings/teammate.md'); assert((await fs.stat(original)).size > 0);
  } finally { await Promise.all([wb.close(), bob.close()]); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-prepare-local-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('SFTP candidate discovery skips other-member submissions and trajectories; denied directory write remains denied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-sftp-')), server = await teamServer();
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); await wb.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    const p = await wb.createProject('分类识别'), b = wb.remote.binding(p.id);
    server.nodes.set(p.remoteRoot + '/资料', { mode: 0o40550, uid: 0, gid: 100, data: Buffer.alloc(0) });
    server.nodes.set(p.remoteRoot + '/submissions/bob', { mode: 0o40750, uid: 1002, gid: 100, data: Buffer.alloc(0) });
    const found = await discoverDestinations(wb.remote, b, () => true);
    assert(found.destinations.some(x => x.path.endsWith('/资料'))); assert(!found.destinations.some(x => x.path.endsWith('/bob') || x.path.includes('trajectories')));
    const file = path.join(root, 'notes.txt'); await fs.writeFile(file, 'notes');
    await wb.configureWorkspace(server.profile('bob'), 'test-password', root, async () => true);
    const transfer = await wb.queue.enqueue(file, wb.remote.binding(p.id), p.remoteRoot + '/资料', 'upload'); await until(() => transfer.status === 'error'); assert.match(transfer.error!, /只能修改自己的提交/);
    wb.remote.disconnect(); const offline = await discoverDestinations(wb.remote, b, () => true); assert.equal(offline.destinations.length, 1); assert(offline.note);
  } finally { await wb.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('hung preparation times out visibly; no duplicate jobs, no automatic upload, supplement survives retry and restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-timeout-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, 3000);
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.cursor = fixture.launcher;
    const s = await wb.createSession('cursor', root, offlineProjectId), d = await wb.prepare(s.id);
    await wb.saveDraftSupplement(d.id, '一直保留的补充', ''); await until(() => d.generation === 'error'); assert.match(d.generationError!, /超时/);
    assert(wb.session(d.prepareSessionId!).closedAt); assert.equal(s.status, 'idle'); assert.equal(wb.store.transfers.length, 0);
    await fixture.write({ status: 'ready', turn: 'success', preparationRaw: 'broken response' });
    await wb.retryPreparation(d.id); await until(() => d.generation === 'error'); assert.match(d.generationError!, /格式不完整/);
    await fixture.write({ status: 'ready', turn: 'success' }); await wb.retryPreparation(d.id); await until(() => d.generation === 'ready'); assert.equal(d.supplement, '一直保留的补充');
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init(); assert.equal(reopened.drafts[0].supplement, d.supplement); assert.equal(reopened.drafts[0].body, d.body);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('cancel preparation preserves notes and supplements, stops only the helper, and supports retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-cancel-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const parent = await wb.createSession('codex', root, offlineProjectId);
    await wb.saveHandoff(parent.id, '# Agent 工作记录\n已有方向性结论');
    await wb.send(parent.id, '持续运行的独立工作');
    await until(() => parent.status === 'running');
    const d = await wb.prepare(parent.id);
    await until(() => wb.session(d.prepareSessionId!).status === 'running');
    await wb.saveDraftSupplement(d.id, '取消后仍保留的补充', '');
    const originalInput = d.inputDir;
    await wb.cancelPreparation(d.id);
    assert.equal(d.generation, 'canceled'); assert(d.generationFinishedAt);
    const helper = wb.session(d.prepareSessionId!);
    assert(helper.closedAt); assert.equal(helper.status, 'idle'); assert.deepEqual(helper.approvals, []);
    assert.equal(parent.status, 'running'); assert.equal(parent.closedAt, undefined);
    assert.equal(await wb.readHandoff(parent.id), '# 阶段摘要\n\n已有方向性结论');
    assert.equal(d.supplement, '取消后仍保留的补充'); assert.equal(wb.store.transfers.length, 0);
    assert.equal((await wb.prepare(parent.id)).id, d.id); assert.equal(d.generation, 'canceled');
    await fixture.write({ status: 'ready', turn: 'success' });
    await wb.retryPreparation(d.id); await until(() => d.generation === 'ready');
    assert.equal(d.inputDir, originalInput); assert.equal(d.supplement, '取消后仍保留的补充');
    const body = d.body;
    await wb.cancelPreparation(d.id); assert.equal(d.generation, 'ready'); assert.equal(d.body, body);
    assert.equal(wb.store.transfers.length, 0);
    await wb.store.save(); const reopened = new Store(wb.store.root); await reopened.init();
    assert.equal(reopened.drafts[0].body, body); assert.equal(reopened.drafts[0].supplement, d.supplement);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('deleting a preparation removes its local task, helper session and temporary files without deleting the source session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-delete-'));
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const parent = await wb.createSession('codex', root, offlineProjectId), draft = await wb.prepare(parent.id);
    await until(() => wb.session(draft.prepareSessionId!).status === 'running');
    const helperId = draft.prepareSessionId!, draftRoot = path.join(wb.store.root, 'drafts', draft.id);
    await fs.access(draftRoot); await wb.deleteDraft(draft.id);
    assert.equal(wb.store.drafts.some(item => item.id === draft.id), false);
    assert.equal(wb.store.sessions.some(item => item.id === helperId), false);
    assert.equal(wb.store.sessions.some(item => item.id === parent.id), true);
    await assert.rejects(fs.access(draftRoot));
    const reopened = new Store(wb.store.root); await reopened.init();
    assert.equal(reopened.drafts.some(item => item.id === draft.id), false);
    assert.equal(reopened.sessions.some(item => item.id === helperId), false);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('older drafts preserve the reviewed explanation and completed submissions during migration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-prepare-migration-'));
  try {
    await fs.writeFile(path.join(root, 'drafts.json'), JSON.stringify([{ id: 'edited', body: 'user edited body', generatedBody: 'old AI body', binding, target: '/p/old', generation: 'ready' }, { id: 'submitted', body: 'frozen body', target: '/p/old', submitted: 'transfer', generation: 'ready' }]));
    const store = new Store(root); await store.init(); assert.equal(store.drafts[0].body, 'user edited body'); assert.equal(store.drafts[0].target, binding.project.uploadPath); assert.equal(store.drafts[1].target, '/p/old');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
