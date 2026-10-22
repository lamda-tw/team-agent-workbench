import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ownedLocalProjects } from '../src/shared/account-scope';
import { accountIdentity } from '../src/shared/account-data';
import { ProjectSync } from '../src/core/project-sync';
import { SyncConflicts } from '../src/core/sync-conflicts';
import { Workbench } from '../src/core/workbench';
import { SftpConnection } from '../src/core/sftp';
import { LocalHistoryProjects, LocalHistoryNotice } from '../src/renderer/local-history-projects';
import type { ConnectionProfile, Project, RemoteBinding, WorkbenchAPI } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const oldProject: Project = { id: 'project_' + 'a'.repeat(32), name: '原来的探索项目', groupName: 'old-group', remoteRoot: '/old/P', uploadPath: '/old/P/alice', historyPath: '/old/P/history' };
const newProject: Project = { ...oldProject, id: 'project_' + 'b'.repeat(32), groupName: 'new-group', remoteRoot: '/new/P', uploadPath: '/new/P/alice', historyPath: '/new/P/history' };
const alice: ConnectionProfile = { id: 'alice-login', name: '', host: 'central.test', port: 22, username: 'alice', fingerprint: 'verified-server', manifestPath: '', projects: [newProject] };
const binding = (project = oldProject, profile = alice): RemoteBinding => ({ connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project: structuredClone(project) });

test('retained local projects require the full account identity and never match a recreated project by name', () => {
  const records = [{ binding: binding() }, { binding: binding() }, { binding: binding(newProject) }, {},
    ...[{ username: 'bob' }, { host: 'elsewhere.test' }, { port: 2222 }, { fingerprint: 'another-server' }].map(change => ({ binding: binding({ ...oldProject, id: randomUUID() }, { ...alice, ...change }) }))];
  const projects = ownedLocalProjects(alice, records);
  assert.deepEqual(projects.map(project => project.id), [oldProject.id, newProject.id]);
  assert.notEqual(projects[0], records[0].binding!.project);
  projects[0].name = '本地视图'; assert.equal(records[0].binding!.project.name, oldProject.name);
  assert.deepEqual(ownedLocalProjects(undefined, records), []);
});

test('missing central projects keep local records and briefs through restart without creating or writing a remote project', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-retained-project-'));
  let central = [newProject], creates = 0, writes = 0;
  const reads: string[] = [], records = [{ binding: binding() }];
  const conflicts = new SyncConflicts(root, () => {});
  const host = { owner: () => accountIdentity(alice), projects: () => central, retainedProjects: () => ownedLocalProjects(alice, records), connected: () => true, changed: () => {},
    binding: (id: string) => { assert(central.some(project => project.id === id), 'history cannot obtain a shared binding'); return binding(central.find(project => project.id === id)!); },
    create: async () => { creates++; throw new Error('must not recreate history remotely'); },
    read: async (value: RemoteBinding) => { reads.push(value.project.id); return { revision: 0 }; },
    save: async () => { writes++; return {}; } };
  let sync = new ProjectSync(root, host, conflicts);
  t.after(async () => { await sync.close(); await conflicts.close(); await fs.rm(root, { recursive: true, force: true }); });
  await sync.init();
  assert.equal(sync.isHistoryOnly(oldProject.id), true);
  assert.deepEqual(sync.projects().map(project => project.id), [newProject.id, oldProject.id]);
  assert.equal(sync.states()[oldProject.id].localOnly, true);
  const original = structuredClone(records);
  const current = await sync.read(oldProject.id);
  await sync.save(oldProject.id, { background: '本地保存的说明', objectives: '继续探索', acceptance: '保留原来的对话和资料', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' }, current.revision);
  await sync.sync(); assert(!reads.includes(oldProject.id)); assert.equal(creates, 0); assert.equal(writes, 0);
  assert.equal(sync.states()[oldProject.id].pending, false); assert.deepEqual(records, original);
  await sync.close(); sync = new ProjectSync(root, host, conflicts); await sync.init();
  assert.equal((await sync.read(oldProject.id)).brief?.background, '本地保存的说明');
  assert.equal(sync.states()[oldProject.id].historyOnly, true);
  central = [newProject, oldProject];
  assert.equal(sync.isHistoryOnly(oldProject.id), false);
  await sync.sync(); assert(reads.includes(oldProject.id)); assert.equal(writes, 1, 'sync resumes only after the same project ID is accessible again');
});

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-local-history-'));
  let wb = new Workbench(path.join(root, 'data'), () => {}, () => {}), online = false;
  t.after(async () => { online = false; await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await wb.store.init(); grantTestWorkspace(wb, root);
  const session = await wb.createSession('codex', root, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  session.title = '连接前的本地对话'; session.messages.push({ id: randomUUID(), role: 'assistant', text: '之前已经得到的结果', createdAt: new Date().toISOString() });
  await wb.saveInput(session.id, { text: '未发送的问题', sourceIds: [], answers: {} });
  const savedBinding = structuredClone(session.binding!);
  const profile = { ...structuredClone(wb.store.settings.workspaceSnapshot!.profile), projects: [{ ...newProject, name: session.binding!.project.name }] };
  wb.store.settings.workspaceSnapshot!.profile = profile;
  Object.defineProperties(wb.remote, { connected: { get: () => online }, profile: { get: () => profile }, workspaces: { get: () => [] } });
  online = true; await wb.store.save();
  return { root, wb, session, profile, savedBinding, restart: async () => {
    online = false; await wb.close(); wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); wb.detect = async () => [];
    await wb.init(); return wb;
  } };
}

test('connecting with a new central project keeps old sessions, input and original bindings visible and usable', async t => {
  const { wb, session, profile, savedBinding } = await fixture(t);
  const snapshot = wb.snapshot();
  assert.equal(snapshot.connection?.connected, true);
  assert(snapshot.connection!.profile.projects.some(project => project.id === offlineProjectId));
  assert.equal(snapshot.projectSync?.[offlineProjectId].historyOnly, true);
  assert.equal(snapshot.sessions.find(value => value.id === session.id)?.messages[0].text, '之前已经得到的结果');
  assert.equal(snapshot.inputs[session.id].text, '未发送的问题');
  assert.equal(wb.projectBinding(offlineProjectId).project.id, offlineProjectId);
  assert.deepEqual(session.binding, savedBinding);
  assert.deepEqual(profile.projects.map(project => project.id), [newProject.id], 'central manifest remains authoritative and untouched');
  assert.doesNotThrow(() => wb.assertCanWork(session.binding));
  let sent = '';
  (wb as any).requireAuth = async () => {};
  (wb as any).runtime = async () => ({ ensureStarted: async () => {}, resolveCapabilities: async () => [], prompt: async (text: string) => { sent = text; return true; } });
  await wb.send(session.id, '继续这个本地对话'); assert.match(sent, /继续这个本地对话/);
  assert.deepEqual(session.binding, savedBinding);
  session.autoUpload = true;
  assert.equal(await wb.archive(session.id, true), undefined);
  await assert.rejects(wb.archive(session.id), /恢复原项目访问后才能上传轨迹/);
  assert.equal(wb.store.transfers.length, 0); assert.equal(session.autoUpload, true, 'history does not rewrite the saved upload choice');
  await wb.closeSession(session.id);
  assert.equal(wb.snapshot().projectSync?.[offlineProjectId].historyOnly, true, 'closed chats remain reachable');
});

test('saved local history survives restart and remains hidden after switching to another account or server identity', async t => {
  const { session, profile, restart } = await fixture(t);
  const restored = await restart();
  assert(restored.snapshot().settings.workspaceSnapshot?.profile.projects.some(project => project.id === offlineProjectId));
  assert.equal(restored.snapshot().inputs[session.id].text, '未发送的问题');
  assert.deepEqual(restored.session(session.id).binding, session.binding);
  for (const change of [{ username: 'bob' }, { fingerprint: 'different-server' }, { host: 'different.test' }, { port: 2222 }]) {
    restored.store.settings.workspaceSnapshot!.profile = { ...profile, ...change };
    const snapshot = restored.snapshot();
    assert(!snapshot.settings.workspaceSnapshot!.profile.projects.some(project => project.id === offlineProjectId));
    assert.equal(snapshot.sessions.length, 0); assert.equal(snapshot.inputs[session.id], undefined);
  }
});

test('showing an old project locally cannot grant its previous shared paths access through the current central connection', () => {
  const sftp = new SftpConnection(), channel = {};
  Object.assign(sftp, { profile: alice, sftp: channel });
  assert.equal(sftp.channel(binding(newProject)), channel);
  assert.throws(() => sftp.channel(binding()), /项目入口配置已改变/);
  assert.deepEqual(alice.projects.map(project => project.id), [newProject.id]);
});

test('local history has a labelled navigation entry and no shared recommendation control', () => {
  const call: WorkbenchAPI['call'] = async () => { throw new Error('render cannot access the central node'); };
  const html = renderToStaticMarkup(React.createElement(LocalHistoryProjects, { projects: [oldProject], selectedId: oldProject.id, select: () => {}, settings: () => {}, call }));
  assert.match(html, /本地历史项目/); assert.match(html, /原来的探索项目/); assert.match(html, /本地对话和草稿仍可使用/);
  assert.doesNotMatch(html, /推荐/);
  assert.equal(renderToStaticMarkup(React.createElement(LocalHistoryProjects, { projects: [], selectedId: '', select: () => {}, settings: () => {}, call })), '');
  const notice = renderToStaticMarkup(React.createElement(LocalHistoryNotice));
  assert.match(notice, /本机会话、草稿与个人成果仍可使用/);
});
