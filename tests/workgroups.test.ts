import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { SftpConnection } from '../src/core/sftp';
// @ts-expect-error Shared protocol fixture.
import { teamServer } from './fixtures/team-server.mjs';

test('local account automatically discovers assigned groups, tolerates no membership, and never rebinds existing sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-groups-')), share = path.join(root, 'share'); await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {}), owner = new Workbench(path.join(root, 'owner'), () => {}, () => {}), member = new Workbench(path.join(root, 'member'), () => {}, () => {});
  try {
    await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' });
    for (const label of ['ocr', 'nlp', 'secret']) await admin.operation({ op: 'group_create', label });
    await admin.operation({ op: 'user_create', username: 'alice', name: 'Alice', password: '1', groups: ['local_ocr', 'local_nlp'], contentAdminGroups: ['local_ocr', 'local_nlp'] });
    await admin.operation({ op: 'user_create', username: 'test1', name: 'Test', password: '1' });
    const config = (name: string) => memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name);
    await owner.store.init(); await member.store.init();
    await owner.configureWorkspace(config('alice'), '1', root, async () => false);
    await assert.rejects(syncedProject(owner, '同名项目'), /请选择.*工作组/);
    const ocr = await syncedProject(owner, '同名项目', 'local_ocr'), nlp = await syncedProject(owner, '同名项目', 'local_nlp');
    assert.notEqual(ocr.id, nlp.id); assert.equal(ocr.groupName, 'local_ocr'); assert.equal(nlp.groupName, 'local_nlp');
    const injected = { ...config('test1'), workPath: '/projects/secret', manifestPath: '/arbitrary.json', projects: [ocr] };
    await member.configureWorkspace(injected, '1', root, async () => false);
    assert.equal(member.workspaceReady, false); assert.equal(member.remote.workspaces.length, 0); assert.equal(member.remote.profile!.projects.length, 0);
    assert.equal(member.remote.profile!.workPath, ''); await assert.rejects(member.createSession('codex', root), /没有加入工作组/);
    await assert.rejects(syncedProject(member, '越权', 'local_secret'), /还没有加入工作组/);
    for (const group of ['local_ocr', 'local_nlp']) await admin.operation({ op: 'group_member', username: 'test1', group, role: group === 'local_ocr' ? 'admin' : 'member' });
    await member.refreshGroups();
    assert.deepEqual(member.remote.workspaces.map(w => w.groupName).sort(), ['local_nlp', 'local_ocr']);
    assert.equal(member.remote.profile!.projects.length, 2); assert(!member.remote.workspaces.some(w => w.groupName === 'local_secret'));
    assert.equal(member.remote.workspaces.find(w => w.groupName === 'local_ocr')!.canCreateProject, true);
    assert.equal(member.remote.workspaces.find(w => w.groupName === 'local_nlp')!.canCreateProject, false);
    await assert.rejects(syncedProject(member, '越权', 'local_nlp'), /组管理员/);
    const session = await member.createSession('codex', root, ocr.id), before = structuredClone(session.binding!);
    const own = await syncedProject(member, '新增项目', 'local_ocr'); assert.equal(own.groupName, 'local_ocr');
    await admin.operation({ op: 'group_member', username: 'test1', group: 'local_ocr', role: 'remove' });
    await assert.rejects(member.remote.list(before, ocr.remoteRoot), /不属于/);
    await member.refreshGroups();
    assert.deepEqual(member.remote.workspaces.map(w => w.groupName), ['local_nlp']);
    assert.deepEqual(member.remote.profile!.projects.map(p => p.id), [nlp.id]); assert.deepEqual(session.binding, before);
    await assert.rejects(member.remote.list(before, ocr.remoteRoot), /项目入口配置已改变/);
    await fs.rename(path.join(share, 'projects', 'nlp'), path.join(share, 'projects', 'nlp-missing'));
    await member.refreshGroups();
    assert.equal(member.remote.workspaces.length, 1); assert(member.remote.workspaces[0].accessError); assert.equal(member.remote.profile!.projects.length, 0);
    assert((await fs.stat(path.join(share, 'projects', 'ocr', '同名项目', 'trajectories'))).isDirectory());
  } finally { admin.disconnect(); await owner.close(); await member.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('SFTP accepts a Chinese workgroup name and still rejects unrecognised workspace paths', async () => {
  const server = await teamServer(), alice = new SftpConnection();
  server.nodes.set('/projects/实体抽取', { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
  server.state.memberships.alice = ['实体抽取'];
  try {
    await alice.connect({ ...server.profile('alice'), workPath: '/projects/实体抽取' }, 'test-password', async () => true);
    await alice.loadManifest();
    assert.equal(alice.workspaces.length, 1);
    const workspace = alice.workspaces[0];
    assert.match(workspace.groupName!, /^wb_test_g[a-f0-9]{13}$/);
    assert.equal(workspace.groupLabel, '实体抽取');
    assert.equal(workspace.path, '/projects/实体抽取'); assert(!workspace.accessError);
    // A path the client cannot recognise is still refused instead of being trusted.
    server.nodes.set('/projects/实体 抽取', { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
    server.state.memberships.alice = ['实体 抽取'];
    await assert.rejects(alice.loadManifest(), /无法识别/);
  } finally { alice.disconnect(); await server.close(); }
});

test('SFTP refresh reconnects the current login after an administrator changes membership or role', async () => {
  const server = await teamServer(), alice = new SftpConnection();
  server.nodes.set('/projects/nlp', { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
  try {
    await alice.connect(server.profile('alice'), 'test-password', async () => true);
    await alice.loadManifest(); assert.equal(alice.workspaces.length, 1);
    server.state.memberships.alice = ['ocr', 'nlp']; server.state.groupAdmins.nlp = ['alice'];
    await server.disconnectClients();
    const deadline = Date.now() + 3000;
    while (alice.connected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alice.connected, false);
    await alice.loadManifest();
    assert.equal(alice.connected, true); assert.deepEqual(alice.workspaces.map(group => group.groupName).sort(), ['wb_test_nlp', 'wb_test_ocr']);
    assert.equal(alice.workspaces.find(group => group.groupName === 'wb_test_nlp')!.canCreateProject, true);
  } finally { alice.disconnect(); await server.close(); }
});

test('SFTP discovers trusted memberships across groups, refreshes roles, isolates access errors and rejects legacy/untrusted metadata', async () => {
  const server = await teamServer(), alice = new SftpConnection(), bob = new SftpConnection();
  server.nodes.set('/projects/nlp', { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
  server.state.memberships.alice = ['ocr', 'nlp']; server.state.groupAdmins.nlp = ['alice']; server.state.memberships.bob = [];
  try {
    await alice.connect({ ...server.profile('alice'), workPath: '/projects/denied' }, 'test-password', async () => true);
    await alice.loadManifest(); assert.equal(alice.workspaces.length, 2);
    await assert.rejects(alice.createProject('同名项目'), /请选择.*工作组/);
    const ocr = await alice.createProject('同名项目', 'wb_test_ocr'), nlp = await alice.createProject('同名项目', 'wb_test_nlp');
    assert.notEqual(ocr.id, nlp.id); assert.equal(ocr.groupLabel, 'OCR'); assert.equal(nlp.groupLabel, 'NLP');
    await bob.connect({ ...server.profile('bob'), projects: [ocr] }, 'test-password', async () => true);
    assert.equal((await bob.loadManifest()).length, 0); assert.equal(bob.workspaces.length, 0);
    await assert.rejects(bob.verifyWorkspace('/projects/ocr'), /所属工作组/);
    server.state.memberships.bob = ['ocr', 'nlp']; await bob.loadManifest();
    assert.equal(bob.profile!.projects.length, 2); assert(bob.workspaces.every(w => !w.canCreateProject));
    await assert.rejects(bob.createProject('越权', 'wb_test_ocr'), /组管理员/);
    const binding = bob.binding(ocr.id);
    server.state.memberships.bob = ['nlp']; await assert.rejects(bob.list(binding, ocr.remoteRoot), /拒绝访问/);
    await bob.loadManifest(); assert.deepEqual(bob.profile!.projects.map(p => p.id), [nlp.id]);
    server.state.memberships.bob = ['nlp', 'denied']; await bob.loadManifest();
    assert.equal(bob.workspaces.length, 2); assert(bob.workspaces.find(w => w.groupName === 'wb_test_denied')!.accessError);
    assert.deepEqual(bob.profile!.projects.map(p => p.id), [nlp.id]);
    server.state.writableRoles = true; await assert.rejects(bob.loadManifest(), /不可信/); assert.equal(bob.workspaces.length, 0);
    server.state.writableRoles = false; server.state.legacyRoles = true;
    await assert.rejects(bob.loadManifest(), /新版管理员端/); assert.equal(bob.profile!.projects.length, 0);
    server.state.legacyRoles = false; await bob.loadManifest(); assert.equal(bob.workspaces.length, 2);
  } finally { alice.disconnect(); bob.disconnect(); await server.close(); }
});
