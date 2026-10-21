import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectSync } from '../src/core/project-sync';
import { SyncConflicts } from '../src/core/sync-conflicts';
import { Workbench } from '../src/core/workbench';
import type { Project, ProjectBriefState, RemoteBinding } from '../src/shared/types';
import type { ProjectBrief } from '../src/shared/project-brief';
import { createHash } from 'node:crypto';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { projectDirectoryKey } from '../src/shared/project-directory';
import { PERSONAL_PROJECT_ID } from '../src/shared/personal-workspace';

const brief = (background = '背景'): ProjectBrief => ({ background, objectives: '目标', acceptance: '验收', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-sync-'));
  let connected = false, creates = 0, owner = 'local';
  const projects: Project[] = [], central = new Map<string, ProjectBriefState>();
  const ai = new SyncConflicts(root, () => {});
  const host = {
    owner: () => owner, projects: () => projects, connected: () => connected, changed: () => {},
    binding: (id: string): RemoteBinding => ({ connectionId: 'fixture', host: 'fixture', port: 22, username: 'alice', fingerprint: 'fixture', project: projects.find(item => item.id === id)! }),
    async create(name: string, groupName: string | undefined, value: ProjectBrief | undefined, id: string) {
      const existing = projects.find(item => item.id === id); if (existing) return existing;
      creates++; const project = { id, name, groupName, remoteRoot: '/team/' + id, uploadPath: '/team/' + id, historyPath: '/team/' + id + '/history', briefRevision: value ? 1 : 0 };
      projects.push(project); central.set(id, { brief: structuredClone(value), revision: value ? 1 : 0 }); return project;
    },
    async read(binding: RemoteBinding) { return structuredClone(central.get(binding.project.id)!); },
    async save(binding: RemoteBinding, value: ProjectBrief, revision: number) {
      const previous = central.get(binding.project.id)!; if (previous.revision !== revision) throw new Error('版本冲突');
      central.set(binding.project.id, { brief: structuredClone(value), revision: revision + 1 });
    },
  };
  let sync = new ProjectSync(root, host, ai); await sync.init();
  return { root, host, central, ai, get sync() { return sync; }, get creates() { return creates; }, connect() { connected = true; }, setOwner(value: string) { owner = value; },
    async restart() { await sync.close(); sync = new ProjectSync(root, host, ai); await sync.init(); },
    async close() { await sync.close(); await ai.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('offline create and edit survive restart, sync automatically with stable identity and do not duplicate after retry', async () => {
  const f = await fixture();
  try {
    const project = await f.sync.create('离线项目', 'team', brief());
    await f.sync.save(project.id, brief('离线修改'), 1); assert.equal(f.creates, 0);
    await f.restart(); assert.equal((await f.sync.read(project.id)).brief?.background, '离线修改');
    f.connect(); await f.sync.sync(); await f.sync.sync();
    assert.equal(f.creates, 1); assert.equal(f.central.get(project.id)?.brief?.background, '离线修改');
    assert.equal(f.sync.states()[project.id].pending, false);
  } finally { await f.close(); }
});

test('project conflicts pause only that project, preserve all versions and reject stale AI decisions', async () => {
  const f = await fixture();
  try {
    const a = await f.sync.create('A', 'team', brief()), b = await f.sync.create('B', 'team', brief()); f.connect(); await f.sync.sync();
    await f.sync.save(a.id, brief('本机'), (await f.sync.read(a.id)).revision);
    await f.sync.save(b.id, brief('独立修改'), (await f.sync.read(b.id)).revision);
    f.central.set(a.id, { brief: brief('中央'), revision: 2 }); await f.sync.sync();
    const conflict = f.sync.states()[a.id].conflict!; assert(conflict);
    assert.equal((await f.sync.read(a.id)).brief?.background, '本机'); assert.equal(f.central.get(b.id)?.brief?.background, '独立修改');
    await f.sync.save(a.id, brief('后续修改'), (await f.sync.read(a.id)).revision);
    await assert.rejects(f.sync.resolve(a.id, conflict.token, 'remote'), /改变/);
    await f.sync.sync(); const latest = f.sync.states()[a.id].conflict!;
    await f.sync.resolve(a.id, latest.token, 'merged', [{ path: ['background'], text: '人工合并' }]); await f.sync.sync();
    assert.equal(f.central.get(a.id)?.brief?.background, '人工合并'); assert.equal(f.ai.history[0].before && (f.ai.history[0].before as ProjectBrief).background, '后续修改');
    await f.sync.undo(a.id, f.ai.history[0].id); assert.equal((await f.sync.read(a.id)).brief?.background, '后续修改');
  } finally { await f.close(); }
});

test('edits during an in-flight remote write remain pending and are not overwritten', async () => {
  const f = await fixture();
  try {
    const a = await f.sync.create('A', 'team', brief()); f.connect(); await f.sync.sync();
    await f.sync.save(a.id, brief('first'), (await f.sync.read(a.id)).revision);
    const save = f.host.save; let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.host.save = async (...args) => { started(); await new Promise<void>(resolve => { release = resolve; }); return save(...args); };
    const pending = f.sync.sync(); await entered;
    await f.sync.save(a.id, brief('second'), (await f.sync.read(a.id)).revision);
    release(); await pending; assert.equal((await f.sync.read(a.id)).brief?.background, 'second');
    f.host.save = save; await f.sync.sync(); assert.equal(f.central.get(a.id)?.brief?.background, 'second');
  } finally { await f.close(); }
});

test('standalone projects support sessions, local result editing and migration without any central account', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-project-'));
  let workbench = new Workbench(root, () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  try {
    await workbench.store.init(); await workbench.restoreLocalWorkspace();
    const project = await workbench.createProject('我的项目', undefined, brief());
    const session = await workbench.createSession('codex', root, PERSONAL_PROJECT_ID);
    await workbench.moveWithinLocal(project.id, { sessionId: session.id });
    assert.equal(workbench.session(session.id).binding?.project.id, project.id);
    const result = await workbench.createConclusion(project.id, '本机成果', '可离线编辑');
    assert.equal(workbench.conclusions(project.id)[0].id, result.id);
    await workbench.close();
    workbench = new Workbench(root, () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
    await workbench.store.init(); await workbench.restoreLocalWorkspace();
    assert.equal(workbench.snapshot().sessions[0].binding?.project.id, project.id); assert.equal(workbench.snapshot().settings.workspaceSnapshot?.profile.projects.some(item => item.id === project.id), true);
    const next = await workbench.createSession('codex', root, project.id); assert.equal(next.projectBrief?.revision, 1); assert.equal(workbench.remote.connected, false);
  } finally { await workbench.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a lost create response preserves later local edits and retries the same project identity', async () => {
  const f = await fixture();
  try {
    const project = await f.sync.create('断线重试', 'team', brief()); f.connect();
    const create = f.host.create; let fail = true;
    f.host.create = async (...args) => { const result = await create(...args); if (fail) throw new Error('response lost'); return result; };
    await f.sync.sync(); assert(f.sync.states()[project.id].error);
    await f.sync.save(project.id, brief('断线后的修改'), (await f.sync.read(project.id)).revision);
    fail = false; await f.restart(); await f.sync.sync();
    assert.equal(f.creates, 1); assert.equal(f.central.get(project.id)?.brief?.background, '断线后的修改');
  } finally { await f.close(); }
});

test('switching accounts never exposes another account pending project or cached edits', async () => {
  const f = await fixture();
  try {
    const project = await f.sync.create('账号一离线项目', 'team', brief('私有修改'));
    f.setOwner('other'); assert.equal(f.sync.projects().length, 0); assert.equal(f.sync.states()[project.id], undefined);
    await f.restart(); assert.equal(f.sync.projects().length, 0);
    f.setOwner('local'); assert.equal((await f.sync.read(project.id)).brief?.background, '私有修改');
  } finally { await f.close(); }
});

test('linking a local project works offline and preserves directories, summaries, results and session identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-link-')), share = path.join(root, 'share'); await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {});
  const local = new Workbench(path.join(root, 'local'), () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  const team = new Workbench(path.join(root, 'team'), () => {}, () => {});
  try {
    await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
    await admin.operation({ op: 'user_create', username: 'alice', name: 'Alice', password: '1', groups: ['local_research'], contentAdminGroups: ['local_research'] });
    await local.store.init(); await local.restoreLocalWorkspace(); await team.store.init();
    const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'alice');
    await team.configureWorkspace(profile, '1', root, async () => false); team.remote.disconnect();
    const project = await local.createProject('本机项目', undefined, brief()), session = await local.createSession('codex', root, project.id);
    const old = await fs.readFile(session.handoffPath, 'utf8');
    assert(await local.journal.commit(session, createHash('sha256').update(old).digest('hex'), 1, '项目摘要', { turnId: 'turn-1', at: session.createdAt, text: '完成离线工作' }));
    const result = await local.createConclusion(project.id, '独立成果', '已保存');
    await local.linkLocalProject(team, project.id, 'local_research');
    assert.equal(local.snapshot().settings.workspaceSnapshot!.profile.projects.some(item => item.id === project.id), false);
    assert.equal(team.session(session.id).binding!.project.id, project.id);
    assert.equal(team.store.settings.projectDirectories![projectDirectoryKey(profile, project.id)], root);
    assert.equal(team.conclusions(project.id)[0].id, result.id);
    assert.equal((await team.journal.exportSessions(new Set([session.id])))[0].entries[0].text, '完成离线工作');
    assert.equal(team.remote.connected, false); assert.equal(team.projectSync.states()[project.id].pending, true);
    await team.configureWorkspace(profile, '1', root, async () => false); await team.projectSync.sync();
    assert.equal(team.remote.profile!.projects.filter(item => item.id === project.id).length, 1);
    assert.equal(team.session(session.id).binding!.project.remoteRoot.startsWith('/projects/'), true);
  } finally { await local.close(); await team.close(); admin.disconnect(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('moving into a local project retains shared results, rewrites copied references and keeps journal entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-local-move-'));
  const workbench = new Workbench(root, () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  try {
    await workbench.store.init(); await workbench.restoreLocalWorkspace();
    const project = await workbench.createProject('目标项目', undefined, brief());
    const a = await workbench.createSession('codex', root, PERSONAL_PROJECT_ID), b = await workbench.createSession('codex', root, PERSONAL_PROJECT_ID);
    const original = await workbench.createConclusion(PERSONAL_PROJECT_ID, '共享引用', '保留正文');
    await workbench.attachConclusion(a.id, original.id); await workbench.attachConclusion(b.id, original.id);
    const old = await fs.readFile(a.handoffPath, 'utf8');
    assert(await workbench.journal.commit(a, createHash('sha256').update(old).digest('hex'), 1, '阶段摘要', { turnId: 'move-turn', at: a.createdAt, text: '完成迁移前工作' }));
    await workbench.moveWithinLocal(project.id, { sessionId: a.id });
    const copy = workbench.conclusions(project.id)[0]; assert.notEqual(copy.id, original.id);
    assert.equal(workbench.conclusions(PERSONAL_PROJECT_ID)[0].id, original.id);
    assert(workbench.session(a.id).sources.some(source => source.sourcePath.startsWith('local-conclusion:' + copy.id + ':')));
    assert(workbench.session(b.id).sources.some(source => source.sourcePath.startsWith('local-conclusion:' + original.id + ':')));
    const record = (await workbench.journal.exportSessions(new Set([a.id])))[0];
    assert.equal(record.projectId, project.id); assert.equal(record.entries[0].text, '完成迁移前工作');
  } finally { await workbench.close(); await fs.rm(root, { recursive: true, force: true }); }
});
