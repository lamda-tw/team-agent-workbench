import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { contentDeleteSelectionsSchema, type SharedContent } from '../src/shared/content';
import { SharedContentDeleteDialog, sharedDeleteSelection } from '../src/renderer/shared-content-delete';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-shared-delete-')), shared = path.join(root, 'share'); await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'delete' });
  for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_delete'], contentAdminGroups: username === 'alice' ? ['local_delete'] : [] });
  const clients: Workbench[] = [];
  const connect = async (name: string) => { const wb = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '1', root, async () => false); return wb; };
  const alice = await connect('alice'), bob = await connect('bob'), project = await syncedProject(alice, '批量删除验证', 'local_delete'); await bob.refreshGroups();
  const file = path.join(root, 'result.md'); await fs.writeFile(file, '需要保留的本地引用');
  const publish = async (wb: Workbench, title: string, kind: SharedContent['kind'] = 'contribution') => { const binding = wb.remote.binding(project.id); await wb.remote.upload(binding, file, (kind === 'trajectory' ? binding.project.historyPath : binding.project.uploadPath) + '/' + title + '.md', () => {}, { kind, title, description: title }); return (await wb.remote.contentList(binding)).find(item => item.title === title)!; };
  const list = () => alice.remote.contentList(alice.remote.binding(project.id));
  return { root, admin, alice, bob, project, publish, list, close: async () => { await Promise.all(clients.map(wb => wb.close())); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-shared-delete-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}
const selection = (items: SharedContent[]) => items.map(({ id, revision }) => ({ id, revision }));

test('bulk shared deletion respects roles and revisions, creates removal activity, and preserves local copies and Sessions', async () => {
  const x = await fixture();
  try {
    const a = await x.publish(x.alice, '管理员成果'), b = await x.publish(x.bob, '成员成果'), keep = await x.publish(x.bob, '未选择');
    await x.bob.syncContentUpdates();
    const local = (await x.bob.importContentConclusion(x.project.id, a.id)).conclusion;
    const session = await x.bob.createSession('codex', x.root, x.project.id), source = await x.bob.attachConclusion(session.id, local.id);
    await assert.rejects(x.bob.deleteSharedContents(x.project.id, selection([b, a])), /无权删除/);
    assert.equal((await x.list()).length, 3, 'a forbidden entry rejects the whole selection before any write');
    await assert.rejects(x.alice.deleteSharedContents(x.project.id, [{ id: a.id, revision: 2 }, { id: b.id, revision: 1 }]), /未删除任何内容/);
    await assert.rejects(x.alice.deleteSharedContents(x.project.id, [{ id: randomUUID(), revision: 1 }]), /不属于此项目/);
    const member = await x.bob.deleteSharedContents(x.project.id, selection([b])); assert.deepEqual(member.deletedIds, [b.id]);
    const result = await x.alice.deleteSharedContents(x.project.id, selection([a])); assert.deepEqual(result, { deletedIds: [a.id], remaining: [] });
    assert.deepEqual((await x.list()).map(item => item.id), [keep.id]);
    const updates = await x.bob.syncContentUpdates(); assert(updates.some(event => event.id === a.id && event.change === 'deleted'));
    assert.equal(x.bob.conclusions(x.project.id)[0].id, local.id); assert(await fs.readFile(source.localPath, 'utf8'));
    assert(x.bob.store.sessions.some(item => item.id === session.id));
    assert(x.alice.contentUpdates().some(event => event.id === a.id && event.change === 'deleted'));
    const curated = await x.publish(x.bob, '已整理');
    await x.alice.editSharedContent(x.project.id, { ...selection([curated])[0], action: 'save', title: curated.title, description: curated.description, curate: true, merge: [] });
    await assert.rejects(x.bob.deleteSharedContents(x.project.id, [{ id: curated.id, revision: 2 }]), /无权删除/);
    assert((await x.list()).some(item => item.id === curated.id));
    const file = await x.publish(x.bob, '共享文件', 'file'), history = await x.publish(x.bob, '上传轨迹', 'trajectory');
    const stored = path.join(x.root, 'share', ...history.path.split('/').filter(Boolean));
    const orphan = path.join(path.dirname(stored), 'left-behind.txt');
    await fs.writeFile(orphan, 'left');
    const projectFile = path.join(x.root, 'share', ...x.project.remoteRoot.split('/').filter(Boolean), '旁边文件.txt');
    await fs.writeFile(projectFile, 'keep');
    const files = await x.alice.deleteSharedContents(x.project.id, selection([file, history]));
    assert.deepEqual(files.deletedIds, [file.id, history.id]); assert.equal(files.error, undefined);
    assert((await x.list()).every(item => item.id !== file.id && item.id !== history.id));
    await assert.rejects(fs.stat(stored)); await assert.rejects(fs.stat(orphan));
    assert.equal(await fs.readFile(projectFile, 'utf8'), 'keep');
  } finally { await x.close(); }
});

test('bulk shared deletion stops at a later conflict and reports completed versus unattempted entries without rollback or retries', async () => {
  const x = await fixture();
  try {
    const entries = await Promise.all(['一', '二', '三'].map(title => x.publish(x.bob, title)));
    const edit = x.alice.remote.contentEdit.bind(x.alice.remote); let calls = 0;
    x.alice.remote.contentEdit = async (binding, change) => { calls++; if (calls === 2) throw new Error('内容已更新，请刷新'); return edit(binding, change); };
    const result = await x.alice.deleteSharedContents(x.project.id, selection(entries));
    assert.deepEqual(result.deletedIds, [entries[0].id]); assert.deepEqual(result.remaining, selection(entries.slice(1))); assert.match(result.error!, /已更新/);
    assert.equal(result.uncertainId, undefined); assert.equal(calls, 2);
    assert.deepEqual(new Set((await x.list()).map(item => item.id)), new Set(entries.slice(1).map(item => item.id)));
    x.alice.remote.contentEdit = edit;
    const retry = await x.alice.deleteSharedContents(x.project.id, result.remaining); assert.equal(retry.deletedIds.length, 2);
  } finally { await x.close(); }
});

test('lost acknowledgement is reconciled once; an unverifiable deletion is reported as uncertain and never automatically retried', async () => {
  const x = await fixture();
  try {
    const a = await x.publish(x.bob, '丢失应答'), b = await x.publish(x.bob, '未执行');
    const edit = x.alice.remote.contentEdit.bind(x.alice.remote), list = x.alice.remote.contentList.bind(x.alice.remote); let calls = 0;
    x.alice.remote.contentEdit = async (binding, change) => { calls++; await edit(binding, change); throw new Error('连接已断开'); };
    const result = await x.alice.deleteSharedContents(x.project.id, selection([a, b]));
    assert.deepEqual(result.deletedIds, [a.id]); assert.deepEqual(result.remaining, selection([b])); assert.match(result.error!, /该团队成果已删除/); assert.equal(calls, 1);
    assert.equal(x.alice.contentUpdates().filter(event => event.id === a.id && event.change === 'deleted').length, 1);
    x.alice.remote.contentEdit = async () => { calls++; x.alice.remote.contentList = async () => { throw new Error('无法连接'); }; throw new Error('请求超时'); };
    const unknown = await x.alice.deleteSharedContents(x.project.id, selection([b]));
    assert.deepEqual(unknown.deletedIds, []); assert.equal(unknown.uncertainId, b.id); assert.deepEqual(unknown.remaining, selection([b])); assert.equal(calls, 2);
    x.alice.remote.contentList = list; x.alice.remote.contentEdit = edit;
    assert((await x.list()).some(item => item.id === b.id));
    const save = x.alice.store.save.bind(x.alice.store);
    x.alice.store.save = async () => { throw new Error('本地磁盘不可写'); };
    try {
      const saved = await x.alice.deleteSharedContents(x.project.id, selection([b]));
      assert.deepEqual(saved.deletedIds, [b.id]); assert.deepEqual(saved.remaining, []); assert.match(saved.error!, /本地删除记录保存失败/);
      assert.equal(x.alice.contentUpdates().filter(event => event.id === b.id && event.change === 'deleted').length, 1, 'reconciliation does not duplicate the removal event');
    } finally { x.alice.store.save = save; await save(); }
  } finally { await x.close(); }
});

test('duplicate bulk requests are blocked and role revocation is rechecked by the existing server edit', async () => {
  const x = await fixture();
  try {
    const a = await x.publish(x.bob, '权限核对');
    const list = x.alice.remote.contentList.bind(x.alice.remote); let release!: () => void, started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { started = resolve; });
    x.alice.remote.contentList = async binding => { const items = await list(binding); started(); await hold; return items; };
    const first = x.alice.deleteSharedContents(x.project.id, selection([a])); await reading;
    await assert.rejects(x.alice.deleteSharedContents(x.project.id, selection([a])), /正在批量删除/);
    release(); await first; x.alice.remote.contentList = list;
    assert.deepEqual(await x.list(), []);
    const revoked = await x.publish(x.bob, '撤权后保留');
    const edit = x.alice.remote.contentEdit.bind(x.alice.remote);
    x.alice.remote.contentEdit = async (binding, change) => {
      await x.admin.operation({ op: 'user_groups', username: 'bob', groups: ['local_delete'], contentAdminGroups: ['local_delete'] });
      await x.admin.operation({ op: 'user_groups', username: 'alice', groups: ['local_delete'], contentAdminGroups: [] });
      return edit(binding, change);
    };
    const result = await x.alice.deleteSharedContents(x.project.id, selection([revoked]));
    assert.deepEqual(result.deletedIds, []); assert.deepEqual(result.remaining, selection([revoked])); assert.match(result.error!, /只能修改自己/);
    assert((await x.list()).some(item => item.id === revoked.id));
  } finally { await x.close(); }
});

test('bulk selection excludes hidden and unauthorized entries; confirmation names exact revisions and cannot delete on cancel', () => {
  const a = { id: randomUUID(), title: '自己的成果', author: 'bob', state: 'submitted', revision: 1 } as SharedContent;
  const b = { ...a, id: randomUUID(), title: '他人成果', author: 'alice' }, c = { ...a, id: randomUUID(), title: '已整理', state: 'curated' as const };
  assert.deepEqual(sharedDeleteSelection([a, b, c], [a.id, b.id, c.id], 'bob', false).selected, [a]);
  assert.deepEqual(sharedDeleteSelection([a], [a.id, b.id], 'alice', true).selected, [a]);
  assert.deepEqual(sharedDeleteSelection([a, b, c], [a.id, b.id, c.id], 'alice', true).selected, [a, b, c]);
  assert.throws(() => contentDeleteSelectionsSchema.parse([])); assert.throws(() => contentDeleteSelectionsSchema.parse(selection([a, a])));
  assert.throws(() => contentDeleteSelectionsSchema.parse(Array.from({ length: 101 }, () => ({ id: randomUUID(), revision: 1 }))));
  let deleted = false, canceled = false;
  const props = { items: [a, b], title: (item: SharedContent) => item.title, busy: false, error: '', close: () => { canceled = true; }, confirm: () => { deleted = true; } };
  const html = renderToStaticMarkup(createElement(SharedContentDeleteDialog, props));
  assert.match(html, /确认批量删除团队成果/); assert.match(html, /自己的成果/); assert.match(html, /他人成果/); assert.match(html, /v1/); assert.match(html, /确认删除 2 项团队成果/); assert.match(html, /正文和历史版本无法从库中恢复/); assert.match(html, /个人副本、本机整理记录、已发送的对话内容及任务和子会话的固定快照保留/); assert.match(html, /其他尚未发送的成果引用，在检测到删除后不再发送给模型/); assert.equal(deleted, false);
  const tree = SharedContentDeleteDialog(props), footer = tree.props.children.props.children.at(-1);
  footer.props.children[0].props.onClick(); assert.equal(canceled, true); assert.equal(deleted, false);
});
