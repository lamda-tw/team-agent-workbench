import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { firstMemberIsAdmin } from '../src/admin/member-defaults';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { Workbench } from '../src/core/workbench';
import { briefFields, PROJECT_BRIEF_FILE, projectBriefSchema, projectSetupIdentity } from '../src/shared/project-brief';
// @ts-expect-error Shared SFTP protocol fixture.
import { teamServer } from './fixtures/team-server.mjs';

const brief = projectBriefSchema.parse({ background: '现有客户信息处理耗时较多。', objectives: '减少重复工作并提升交付质量。', acceptance: '抽查结果符合既定规则，由项目负责人验收。', scope: '本阶段处理文本，暂不做图片。', deliverables: '方案文档和可运行工具；两周完成初版。', resources: '内部说明文档，无需仓库链接。', constraints: '不上传原始敏感数据，不填写访问密钥。', collaboration: '每周评审阶段成果，重大决策记录原因。' });
test('first-member default follows group membership, never an absent admin or other-group membership', () => {
  const state: any = { users: {}, groups: { a: {}, b: {} } };
  assert(firstMemberIsAdmin(state, 'a')); assert(!firstMemberIsAdmin(state, 'unknown'));
  state.users.alice = { groups: ['a'], enabled: false, contentAdminGroups: [] };
  assert(!firstMemberIsAdmin(state, 'a')); assert(firstMemberIsAdmin(state, 'b'));
  assert(!firstMemberIsAdmin(undefined, 'a'));
});

test('local onboarding: empty detection, required brief, identity binding, readable shared file, reconnect, revocation, no overwrites', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-onboarding-')), share = path.join(root, 'share'); await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {}), owner = new Workbench(path.join(root, 'owner'), () => {}, () => {}), member = new Workbench(path.join(root, 'member'), () => {}, () => {});
  try {
    await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' });
    for (const label of ['one', 'two', 'existing']) await admin.operation({ op: 'group_create', label });
    const groups = Object.keys(admin.snapshot.state!.groups), defaults = groups.filter(g => firstMemberIsAdmin(admin.snapshot.state, g));
    await admin.operation({ op: 'user_create', username: 'alice', name: 'Alice', password: '1', groups, contentAdminGroups: defaults });
    await admin.operation({ op: 'user_create', username: 'bob', name: 'Bob', password: '1', groups, contentAdminGroups: groups.filter(g => firstMemberIsAdmin(admin.snapshot.state, g)) });
    assert.deepEqual(admin.snapshot.state!.users.alice.contentAdminGroups, groups); assert.deepEqual(admin.snapshot.state!.users.bob.contentAdminGroups, []);
    await fs.writeFile(path.join(share, 'projects/existing/原有资料.txt'), 'keep');
    const config = (name: string) => memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name);
    await owner.store.init(); await member.store.init();
    await owner.configureWorkspace(config('alice'), '1', root, async () => false); await member.configureWorkspace(config('bob'), '1', root, async () => false);
    const key = (wb: Workbench, group: string) => projectSetupIdentity(wb.remote.profile!, group);
    assert.equal(projectSetupIdentity({ ...owner.remote.profile!, id: 'reimported-profile' }, 'local_one'), key(owner, 'local_one'));
    assert.notEqual(projectSetupIdentity({ ...owner.remote.profile!, localRoot: share + '-other' }, 'local_one'), key(owner, 'local_one'));
    assert(owner.remote.workspaces.find(w => w.groupName === 'local_one')!.isEmpty);
    assert.equal(owner.remote.workspaces.find(w => w.groupName === 'local_existing')!.isEmpty, true);
    await owner.initializeProject('不覆盖', 'local_existing', brief, key(owner, 'local_existing')); assert.equal(await fs.readFile(path.join(share, 'projects/existing/原有资料.txt'), 'utf8'), 'keep');
    await assert.rejects(owner.initializeProject('错误账号', 'local_one', brief, key(member, 'local_one')), /账号已改变/);
    await assert.rejects(member.initializeProject('越权', 'local_one', brief, key(member, 'local_one')), /组管理员/);
    await assert.rejects(owner.initializeProject('缺少说明', 'local_one', { ...brief, acceptance: ' ' }, key(owner, 'local_one')));
    assert.deepEqual(await fs.readdir(path.join(share, 'projects/one')), []);
    const created = await owner.initializeProject('客户信息整理', 'local_one', brief, key(owner, 'local_one'));
    await owner.projectSync.sync(); const project = owner.projectBinding(created.id).project;
    const text = await fs.readFile(path.join(share, 'projects/one/客户信息整理', PROJECT_BRIEF_FILE), 'utf8');
    for (const field of briefFields) { assert(text.includes('## ' + field.label)); assert(text.includes(brief[field.key])); }
    for (const dir of ['trajectories', 'submissions']) assert((await fs.stat(path.join(share, 'projects/one/客户信息整理', dir))).isDirectory());
    await member.remote.loadManifest(); const preview = await member.remote.preview(member.remote.binding(project.id), project.remoteRoot + '/' + PROJECT_BRIEF_FILE); assert.equal(preview.content, text);
    await owner.configureWorkspace(config('alice'), '1', root, async () => false); assert.equal(owner.remote.workspaces.find(w => w.groupName === 'local_one')!.isEmpty, false);
    await assert.rejects(owner.initializeProject('客户信息整理', 'local_one', brief, key(owner, 'local_one')), /EEXIST|已存在/);
    assert.equal(await fs.readFile(path.join(share, 'projects/one/客户信息整理', PROJECT_BRIEF_FILE), 'utf8'), text);
    await admin.operation({ op: 'group_member', username: 'alice', group: 'local_two', role: 'member', handoffs: { 'local_two': null } });
    const revoked = await owner.initializeProject('撤权后创建', 'local_two', brief, key(owner, 'local_two'));
    await owner.projectSync.sync(); assert.match(owner.projectSync.states()[revoked.id].error!, /管理员|管理者/);
    assert.equal((await owner.projectSync.read(revoked.id)).brief?.background, brief.background);
    assert.deepEqual(await fs.readdir(path.join(share, 'projects/two')), []);
  } finally { admin.disconnect(); await owner.close(); await member.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('SFTP onboarding publishes complete UTF-8 brief, respects permissions, removes partial files on write failure', async () => {
  const server = await teamServer(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-onboard-sftp-'));
  const owner = new Workbench(path.join(root, 'owner'), () => {}, () => {}), member = new Workbench(path.join(root, 'member'), () => {}, () => {});
  try {
    await owner.store.init(); await member.store.init();
    await owner.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    await member.configureWorkspace(server.profile('bob'), 'test-password', root, async () => true);
    const key = projectSetupIdentity(owner.remote.profile!, 'wb_test_ocr'); assert(owner.remote.workspace!.isEmpty);
    await assert.rejects(member.initializeProject('越权', 'wb_test_ocr', brief, projectSetupIdentity(member.remote.profile!, 'wb_test_ocr')), /组管理员/);
    server.state.failWrite = PROJECT_BRIEF_FILE;
    await assert.rejects(owner.remote.createProject('失败项目', 'wb_test_ocr', brief), /未创建成功/);
    assert(![...server.nodes.keys()].some((p: string) => p.startsWith('/projects/ocr/失败项目')));
    server.state.failWrite = '.workbench-project.json';
    await assert.rejects(owner.remote.createProject('失败项目', 'wb_test_ocr', brief), /未创建成功/);
    assert(![...server.nodes.keys()].some((p: string) => p.startsWith('/projects/ocr/失败项目')));
    server.state.failWrite = '';
    const created = await owner.initializeProject('客户资料项目', 'wb_test_ocr', brief, key);
    await owner.projectSync.sync(); const project = owner.projectBinding(created.id).project;
    const file = project.remoteRoot + '/' + PROJECT_BRIEF_FILE;
    assert.equal(server.nodes.get(file).mode & 0o777, 0o640); assert.equal(owner.remote.workspace!.isEmpty, false);
    await member.remote.loadManifest(); const preview = await member.remote.preview(member.remote.binding(project.id), file); assert(preview.content.includes(brief.background));
    const another = await owner.initializeProject('新项目', 'wb_test_ocr', brief, key); assert.notEqual(another.id, project.id); await owner.projectSync.sync(); assert.equal(owner.remote.profile!.projects.length, 2);
  } finally { await owner.close(); await member.close(); await server.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('old central nodes reject stable-ID creation before creating any directory; an upgrade resumes it once', async () => {
  const server = await teamServer(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-old-server-'));
  const workbench = new Workbench(root, () => {}, () => {});
  try {
    await workbench.store.init(); await workbench.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    server.state.legacyProjectCreation = true;
    const project = await workbench.createProject('升级后同步', 'wb_test_ocr', brief); await workbench.projectSync.sync();
    assert.match(workbench.projectSync.states()[project.id].error!, /更新项目同步服务/);
    assert(!server.nodes.has('/projects/ocr/升级后同步'));
    server.state.legacyProjectCreation = false; await workbench.projectSync.sync(); await workbench.projectSync.sync();
    assert.equal(workbench.remote.profile!.projects.filter(item => item.id === project.id).length, 1);
  } finally { await workbench.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
