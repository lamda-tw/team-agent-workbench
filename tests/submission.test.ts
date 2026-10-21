import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { submissionRecord, destinationLabel, sourceLabel, activityText } from '../src/shared/submission';
import { contributionCategoryDirectory } from '../src/core/preparation';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { TransferQueue } from '../src/core/transfers';
import { hashFile } from '../src/core/artifacts';
import type { SharedFiles } from '../src/core/shared-files';
import type { AgentSession, Transfer, RemoteBinding } from '../src/shared/types';
import { SubmissionDetails } from '../src/renderer/submission-details';
import { TransferRecords } from '../src/renderer/transfer-records';

const brief = { background: '竞赛研发', objectives: '提高质量', acceptance: '固定评测集', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-submission-')), shared = path.join(root, 'shared'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' });
  for (const label of ['竞赛组', 'OCR组']) await admin.operation({ op: 'group_create', label });
  const groups = Object.keys(admin.snapshot.state!.groups);
  for (const name of ['alice', 'bob']) await admin.operation({ op: 'user_create', username: name, name, password: '123', groups, contentAdminGroups: name === 'alice' ? groups : [] });
  const connect = async (name: string) => {
    const wb = new Workbench(path.join(root, name), () => {}, () => {}); await wb.store.init();
    await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '123', root, async () => false); return wb;
  };
  const alice = await connect('alice'), bob = await connect('bob');
  const first = await syncedProject(alice, '优化项目', groups[0], brief), second = await syncedProject(alice, '优化项目', groups[1], brief); await bob.refreshGroups();
  return { root, admin, alice, bob, first, second, close: async () => { await alice.close(); await bob.close(); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-submission-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
async function completed(task: Transfer) {
  const deadline = Date.now() + 6000;
  while (task.status === 'queued' || task.status === 'running') { if (Date.now() > deadline) throw Error('传输超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(task.status, 'done', task.error || '');
}

test('session snapshot provenance stays fixed through later turns, renaming, upload retry and application restart in two groups', async () => {
  const x = await fixture();
  try {
    const session = await x.bob.createSession('codex', x.root, x.first.id); session.title = '量化误差分析';
    session.messages.push({ id: randomUUID(), role: 'user', text: '比较不同量化方案', createdAt: new Date().toISOString() });
    // Exercise snapshot/queue/storage without running a real model.
    (x.bob as any).runPreparation = async (draft: any) => { draft.generation = 'ready'; };
    const draft = await x.bob.prepare(session.id, [], ['exploration'], 'full');
    session.title = '后来更名'; session.messages.push({ id: randomUUID(), role: 'user', text: '继续讨论，但不加入这次提交', createdAt: new Date().toISOString() });
    const folder = contributionCategoryDirectory(draft.binding!, 'exploration');
    draft.artifacts = [{ id: randomUUID(), title: '误差比较', category: 'exploration', fields: { result: '误差下降' }, body: '误差下降', target: folder, selected: true }];
    const original = x.bob.remote.upload.bind(x.bob.remote); let lost = true;
    x.bob.remote.upload = async (...args) => { const receipt = await original(...args); if (lost) { lost = false; throw Error('模拟丢失回执'); } return receipt; };
    const transfer = await x.bob.submitDraft(draft.id); const deadline = Date.now() + 6000;
    while (transfer.status !== 'error') { if (Date.now() > deadline) throw Error('未收到预期失败'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const frozen = structuredClone(transfer.metadata!.submission!);
    assert.equal(frozen.sources[0].title, '量化误差分析'); assert.equal(frozen.sources[0].snapshotHash, draft.snapshot!.conversationHash);
    // Another active group/session must never retarget the old failed upload.
    await x.bob.createSession('codex', x.root, x.second.id);
    const store = new Store(x.bob.store.root); await store.init();
    assert.deepEqual(store.transfers.find(item => item.id === transfer.id)!.metadata!.submission, frozen);
    const restoredQueue = new TransferQueue(store, x.bob.remote, () => {}), recovered = store.transfers.find(item => item.id === transfer.id)!;
    await restoredQueue.retry(recovered.id); await completed(recovered);
    const results = await x.bob.remote.contentList(draft.binding!); assert.equal(results.length, 1);
    assert.equal(results[0].submission!.destination.projectId, x.first.id);
    assert.equal(results[0].submission!.submittedBy, 'bob'); assert.deepEqual(results[0].submission!.sources, frozen.sources);
    assert.deepEqual(recovered.submission, results[0].submission);
    assert.equal((await x.bob.remote.contentList(x.bob.remote.binding(x.second.id))).length, 0);
    await x.alice.syncContentUpdates(); const event = x.alice.contentUpdates().find(item => item.id === results[0].id)!;
    assert.deepEqual(event.submission, results[0].submission);
    await x.alice.store.save(); const restored = new Store(x.alice.store.root); await restored.init();
    assert.deepEqual(restored.settings.contentUpdates!.find(item => item.eventId === event.eventId)!.submission, event.submission);
  } finally { await x.close(); }
});

test('personal sharing publishes only the selected result version; private ancestors are opt-in; files keep their original name', async () => {
  const x = await fixture();
  try {
    const result = await x.bob.createConclusion(x.first.id, '探索发现', '当前已观察到的结果', 'exploration');
    result.derivedFrom = [{ scope: 'personal', projectId: x.first.id, id: randomUUID(), version: 1 }];
    const task = await x.bob.publishConclusion(result.id); result.title = '之后的名称'; result.version++;
    await completed(task); assert.deepEqual(task.submission!.sources, [{ kind: 'personal_result', id: result.id, title: '【探索记录】 探索发现', version: 1, projectId: x.first.id }]);
    const shared = (await x.bob.remote.contentList(task.binding))[0]; assert.equal(shared.disclosedSources, undefined);
    assert(!JSON.stringify(shared.submission).includes(result.derivedFrom[0].id));
    const file = path.join(x.root, '结果表.csv'); await fs.writeFile(file, 'setting,value\na,1');
    const secondBinding = x.bob.remote.binding(x.second.id);
    await x.bob.uploadFiles(secondBinding, secondBinding.project.uploadPath, [file]);
    const fileTask = x.bob.store.transfers.find(item => item.metadata?.kind === 'file')!; await completed(fileTask);
    assert.equal(fileTask.name, '结果表.csv'); assert.equal(fileTask.submission!.destination.projectId, x.second.id);
    assert.deepEqual(fileTask.submission!.sources, [{ kind: 'file', title: '结果表.csv' }]);
    await assert.rejects(x.bob.publishConclusion(result.id, [], 1), /已更新/);
    const trajectory = await x.bob.remote.upload(secondBinding, file, secondBinding.project.historyPath + '/track.zip', () => {}, { kind: 'trajectory', title: '会话轨迹', description: '' });
    await x.alice.syncContentUpdates(); assert(!x.alice.contentUpdates().some(item => item.id === trajectory.id));
  } finally { await x.close(); }
});

test('personal upload blocks double clicks, persists success and allows a genuinely updated version', async () => {
  const x = await fixture(); let release = () => {};
  try {
    const result = await x.bob.createConclusion(x.first.id, '并发分享验证', '固定版本内容', 'exploration');
    const original = x.bob.queue.enqueue.bind(x.bob.queue);
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {}; const reached = new Promise<void>(resolve => { entered = resolve; });
    x.bob.queue.enqueue = async (...args) => { entered(); await held; return original(...args); };
    const pending = x.bob.publishConclusion(result.id, [], result.version); await reached;
    assert.equal(x.bob.conclusionUploadState(result.id).status, 'running');
    await assert.rejects(x.bob.publishConclusion(result.id), /正在上传/);
    release(); const task = await pending; await completed(task);
    assert.equal(x.bob.conclusionUploadState(result.id).status, 'done');
    await assert.rejects(x.bob.publishConclusion(result.id), /当前版本已上传/);
    await x.bob.saveConclusionAlias(result.id, '本地别名');
    assert.equal(x.bob.conclusionUploadState(result.id).status, 'done');
    await x.bob.store.save(); const restored = new Store(x.bob.store.root); await restored.init();
    assert.equal(restored.conclusions.find(item => item.id === result.id)!.publication!.version, 1);
    const records = (x.bob.accountSync as any).collect(x.bob.remote.profile);
    assert.equal(records['material:' + result.id].publication.version, 1, 'account synchronization keeps the success marker');
    const updated = await x.bob.saveConclusion(result.id, result.title, '有新的验证依据', result.category, undefined, result.version);
    assert.equal(x.bob.conclusionUploadState(result.id).status, 'ready');
    const next = await x.bob.publishConclusion(result.id, [], updated.version); await completed(next);
    assert.equal(next.submission!.sources[0].version, 2);
    assert.equal((await x.bob.remote.contentList(task.binding)).length, 2);
    const imported = await x.alice.importContentConclusion(x.first.id, (await x.alice.remote.contentList(x.alice.remote.binding(x.first.id)))[0].id);
    assert.equal(x.alice.conclusionUploadState(imported.conclusion.id).status, 'done');
    await assert.rejects(x.alice.publishConclusion(imported.conclusion.id), /当前版本已上传/);
    await x.alice.saveConclusion(imported.conclusion.id, imported.conclusion.title, '加入管理员自己的新分析', imported.conclusion.category);
    assert.equal(x.alice.conclusionUploadState(imported.conclusion.id).status, 'ready');
  } finally { release(); await x.close(); }
});

test('failed personal upload retries the original receipt instead of generating a second public result', async () => {
  const x = await fixture();
  try {
    const result = await x.bob.createConclusion(x.first.id, '失败重试验证', '已冻结的正文', 'exploration');
    const original = x.bob.remote.upload.bind(x.bob.remote); let lost = true;
    x.bob.remote.upload = async (...args) => { const receipt = await original(...args); if (lost) { lost = false; throw Error('模拟丢失回执'); } return receipt; };
    const task = await x.bob.publishConclusion(result.id); const deadline = Date.now() + 6000;
    while (task.status !== 'error') { if (Date.now() > deadline) throw Error('未收到失败'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.deepEqual(x.bob.conclusionUploadState(result.id), { status: 'error', transferId: task.id });
    const target = task.target, requestId = task.requestId, source = structuredClone(task.metadata!.submission);
    const accepted = (await x.bob.remote.contentList(task.binding))[0].submission;
    await x.bob.createSession('codex', x.root, x.second.id);
    const retried = await x.bob.publishConclusion(result.id, [], result.version); assert.equal(retried, task); await completed(retried);
    assert.equal(task.target, target); assert.equal(task.requestId, requestId); assert.deepEqual(task.metadata!.submission!.sources, source!.sources);
    assert.deepEqual(task.submission, accepted, 'retry keeps the original server-accepted record and timestamp');
    assert.equal(x.bob.store.transfers.filter(value => !value.attachment).length, 1);
    assert.equal((await x.bob.remote.contentList(task.binding)).length, 1);
    assert.equal((await x.bob.remote.contentList(x.bob.remote.binding(x.second.id))).length, 0);
    assert.equal(x.bob.conclusionUploadState(result.id).status, 'done');
    await assert.rejects(x.bob.publishConclusion(result.id), /当前版本已上传/);
  } finally { await x.close(); }
});

test('a failed success-record save leaves the personal result retryable and never creates another remote copy', async () => {
  const x = await fixture();
  try {
    const result = await x.bob.createConclusion(x.first.id, '成功记录保存失败', '固定正文', 'exploration');
    const original = x.bob.store.save.bind(x.bob.store); let failOnce = true;
    x.bob.store.save = async () => {
      if (failOnce && x.bob.store.transfers.some(task => task.phase === 'completed')) { failOnce = false; throw Error('模拟本机保存失败'); }
      return original();
    };
    const task = await x.bob.publishConclusion(result.id); const deadline = Date.now() + 6000;
    while (task.status !== 'error') { if (Date.now() > deadline) throw Error('未收到保存失败'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert(result.publication); assert.equal(x.bob.conclusionUploadState(result.id).status, 'error');
    const retried = await x.bob.publishConclusion(result.id); assert.equal(retried, task); await completed(retried);
    assert.equal(x.bob.conclusionUploadState(result.id).status, 'done');
    assert.equal((await x.bob.remote.contentList(task.binding)).length, 1);
  } finally { await x.close(); }
});

test('server authority rejects identity/target mismatches, retains original submitter on curation, and derives exact public merge versions', async () => {
  const x = await fixture();
  try {
    const binding = x.bob.remote.binding(x.first.id), file = path.join(x.root, 'source.md'); await fs.writeFile(file, 'source');
    const record = submissionRecord(binding, [{ kind: 'manual' }]);
    for (const bad of [{ ...record, submittedBy: 'alice' }, { ...record, destination: { ...record.destination, projectId: x.second.id } }, { ...record, destination: { ...record.destination, groupName: x.second.groupName } }]) {
      await assert.rejects(x.bob.remote.upload(binding, file, binding.project.uploadPath + '/bad.md', () => {}, { kind: 'contribution', title: '伪造记录', description: 'text', submission: bad }), /提交账号或目标/);
    }
    const sources = [];
    for (const name of ['a', 'b']) sources.push(await x.bob.remote.upload(binding, file, binding.project.uploadPath + `/${name}.md`, () => {}, { kind: 'contribution', title: name, description: 'text', submission: record }));
    const a = sources[0], adminBinding = x.alice.remote.binding(x.first.id);
    const curated = await x.alice.editSharedContent(x.first.id, { id: a.id, revision: 1, action: 'save', title: '管理员更新标题', description: '整理内容', curate: true, merge: [] });
    assert.deepEqual(curated!.submission, a.submission); assert.equal(curated!.updatedBy, 'alice');
    await x.bob.syncContentUpdates();
    const merged = await x.alice.remote.contentMerge(adminBinding, { sources: [{ id: a.id, revision: 2 }, { id: sources[1].id, revision: 1 }], replaceIds: [a.id], title: '统一发现', description: '合并证据' });
    assert.equal(merged.submission!.submittedBy, 'alice');
    assert.deepEqual(merged.submission!.sources.map(source => [source.kind, source.title, source.version, source.author]), [['team_result', '管理员更新标题', 2, 'bob'], ['team_result', 'b', 1, 'bob']]);
    await x.bob.syncContentUpdates();
    const superseded = x.bob.contentUpdates().find(item => item.id === a.id && item.change === 'superseded');
    assert(superseded); await x.bob.store.save(); const restored = new Store(x.bob.store.root); await restored.init(); assert.deepEqual(restored.settings.contentUpdates!.find(item => item.eventId === superseded.eventId), JSON.parse(JSON.stringify(superseded)));
    await x.alice.editSharedContent(x.first.id, { id: merged.id, revision: 1, action: 'delete', curate: false, merge: [] });
    const tombstone = (await x.alice.remote.contentHistory(adminBinding, merged.id, undefined, true)).find(item => item.deletedAt)!;
    assert.equal(tombstone.deletedBy, 'alice'); assert.deepEqual(tombstone.submission, merged.submission);
  } finally { await x.close(); }
});

test('legacy unknown sources stay unknown and full origin/destination details are initially collapsed', () => {
  const html = renderToStaticMarkup(createElement(SubmissionDetails, { legacyAuthor: 'bob', updatedBy: 'alice', revision: 3 }));
  assert.match(html, /<details[^>]*><summary>来源与历史/); assert.doesNotMatch(html, /open=|手工提交|手动编写/);
  assert.match(html, /未记录来源/); assert.match(html, /未记录目标/); assert.match(html, /最近维护/);
  assert.equal(sourceLabel({ kind: 'unknown' }), '未记录来源'); assert.equal(sourceLabel({ kind: 'manual' }), '手动编写');
  assert.equal(activityText({ title: '误差评估', author: 'bob', updatedBy: 'alice', change: 'updated' }), 'alice 更新了《误差评估》');
  const p = { id: 'a', name: '优化', groupName: 'g1', groupLabel: '竞赛组', remoteRoot: '/a', uploadPath: '/a/s', historyPath: '/a/t' };
  assert.equal(destinationLabel(p, [p]), '优化'); assert.equal(destinationLabel(p, [p, { ...p, id: 'b', groupName: 'g2' }]), '竞赛组 / 优化');
  const binding = { username: 'bob', project: p } as RemoteBinding;
  const task = { id: 't', kind: 'upload', name: 'internal.zip', metadata: { title: '误差评估', description: '', kind: 'contribution' }, binding, target: '/a/s/report.zip', status: 'done', bytes: 10, total: 10, createdAt: new Date().toISOString(), projectName: '优化' } as Transfer;
  const transferHtml = renderToStaticMarkup(createElement(TransferRecords, { transfers: [task], retry: () => {} }));
  assert.match(transferHtml, /上传 · 误差评估/); assert.doesNotMatch(transferHtml, /internal.zip|@undefined|<progress/);
  assert(transferHtml.indexOf('查看详情') < transferHtml.indexOf('提交人'));
});

test('queue captures origin and destination before async hashing; later caller mutations cannot alter the upload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-submission-freeze-'));
  try {
    const file = path.join(root, 'result.md'); await fs.writeFile(file, 'content');
    const store = new Store(root); await store.init();
    const binding: RemoteBinding = { connectionId: 'c', host: 'local', port: 22, fingerprint: 'SHA256:fixture', username: 'alice', project: { id: 'p1', name: '原项目', groupName: 'g1', groupLabel: '原工作组', remoteRoot: '/p1', uploadPath: '/p1/submissions/alice', historyPath: '/p1/trajectories/alice' } };
    const metadata = { kind: 'contribution' as const, title: '原成果', description: '原正文', submission: submissionRecord(binding, [{ kind: 'personal_result', id: randomUUID(), title: '原个人成果', version: 2, projectId: 'p1' }]) };
    const remote = {
      loadManifest: async () => [], channel: () => ({}), ensurePersonalFolder: async () => {},
      upload: async (received: RemoteBinding, _file: string, target: string, progress: (bytes: number, total: number) => void, meta: typeof metadata, sha256: string) => {
        assert.equal(received.project.id, 'p1'); assert.equal(received.project.name, '原项目');
        assert.equal(meta.title, '原成果'); assert.equal(meta.submission.sources[0].version, 2);
        const size = (await fs.stat(file)).size; progress(size, size);
        return { path: target, author: 'alice', size, sha256, submission: meta.submission };
      }
    } as unknown as SharedFiles;
    const queue = new TransferQueue(store, remote, () => {}), pending = queue.enqueue(file, binding, binding.project.uploadPath, 'upload', undefined, metadata);
    binding.project.id = 'p2'; binding.project.name = '另一项目'; metadata.title = '后来改名'; metadata.submission.sources[0].version = 9;
    const transfer = await pending; await completed(transfer);
    assert.equal(transfer.submission!.destination.projectName, '原项目'); assert.equal(transfer.metadata!.title, '原成果');
    await store.save(); const restored = new Store(root); await restored.init(); assert.deepEqual(restored.transfers[0].submission, transfer.submission);
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'wb-submission-freeze-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('merged project-material workflows preserve attached files and exact origins through session, personal and team publication', async () => {
  const x = await fixture();
  try {
    const session = await x.bob.createSession('codex', x.root, x.first.id); session.title = '比赛资料整理';
    session.messages.push({ id: randomUUID(), role: 'user', text: '整理样例与说明', createdAt: new Date().toISOString() });
    (x.bob as any).runPreparation = async (draft: any) => { draft.generation = 'ready'; };
    // Reviewed material records from older clients still retain attachment and provenance support.
    const draft = await x.bob.prepare(session.id, [], ['exploration'], 'full');
    draft.resultRules = { contract: 3, categories: ['project_material'] };
    const artifactId = randomUUID();
    draft.artifacts = [{ id: artifactId, title: '竞赛样例说明', category: 'project_material', fields: { subject: '样例', usage: '验证输入格式' }, body: '样例用于验证输入格式', target: contributionCategoryDirectory(draft.binding!, 'project_material'), selected: true }];
    const file = path.join(x.root, 'samples.csv'); await fs.writeFile(file, 'sample,label\n1,A');
    await x.bob.addDraftFiles(draft.id, [file], artifactId);
    const [personal] = await x.bob.saveDraftPersonal(draft.id, [artifactId]);
    assert.equal(personal.localFiles!.length, 1);
    session.title = '另一阶段的会话名';
    const sessionUpload = await x.bob.submitDraft(draft.id);
    assert.notEqual(x.bob.conclusionUploadState(personal.id).status, 'ready', 'saving personally then sharing the same draft cannot create a second upload');
    await completed(sessionUpload);
    assert.equal(sessionUpload.submission!.sources[0].title, '比赛资料整理');
    assert.equal(sessionUpload.metadata!.category, 'project_material'); assert.equal(sessionUpload.metadata!.attachments!.length, 1);
    assert.equal(x.bob.conclusionUploadState(personal.id).status, 'done');
    await assert.rejects(x.bob.publishConclusion(personal.id, [], personal.version), /当前版本已上传/);
    const independent = await x.bob.createConclusion(x.first.id, '独立样例复盘', '本次额外验证的格式边界', 'project_material');
    await x.bob.addConclusionFiles(independent.id, [file]);
    const sharedPersonal = await x.bob.publishConclusion(independent.id, [], independent.version); await completed(sharedPersonal);
    assert.equal(sharedPersonal.submission!.sources[0].kind, 'personal_result'); assert.equal(sharedPersonal.submission!.sources[0].version, independent.version);
    assert.equal(sharedPersonal.metadata!.attachments!.length, 1);

    const second = await x.bob.createConclusion(x.first.id, '样例用途补充', '覆盖边界说明', 'project_material');
    const mergedDraft = await x.bob.prepareConclusionMerge(x.first.id, session.id, [personal.id, second.id], '合并资料说明');
    mergedDraft.title = '合并样例资料'; mergedDraft.body = '样例用于检查格式，完整性能仍需验证。';
    await x.bob.addDraftFiles(mergedDraft.id, [file]);
    const personalMerge = await x.bob.submitConclusionMerge(mergedDraft.id); await completed(personalMerge);
    assert.deepEqual(personalMerge.submission!.sources.map(source => [source.kind, source.id, source.version]), [['personal_result', personal.id, personal.version], ['personal_result', second.id, second.version]]);
    assert.equal(personalMerge.metadata!.attachments!.length, 1);
    assert(!personalMerge.submission!.sources.some(source => source.id === session.id));

    const binding = x.bob.remote.binding(x.first.id), items = await x.bob.remote.contentList(binding);
    const originals = [sessionUpload, sharedPersonal].map(task => items.find(item => item.path === task.target)!);
    const adminBinding = x.alice.remote.binding(x.first.id), extra = path.join(x.root, 'scope.txt'); await fs.writeFile(extra, '覆盖范围');
    const extraFile = await x.alice.remote.uploadAttachment(adminBinding, extra, await hashFile(extra), () => {});
    const team = await x.alice.remote.contentMerge(adminBinding, { sources: originals.map(item => ({ id: item.id, revision: item.revision })), replaceIds: [], title: '团队比赛资料', description: '统一资料入口', category: 'project_material', attachments: [{ name: 'scope.txt', ...extraFile }] });
    assert.equal(team.category, 'project_material'); assert.equal(team.attachments!.length, 2);
    assert.deepEqual(team.submission!.sources.map(source => [source.kind, source.id, source.version]), originals.map(item => ['team_result', item.id, item.revision]));
    assert.equal(team.submission!.submittedBy, 'alice');
  } finally { await x.close(); }
});
