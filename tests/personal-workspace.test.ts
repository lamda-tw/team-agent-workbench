import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { PERSONAL_PROJECT_ID, isPersonalBinding } from '../src/shared/personal-workspace';
import { accountIdentity } from '../src/shared/account-data';
import { contributionCategoryDirectory } from '../src/core/preparation';
import { recoverPersonalMove } from '../src/core/personal-move';
import { atomicJson, Store } from '../src/core/store';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-personal-'));
  const local = new Workbench(path.join(base, 'personal'), () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
  const team = new Workbench(path.join(base, 'team'), () => {}, () => {}), admin = new LocalAdminConnection(() => {});
  await local.store.init(); await local.restoreLocalWorkspace(); await team.store.init();
  const cwd = path.join(base, 'code'); await fs.mkdir(cwd);
  return { base, local, team, admin, cwd,
    async connect() {
      const share = path.join(base, 'share'); await fs.mkdir(share);
      await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
      await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: '研发' });
      const group = Object.keys(admin.snapshot.state!.groups)[0];
      await admin.operation({ op: 'user_create', username: 'owner', name: 'Owner', password: '1', groups: [group], contentAdminGroups: [group] });
      await admin.operation({ op: 'user_create', username: 'member', name: 'Member', password: '1', groups: [group] });
      const owner = new Workbench(path.join(base, 'owner'), () => {}, () => {}); await owner.store.init();
      try { await owner.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'owner'), '1', '', async () => false); const project = await owner.createProject('团队项目', group);
        await team.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'member'), '1', '', async () => false); return project;
      } finally { await owner.close(); }
    },
    async close() { admin.disconnect(); await local.close(); await team.close(); assert.equal(await fs.realpath(path.dirname(base)), await fs.realpath(os.tmpdir())); await fs.rm(base, { recursive: true, force: true, maxRetries: 5 }); },
  };
}

test('first use has no seeded records, and local sessions/groups/results survive restart without central login', async () => {
  const f = await fixture();
  try {
    assert.equal(f.local.workspaceReady, true); assert.equal(f.local.remote.connected, false);
    assert.equal(f.local.snapshot().sessions.length, 0); assert.deepEqual(f.local.store.settings.personalGroups || [], []);
    const group = await f.local.savePersonalGroup('资料研究');
    await assert.rejects(f.local.savePersonalGroup('资料研究'), /同名/);
    const session = await f.local.createSession('codex', f.cwd, PERSONAL_PROJECT_ID, 'work', undefined, undefined, 'inherit', false, 'direct');
    await f.local.assignPersonalGroup(session.id, group.id);
    const conclusion = await f.local.createConclusion(PERSONAL_PROJECT_ID, '个人成果', '已确认的结论');
    assert.equal(f.local.snapshot().sessions[0].id, session.id); assert(isPersonalBinding(session.binding));
    const restored = new Workbench(f.local.store.root, () => {}, () => {}, undefined, () => ({}), undefined, undefined, undefined, true);
    try { await restored.store.init(); await restored.restoreLocalWorkspace(); assert.equal(restored.session(session.id).personalGroupId, group.id); assert.equal(restored.conclusions(PERSONAL_PROJECT_ID)[0].id, conclusion.id); }
    finally { await restored.close(); }
    await f.local.dissolvePersonalGroup(group.id); assert.equal(session.personalGroupId, undefined);
    assert.equal(f.local.session(session.id).id, session.id);
  } finally { await f.close(); }
});

test('whole-group migration checks all members and preserves session/draft/result identity and local files', async () => {
  const f = await fixture();
  try {
    const group = await f.local.savePersonalGroup('整体迁移');
    const a = await f.local.createSession('codex', f.cwd), b = await f.local.createSession('claude', f.cwd);
    await f.local.assignPersonalGroup(a.id, group.id); await f.local.assignPersonalGroup(b.id, group.id);
    a.messages.push({ id: randomUUID(), role: 'user', text: '保留我的工作记录', createdAt: new Date().toISOString() });
    f.local.store.inputs[a.id] = { text: '尚未发送', sourceIds: [], answers: {} };
    const result = await f.local.createConclusion(PERSONAL_PROJECT_ID, '本机结论', '内容保留');
    const draft = { id: randomUUID(), sessionId: a.id, binding: structuredClone(a.binding), personalSavedIds: [result.id], title: '待审阅草稿', body: '草稿内容', files: [], inputDir: f.cwd, outputPath: path.join(f.cwd, 'draft.md'), createdAt: new Date().toISOString(), generation: 'ready' as const, artifacts: [{ id: randomUUID(), category: 'finding' as const, title: '发现', body: '正文', fields: { statement: '正文' }, target: '/personal/results', selected: true }] };
    f.local.store.drafts.push(draft); await fs.writeFile(draft.outputPath, '草稿内容');
    await assert.rejects(f.local.movePersonalTo(f.team, 'missing', { groupId: group.id }), /登录中央节点/);
    const project = await f.connect();
    b.status = 'running';
    await assert.rejects(f.local.movePersonalTo(f.team, project.id, { groupId: group.id }), /先结束/);
    assert.equal(f.local.store.sessions.length, 2); assert.equal(f.team.store.sessions.length, 0);
    b.status = 'idle';
    await assert.rejects(f.local.movePersonalTo(f.team, 'not-authorized', { groupId: group.id }), /项目入口不存在/);
    const moved = await f.local.movePersonalTo(f.team, project.id, { groupId: group.id });
    assert.equal(moved.count, 2); assert.equal(f.local.store.sessions.length, 0); assert.equal(f.local.store.settings.personalGroups!.length, 0);
    assert.deepEqual(f.team.session(a.id).messages, a.messages); assert.equal(f.team.session(a.id).cwd, f.cwd); assert.equal(f.team.session(a.id).networkRoute, 'direct');
    assert.equal(f.team.session(a.id).binding!.project.id, project.id); assert.equal(f.team.store.inputs[a.id].text, '尚未发送');
    assert.equal(f.team.draft(draft.id).artifacts![0].target, contributionCategoryDirectory(f.team.session(a.id).binding!, 'finding'));
    assert.equal(f.team.conclusions(project.id)[0].id, result.id); assert.equal(f.team.conclusions(project.id)[0].accountOwner, accountIdentity(f.team.session(a.id).binding!));
    assert.equal(await fs.readFile(draft.outputPath, 'utf8'), '草稿内容');
    assert.equal(f.team.store.transfers.length, 0);
    const disk = new Store(f.team.store.root); await disk.init(); assert.equal(disk.sessions.length, 2);
    const personalDisk = new Store(f.local.store.root); await personalDisk.init(); assert.equal(personalDisk.sessions.length, 0);
  } finally { await f.close(); }
});

test('interrupted group migration recovers once without duplicate sessions or loss of unrelated records', async () => {
  const f = await fixture();
  try {
    const project = await f.connect(), group = await f.local.savePersonalGroup('恢复');
    const source = await f.local.createSession('codex', f.cwd), remaining = await f.local.createSession('claude', f.cwd);
    await f.local.assignPersonalGroup(source.id, group.id);
    const session = structuredClone(source); session.binding = f.team.remote.binding(project.id); delete session.personalGroupId;
    const move = { version: 1, targetRoot: f.team.store.root, groupId: group.id, sessions: [session], drafts: [], conclusions: [], inputs: {} };
    await atomicJson(path.join(f.local.store.root, 'pending-personal-move.json'), move);
    await recoverPersonalMove(f.local.store.root); await recoverPersonalMove(f.local.store.root);
    const local = new Store(f.local.store.root), team = new Store(f.team.store.root); await local.init(); await team.init();
    assert.deepEqual(local.sessions.map(item => item.id), [remaining.id]); assert.deepEqual(team.sessions.map(item => item.id), [source.id]); assert.equal(local.settings.personalGroups!.length, 0);
    // Do not overwrite recovered disk state when fixture engines close.
    f.local.store.sessions = local.sessions; f.local.store.settings = local.settings; f.team.store.sessions = team.sessions;
  } finally { await f.close(); }
});
