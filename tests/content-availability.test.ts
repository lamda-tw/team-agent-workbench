import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { diskPath } from '../src/core/local-space';
import { hashFile } from '../src/core/artifacts';
import { inspectContentFiles } from '../src/core/content-files-state';
import { memberProfile } from './fixtures/member-profile';
import type { SharedContent } from '../src/shared/content';
import { ActivityResultActions } from '../src/renderer/activity-result-actions';
import { SftpConnection } from '../src/core/sftp';
import type { ContentUpdate } from '../src/shared/types';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-availability-')), shared = path.join(root, 'shared');
  await fs.mkdir(shared);
  const admin = new LocalAdminConnection(() => {}), alice = new Workbench(path.join(root, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(root, 'bob'), () => {}, () => {});
  await admin.connect({ mode: 'local', localRoot: shared, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'availability' });
  for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_availability'], contentAdminGroups: username === 'alice' ? ['local_availability'] : [] });
  for (const wb of [alice, bob]) { await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, wb === alice ? 'alice' : 'bob'), '1', root, async () => false); }
  const project = await alice.createProject('文件状态', 'local_availability'); await bob.refreshGroups();
  const binding = alice.remote.binding(project.id), local = path.join(root, 'result.md'); await fs.writeFile(local, '可信的原始记录');
  const publish = async (title: string, attachments?: SharedContent['attachments']) => {
    await alice.remote.upload(binding, local, binding.project.uploadPath + '/explorations/' + randomUUID() + '.md', () => {}, { kind: 'contribution', category: 'exploration', title, description: title, attachments });
    return (await alice.remote.contentList(binding)).find(item => item.title === title)!;
  };
  const close = async () => { await alice.close(); await bob.close(); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-availability-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); };
  return { root, shared, alice, bob, binding, project, local, publish, close };
}

test('deletion archives untouched and adopted activities, preserves actions, and yields one authoritative deletion per result', async () => {
  const x = await fixture();
  try {
    const used = await x.publish('已采用'), unread = await x.publish('未采用');
    await x.bob.syncContentUpdates();
    const saved = await x.bob.importContentConclusion(x.project.id, used.id);
    const original = x.bob.contentUpdates().find(event => event.id === used.id)!;
    const actions = structuredClone(original.actions), readAt = original.readAt;
    for (const item of [used, unread]) await x.alice.editSharedContent(x.project.id, { id: item.id, revision: item.revision, action: 'delete', merge: [], curate: false });
    await x.bob.syncContentUpdates(); await x.bob.syncContentUpdates();
    const updates = x.bob.contentUpdates();
    const untouched = updates.find(event => event.id === unread.id && event.change === 'new')!;
    assert(untouched.unavailableAt && untouched.readAt); assert.equal(untouched.archiveReason, 'content_deleted');
    const retained = updates.find(event => event.eventId === original.eventId)!;
    assert.equal(retained.readAt, readAt); assert.deepEqual(retained.actions, actions); assert(retained.unavailableAt);
    assert.equal(updates.filter(event => event.change === 'deleted').length, 2);
    assert.equal(updates.filter(event => !event.readAt && event.change !== 'deleted').length, 0);
    assert.equal(x.bob.conclusions(x.project.id)[0].id, saved.conclusion.id);
    assert.equal((await x.alice.remote.contentHistory(x.binding)).filter(item => item.deletedAt).length, 2);
  } finally { await x.close(); }
});

test('external file loss is not deletion, freezes unsent references, and recovers without erasing personal copies or delivered context', async () => {
  const x = await fixture();
  try {
    const item = await x.publish('外部文件状态'); await x.bob.syncContentUpdates();
    const unsent = await x.bob.createSession('codex', x.root, x.project.id), delivered = await x.bob.createSession('codex', x.root, x.project.id);
    await x.bob.importContentConclusion(x.project.id, item.id, item.revision);
    const source = await x.bob.attachContent(unsent.id, item.id), accepted = await x.bob.attachContent(delivered.id, item.id);
    delivered.messages.push({ id: 'delivered', role: 'user', text: '已发送', createdAt: '', context: { nativeId: 'fixture', accepted: true, workRecord: false, sourceHashes: { [accepted.id]: accepted.sha256 } } });
    const file = await diskPath(x.shared, item.path), bytes = await fs.readFile(file); await fs.unlink(file);
    await x.bob.syncContentUpdates(); await x.bob.syncContentUpdates();
    const missing = x.bob.contentUpdates().filter(event => event.change === 'files_missing');
    const restarted = new Store(x.bob.store.root); await restarted.init();
    assert.equal(restarted.settings.contentUpdates!.find(event => event.eventId === missing[0].eventId)!.files?.body, 'missing');
    assert.equal(missing.length, 1); assert.equal(x.bob.contentUpdates().filter(event => event.change === 'deleted').length, 0);
    assert.equal((await x.bob.remote.contentList(x.bob.remote.binding(x.project.id)))[0].id, item.id);
    assert.equal(unsent.sources.find(value => value.id === source.id)!.resultUnavailable, true);
    assert(!x.bob.snapshot().sessions.find(session => session.id === unsent.id)!.sources.some(value => value.id === source.id));
    assert(x.bob.snapshot().sessions.find(session => session.id === delivered.id)!.sources.some(value => value.id === accepted.id));
    assert(x.bob.conclusions(x.project.id).length); assert(await fs.readFile(source.localPath, 'utf8'));
    await assert.rejects(x.bob.importContentConclusion(x.project.id, item.id), /文件缺失/);
    await assert.rejects(x.bob.attachContent(unsent.id, item.id), /文件缺失/);
    const list = x.bob.remote.contentList.bind(x.bob.remote);
    x.bob.remote.contentList = async () => [{ ...item, files: { body: 'unverified', attachments: {} } }];
    await x.bob.syncContentUpdates(); assert.equal(unsent.sources.find(value => value.id === source.id)!.resultUnavailable, true);
    assert(!x.bob.contentUpdates().some(event => event.change === 'files_restored'));
    const before = structuredClone(x.bob.contentUpdates());
    x.bob.remote.contentList = async () => { throw new Error('网络中断'); };
    await x.bob.syncContentUpdates(); assert.deepEqual(x.bob.contentUpdates(), before);
    x.bob.remote.contentList = list; await fs.writeFile(file, bytes); await x.bob.syncContentUpdates(); await x.bob.syncContentUpdates();
    assert.equal(x.bob.contentUpdates().filter(event => event.change === 'files_restored').length, 1);
    assert(x.bob.contentUpdates().find(event => event.eventId === missing[0].eventId)!.readAt);
    assert(!unsent.sources.find(value => value.id === source.id)!.resultUnavailable);
    assert(x.bob.snapshot().sessions.find(session => session.id === unsent.id)!.sources.some(value => value.id === source.id));
    const index = await diskPath(x.shared, x.binding.project.remoteRoot + '/.workbench-content.json');
    const indexBytes = await fs.readFile(index), observations = structuredClone(x.bob.contentUpdates());
    await fs.unlink(index); await x.bob.syncContentUpdates();
    assert.deepEqual(x.bob.contentUpdates(), observations, 'a missing registry cannot prove deletion');
    await assert.rejects(x.bob.remote.contentList(x.bob.remote.binding(x.project.id)), /团队成果清单不存在/);
    await fs.writeFile(index, indexBytes);
  } finally { await x.close(); }
});

test('cleanup retains attachments in another result history, then frees them after that result is deleted', async () => {
  const x = await fixture();
  try {
    const hash = await hashFile(x.local), blob = await x.alice.remote.uploadAttachment(x.binding, x.local, hash, () => {}), attachment = { ...blob, name: '依据.md' };
    const owner = await x.publish('附件来源', [attachment]), other = await x.publish('历史引用', [attachment]);
    await x.alice.editSharedContent(x.project.id, { id: other.id, revision: other.revision, action: 'save', title: other.title, description: '新版本', merge: [], curate: false });
    const index = await diskPath(x.shared, x.binding.project.remoteRoot + '/.workbench-content.json');
    const items = JSON.parse(await fs.readFile(index, 'utf8')) as SharedContent[];
    items.find(item => item.id === other.id)!.attachments = [];
    await fs.writeFile(index, JSON.stringify(items));
    await x.alice.editSharedContent(x.project.id, { id: owner.id, revision: 1, action: 'delete', merge: [], curate: false });
    assert(await fs.readFile(await diskPath(x.shared, blob.path), 'utf8'));
    assert.equal((await x.alice.remote.contentHistory(x.binding, other.id, 1))[0].attachments![0].sha256, hash);
    await x.alice.editSharedContent(x.project.id, { id: other.id, revision: 2, action: 'delete', merge: [], curate: false });
    await assert.rejects(fs.stat(await diskPath(x.shared, blob.path, true)), /ENOENT/);
  } finally { await x.close(); }
});

test('observations deduplicate file probes and propagate transport errors; unavailable UI operations are disabled', async () => {
  const hash = 'a'.repeat(64), item = { id: 'one', path: '/p/body', attachments: [{ name: '证据.csv', path: '/p/blob', sha256: hash, size: 1 }] } as SharedContent;
  const calls: string[] = [];
  const checked = await inspectContentFiles([item, { ...item, id: 'two' }], async path => { calls.push(path); return path.endsWith('body') ? 'ok' : 'missing'; });
  assert.deepEqual(calls.sort(), ['/p/blob', '/p/body']);
  await assert.rejects(inspectContentFiles([item], async () => { throw new Error('连接断开'); }), /连接断开/);
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { workbench: {} };
  const { SharedAttachments } = await import('../src/renderer/attachments');
  const html = renderToStaticMarkup(createElement(SharedAttachments, { item: checked[0], projectId: 'p' }));
  (globalThis as any).window = previousWindow;
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  const event = { eventId: 'e', revision: 1 } as ContentUpdate;
  const blocked = renderToStaticMarkup(createElement(ActivityResultActions, { event, item: { ...checked[0], files: { body: 'missing', attachments: {} } }, changed: async () => {}, notice: () => {} }));
  assert.match(blocked, /disabled=""[^>]*>.*?存入个人成果库/); assert.match(blocked, /标记已处理/);
});

test('SSH batches checks by directory and distinguishes missing files, denied access and a broken connection', async () => {
  const remote = new SftpConnection(), hash = 'b'.repeat(64);
  const items = ['a', 'b'].map(id => ({ id, path: `/p/submissions/user/${id}.md`, attachments: [{ name: '依据', path: '/p/.workbench-attachments/user/' + hash, sha256: hash, size: 1 }] })) as SharedContent[];
  let mode = 'ok'; const directories: string[] = [];
  const channel = {
    readFile: (_path: string, callback: Function) => callback(undefined, Buffer.from(JSON.stringify(items))),
    readdir: (directory: string, callback: Function) => {
      directories.push(directory);
      if (mode === 'denied' || mode === 'down') return callback(Object.assign(new Error(mode), { code: mode === 'denied' ? 3 : 4 }));
      const names = directory.includes('.workbench-attachments') ? [hash] : mode === 'missing' ? ['b.md'] : ['a.md', 'b.md'];
      callback(undefined, names.map(filename => ({ filename, attrs: { isFile: () => true } })));
    }
  };
  (remote as any).channel = () => channel; (remote as any).checked = async () => '/p';
  const binding = { project: { remoteRoot: '/p' } } as any;
  assert((await remote.contentList(binding)).every(item => item.files?.body === 'ok'));
  assert.equal(directories.length, 2, 'two results and their shared attachment use two directory reads');
  mode = 'missing'; assert.equal((await remote.contentList(binding))[0].files?.body, 'missing');
  mode = 'denied'; assert((await remote.contentList(binding)).every(item => item.files?.body === 'unverified'));
  mode = 'down'; await assert.rejects(remote.contentList(binding), /down/);
});
