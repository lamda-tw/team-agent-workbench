import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { ContentFiles } from '../src/core/content-files';
import { SftpConnection } from '../src/core/sftp';
import { applyPreparation } from '../src/core/preparation';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { materialCategories, contributionCategoryInfo } from '../src/shared/content';
import { assertTodoMerge, effectiveResultStatus, resultStateLabel, resultCategory, orderedResults, sameResultCategory } from '../src/shared/result-model';
import type { Draft, RemoteBinding } from '../src/shared/types';

test('five independent categories keep legacy data readable without guessing implemented capabilities', () => {
  assert.deepEqual(materialCategories, ['project_goal', 'project_material', 'capability', 'exploration', 'todo']);
  assert(materialCategories.every(category => contributionCategoryInfo[category].label.length === 4));
  assert.equal(resultCategory({ title: '【已有能力】 title', category: 'issue' }), 'todo');
  assert.equal(resultCategory({ title: '【项目标准】 title' }), 'project_goal');
  assert.equal(resultCategory({ title: '【调研发现】 文献', category: 'research' }), 'project_material');
  assert.equal(resultCategory({ title: '【项目资料】 协作文档' }), 'project_material');
  assert.equal(resultCategory({ title: 'test', category: 'design' }), 'exploration');
  assert.equal(resultCategory({ title: '【已有能力】 file', kind: 'file' }), undefined);
  assert.throws(() => sameResultCategory([{ title: '', category: 'todo' }, { title: '', category: 'exploration' }]), /同一分类/);
  assert.equal(sameResultCategory([{ title: '', category: 'finding' }, { title: '', category: 'exploration' }]), 'exploration');
  assert.throws(() => sameResultCategory([{ title: '', category: 'finding' }], 'todo'), /来源分类/);
  const todos = [{ title: 'a', category: 'todo' }, { title: 'b', category: 'todo' }];
  assert.throws(() => assertTodoMerge(todos), /独立事项/); assert.doesNotThrow(() => assertTodoMerge(todos, true));
});

function reviewedDraft(binding: RemoteBinding): Draft {
  return { id: randomUUID(), sessionId: randomUUID(), binding, title: '', body: '', files: [], inputDir: '', outputPath: '', createdAt: new Date().toISOString(), generation: 'ready', resultRules: { contract: 4, categories: [...materialCategories] }, preparationEvidenceIds: ['message:m'], snapshot: { capturedAt: '', messageCount: 1, conversationHash: 'a'.repeat(64) } };
}
const result = (category: string, title: string, topic = '同一主题') => ({ category, topic, title, body: title + '的具体内容与验证边界。', origin: 'project', evidenceIds: ['message:m'] });
const output = (artifacts: unknown[]) => JSON.stringify({ artifacts, sourceReview: { status: 'complete', inputCount: 1, conversationHash: 'a'.repeat(64) } });

test('October 8 extraction preserves independent tasks up to 50 results and rejects incomplete review or fabricated updates', () => {
  const draft = reviewedDraft({ project: { id: 'p', remoteRoot: '/p', uploadPath: '/p/submissions/a', historyPath: '/p/trajectories/a' } } as RemoteBinding);
  const tasks = Array.from({length:9}, (_,i)=>'待办动作'+i).join('；');
  const artifacts = [result('exploration','词典增加召回也带来误匹配'), {...result('todo','待办动作列表'),body:tasks}];
  applyPreparation(draft,output(artifacts)); assert.equal(draft.artifacts!.length,2);
  assert.equal(draft.artifacts![1].resultStatus,'pending'); assert.match(draft.artifacts![1].body,/待办动作8/);
  assert.throws(()=>applyPreparation(draft,output([artifacts[0],artifacts[0]])),/每个勾选类别|重复/);
  applyPreparation(draft,output(Array.from({length:50},(_,i)=>result('todo','动作'+i))));
  assert.equal(draft.artifacts!.length,50);
  assert.throws(()=>applyPreparation(draft,output(Array.from({length:51},(_,i)=>result('todo','动作'+i)))),/最多 50 条/);
  assert.throws(() => applyPreparation(draft, JSON.stringify({ artifacts, sourceReview: { status: 'incomplete', explanation: '只读取了部分对话' } })), /完整读取/);
  assert.throws(() => applyPreparation(draft, output([{ ...result('capability', '批处理'), updateId: randomUUID() }])), /当前个人能力版本/);
  applyPreparation(draft, output([result('todo', '修复产品的代理连接失败问题')])); assert.equal(draft.artifacts!.length, 1, 'project defects are not dropped by environment keywords');
});

test('local lifecycle edits are versioned, completed todos stay visible, reclassification resets status and failed saves roll back', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-four-life-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const item = await wb.createConclusion(offlineProjectId, '完善输入校验', '空输入需要单独处理。', 'todo', 'pending', 'Alice');
    assert.equal(item.resultOwner, 'Alice');
    const origin = structuredClone(item);
    await wb.saveConclusion(item.id, item.title, item.content, 'todo', 'completed', 1);
    assert.equal(item.resultStatus, 'completed'); assert.equal(wb.conclusions(offlineProjectId).length, 1);
    assert.equal(item.versions![0].category, 'todo'); assert.equal(item.versions![0].resultStatus, 'pending');
    await assert.rejects(wb.saveConclusion(item.id, item.title, 'stale', 'todo', 'pending', 1), /已更新/);
    await wb.saveConclusion(item.id, item.title, item.content, 'exploration', undefined, 2);
    assert.equal(item.resultStatus, undefined); assert.equal(item.id, origin.id); assert.equal(item.content, origin.content);
    const before = structuredClone(item), save = wb.store.save.bind(wb.store); wb.store.save = async () => { throw new Error('disk failure'); };
    await assert.rejects(wb.saveConclusion(item.id, '新标题', '正文', 'capability', 'available', 3), /disk failure/);
    wb.store.save = save; assert.deepEqual(item, before);
    assert.deepEqual(orderedResults([{ title: 'done', category: 'todo', resultStatus: 'completed' as const }, { title: 'active', category: 'todo' }]).map(item => item.title), ['active', 'done']);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('review edits and confirmed capability updates preserve ID, prior version, source trace and frozen input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-four-review-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const profile = wb.store.settings.workspaceSnapshot!.profile;
    const binding = { ...profile, connectionId: profile.id, project: profile.projects[0] };
    const previous = await wb.createConclusion(offlineProjectId, '离线批处理', '仅处理单文件。', 'capability');
    const draft = reviewedDraft(binding); draft.preparationExistingResults = [{ id: previous.id, title: previous.title, category: 'capability', version: previous.version }];
    applyPreparation(draft, output([{ ...result('capability', '离线批处理支持目录'), updateId: previous.id }])); wb.store.drafts.push(draft);
    const artifact = draft.artifacts![0], snapshot = structuredClone(draft.snapshot);
    await wb.editDraftArtifact(draft.id, artifact.id, '离线目录批处理', '目录下多个文件已经验证，在线接口未覆盖。', artifact.updateTarget);
    assert.equal(previous.version, 1, 'review does not mutate existing result');
    const saved = await wb.saveDraftPersonal(draft.id, [artifact.id]);
    assert.equal(saved[0].id, previous.id); assert.equal(saved[0].version, 2); assert.equal(saved[0].versions![0].content, '仅处理单文件。');
    assert.equal(saved[0].sources.at(-1)!.id, artifact.id); assert.deepEqual(draft.snapshot, snapshot);
    assert.equal((await wb.saveDraftPersonal(draft.id, [artifact.id]))[0].version, 2, 'retry is idempotent');
    await wb.editDraftArtifact(draft.id, artifact.id, artifact.title, '仅用于下一次团队提交的说明。', artifact.updateTarget);
    assert.equal(previous.version, 2); assert.match(previous.content, /目录下多个文件/);
    assert.match(artifact.body, /仅用于下一次团队提交/);
    const second = reviewedDraft(binding); applyPreparation(second, output([result('capability', '补充目录过滤')])); wb.store.drafts.push(second);
    await wb.editDraftArtifact(second.id, second.artifacts![0].id, '补充目录过滤', '新正文', { scope: 'personal', projectId: offlineProjectId, id: previous.id, version: 2 });
    await wb.saveConclusion(previous.id, previous.title, '成员手动维护的新版本', 'capability', 'limited', 2);
    await assert.rejects(wb.saveDraftPersonal(second.id, [second.artifacts![0].id]), /已变化/);
    assert.equal(wb.conclusions(offlineProjectId).length, 1);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('reclassification keeps draft edits through category round trips and rolls back failed persistence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-four-reclass-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const profile = wb.store.settings.workspaceSnapshot!.profile, binding = { ...profile, connectionId: profile.id, project: profile.projects[0] };
    const draft = reviewedDraft(binding); applyPreparation(draft, output([result('capability', '离线运行')])); wb.store.drafts.push(draft);
    const id = draft.artifacts![0].id;
    await wb.changeDraftCategory(draft.id, 'exploration', id);
    await wb.editDraftArtifact(draft.id, id, '需要验证在线运行', '只有离线场景已覆盖，在线接口待验证。');
    await wb.changeDraftCategory(draft.id, 'capability', id);
    assert.equal(draft.artifacts![0].classificationVersion, 2); assert.match(draft.artifacts![0].body, /在线接口待验证/);
    const before = structuredClone(draft), save = wb.store.save.bind(wb.store);
    wb.store.save = async () => { throw new Error('disk failure'); };
    await assert.rejects(wb.changeDraftCategory(draft.id, 'todo', id), /disk failure/);
    wb.store.save = save; assert.deepEqual(draft, before);
    await wb.changeDraftCategory(draft.id, 'todo', id);
    assert.equal(draft.artifacts![0].resultStatus, 'pending'); assert.match(draft.artifacts![0].target, /todos$/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('linked todos follow visible task acceptance and never infer hidden task completion', () => {
  const item = { title: '验证', category: 'todo', resultStatus: 'pending' as const };
  const linked = (...states: string[]) => ({ ...item, linkedAssignments: states.map(status => ({ status })) });
  assert.equal(effectiveResultStatus(linked('pending_review')), 'pending_review');
  assert.equal(effectiveResultStatus(linked('completed')), 'completed');
  assert.equal(effectiveResultStatus(linked('completed', 'in_progress')), 'in_progress');
  assert.equal(effectiveResultStatus(linked('completed', 'assigned')), 'pending');
  assert.equal(effectiveResultStatus(linked('completed', 'linked')), undefined);
  assert.equal(resultStateLabel(linked('linked')), '跟随项目任务');
  assert.equal(orderedResults([linked('completed'), linked('pending_review')])[0].linkedAssignments[0].status, 'pending_review');
});

test('disk storage enforces same-category merges, version races, author permissions and linked-task approval boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-four-disk-'));
  let actor = { username: 'alice', admin: true };
  const files = new ContentFiles(root, async () => actor), binding = { connectionId: 'c', host: 'local', port: 22, fingerprint: 'SHA256:fixture', username: 'alice', project: { id: offlineProjectId, name: '分类验证项目', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/trajectories/alice' } } as RemoteBinding;
  const source = path.join(root, 'source.md'); await fs.writeFile(source, 'evidence');
  try {
    const publish = (category: typeof materialCategories[number], n: string) => files.publish(binding, source, `/p/submissions/alice/${contributionCategoryInfo[category].folder}/${n}.md`, { title: n, description: '内容' + n, kind: 'contribution', category });
    const a = await publish('capability', 'a'), b = await publish('exploration', 'b');
    const merge = { sources: [a, b].map(item => ({ id: item.id, revision: item.revision })), replaceIds: [], title: 'merged', description: 'merged result' };
    await assert.rejects(files.merge(binding, merge), /同一分类/); assert.equal((await files.list(binding)).length, 2);
    const edited = (await files.edit(binding, { id: b.id, revision: b.revision, action: 'save', title: b.title, description: b.description, category: 'capability', curate: true, merge: [] }))!;
    assert.equal(edited.id, b.id); assert.equal((await files.history(binding, b.id))[0].category, 'exploration'); assert(edited.path.includes('/capabilities/'));
    await assert.rejects(files.merge(binding, merge), /已更新/);
    const combined = await files.merge(binding, { ...merge, sources: [a, edited].map(item => ({ id: item.id, revision: item.revision })), replaceIds: [a.id, edited.id], category: 'capability' });
    assert.equal(combined.category, 'capability'); assert.equal((await files.list(binding)).length, 1); assert.equal(combined.derivedFrom!.length, 2);
    actor = { username: 'alice', admin: false };
    await assert.rejects(files.edit(binding, { id: combined.id, revision: 1, action: 'save', title: 'bad', description: 'bad', curate: false, merge: [] }), /整理/);
    actor.admin = true; const todo = await publish('todo', 'todo');
    const duplicate = await publish('todo', 'duplicate');
    await assert.rejects(files.merge(binding, { sources: [todo, duplicate].map(item => ({ id: item.id, revision: 1 })), replaceIds: [], title: '合并待办', description: '同一事项' }), /独立事项/);
    const taskIndex = path.join(root, '.workbench-local', 'assignments', offlineProjectId + '.json'); await fs.mkdir(path.dirname(taskIndex), { recursive: true }); await fs.writeFile(taskIndex, JSON.stringify([{ id: randomUUID(), title: '验证任务', status: 'pending_review', assignee: 'alice', references: [{ id: todo.id }] }]));
    await assert.rejects(files.edit(binding, { id: todo.id, revision: 1, action: 'save', title: todo.title, description: todo.description, resultStatus: 'completed', curate: true, merge: [] }), /项目任务/);
    assert.equal((await files.list(binding)).find(item => item.id === todo.id)!.linkedAssignments!.length, 1);
    const tasks = JSON.parse(await fs.readFile(taskIndex, 'utf8')); tasks[0].references.push({ id: combined.id }); await fs.writeFile(taskIndex, JSON.stringify(tasks));
    assert.equal((await files.list(binding)).find(item => item.id === combined.id)!.linkedAssignments!.length, 0, 'a task reference must not impose todo lifecycle on a capability');
    actor = { username: 'bob', admin: false };
    assert.equal((await files.list(binding)).find(item => item.id === todo.id)!.linkedAssignments![0].title, '关联任务');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('SFTP result listing enriches linked todos and remains readable with older workers', async () => {
  const connection = new SftpConnection(() => {}), binding = { project: { id: offlineProjectId, remoteRoot: '/p' } } as RemoteBinding;
  const rows = [{ id: 'todo', category: 'todo', kind: 'contribution', title: '验证' }];
  Object.assign(connection, { storageVersion: 1, checked: async () => {}, channel: () => ({ readFile: (_: string, callback: Function) => callback(null, Buffer.from(JSON.stringify(rows))) }), request: async (data: any) => { assert.equal(data.op, 'content_task_links'); return { todo: [{ id: 't', status: 'pending_review' }] }; } });
  assert.equal((await connection.contentList(binding))[0].linkedAssignments![0].status, 'pending_review');
  Object.assign(connection, { request: async () => { throw new Error('不支持的内容操作'); } });
  assert.equal((await connection.contentList(binding))[0].id, 'todo');
  Object.assign(connection, { request: async () => { throw new Error('权限已撤销'); } });
  await assert.rejects(connection.contentList(binding), /权限已撤销/);
});
