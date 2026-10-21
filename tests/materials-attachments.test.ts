import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { memberProfile } from './fixtures/member-profile';
import { applyPreparation } from '../src/core/preparation';
import { diskPath } from '../src/core/local-space';
import { mergeAccountRecords } from '../src/core/account-sync';
import { settingsSchema } from '../src/core/config';
import type { Draft } from '../src/shared/types';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-materials-')), shared = path.join(root, 'shared'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
  for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_research'], contentAdminGroups: ['local_research'] });
  const clients: Workbench[] = [];
  const client = async (slot: string, username = 'alice') => {
    const wb = new Workbench(path.join(root, slot), () => {}, () => {}); clients.push(wb); await wb.store.init();
    const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, username); profile.id = 'connection-' + slot;
    await wb.configureWorkspace(profile, '1', '', async () => false); return wb;
  };
  const first = await client('one'), created = await first.createProject('调研项目', 'local_research');
  await first.projectSync.sync(); const project = first.projectBinding(created.id).project;
  return { root, shared, admin, first, project, client, close: async () => { await Promise.all(clients.map(wb => wb.close())); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
async function settled(wb: Workbench) { const deadline = Date.now() + 15000; while (wb.store.transfers.some(item => ['running', 'queued'].includes(item.status))) { if (Date.now() > deadline) throw Error('queue timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('retired classification settings are discarded and removed from remote account data without losing results or producing conflicts', async () => {
  const env = await setup();
  try {
    const wb = env.first, result = await wb.createConclusion(env.project.id, '已有探索', '已保存的探索不受配置删除影响。', 'exploration');
    await wb.accountSync.sync();
    const data = await wb.remote.accountData();
    await wb.remote.accountData({ revision: data.revision, records: { ...data.records, 'result-rules:preferences': { obsolete: true } } });
    assert(!Object.hasOwn(settingsSchema.parse({ ...wb.store.settings, resultPreferences: { obsolete: true } }), 'resultPreferences'));
    await wb.accountSync.sync(); assert.equal(wb.accountSync.state.status, 'synced');
    const cleaned = await wb.remote.accountData();
    assert(!Object.hasOwn(cleaned.records, 'result-rules:preferences')); assert(Object.hasOwn(cleaned.records, 'material:' + result.id));
    const second = await env.client('cleaned-copy'); assert.equal(second.conclusions(env.project.id)[0].content, result.content);
  } finally { await env.close(); }
});

test('preparation reads authorized project brief and current/history team results while excluding trajectories and another account private results', async () => {
  const env = await setup();
  try {
    const wb = env.first, binding = wb.remote.binding(env.project.id);
    const brief = { background: '比赛格式转换', objectives: '降低量化误差', acceptance: '固定样例误差评估', scope: '', constraints: '公开样例', deliverables: '', resources: '', collaboration: '' };
    const initial = await wb.remote.projectBrief(binding);
    await wb.remote.saveProjectBrief(binding, brief, initial.revision);
    const source = path.join(env.root, 'team-source.md'); await fs.writeFile(source, '团队探索');
    const item = await wb.remote.upload(binding, source, binding.project.uploadPath + '/explorations/team-source.md', () => {}, { kind: 'contribution', category: 'exploration', title: '量化误差分析', description: '首轮误差只覆盖均值。' });
    await wb.editSharedContent(env.project.id, { id: item.id, revision: item.revision, action: 'save', title: item.title, description: '第二轮增加长尾误差。', category: 'exploration', curate: true, merge: [] });
    await wb.remote.upload(binding, source, binding.project.historyPath + '/trajectory.md', () => {}, { kind: 'trajectory', title: '量化误差分析', description: 'PRIVATE_TRAJECTORY_TEXT' });
    const bob = await env.client('private-history', 'bob');
    await bob.createConclusion(env.project.id, '量化误差分析', 'PRIVATE_OTHER_ACCOUNT_TEXT', 'exploration');
    await wb.accountSync.sync();
    const inputDir = path.join(wb.store.root, 'context-input'); await fs.mkdir(inputDir);
    const draft: Draft = { id: randomUUID(), sessionId: 'fixture', binding, title: '量化误差分析', body: '', files: [], inputDir, outputPath: path.join(inputDir, 'draft.md'), createdAt: new Date().toISOString() };
    const context = await (wb as any).freezePreparationContext(draft, [{ text: '量化误差分析' }]);
    assert.equal(context.brief.objectives, brief.objectives);
    assert(context.results.some((result: any) => result.scope === 'team' && result.id === item.id && result.state === 'current' && result.version === 2));
    assert(context.results.some((result: any) => result.scope === 'team' && result.id === item.id && result.state === 'history' && result.version === 1));
    assert(!JSON.stringify(context).includes('PRIVATE_TRAJECTORY_TEXT')); assert(!JSON.stringify(context).includes('PRIVATE_OTHER_ACCOUNT_TEXT'));
    assert(JSON.stringify(context).length <= 6000);
  } finally { await env.close(); }
});

test('sharing a personal result creates an independent team ID and discloses only selected direct references', async () => {
  const env = await setup();
  try {
    const wb = env.first, projectId = env.project.id;
    const privateSource = await wb.createConclusion(projectId, '未分享的依据', '仅自己可见的原文');
    const result = await wb.createConclusion(projectId, '可分享结论', '公开给项目组的结论');
    result.derivedFrom = [{ scope: 'personal', projectId, id: privateSource.id, version: privateSource.version }];
    await assert.rejects(wb.publishConclusion(result.id, [{ scope: 'personal', projectId, id: randomUUID(), version: 1 }]), /直接来源/);
    await wb.publishConclusion(result.id); await settled(wb);
    const binding = wb.remote.binding(projectId), first = (await wb.remote.contentList(binding))[0];
    assert.notEqual(first.id, result.id);
    assert.equal(first.description, result.content);
    assert.equal(first.disclosedSources, undefined);
    assert.equal(first.replaces, undefined);
    await assert.rejects(wb.publishConclusion(result.id, result.derivedFrom), /当前版本已上传/, 'changing source disclosure must not duplicate an already uploaded version');
    await wb.saveConclusion(result.id, result.title, '公开给项目组的结论，补充新的验证结果');
    await wb.publishConclusion(result.id, result.derivedFrom); await settled(wb);
    const published = await wb.remote.contentList(binding);
    assert.equal(published.length, 2);
    assert.deepEqual(published[0].disclosedSources, result.derivedFrom);
    assert.equal(published[0].replaces, undefined);
    assert.equal(wb.conclusions(projectId).find(item => item.id === privateSource.id)?.content, '仅自己可见的原文');
    await wb.accountSync.sync(); assert.equal(wb.accountSync.state.status, 'synced', wb.accountSync.state.detail || '');
    const sameAccount = await env.client('same-account');
    assert.equal(sameAccount.store.transfers.length, 0);
    assert.equal(sameAccount.conclusionUploadState(result.id).status, 'done', 'another computer restores publication state without local transfer history');
    await assert.rejects(sameAccount.publishConclusion(result.id), /当前版本已上传/);
    const teammate = await env.client('private-check', 'bob');
    assert.equal(teammate.conclusions(projectId).length, 0);
    assert(!JSON.stringify(await teammate.remote.contentList(teammate.remote.binding(projectId))).includes('仅自己可见的原文'));
  } finally { await env.close(); }
});

test('a later team revision does not rewrite a personal copy or an already attached session snapshot', async () => {
  const env = await setup();
  try {
    const alice = env.first, bob = await env.client('version-copy', 'bob'), binding = alice.remote.binding(env.project.id);
    const local = path.join(env.root, 'version-source.md'); await fs.writeFile(local, '上传包');
    const original = await alice.remote.upload(binding, local, `${binding.project.uploadPath}/version-source.md`, () => {}, { kind: 'contribution', title: '团队 D', description: 'D 第一版正文' });
    const copy = (await bob.importContentConclusion(env.project.id, original.id, 1)).conclusion;
    const session = await bob.createSession('codex', env.root, env.project.id);
    const source = await bob.attachConclusion(session.id, copy.id), frozenText = await fs.readFile(source.localPath, 'utf8');
    const updated = await alice.editSharedContent(env.project.id, { id: original.id, revision: 1, action: 'save', title: '团队 D', description: 'D 第二版正文', curate: true, merge: [] });
    assert.equal(updated?.id, original.id);
    assert.equal(updated?.revision, 2);
    assert.deepEqual(copy.derivedFrom, [{ scope: 'team', projectId: env.project.id, id: original.id, version: 1 }]);
    assert.equal(copy.content, 'D 第一版正文');
    assert.equal(await fs.readFile(source.localPath, 'utf8'), frozenText);
    assert.equal((await alice.remote.contentHistory(binding, original.id, 1))[0].description, 'D 第一版正文');
  } finally { await env.close(); }
});


test('a reviewed legacy category publishes to its fixed folder and preserves metadata across computers', async () => {
  const env = await setup();
  try {
    const a = env.first, bob = await env.client('recipient', 'bob'), session = await a.createSession('codex', '', env.project.id);
    const draft: Draft = { id: randomUUID(), sessionId: session.id, binding: session.binding, title: '', body: '', files: [], inputDir: path.join(a.store.root, 'input'), outputPath: path.join(a.store.root, 'draft.md'), createdAt: new Date().toISOString(), generation: 'ready', preparationVersion: 3, resultRules: { contract: 2, categories: ['design'] }, preparationEvidenceIds: ['handoff'] };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'design', topic: '版本化更新', title: '编辑时按版本号检查冲突', body: '以版本号保护并发写入，避免静默覆盖。', origin: 'project', evidenceIds: ['handoff'] }] })); a.store.drafts.push(draft);
    await a.submitDraft(draft.id); await settled(a); assert(a.store.transfers.every(item => item.status === 'done'));
    const shared = (await a.remote.contentList(session.binding!))[0]; assert.equal(shared.category, 'design'); assert.match(shared.path, /\/designs\//);
    const local = await bob.importContentConclusion(env.project.id, shared.id); assert.equal(local.conclusion.category, 'design');
    const merged = await a.remote.contentEdit(session.binding!, { id: shared.id, revision: shared.revision, action: 'save', title: '【验证结果】 版本保护回归通过', description: '回归结果。', category: 'verification', sourceDetails: '指定来源的验证记录。', curate: true, merge: [] });
    assert.equal(merged!.category, 'verification'); assert.deepEqual(merged!.fields, {}); assert.equal(merged!.sourceDetails, '指定来源的验证记录。');
  } finally { await env.close(); }
});

test('research folders persist; account restores personal materials and selected files, never sessions or code paths', async () => {
  const env = await setup();
  try {
    const { first: a, project, root } = env;
    const session = await a.createSession('codex', '', project.id), second = await a.createSession('codex', '', project.id);
    assert.notEqual(session.cwd, second.cwd); assert(session.cwd.startsWith(path.join(a.store.root, 'workspaces')));
    session.messages.push({ id: randomUUID(), role: 'user', text: 'PRIVATE_FULL_CONVERSATION', createdAt: new Date().toISOString() });
    const material = await a.createConclusion(project.id, '【项目标准】 使用人工复核结果验收', '必须保留独立复核。');
    const draft: Draft = { id: randomUUID(), sessionId: session.id, binding: session.binding, title: '资料', body: '', files: [], inputDir: path.join(a.store.root, 'drafts', 'input'), outputPath: path.join(a.store.root, 'drafts', 'result.md'), createdAt: new Date().toISOString(), generation: 'ready', preparationVersion: 3, concise: true };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '抽样复核能发现漏检', fields: { statement: '复核发现了漏检。' } }] })); a.store.drafts.push(draft);
    const file = path.join(root, '证据.csv'); await fs.writeFile(file, 'item,result\n1,pass'); await a.addDraftFiles(draft.id, [file], draft.artifacts![0].id);
    await a.accountSync.sync(); assert.equal(a.accountSync.state.status, 'synced', a.accountSync.state.detail || '');
    const remote = await a.remote.accountData(); assert(!JSON.stringify(remote).includes('PRIVATE_FULL_CONVERSATION')); assert(!JSON.stringify(remote).includes(session.cwd));
    const b = await env.client('two'); assert.equal(b.store.sessions.length, 0); assert.deepEqual(b.conclusions(project.id).map(item => item.id), [material.id], 'an unsaved preparation must not become a personal result on another computer');
    assert.equal(await fs.readFile(b.store.drafts[0].files[0].localPath, 'utf8'), 'item,result\n1,pass');
    assert.equal((await env.client('other', 'bob')).conclusions(project.id).length, 0);
    await a.saveConclusion(material.id, material.title, '电脑一编辑'); await a.accountSync.sync();
    await b.saveConclusion(material.id, material.title, '电脑二编辑'); await b.accountSync.sync();
    assert.equal(b.accountSync.state.status, 'conflict'); assert.equal(b.conclusions(project.id)[0].content, '电脑二编辑');
    await b.accountSync.resolve('material:' + material.id, 'local', b.accountSync.state.conflicts![0].token); assert.equal(b.accountSync.state.status, 'synced');
    await a.accountSync.sync(); assert.equal(a.conclusions(project.id)[0].content, '电脑二编辑');
    assert(a.conclusions(project.id)[0].versions?.some(version => version.content === '必须保留独立复核。'), 'older personal versions survive account synchronization');
    assert.equal(a.store.sessions.length, 2); assert.equal(a.session(session.id).cwd, session.cwd);
  } finally { await env.close(); }
});

test('a second computer repairs a reviewed preparation whose personal result is missing from older account data', async () => {
  const env = await setup();
  try {
    const a = env.first, projectId = env.project.id, session = await a.createSession('codex', '', projectId);
    const draft: Draft = { id: randomUUID(), sessionId: session.id, binding: session.binding, title: '', body: '', files: [], inputDir: path.join(a.store.root, 'legacy-input'), outputPath: path.join(a.store.root, 'legacy-result.md'), createdAt: new Date().toISOString(), generation: 'ready', preparationVersion: 3, resultRules: { contract: 2, categories: ['finding'] }, preparationEvidenceIds: ['handoff'] };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', topic: '换机恢复', title: '已确认成果应跟随账号', body: '新电脑应同时恢复整理记录和已确认的个人成果。', origin: 'project', evidenceIds: ['handoff'] }] }));
    a.store.drafts.push(draft); await a.saveDraftPersonal(draft.id, [draft.artifacts![0].id]); await a.accountSync.sync();
    const complete = await a.remote.accountData();
    const incomplete = Object.fromEntries(Object.entries(complete.records).filter(([key]) => !key.startsWith('material:')));
    const legacy = await a.remote.accountData({ revision: complete.revision, records: incomplete }); assert(!legacy.conflict);

    const b = await env.client('legacy-second');
    assert.equal(b.store.sessions.length, 0);
    assert.equal(b.store.drafts.filter(item => item.id === draft.id).length, 1);
    assert.equal(b.conclusions(projectId).filter(item => item.sources.some(source => source.id === draft.artifacts![0].id)).length, 1);
    const repaired = await b.remote.accountData();
    assert(Object.keys(repaired.records).some(key => key.startsWith('material:')), 'the repaired result must be persisted for later computers');
  } finally { await env.close(); }
});

test('account synchronization while an activity scan awaits its response cannot detach the inbox and lose merge notifications', async () => {
  const env = await setup(); let release: (() => void) | undefined;
  try {
    const a = env.first, bob = await env.client('activity-race', 'bob'), binding = a.remote.binding(env.project.id), file = path.join(env.root, 'source.md');
    await fs.writeFile(file, '验证内容');
    for (const name of ['one', 'two']) await a.remote.upload(binding, file, binding.project.uploadPath + '/' + name + '.md', () => {}, { kind: 'contribution', title: name, description: name });
    const items = await a.remote.contentList(binding); await bob.syncContentUpdates(); await bob.accountSync.sync();
    const merged = await a.remote.contentMerge(binding, { requestId: randomUUID(), sources: items.map(item => ({ id: item.id, revision: item.revision })), replaceIds: items.map(item => item.id), title: '综合结果', description: '合并证据' });
    const contentHistory = bob.remote.contentHistory.bind(bob.remote);
    bob.remote.contentHistory = async () => { throw new Error('不支持的内容操作'); };
    const contentList = bob.remote.contentList.bind(bob.remote), gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const pending = new Promise<void>(resolve => { entered = resolve; });
    bob.remote.contentList = async (...args) => { const result = await contentList(...args); entered(); await gate; return result; };
    const inbox = bob.store.settings.contentUpdates, scan = bob.syncContentUpdates(); await pending; await bob.accountSync.sync();
    assert.notEqual(bob.store.settings.contentUpdates, inbox, 'account restore replaces the array during this scan');
    release!(); const result = await scan;
    assert(result.some(item => item.id === merged!.id && item.change === 'merged'));
    assert(result.some(item => item.id === items[1].id && item.change === 'superseded' && item.replacedBy?.id === merged!.id));
    bob.remote.contentList = contentList;
    bob.remote.contentHistory = contentHistory;
  } finally { release?.(); await env.close(); }
});

test('a source deletion stays a deletion after it was reused in another result', async () => {
  const env = await setup();
  try {
    const alice = env.first, bob = await env.client('source-deletion', 'bob'), binding = alice.remote.binding(env.project.id), file = path.join(env.root, 'source-reuse.md');
    await fs.writeFile(file, '证据');
    for (const name of ['first', 'second']) await alice.remote.upload(binding, file, binding.project.uploadPath + '/' + name + '.md', () => {}, { kind: 'contribution', title: name, description: name });
    const sources = await alice.remote.contentList(binding);
    await bob.syncContentUpdates();
    const derived = await alice.remote.contentMerge(binding, { requestId: randomUUID(), sources: sources.map(item => ({ id: item.id, revision: item.revision })), title: '新角度结论', description: '沿用两条来源' });
    assert.deepEqual(derived?.replaces, []);
    await bob.syncContentUpdates();
    await alice.remote.contentEdit(binding, { id: sources[0].id, revision: sources[0].revision, action: 'delete', curate: false, merge: [] });
    const updates = await bob.syncContentUpdates();
    assert(updates.some(item => item.id === sources[0].id && item.change === 'deleted'));
    assert(!updates.some(item => item.id === sources[0].id && item.change === 'superseded'));
  } finally { await env.close(); }
});

test('attachments are explicit, frozen, deduplicated, dependency-gated and retryable without duplicating successful files', async () => {
  const env = await setup();
  try {
    const wb = env.first, session = await wb.createSession('codex', '', env.project.id);
    const draft: Draft = { id: randomUUID(), sessionId: session.id, binding: session.binding, title: '', body: '', files: [], inputDir: path.join(wb.store.root, 'input'), outputPath: path.join(wb.store.root, 'draft.md'), createdAt: new Date().toISOString(), generation: 'ready', preparationVersion: 3 };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '结果', fields: { statement: '实际结果' }, attachmentIds: ['invented'] }, { category: 'issue', title: '风险', fields: { problem: '边界缺口' } }] }));
    assert.deepEqual(draft.artifacts![0].attachments, []); wb.store.drafts.push(draft);
    const file = path.join(env.root, 'report.csv'); await fs.writeFile(file, 'frozen evidence');
    await wb.addDraftFiles(draft.id, [file], draft.artifacts![0].id); await wb.addDraftFiles(draft.id, [file], draft.artifacts![1].id);
    await fs.writeFile(file, 'changed after selection');
    const upload = wb.remote.uploadAttachment.bind(wb.remote); let failures = 1, successful = 0;
    wb.remote.uploadAttachment = async (...args) => { if (failures-- > 0) throw new Error('temporary failure'); successful++; return upload(...args); };
    const transfer = await wb.submitDraft(draft.id); await settled(wb);
    assert.equal(wb.store.transfers.filter(item => item.attachment).length, 1); assert.equal(transfer.status, 'error'); assert.equal((await wb.remote.contentList(session.binding!)).length, 0);
    await wb.queue.retry(transfer.id); await settled(wb);
    assert(wb.store.transfers.every(item => item.status === 'done'), JSON.stringify(wb.store.transfers.map(item => item.error))); assert.equal(successful, 1);
    const shared = await wb.remote.contentList(session.binding!); assert.equal(shared.length, 2); assert.equal(shared[0].attachments![0].path, shared[1].attachments![0].path);
    assert.equal(await fs.readFile(await diskPath(env.shared, shared[0].attachments![0].path), 'utf8'), 'frozen evidence');
    await assert.rejects(wb.remote.contentMerge(session.binding!, { requestId: randomUUID(), sources: shared.map(item => ({ id: item.id, revision: item.revision })), title: '合并结果', description: '保留证据' }), /同一分类/);
    const risk = shared.find(item => item.category === 'issue')!;
    await wb.remote.contentEdit(session.binding!, { id: risk.id, revision: risk.revision, action: 'save', title: risk.title, description: risk.description, category: 'exploration', curate: true, merge: [] });
    const updated = await wb.remote.contentList(session.binding!);
    const combined = await wb.remote.contentMerge(session.binding!, { requestId: randomUUID(), sources: updated.map(item => ({ id: item.id, revision: item.revision })), title: '合并结果', description: '保留证据' });
    assert.equal(combined!.attachments!.length, 1);
    const attachmentFile = await diskPath(env.shared, shared[0].attachments![0].path);
    let listed = await wb.remote.contentList(session.binding!);
    const holders = () => listed.filter(item => item.attachments?.some(entry => entry.path === shared[0].attachments![0].path));
    const firstHolder = holders()[0];
    await wb.remote.contentEdit(session.binding!, { id: firstHolder.id, revision: firstHolder.revision, action: 'delete', curate: true, merge: [] });
    assert.equal(await fs.readFile(attachmentFile, 'utf8'), 'frozen evidence');
    listed = await wb.remote.contentList(session.binding!);
    const removed = [firstHolder, ...holders()];
    for (const item of holders()) await wb.remote.contentEdit(session.binding!, { id: item.id, revision: item.revision, action: 'delete', curate: true, merge: [] });
    await assert.rejects(() => fs.stat(attachmentFile));
    const receipts = JSON.parse(await fs.readFile(await diskPath(env.shared, '/.workbench-local/upload-receipts.json'), 'utf8')) as Record<string, { id?: string; description?: string }>;
    assert(!Object.values(receipts).some(value => removed.some(item => item.id === value.id)));
    assert(!Object.values(receipts).some(value => removed.some(item => item.description && value.description === item.description)));
    for (const item of removed) {
      const file = await diskPath(env.shared, item.path, true);
      await assert.rejects(() => fs.stat(file));
    }
    await assert.rejects(wb.addDraftFiles(draft.id, [file], draft.artifacts![0].id), /提交前/);
  } finally { await env.close(); }
});

test('empty concise result is success; cap, valid categories and read/archive merge are enforced', () => {
  const draft = { id: 'd', concise: true, files: [], binding: { project: { remoteRoot: '/p', uploadPath: '/p/submissions/a' } } } as unknown as Draft;
  applyPreparation(draft, '{"artifacts":[]}'); assert.equal(draft.body, ''); assert.equal(draft.artifacts!.length, 0);
  assert.throws(() => applyPreparation(draft, JSON.stringify({ artifacts: Array(6).fill({ category: 'finding', title: '重复', fields: { statement: '重复' } }) })), /超过 5/);
  const readAt = '2026-09-23T00:00:00.000Z';
  const result = mergeAccountRecords({ 'update:p': { title: '旧' } }, { 'update:p': { title: '新', readAt } }, { 'update:p': { title: '新', actions: [{ kind: 'archived' }] } });
  assert.equal(result.records['update:p'].readAt, readAt); assert.equal(result.conflicts.length, 0);
});

test('account switching never exports another account and loss of membership keeps private records', async () => {
  const env = await setup();
  try {
    const a = env.first, material = await a.createConclusion(env.project.id, '仅 Alice 的资料', 'PRIVATE_ALICE'); await a.accountSync.sync();
    const login = async (name: string) => a.configureWorkspace(memberProfile(env.admin.snapshot.profile!, env.admin.snapshot.state!, name), '1', '', async () => false);
    await login('bob'); assert.equal(a.conclusions(env.project.id).length, 0);
    await a.createConclusion(env.project.id, '仅 Bob 的资料', 'PRIVATE_BOB'); await a.accountSync.sync();
    assert(!JSON.stringify(await a.remote.accountData()).includes('PRIVATE_ALICE'));
    await login('alice'); assert.equal(a.conclusions(env.project.id)[0].id, material.id);
    assert(!JSON.stringify(await a.remote.accountData()).includes('PRIVATE_BOB'));
    await env.admin.operation({ op: 'group_member', group: 'local_research', username: 'alice', role: 'remove' });
    await a.refreshGroups(); await a.accountSync.sync();
    assert(JSON.stringify(await a.remote.accountData()).includes('PRIVATE_ALICE'));
  } finally { await env.close(); }
});

test('deleting a restored preparation record syncs without deleting results or the source computer progress', async () => {
  const env = await setup();
  try {
    const a = env.first, session = await a.createSession('codex', '', env.project.id), now = new Date().toISOString();
    session.messages.push({ id: 'boundary', role: 'assistant', text: '已完成部分', createdAt: now });
    const id = randomUUID(), base = path.join(a.store.root, 'drafts', id);
    const draft: Draft = { id, sessionId: session.id, binding: session.binding, title: '', body: '', files: [], inputDir: path.join(base, 'input'), outputPath: path.join(base, 'draft.md'), createdAt: now, generation: 'ready', preparationVersion: 3, snapshot: { capturedAt: now, messageCount: 1, totalMessageCount: 1, lastMessageId: 'boundary', lastMessageLength: 5, conversationHash: 'snapshot' } };
    applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '独立成果', fields: { statement: '不是整理记录的附属品。' } }] }));
    a.store.drafts.push(draft); await a.renameDraftResult(id, '独立成果', draft.artifacts![0].id); await a.saveDraftPersonal(id, [draft.artifacts![0].id]); await a.accountSync.sync();
    assert.equal(a.accountSync.state.status, 'synced', a.accountSync.state.detail || '');
    const progress = structuredClone(session.preparationCheckpoint), result = a.conclusions(env.project.id)[0]; assert(progress);
    const b = await env.client('delete-record'); assert.equal(b.store.sessions.length, 0);
    assert(b.store.drafts.find(item => item.id === id)?.restored);
    await b.deleteDraft(id); await b.accountSync.sync(); await a.accountSync.sync();
    assert(!a.store.drafts.some(item => item.id === id)); assert.deepEqual(session.preparationCheckpoint, progress);
    assert(a.conclusions(env.project.id).some(item => item.id === result.id)); assert(b.conclusions(env.project.id).some(item => item.id === result.id));
    const c = await env.client('after-deletion'); assert(!c.store.drafts.some(item => item.id === id)); assert.equal(c.store.sessions.length, 0);
    await a.accountSync.sync(); await b.accountSync.sync(); assert(!a.store.drafts.some(item => item.id === id));
    assert.equal((await a.remote.accountData()).records['draft:' + id], null, 'deletion tombstone prevents restoration');
  } finally { await env.close(); }
});
