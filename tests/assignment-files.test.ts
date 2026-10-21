import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { memberProfile } from './fixtures/member-profile';
import { hashFile } from '../src/core/artifacts';
import { resolveAssignmentFile } from '../src/core/assignment-blobs';
import { assignmentCreateSchema } from '../src/shared/assignments';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-task-files-')), shared = path.join(root, 'shared'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {}), clients: Workbench[] = [];
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'team' });
  for (const username of ['alice', 'bob', 'carol']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_team'], contentAdminGroups: username === 'alice' ? ['local_team'] : [] });
  const client = async (username: string) => { const wb = new Workbench(path.join(root, username), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, username), '1', root, async () => false); return wb; };
  const alice = await client('alice'), project = await syncedProject(alice, '附件任务', 'local_team'), bob = await client('bob'), carol = await client('carol');
  return { root, shared, admin, alice, bob, carol, project, close: async () => { for (const wb of clients) await wb.close(); admin.disconnect(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

test('tasks carry selected shared files and local snapshots, deduplicate only within an identical permission scope, and freeze files into sessions', async () => {
  const env = await setup();
  try {
    const { root, alice, bob, carol, project, shared } = env, binding = alice.remote.binding(project.id), local = path.join(root, '证据.csv'), original = 'id,result\n1,pass';
    await fs.writeFile(local, original); const sha256 = await hashFile(local), attachment = await alice.remote.uploadAttachment(binding, local, sha256, () => {});
    await alice.remote.upload(binding, local, binding.project.uploadPath + '/findings/result.md', () => {}, { kind: 'contribution', category: 'finding', title: '【项目结论】 样本验证', description: '验证当前样本。', attachments: [{ ...attachment, name: '证据.csv' }] });
    const result = (await alice.remote.contentList(binding))[0], id = randomUUID(), picked = await alice.selectAssignmentFiles(project.id, id, [local]);
    await fs.writeFile(local, 'changed after file selection');
    const input = { id, title: '核实依据', description: '核实当前样本', acceptance: '', assignee: 'bob', references: [{ id: result.id, revision: result.revision }], uploadIds: picked.map(file => file.id) };
    const task = await alice.createAssignment(project.id, input);
    assert.equal(task.files?.length, 1, 'identical name and contents in linked results/local files are one task reference');
    assert.equal(task.files![0].md5, createHash('md5').update(original).digest('hex'));
    assert.equal((await alice.createAssignment(project.id, input)).id, task.id, 'retry remains idempotent after staging cleanup');
    assert.equal((await alice.remote.contentList(binding)).length, 1, 'private task uploads are not public results');
    const download = path.join(root, 'download.csv'); await bob.remote.assignmentDownload(bob.remote.binding(project.id), task.id, task.files![0].id, download); assert.equal(await fs.readFile(download, 'utf8'), original);
    await assert.rejects(carol.remote.assignmentDownload(carol.remote.binding(project.id), task.id, task.files![0].id, path.join(root, 'denied')), /无权/);
    const same = await alice.createAssignment(project.id, { ...input, id: randomUUID(), uploadIds: [] });
    const other = await alice.createAssignment(project.id, { ...input, id: randomUUID(), assignee: 'carol', uploadIds: [] });
    const firstBlob = await resolveAssignmentFile(shared, project.id, 'bob', task.id, task.files![0]);
    const sameBlob = await resolveAssignmentFile(shared, project.id, 'bob', same.id, same.files![0]);
    const otherBlob = await resolveAssignmentFile(shared, project.id, 'carol', other.id, other.files![0]);
    assert.equal(firstBlob, sameBlob); assert.notEqual(firstBlob, otherBlob); assert.notEqual(task.files![0].path, same.files![0].path);
    await assert.rejects(resolveAssignmentFile(shared, project.id, 'bob', task.id, { ...task.files![0], path: other.files![0].path }), /路径/);
    const withoutFiles = await alice.createAssignment(project.id, { ...input, id: randomUUID(), uploadIds: [], references: [{ id: result.id, revision: 1, attachmentHashes: [] }] }); assert.equal(withoutFiles.files?.length, 0);
    await fs.writeFile(local, original);
    await alice.remote.upload(binding, local, binding.project.uploadPath + '/standalone.csv', () => {}, { kind: 'file', title: '独立共享文件', description: '直接关联文件，不需要先创建结论。' });
    const standalone = (await alice.remote.contentList(binding)).find(item => item.kind === 'file')!;
    const fileTask = await alice.createAssignment(project.id, { ...input, id: randomUUID(), uploadIds: [], references: [{ id: standalone.id, revision: 1 }] });
    assert.equal(fileTask.references[0].kind, 'file'); assert.equal(fileTask.files?.length, 1);
    const fileSession = await bob.startAssignment(project.id, fileTask.id, 1, 'codex', root); assert.equal(fileSession.sources.length, 2); assert.equal(bob.conclusions(project.id).length, 0, 'binary/shared files are not imported as text conclusions');
    await assert.rejects(alice.createAssignment(project.id, { ...input, id: randomUUID(), uploadIds: [], references: [{ id: result.id, revision: 1, attachmentHashes: ['a'.repeat(64)] }] }), /附件已变化/);
    await alice.editSharedContent(project.id, { id: result.id, revision: 1, action: 'delete', curate: true, merge: [] });
    const session = await bob.startAssignment(project.id, task.id, task.revision, 'codex', root);
    const source = session.sources.find(source => source.sourcePath.startsWith(`assignment:${task.id}:file:`)); assert(source);
    assert.equal(await fs.readFile(source.localPath, 'utf8'), original); assert(session.assignment?.sourceIds.includes(source.id)); assert.equal(session.messages.length, 0);
    assert.equal((await bob.startAssignment(project.id, task.id, 1, 'codex', root)).id, session.id);
    const review = await bob.updateAssignment(project.id, { id: task.id, revision: 2, status: 'pending_review', submission: { summary: '已核实依据。', references: [], uploadIds: [] } });
    const finished = await alice.updateAssignment(project.id, { id: task.id, revision: review.revision, status: 'completed' }); assert.equal(finished.status, 'completed');
    await bob.remote.assignmentDownload(bob.remote.binding(project.id), task.id, task.files![0].id, path.join(root, 'completed.csv'));
    await fs.writeFile(firstBlob, 'tampered blob');
    await assert.rejects(bob.remote.assignmentDownload(bob.remote.binding(project.id), task.id, task.files![0].id, path.join(root, 'corrupt.csv')), /校验失败/);
    assert.equal(await fs.readFile(source.localPath, 'utf8'), original, 'already-used session file remains independent');
  } finally { await env.close(); }
});

test('review submissions survive rejection and deletion; purge preserves sessions, results and other tasks sharing a blob', async () => {
  const env = await setup();
  try {
    const { root, shared, alice, bob, carol, project } = env, binding = alice.remote.binding(project.id), bb = bob.remote.binding(project.id);
    const local = path.join(root, 'proof.txt'); await fs.writeFile(local, 'frozen proof');
    const attachment = await alice.remote.uploadAttachment(binding, local, await hashFile(local), () => {});
    await alice.remote.upload(binding, local, binding.project.uploadPath + '/verifications/result.md', () => {}, { kind: 'contribution', category: 'verification', title: '【验证结果】 候选不优于基线', description: '对照表支持不继续的判断。', attachments: [{ ...attachment, name: 'proof.txt' }] });
    const result = (await alice.remote.contentList(binding))[0];
    const input = { id: randomUUID(), title: '评估候选', description: '判断是否继续', acceptance: '提供可核实的对照', assignee: 'bob', references: [{ id: result.id, revision: result.revision }] };
    const first = await alice.createAssignment(project.id, input), second = await alice.createAssignment(project.id, { ...input, id: randomUUID() });
    const blob = await resolveAssignmentFile(shared, project.id, 'bob', first.id, first.files![0]);
    const session = await bob.startAssignment(project.id, first.id, 1, 'codex', root), source = session.sources.find(item => item.sourcePath.includes(':file:'))!;
    assert.equal(bob.conclusions(project.id).length, 1);
    const selectionId = randomUUID(), files = await bob.selectAssignmentFiles(project.id, first.id, [local], selectionId);
    await fs.writeFile(local, 'changed after selection');
    await assert.rejects(carol.selectAssignmentFiles(project.id, first.id, [local], randomUUID()), /组管理员/);
    await assert.rejects(alice.selectAssignmentFiles(project.id, first.id, [local], randomUUID()), /负责人/);
    await assert.rejects(bob.updateAssignment(project.id, { id: first.id, revision: 2, status: 'completed' }), /组管理员/);
    const submit = { id: first.id, revision: 2, status: 'pending_review' as const, selectionId, submission: { summary: '已比较，候选不优于基线，不继续。', references: [{ id: result.id, revision: 1 }], uploadIds: files.map(file => file.id) } };
    await assert.rejects(bob.updateAssignment(project.id, { ...submit, submission: { ...submit.submission, references: [{ id: result.id, revision: 999 }] } }), /已更新/);
    assert.equal((await bob.remote.assignmentList(bb)).find(task => task.id === first.id)?.status, 'in_progress');
    let task = await bob.updateAssignment(project.id, submit);
    assert.equal(task.status, 'pending_review'); assert.equal(task.submissions?.length, 1); assert.equal(task.submissions![0].files.length, 1);
    await assert.rejects(bob.startAssignment(project.id, task.id, task.revision, 'codex', root), /验收/);
    await assert.rejects(bob.selectAssignmentFiles(project.id, task.id, [local], randomUUID()), /进行中/);
    await assert.rejects(alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'in_progress' }), /原因/);
    task = await alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'in_progress', reason: '补充适用范围' });
    assert.equal(task.history?.at(-1)?.by, 'alice');
    assert.equal((await bob.startAssignment(project.id, task.id, task.revision, 'codex', root)).id, session.id);
    task = await bob.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'pending_review', submission: { summary: '仅在当前样本范围内不优于基线，依据见上次附件。', references: [], uploadIds: [] } });
    task = await alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'completed', reason: '按探索目标验收通过' });
    assert.equal(task.submissions?.length, 2); assert.equal(task.submissions![0].references[0].category, 'verification');
    const downloaded = path.join(root, 'review-proof.txt'); await bob.remote.assignmentDownload(bb, task.id, task.submissions![0].files[0].id, downloaded); assert.equal(await fs.readFile(downloaded, 'utf8'), 'frozen proof');
    await assert.rejects(bob.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'deleted' }), /组管理员/);
    task = await alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'deleted' });
    assert(!(await bob.remote.assignmentList(bb)).some(item => item.id === task.id));
    assert((await alice.remote.assignmentList(binding)).some(item => item.id === task.id && item.deletedAt));
    assert.equal(await fs.readFile(blob, 'utf8'), 'frozen proof');
    await assert.rejects(bob.remote.assignmentDownload(bb, task.id, first.files![0].id, path.join(root, 'denied-deleted')), /无权/);
    task = await alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'restored' });
    assert.equal(task.status, 'completed'); assert.equal(task.submissions?.length, 2);
    assert((await bob.remote.assignmentList(bb)).some(item => item.id === task.id));
    task = await alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'deleted' });
    const purged = await alice.updateAssignment(project.id, { id: task.id, revision: task.revision, status: 'purged' });
    assert(purged.purgedAt); assert.equal(purged.title, '');
    assert(!(await alice.remote.assignmentList(binding)).some(item => item.id === task.id));
    await assert.rejects(alice.createAssignment(project.id, input), /已删除|进行中|派发附件/);
    await assert.rejects(alice.updateAssignment(project.id, { id: task.id, revision: purged.revision, status: 'restored' }), /不存在/);
    assert.equal(await resolveAssignmentFile(shared, project.id, 'bob', second.id, second.files![0]), blob);
    assert.equal(await fs.readFile(source.localPath, 'utf8'), 'frozen proof'); assert.equal(bob.session(session.id).id, session.id); assert.equal(bob.conclusions(project.id).length, 1);
    assert((await alice.remote.contentList(binding)).some(item => item.id === result.id));
    await assert.rejects(alice.updateAssignment(project.id, { id: second.id, revision: 1, status: 'deleted' }), /状态/);
    let cancelled = await alice.updateAssignment(project.id, { id: second.id, revision: 1, status: 'cancelled', reason: '重复任务' });
    cancelled = await alice.updateAssignment(project.id, { id: second.id, revision: cancelled.revision, status: 'deleted' });
    assert.equal(await fs.readFile(blob, 'utf8'), 'frozen proof', 'recoverable tasks retain their attachments');
    await alice.updateAssignment(project.id, { id: second.id, revision: cancelled.revision, status: 'purged' });
    await assert.rejects(fs.stat(blob), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(shared, attachment.path), 'utf8'), 'frozen proof', 'shared result attachment is not a task blob');
    assert.equal(await fs.readFile(source.localPath, 'utf8'), 'frozen proof');
  } finally { await env.close(); }
});

test('local attachment selection is account/request bound and lost create acknowledgement does not duplicate the task', async () => {
  const env = await setup();
  try {
    const { alice, bob, root, project } = env, file = path.join(root, 'manual.txt'), id = randomUUID(); await fs.writeFile(file, 'manual evidence');
    await assert.rejects(bob.selectAssignmentFiles(project.id, id, [file]), /组管理员/);
    const selected = await alice.selectAssignmentFiles(project.id, id, [file]);
    const input = { id, title: '只有附件的任务', description: '阅读所附材料', acceptance: '', assignee: 'bob', references: [], uploadIds: [selected[0].id] };
    await assert.rejects(alice.createAssignment(project.id, { ...input, id: randomUUID() }), /快照缺失/);
    assert.equal(assignmentCreateSchema.safeParse({ ...input, uploadIds: [selected[0].id, selected[0].id] }).success, false);
    const create = alice.remote.assignmentCreate.bind(alice.remote); let once = true;
    alice.remote.assignmentCreate = async (...args) => { const value = await create(...args); if (once) { once = false; throw new Error('lost acknowledgement'); } return value; };
    await assert.rejects(alice.createAssignment(project.id, input), /lost acknowledgement/);
    const saved = await alice.createAssignment(project.id, input); assert.equal(saved.files?.length, 1);
    assert.equal((await alice.remote.assignmentList(alice.remote.binding(project.id))).length, 1);
    (globalThis as any).window = { workbench: { call: async () => [] } };
    const { AssignmentsPanel } = await import('../src/renderer/assignments');
    const html = renderToStaticMarkup(createElement(AssignmentsPanel, { project, admin: false, username: 'bob', items: [saved], loading: false, loadError: '', refresh: async () => {}, start: () => {}, sessions: [], aliases: {} }));
    assert.match(html, /任务关联文件/); assert.match(html, /manual.txt/); assert.match(html, /下载附件/); assert.match(html, /开始工作时自动加入会话/);
    const source = await fs.readFile('src/renderer/assignments.tsx', 'utf8'); for (const label of ['另外附文件', '关联文件：', '确认派发时上传', '选择本地文件']) assert(source.includes(label));
  } finally { delete (globalThis as any).window; await env.close(); }
});
