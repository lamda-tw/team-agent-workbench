import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../src/core/workbench';
// @ts-expect-error JavaScript protocol fixture shared with the Electron smoke test.
import { teamServer } from './fixtures/team-server.mjs';

test('automatic assigned workspace discovery, scoped project creation and trajectory upload', async () => {
  const server = await teamServer(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-workspace-'));
  const alice = new Workbench(path.join(root, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(root, 'bob'), () => {}, () => {});
  try {
    await alice.store.init(); await bob.store.init();
    await assert.rejects(alice.createSession('codex', root), /验证/);
    assert.equal(alice.workspaceReady, false);
    await alice.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true);
    assert.equal(alice.store.settings.localWorkspace, '');
    assert.equal(alice.workspaceReady, true); assert.equal(alice.remote.workspace!.canCreateProject, true);
    const project = await syncedProject(alice, '实体抽取');
    assert(server.nodes.has('/projects/ocr/实体抽取/trajectories'));
    assert.equal(project.historyPath, '/projects/ocr/实体抽取/trajectories/alice');
    assert.equal(project.uploadPath, '/projects/ocr/实体抽取/submissions/alice');
    await assert.rejects(syncedProject(alice, '实体抽取'), /已存在/);
    assert(server.nodes.has('/projects/ocr/实体抽取/.workbench-project.json'));
    server.state.failFolder = 'trajectories';
    await assert.rejects(alice.remote.createProject('失败项目'), /未创建成功/);
    assert.equal(server.nodes.has('/projects/ocr/失败项目'), false); server.state.failFolder = '';
    const session = await alice.createSession('codex', root, project.id), transfer = await alice.archive(session.id);
    const deadline = Date.now() + 10000;
    while (['queued','running'].includes(transfer.status) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(transfer.status, 'done', transfer.error || 'transfer failed');
    assert(transfer.target.startsWith('/projects/ocr/实体抽取/trajectories/alice/'));
    assert.equal(server.nodes.get('/projects/ocr/实体抽取/trajectories/alice').mode & 0o777, 0o750);
    await bob.configureWorkspace(server.profile('bob'), 'test-password', root, async () => true);
    assert.equal(bob.remote.workspace!.canCreateProject, false);
    assert.equal(bob.remote.profile!.projects[0].id, project.id);
    assert.equal(bob.remote.profile!.projects[0].historyPath, '/projects/ocr/实体抽取/trajectories/bob');
    await assert.rejects(syncedProject(bob, '越权'), /组管理员/);
    server.state.admins = [];
    await assert.rejects(syncedProject(alice, '已撤权'), /组管理员/);
    assert.equal(alice.remote.workspace!.canCreateProject, false);
    const before = alice.store.settings.localWorkspace;
    const attempted = { ...server.profile('alice'), username: 'new-account' };
    await assert.rejects(alice.configureWorkspace(attempted, 'wrong-password', root, async () => true));
    assert.equal(alice.workspaceReady, true); assert.equal(alice.store.settings.localWorkspace, before);
    assert.equal(alice.store.settings.connections[0].host, attempted.host);
    assert.equal(alice.store.settings.connections[0].port, attempted.port);
    assert.equal(alice.store.settings.connections[0].username, 'new-account');
    assert(!JSON.stringify(alice.store.settings).includes('wrong-password'));
    const restarted = new Workbench(path.join(root, 'alice'), () => {}, () => {}); await restarted.store.init();
    assert.equal(restarted.store.settings.connections[0].username, 'new-account');
    await restarted.close();
    await assert.rejects(alice.createSession('cursor', root), /本机没有此项目/); const offline = await alice.createSession('cursor', root, project.id); assert.equal(offline.binding?.project.id, project.id);
  } finally { await alice.close(); await bob.close(); await server.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); }
});
