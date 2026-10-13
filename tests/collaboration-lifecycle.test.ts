import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { Workbench } from '../src/core/workbench';
import { preparationSnapshot } from '../src/core/preparation-snapshot';
import { contributionStatus } from '../src/shared/contribution-status';
import type { AgentSession, Draft, Transfer } from '../src/shared/types';
import { execFileSync } from 'node:child_process';
import { gitRevision } from '../src/core/git-revision';
import { contributionBody } from '../src/core/artifacts';

const brief = { background: '团队改进资料提取', objectives: '改进可靠性', acceptance: '按项目验收', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-lifecycle-')), shared = path.join(root, 'share'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' });
  for (const label of ['relation', 'ocr']) await admin.operation({ op: 'group_create', label });
  for (const username of ['alice', 'bob', 'newbie']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: username === 'newbie' ? [] : ['local_relation', 'local_ocr'], contentAdminGroups: username === 'alice' ? ['local_relation'] : username === 'bob' ? ['local_ocr'] : [] });
  const clients: Workbench[] = [];
  const connect = async (name: string) => { const wb = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '1', root, async () => false); return wb; };
  const alice = await connect('alice'), bob = await connect('bob'), newbie = await connect('newbie');
  const project = await alice.createProject('实体抽取', 'local_relation', brief); await bob.refreshGroups();
  return { root, shared, admin, alice, bob, newbie, project, close: async () => { await Promise.all(clients.map(c => c.close())); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'team-lifecycle-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
async function done(transfer: Transfer) { const end = Date.now() + 5000; while (['queued', 'running'].includes(transfer.status)) { if (Date.now() > end) throw new Error('queue stalled'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('retracting an unsent team result removes the session reference but retains the personal copy and records the reversal', async () => {
  const x = await fixture();
  try {
    const binding = x.alice.remote.binding(x.project.id), file = path.join(x.root, 'result.md'); await fs.writeFile(file, '团队成果');
    await x.alice.remote.upload(binding, file, binding.project.uploadPath + '/result.md', () => {}, { kind: 'contribution', title: '低清晰度样本', description: '需要补样本' });
    const remote = (await x.alice.remote.contentList(binding))[0]; await x.bob.syncContentUpdates();
    await x.bob.importContentConclusion(x.project.id, remote.id, remote.revision);
    const session = await x.bob.createSession('codex', x.root, x.project.id), source = await x.bob.attachContent(session.id, remote.id);
    await x.bob.saveInput(session.id, { text: '继续', sourceIds: [source.id], answers: {} });
    assert.equal(x.bob.conclusions(x.project.id).length, 1);
    await x.bob.detachPendingSource(session.id, source.id);
    assert.equal(session.sources.some(item => item.id === source.id), false); assert.deepEqual(x.bob.store.inputs[session.id].sourceIds, []);
    assert.equal(x.bob.conclusions(x.project.id).length, 1);
    assert.deepEqual(x.bob.contentUpdates().find(item => item.id === remote.id)?.actions?.map(action => action.kind), ['saved_conclusion', 'attached_session', 'detached_session']);
    await assert.rejects(fs.stat(source.localPath), { code: 'ENOENT' });
    const again = await x.bob.attachContent(session.id, remote.id); assert.notEqual(again.id, source.id);
    assert.equal(x.bob.contentUpdates().find(item => item.id === remote.id)?.actions?.at(-1)?.kind, 'attached_session');
  } finally { await x.close(); }
});

test('team scans retire orphaned legacy choices only after complete reads, preserve private copies and delivered history', async () => {
  const x = await fixture();
  try {
    const binding = x.alice.remote.binding(x.project.id), file = path.join(x.root, 'retire.md'); await fs.writeFile(file, '团队成果');
    await x.alice.remote.upload(binding, file, binding.project.uploadPath + '/retire.md', () => {}, { kind: 'contribution', title: '共享结论', description: '已有验证依据' });
    const item = (await x.alice.remote.contentList(binding))[0];
    const ownerSession = await x.alice.createSession('codex', x.root, x.project.id), ownerRef = await x.alice.attachContent(ownerSession.id, item.id);
    await x.bob.importContentConclusion(x.project.id, item.id, item.revision);
    const s = await x.bob.createSession('codex', x.root, x.project.id), ref = await x.bob.attachContent(s.id, item.id);
    const local = x.bob.conclusions(x.project.id)[0], personalRef = await x.bob.attachConclusion(s.id, local.id);
    const legacy = { ...ref, id: randomUUID(), contentRef: undefined, sourcePath: binding.project.uploadPath + '/old-deleted.zip' }; s.sources.push(legacy);
    await x.bob.saveInput(s.id, { text: '继续', sourceIds: [ref.id, legacy.id], answers: {} });
    const delivered = await x.bob.createSession('codex', x.root, x.project.id), accepted = await x.bob.attachContent(delivered.id, item.id);
    delivered.messages.push({ id: randomUUID(), role: 'user', text: '已带入成果', createdAt: '', context: { nativeId: 'old-native', accepted: true, sourceHashes: { [accepted.id]: accepted.sha256 }, workRecord: false } });
    const messages = structuredClone(delivered.messages);
    const history = x.bob.remote.contentHistory.bind(x.bob.remote);
    const choices = () => x.bob.snapshot().sessions.find(value => value.id === s.id)!.sources.map(value => value.id);
    x.bob.remote.contentHistory = async () => { throw new Error('network failure'); };
    await x.bob.syncContentUpdates(); assert(choices().includes(legacy.id));
    x.bob.remote.contentHistory = async () => { throw new Error('不支持的内容操作'); };
    await x.bob.syncContentUpdates(); assert(choices().includes(legacy.id));
    x.bob.remote.contentHistory = history;
    await x.bob.syncContentUpdates(); assert(!choices().includes(legacy.id)); assert(choices().includes(ref.id));
    await x.alice.editSharedContent(x.project.id, { id: item.id, revision: item.revision, action: 'delete', curate: false, merge: [] });
    assert(!x.alice.snapshot().sessions.find(value => value.id === ownerSession.id)!.sources.some(value => value.id === ownerRef.id));
    await x.bob.syncContentUpdates();
    assert(!choices().includes(ref.id)); assert(choices().includes(personalRef.id), 'the independent personal copy remains available');
    assert.deepEqual(x.bob.snapshot().inputs[s.id].sourceIds, []);
    assert(x.bob.snapshot().sessions.find(value => value.id === delivered.id)!.sources.some(value => value.id === accepted.id));
    assert.deepEqual(delivered.messages, messages); assert(await fs.stat(accepted.localPath));
    await x.bob.deleteConclusion(local.id, local.version); assert(!choices().includes(personalRef.id));
    const restarted = new Workbench(x.bob.store.root, () => {}, () => {}); await restarted.store.init();
    assert(!restarted.snapshot().sessions.find(value => value.id === s.id)!.sources.some(value => [ref.id, legacy.id, personalRef.id].includes(value.id)));
    await restarted.close();
  } finally { await x.close(); }
});

test('personal activity actions show destinations, reject invalid transitions and preserve history across removal and restart', async () => {
  const x = await fixture();
  try {
    const binding = x.alice.remote.binding(x.project.id), file = path.join(x.root, 'personal.md'); await fs.writeFile(file, '个人处理记录');
    await x.alice.remote.upload(binding, file, binding.project.uploadPath + '/personal.md', () => {}, { kind: 'contribution', title: '数据覆盖约束', description: '需要补充低清晰度 OCR 样本。' });
    const remote = (await x.alice.remote.contentList(binding))[0], event = (await x.bob.syncContentUpdates()).find(item => item.id === remote.id)!;
    const sharedBefore = structuredClone(await x.alice.remote.contentList(binding));
    const local = (await x.bob.importContentConclusion(x.project.id, remote.id)).conclusion;
    assert.deepEqual(x.alice.conclusions(x.project.id), [], 'another member does not get the private copy');
    assert.deepEqual(await x.alice.remote.contentList(binding), sharedBefore, 'private import never rewrites shared content');
    assert.equal(event.actions?.[0].kind, 'saved_conclusion'); assert.equal(event.actions?.[0].targetId, local.id);
    const firstAction = structuredClone(event.actions![0]);
    await x.bob.importContentConclusion(x.project.id, remote.id); assert.deepEqual(event.actions, [firstAction]);
    const first = await x.bob.createSession('codex', x.root, x.project.id), second = await x.bob.createSession('codex', x.root, x.project.id);
    await x.bob.renameSession(first.id, '样本补全'); await x.bob.renameSession(second.id, '验收复核');
    const [a, duplicate] = await Promise.all([x.bob.attachContent(first.id, remote.id), x.bob.attachContent(first.id, remote.id)]);
    assert.equal(a.id, duplicate.id); assert.equal(first.sources.filter(source => source.contentRef?.id === remote.id).length, 1);
    delete a.contentRef; a.name = '旧版别名 · v' + remote.revision;
    assert.equal((await x.bob.attachContent(first.id, remote.id)).id, a.id, 'old snapshots without contentRef are reused by origin and revision');
    assert.equal(first.sources.filter(source => source.sourcePath === remote.path).length, 1);
    await x.bob.attachConclusion(second.id, local.id); await x.bob.attachConclusion(second.id, local.id);
    assert.deepEqual(event.actions?.filter(action => action.kind === 'attached_session').map(action => action.targetTitle), ['样本补全', '验收复核']);
    const recorded = structuredClone(event.actions); second.closedAt = new Date().toISOString();
    await assert.rejects(x.bob.attachContent(second.id, remote.id), /未关闭/);
    await assert.rejects(x.bob.attachLocal(second.id, [file]), /未关闭/);
    await assert.rejects(x.bob.attachRemote(second.id, x.project.id, remote.path), /未关闭/);
    assert.deepEqual(event.actions, recorded, 'rejected operations must not add success records');
    const closing = await x.bob.createSession('codex', x.root, x.project.id), list = x.bob.remote.contentList.bind(x.bob.remote);
    let release!: () => void, started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { started = resolve; });
    x.bob.remote.contentList = async (...args) => { const items = await list(...args); started(); await hold; return items; };
    const attaching = x.bob.attachContent(closing.id, remote.id); await reading; await x.bob.closeSession(closing.id); release();
    await assert.rejects(attaching, /未关闭/); x.bob.remote.contentList = list;
    assert.equal(closing.sources.some(source => source.contentRef?.id === remote.id), false);
    assert.deepEqual(event.actions, recorded, 'closing during the remote read must not attach or record success');

    await x.alice.editSharedContent(x.project.id, { id: remote.id, revision: remote.revision, action: 'save', title: remote.title, description: '新版还要求覆盖倾斜扫描件。', curate: true, merge: [] });
    const newer = (await x.bob.syncContentUpdates()).find(item => item.id === remote.id && item.revision === remote.revision + 1)!;
    const third = await x.bob.createSession('codex', x.root, x.project.id); await x.bob.attachConclusion(third.id, local.id);
    assert.equal(newer.readAt, undefined, 'attaching an old personal snapshot cannot handle a new remote revision'); assert.equal(newer.actions, undefined);
    await x.bob.importContentConclusion(x.project.id, remote.id); assert.equal(x.bob.contentUpdates().find(item => item.eventId === newer.eventId)?.actions?.[0].sourceRevision, newer.revision);
    const updatedSource = await x.bob.attachContent(first.id, remote.id);
    assert.notEqual(updatedSource.id, a.id, 'new versions must not be collapsed with legacy snapshots');
    assert.equal(updatedSource.contentRef?.revision, newer.revision);
    await x.bob.markContentUpdates([event.eventId], false);
    assert.equal(event.readAt, undefined, 'a member can reopen an already imported activity');
    await x.alice.editSharedContent(x.project.id, { id: remote.id, revision: newer.revision, action: 'delete', curate: true, merge: [] });
    const after = await x.bob.syncContentUpdates(), removed = after.find(item => item.id === remote.id && item.change === 'deleted')!;
    assert(after.find(item => item.eventId === event.eventId)?.unavailableAt, 'processed events survive shared removal');
    assert.deepEqual(after.find(item => item.eventId === event.eventId)?.actions, event.actions, 'reopened history survives shared removal too');
    assert.equal(removed.readAt, undefined); assert.equal(removed.actions, undefined);
    await x.bob.resolveContentDeletion(removed.eventId, []); assert.equal(x.bob.contentUpdates().find(item => item.eventId === removed.eventId)?.actions?.[0].kind, 'kept_conclusion');
    await x.bob.resolveContentDeletion(removed.eventId, [{ id: local.id, version: local.version }]); assert.equal(x.bob.contentUpdates().find(item => item.eventId === removed.eventId)?.actions?.at(-1)?.kind, 'deleted_conclusion');
    assert.equal(x.bob.conclusions(x.project.id).length, 0); assert(await fs.readFile(a.localPath, 'utf8'));
    const expected = JSON.parse(JSON.stringify(x.bob.contentUpdates())); await x.bob.close();
    const restored = new Workbench(x.bob.store.root, () => {}, () => {}); await restored.store.init();
    assert.deepEqual(restored.contentUpdates(), expected); await restored.close();
  } finally { await x.close(); }
});

test('bulk activity deletion keeps content, survives sync and does not lose concurrent new updates', async () => {
  const x = await fixture();
  try {
    const binding = x.alice.remote.binding(x.project.id), file = path.join(x.root, 'activity.md'); await fs.writeFile(file, '动态删除验证');
    for (const title of ['第一条', '第二条', '未选择']) await x.alice.remote.upload(binding, file, binding.project.uploadPath + '/' + title + '.md', () => {}, { kind: 'contribution', title, description: title + '的独立依据' });
    const remote = await x.alice.remote.contentList(binding), events = await x.bob.syncContentUpdates();
    const chosen = events.filter(item => item.title !== '未选择'), keep = events.find(item => item.title === '未选择')!;
    const local = (await x.bob.importContentConclusion(x.project.id, chosen[0].id)).conclusion;
    const session = await x.bob.createSession('codex', x.root, x.project.id), source = await x.bob.attachConclusion(session.id, local.id);
    const before = structuredClone(x.bob.conclusions(x.project.id, true)), seen = structuredClone(x.bob.store.settings.contentSeen);
    await x.bob.markContentUpdates([chosen[0].eventId]); await x.bob.dismissContentUpdates(events.map(item => item.eventId));
    await x.bob.deleteContentUpdates(chosen.map(item => item.eventId));
    assert.deepEqual(x.bob.contentUpdates().map(item => item.eventId), [keep.eventId]);
    assert.deepEqual(x.bob.store.settings.dismissedContentUpdateIds, [keep.eventId]);
    assert.deepEqual(x.bob.store.settings.contentSeen, seen);
    assert.deepEqual(await x.alice.remote.contentList(binding), remote);
    assert.deepEqual(x.bob.conclusions(x.project.id, true), before); assert(await fs.readFile(source.localPath, 'utf8'));
    assert.deepEqual((await x.bob.syncContentUpdates()).map(item => item.eventId), [keep.eventId]);
    const revised = remote.find(item => item.id === chosen[0].id)!;
    await x.alice.editSharedContent(x.project.id, { id: revised.id, revision: revised.revision, action: 'save', title: revised.title, description: '新的修订仍应通知', curate: true, merge: [] });
    // Hold a sync at its remote read, then delete the remaining event while it is in flight.
    const list = x.bob.remote.contentList.bind(x.bob.remote);
    let release!: () => void, started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { started = resolve; });
    x.bob.remote.contentList = async (...args) => { started(); await hold; return list(...args); };
    const syncing = x.bob.syncContentUpdates(); await reading; await x.bob.deleteContentUpdates([keep.eventId]); release();
    const after = await syncing; x.bob.remote.contentList = list;
    assert.equal(after.length, 1); assert.equal(after[0].change, 'updated'); assert.equal(after[0].id, revised.id);
    assert(!events.some(item => item.eventId === after[0].eventId));
    await x.bob.close();
    const restored = new Workbench(x.bob.store.root, () => {}, () => {}); await restored.store.init();
    assert.deepEqual(restored.contentUpdates().map(item => item.eventId), after.map(item => item.eventId));
    assert.deepEqual(restored.conclusions(x.project.id, true), before); await restored.close();
  } finally { await x.close(); }
});

test('shared deletions preserve local conclusions until explicit, version-checked choices', async () => {
  const x = await fixture();
  try {
    const binding = x.bob.remote.binding(x.project.id), file = path.join(x.root, 'retained.md'); await fs.writeFile(file, '保留依据');
    await x.bob.remote.upload(binding, file, binding.project.uploadPath + '/retained.md', () => {}, { kind: 'contribution', title: '待删除的共享结论', description: '即使管理员撤下，也由本地用户决定如何处理。' });
    const remote = (await x.bob.remote.contentList(binding))[0]; await x.bob.syncContentUpdates();
    const local = (await x.bob.importContentConclusion(x.project.id, remote.id)).conclusion;
    const adminLocal = (await x.alice.importContentConclusion(x.project.id, remote.id)).conclusion;
    await x.bob.saveContentAlias(x.project.id, remote.id, '共享条目的易读名称');
    await x.bob.saveConclusionAlias(local.id, '本地保留的名称');
    const mixed = await x.bob.createConclusion(x.project.id, '另有其他来源', '用户补充的独立结论');
    mixed.sources = [structuredClone(local.sources[0]), { id: 'manual-note', kind: 'manual', title: '人工验证', content: '其他独立依据', updatedAt: new Date().toISOString() }];
    const unrelated = await x.bob.createConclusion(x.project.id + '_other', '同 ID 的另一项目', '其他项目不允许从此动态删除');
    unrelated.sources = [structuredClone(local.sources[0])];
    const session = await x.bob.createSession('codex', x.root, x.project.id), frozen = await x.bob.attachConclusion(session.id, local.id);
    const before = structuredClone(x.bob.conclusions(x.project.id, true));
    await x.alice.editSharedContent(x.project.id, { id: remote.id, revision: remote.revision, action: 'delete', curate: true, merge: [] });
    assert(x.alice.conclusions(x.project.id).some(item => item.id === adminLocal.id), 'the deleting administrator also keeps a local copy');
    assert(x.alice.contentUpdates().some(item => item.change === 'deleted' && !item.readAt));
    const updates = await x.bob.syncContentUpdates(), event = updates.find(item => item.id === remote.id && item.change === 'deleted')!;
    assert(event && !event.readAt); assert.deepEqual(x.bob.conclusions(x.project.id, true), before);
    assert(Object.values(x.bob.store.settings.contentAliases!).includes('共享条目的易读名称'));
    assert.deepEqual(new Set(x.bob.deletedContentConclusions(event.eventId).map(item => item.id)), new Set([local.id, mixed.id]));
    await x.bob.resolveContentDeletion(event.eventId, []);
    assert.deepEqual(x.bob.conclusions(x.project.id, true), before, 'keep does not alter sources, content, aliases or archive state');
    await x.bob.syncContentUpdates(); assert.deepEqual(x.bob.conclusions(x.project.id, true), before);
    await assert.rejects(x.bob.resolveContentDeletion(event.eventId, [{ id: unrelated.id, version: unrelated.version }]), /已变化/);
    await assert.rejects(x.bob.resolveContentDeletion(event.eventId, [{ id: local.id, version: local.version + 1 }]), /已变化/);
    await x.bob.resolveContentDeletion(event.eventId, [{ id: local.id, version: local.version }]);
    assert.deepEqual(x.bob.conclusions(x.project.id, true).map(item => item.id), [mixed.id]);
    assert.equal(await fs.readFile(frozen.localPath, 'utf8').then(text => text.includes('由本地用户决定')), true);
    await x.bob.close();
    const restored = new Workbench(x.bob.store.root, () => {}, () => {}); await restored.store.init();
    assert.deepEqual(restored.conclusions(x.project.id, true).map(item => item.id), [mixed.id]);
    assert.equal(restored.conclusions(x.project.id + '_other')[0].id, unrelated.id); await restored.close();
  } finally { await x.close(); }
});

test('one SSH identity spans groups; author revisions, admin curation, merge and cross-group denials', async () => {
  const x = await fixture();
  try {
    assert.equal(x.bob.remote.workspaces.find(g => g.groupName === 'local_ocr')!.canCreateProject, true);
    assert.equal(x.bob.remote.workspaces.find(g => g.groupName === 'local_relation')!.canCreateProject, false);
    const b = x.bob.remote.binding(x.project.id), a = x.alice.remote.binding(x.project.id), file = path.join(x.root, 'conclusion.md'); await fs.writeFile(file, '初始结论');
    await x.bob.remote.upload(b, file, b.project.uploadPath + '/结论.md', () => {}, { kind: 'contribution', title: '方案结论', description: '初始结论' });
    let item = (await x.bob.remote.contentList(b))[0];
    item = (await x.bob.remote.contentEdit(b, { id: item.id, revision: item.revision, action: 'save', title: '补充证据', description: '原作者补充', curate: false, merge: [] }))!;
    assert.equal(item.state, 'submitted');
    item = (await x.alice.remote.contentEdit(a, { id: item.id, revision: item.revision, action: 'save', title: '项目采用结论', description: '整理后的内容', curate: true, merge: [] }))!;
    assert.equal(item.state, 'curated'); assert.equal(item.author, 'bob'); assert.equal(item.updatedBy, 'alice');
    await assert.rejects(x.bob.remote.contentEdit(b, { id: item.id, revision: item.revision, action: 'delete', curate: false, merge: [] }), /尚未被/);
    await assert.rejects(x.bob.remote.upload(b, file, item.path, () => {}), /自己的公共/);
    await assert.rejects(x.newbie.createSession('codex', x.root, x.project.id), /没有加入工作组/);
    assert.equal(x.newbie.workspaceReady, false);
    const other = await x.bob.createProject('OCR', 'local_ocr'); await x.alice.refreshGroups();
    await assert.rejects(x.alice.remote.saveProjectBrief(x.alice.remote.binding(other.id), brief, 0), /组管理员/);
    await x.bob.remote.upload(b, file, b.project.uploadPath + '/补充.md', () => {}, { kind: 'contribution', title: '新的补充', description: '补充' });
    const second = (await x.bob.remote.contentList(b)).find(i => i.id !== item.id)!;
    await assert.rejects(x.alice.remote.contentEdit(a, { id: item.id, revision: item.revision, action: 'save', title: '旧式合并', description: '不应保存', curate: true, merge: [{ id: second.id, revision: second.revision }] }), /旧版合并入口/);
    const merged = await x.alice.remote.contentMerge(a, { requestId: randomUUID(), sources: [{ id: item.id, revision: item.revision }, { id: second.id, revision: second.revision }], replaceIds: [item.id, second.id], title: '合并结论', description: '已合并' });
    assert.notEqual(merged.id, item.id); assert.notEqual(merged.id, second.id);
    assert.deepEqual(new Set(merged.sources), new Set([item.id, second.id])); assert.deepEqual(new Set(merged.provenance?.map(source => source.id)), new Set([item.id, second.id])); assert.equal((await x.bob.remote.contentList(b)).length, 1);
  } finally { await x.close(); }
});

test('concurrent revisions have one winner; lost upload acknowledgement retries without duplicate content', async () => {
  const x = await fixture();
  try {
    const b = x.bob.remote.binding(x.project.id), file = path.join(x.root, 'result.md'); await fs.writeFile(file, 'report');
    const original = x.bob.remote.upload.bind(x.bob.remote); let lost = true;
    x.bob.remote.upload = async (...args) => { const result = await original(...args); if (lost) { lost = false; throw new Error('injected acknowledgement loss'); } return result; };
    const transfer = await x.bob.queue.enqueue(file, b, b.project.uploadPath, 'upload', undefined, { title: '报告', description: '结论', kind: 'contribution' }); await done(transfer);
    assert.equal(transfer.status, 'error'); assert.equal((await x.bob.remote.contentList(b)).length, 1);
    assert.equal(contributionStatus({ submitted: transfer.id } as Draft, transfer), '上传失败');
    await x.bob.queue.retry(transfer.id); await done(transfer); assert.equal(transfer.status, 'done'); assert(transfer.completedAt);
    const item = (await x.bob.remote.contentList(b))[0];
    const edit = { id: item.id, revision: item.revision, action: 'save' as const, title: '修改', description: '新内容', curate: false, merge: [] };
    const results = await Promise.allSettled([x.bob.remote.contentEdit(b, edit), x.alice.remote.contentEdit(x.alice.remote.binding(x.project.id), { ...edit, curate: true })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await x.bob.remote.contentList(b)).length, 1);
  } finally { await x.close(); }
});

test('project briefs are independently versioned; a newer brief is adopted on the next send', async () => {
  const x = await fixture();
  try {
    const second = await x.alice.createProject('另一个项目', 'local_relation'); const a = x.alice.remote.binding(second.id);
    assert.equal((await x.alice.remote.projectBrief(a)).revision, 0);
    await x.alice.remote.saveProjectBrief(a, brief, 0);
    await assert.rejects(x.alice.remote.saveProjectBrief(a, brief, 0), /已更新/);
    await x.bob.refreshGroups(); const s = await x.bob.createSession('codex', x.root, second.id);
    assert.equal(s.projectBrief?.revision, 1); const snapshot = s.sources.find(f => f.id === s.projectBrief?.sourceId)!; const old = await fs.readFile(snapshot.localPath, 'utf8');
    await x.alice.remote.saveProjectBrief(a, { ...brief, objectives: '第二版目标' }, 1);
    assert.equal(await fs.readFile(snapshot.localPath, 'utf8'), old); assert.equal(s.projectBrief?.revision, 1);
    s.followProjectBrief = false; await x.bob.adoptLatestProjectBrief(s); assert.equal(s.projectBrief?.revision, 1);
    s.followProjectBrief = true; await x.bob.adoptLatestProjectBrief(s); assert.equal(s.projectBrief?.revision, 2);
    assert((await fs.readFile(s.sources.find(f => f.id === s.projectBrief?.sourceId)!.localPath, 'utf8')).includes('第二版目标'));
    x.bob.remote.disconnect(); const offline = await x.bob.createSession('codex', x.root, second.id); assert(offline.binding);
    // Disconnected work carries no time limit: the same project keeps accepting new offline sessions.
    assert(await x.bob.createSession('cursor', x.root, second.id));
  } finally { await x.close(); }
});

test('last subadministrator changes require a successor or explicit vacancy, preserving other groups', async () => {
  const x = await fixture();
  try {
    const op = { op: 'group_member' as const, username: 'alice', group: 'local_relation', role: 'member' as const };
    await assert.rejects(x.admin.operation(op), /最后|失去组管理员/);
    assert(x.admin.snapshot.state!.users.alice.contentAdminGroups?.includes('local_relation'));
    await x.admin.operation({ ...op, handoffs: { local_relation: 'bob' } });
    assert.deepEqual(new Set(x.admin.snapshot.state!.users.bob.contentAdminGroups), new Set(['local_relation', 'local_ocr']));
    await assert.rejects(x.admin.operation({ op: 'user_enabled', username: 'bob', enabled: false }), /组管理员/);
    await x.admin.operation({ op: 'user_enabled', username: 'bob', enabled: false, handoffs: { local_relation: null, local_ocr: null } });
    assert.equal(x.admin.snapshot.state!.users.bob.enabled, false);
  } finally { await x.close(); }
});

test('preparation freezes conversation independently of absent notes and later turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-snapshot-'));
  try {
    const s = { id: 'session', handoffPath: path.join(root, 'missing.md'), sources: [], messages: [{ id: 'm1', role: 'assistant', text: '只有对话里有的结论', createdAt: new Date().toISOString() }] } as unknown as AgentSession;
    const pending = preparationSnapshot(s, path.join(root, 'input')); s.messages[0].text = '后续变更';
    const result = await pending; assert.equal(result.snapshot.messageCount, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'input/conversation.json'), 'utf8'))[0].text, '只有对话里有的结论');
    assert(JSON.parse(await fs.readFile(path.join(root, 'input/source-index.json'), 'utf8')).noteWarning);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('trajectory deduplication, success timestamps and cache cleanup preserve source sessions', async () => {
  const x = await fixture();
  try {
    const s = await x.bob.createSession('codex', x.root, x.project.id);
    const [first, simultaneous] = await Promise.all([x.bob.archive(s.id), x.bob.archive(s.id)]); assert.equal(first.id, simultaneous.id); await done(first); assert.equal(first.status, 'done'); assert(s.lastArchiveAt);
    const second = await x.bob.archive(s.id); assert.equal(second.id, first.id);
    s.messages.push({ id: 'message', role: 'user', text: '新内容', createdAt: new Date().toISOString() });
    assert.equal(await x.bob.archive(s.id, true), undefined, 'automatic frequency is bounded');
    const third = await x.bob.archive(s.id); await done(third); assert.notEqual(third.id, first.id);
    const cleaned = await x.bob.cleanUploadCache(); assert.equal(cleaned.count, 2);
    assert(await fs.stat(s.handoffPath)); assert.equal(x.bob.store.sessions.length, 1);
    assert.equal((await x.alice.remote.contentList(x.alice.remote.binding(x.project.id))).filter(i => i.kind === 'trajectory').length, 2);
  } finally { await x.close(); }
});

test('file replacement respects author/admin revisions and reusable text snapshots keep source provenance', async () => {
  const x = await fixture();
  try {
    const b = x.bob.remote.binding(x.project.id), file = path.join(x.root, 'table.csv'); await fs.writeFile(file, 'v1');
    await x.bob.remote.upload(b, file, b.project.uploadPath + '/table.csv', () => {}, { kind: 'file', title: '统计结果', description: '统计说明' });
    const item = (await x.bob.remote.contentList(b))[0]; await fs.writeFile(file, 'v2');
    const change = { id: item.id, revision: 1, action: 'save' as const, title: '整理后的统计', description: '统一口径', curate: true, merge: [] };
    const replacement = await x.alice.remote.contentReplace(x.alice.remote.binding(x.project.id), change, file);
    assert.equal(replacement?.revision, 2); assert.equal(replacement?.state, 'curated');
    assert.equal((await x.bob.remote.preview(b, replacement!.path)).content, 'v2');
    await assert.rejects(x.bob.remote.contentReplace(b, { ...change, revision: 2, curate: false }, file), /尚未被/);
    const session = await x.bob.createSession('codex', x.root, x.project.id), source = await x.bob.attachContent(session.id, item.id);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /统一口径/); assert.equal(source.sourcePath, replacement?.path);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /维护人：alice/);
    const legacy = path.join(x.shared, ...b.project.remoteRoot.slice(1).split('/'), 'legacy.txt'); await fs.writeFile(legacy, '旧版共享资料');
    await assert.rejects(x.bob.remote.contentAdopt(b, b.project.remoteRoot + '/legacy.txt'), /组管理员/);
    const adopted = await x.alice.remote.contentAdopt(x.alice.remote.binding(x.project.id), b.project.remoteRoot + '/legacy.txt');
    assert.equal(adopted?.state, 'curated'); assert.match(adopted?.description || '', /旧版共享资料/);
  } finally { await x.close(); }
});

test('trajectory upload also sends current session files and skips unchanged copies', async () => {
  const x = await fixture();
  try {
    const s = await x.bob.createSession('codex', x.root, x.project.id);
    const report = path.join(x.root, 'notes.md'); await fs.writeFile(report, 'session evidence');
    s.messages.push({ id: randomUUID(), role: 'assistant', text: '结果写在 `notes.md`。', createdAt: new Date().toISOString() });
    const trajectory = await x.bob.archive(s.id);
    const uploaded = x.bob.store.transfers.find(item => item.kind === 'upload' && item.sessionId === s.id);
    assert.ok(uploaded); await done(trajectory); await done(uploaded);
    assert.equal(uploaded.metadata?.kind, 'file'); assert.equal(uploaded.metadata?.title, 'notes.md');
    assert.equal(uploaded.status, 'done'); assert.ok(uploaded.target.startsWith(s.binding!.project.historyPath + '/'));
    assert.equal(x.bob.store.transfers.filter(item => item.kind === 'upload').length, 1);
    await x.bob.archive(s.id);
    assert.equal(x.bob.store.transfers.filter(item => item.kind === 'upload').length, 1);
  } finally { await x.close(); }
});

test('automatic trajectory upload waits for its interval and includes tool-only changes', async () => {
  const x = await fixture();
  try {
    const s = await x.bob.createSession('codex', x.root, x.project.id); s.autoUpload = true; x.bob.store.settings.autoUploadMinutes = 1;
    const original = await x.bob.archive(s.id); await done(original);
    const dir = x.bob.store.sessionDir(s.id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'events.jsonl'), '{"tool":"new-evidence"}\n');
    s.lastTrajectoryQueuedAt = new Date(Date.now() - 59800).toISOString();
    assert.equal(await x.bob.archive(s.id, true), undefined);
    const deadline = Date.now() + 4000;
    while (x.bob.store.transfers.length !== 2) { assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 25)); }
    await done(x.bob.store.transfers[0]); assert.equal(x.bob.store.transfers[0].status, 'done'); assert.notEqual(x.bob.store.transfers[0].trajectoryHash, original.trajectoryHash);
  } finally { await x.close(); }
});

test('optional Git snapshot reports committed, dirty, unborn and non-repository directories without uploading code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-git-context-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    assert.equal(await gitRevision(root), undefined); git('init', '-b', 'main');
    assert.equal((await gitRevision(root))?.commit, undefined);
    await fs.writeFile(path.join(root, 'result.txt'), 'v1'); git('add', 'result.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
    const clean = (await gitRevision(root))!; assert.equal(clean.branch, 'main'); assert.equal(clean.commit, git('rev-parse', 'HEAD').trim()); assert.equal(clean.dirty, false);
    await fs.writeFile(path.join(root, 'result.txt'), 'v2'); const dirty = (await gitRevision(root))!; assert.equal(dirty.dirty, true);
    const draft = { body: '方向性结论', git: dirty, includeGit: true } as Draft;
    assert.match(contributionBody(draft), /commit 无法代表全部/); draft.includeGit = false; assert.equal(contributionBody(draft), '方向性结论');
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'team-git-context-'))); await fs.rm(root, { recursive: true, force: true }); }
});
