import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { readRegistry, writeRegistry } from '../src/core/local-space';
import { memberProfile } from '../tests/fixtures/member-profile';
// @ts-expect-error Shared CLI fixture.
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
async function main() {
const expect = baseExpect.configure({ timeout: 20000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'personal-flow-' + Date.now()), store = path.join(data, 'user');
const output = path.join(root, 'artifacts', 'personal-workspace'); await fs.mkdir(output, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success', nativeHistory: true });
const share = path.join(data, 'share'); await fs.mkdir(share, { recursive: true });
const admin = new LocalAdminConnection(() => {}), owner = new Workbench(path.join(data, 'owner'), () => {}, () => {});
await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: '研发组' });
const groupName = Object.keys(admin.snapshot.state!.groups)[0];
await admin.operation({ op: 'user_create', username: 'owner', name: 'Owner', password: '1', groups: [groupName], contentAdminGroups: [groupName] });
await admin.operation({ op: 'user_create', username: 'member', name: 'Member', groups: [groupName] });
await owner.store.init(); await owner.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'owner'), '1', '', async () => false);
const project = await owner.createProject('实体抽取', groupName); await owner.close();
const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'member');
const registry = await readRegistry(share); registry.state.users.owner.mustChangePassword = false; await writeRegistry(share, registry); admin.disconnect();
const settings = { connections: [profile], providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher }, lastWorkspace: '' };
await fs.mkdir(path.join(store, 'window-state', '1'), { recursive: true }); await fs.mkdir(path.join(store, 'personal'), { recursive: true });
await fs.writeFile(path.join(store, 'window-state', '1', 'settings.json'), JSON.stringify(settings));
await fs.writeFile(path.join(store, 'personal', 'settings.json'), JSON.stringify({ ...settings, connections: [] }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>>, page: Awaited<ReturnType<typeof app.firstWindow>>;
const errors: string[] = [];
async function launch() { app = await electron.launch({ args: ['dist/user'], cwd: root, env, timeout: 60000 }); page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); }
async function snapshot() { return page.evaluate(() => window.workbench.call<any>('snapshot')); }
await launch();
try {
  await page.getByLabel('登录密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('密码');
  await page.getByRole('button', { name: '跳过' }).click();
  await expect(page.getByLabel('空白工作台')).toBeVisible();
  assert.equal((await snapshot()).sessions.length, 0);
  await page.screenshot({ path: path.join(output, 'empty.png') });
  await page.getByRole('button', { name: '新建个人分组' }).click();
  await page.getByLabel('个人分组名称').fill('资料研究'); await page.getByRole('button', { name: '保存分组', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect.poll(async () => (await snapshot()).sessions.filter((item: any) => item.purpose === 'work').length).toBe(index + 1);
  }
  const before = await snapshot(), originals = before.sessions.filter((item: any) => item.purpose === 'work');
  const groupId = before.settings.personalGroups[0].id; assert(originals.every((item: any) => item.personalGroupId === groupId));
  await page.screenshot({ path: path.join(output, 'personal-session.png') });
  await page.getByRole('button', { name: '会话记录', exact: true }).click();
  await expect(page.getByText('此会话自动上传', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认上传轨迹', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  // Exercise a real CLI turn and preparation without any central login.
  await page.evaluate(async id => { await window.workbench.call('session.send', { id, text: '总结本次研究', sourceIds: [], capabilities: [] }); }, originals[0].id);
  await expect.poll(async () => (await snapshot()).sessions.find((item: any) => item.id === originals[0].id)?.status).toBe('idle');
  const draft = await page.evaluate(id => window.workbench.call<any>('draft.prepare', { id, categories: ['exploration'] }), originals[0].id);
  await expect.poll(async () => (await snapshot()).drafts.find((item: any) => item.id === draft.id)?.generation, { timeout: 30000 }).toBe('ready');
  const saved = await page.evaluate(async id => { const state = await window.workbench.call<any>('snapshot'); const draft = state.drafts.find((item: any) => item.id === id); return window.workbench.call('draft.personal.save', { id, artifactIds: draft.artifacts.filter((item: any) => item.selected).map((item: any) => item.id) }); }, draft.id);
  const results = await page.evaluate(() => window.workbench.call<any[]>('personal:conclusion.list', { projectId: '__personal__' }));
  assert(results.length > 0);
  const reference = await page.evaluate(async ({ id, conclusionId }) => window.workbench.call<any>('session.attachConclusion', { id, conclusionId }), { id: originals[1].id, conclusionId: results[0].id });
  assert(reference.localPath);
  await app.close(); await launch();
  await page.getByRole('button', { name: '跳过' }).click();
  await expect.poll(async () => (await snapshot()).sessions.filter((item: any) => item.purpose === 'work').length).toBe(2);
  await page.locator('.topbar').getByRole('button', { name: '连接中央节点', exact: true }).click();
  await page.getByLabel('登录密码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByLabel('新密码', { exact: true })).toBeVisible();
  assert.equal((await snapshot()).connection?.connected || false, false);
  await page.getByLabel('新密码', { exact: true }).fill('1');
  await page.getByLabel('确认新密码', { exact: true }).fill('different');
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
  await page.getByLabel('确认新密码', { exact: true }).fill('1');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect.poll(async () => !!(await snapshot()).connection?.connected).toBe(true);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('原密码', { exact: true }).fill('wrong');
  await page.getByLabel('新密码', { exact: true }).fill('2'); await page.getByLabel('确认新密码', { exact: true }).fill('2');
  await page.getByRole('button', { name: '保存密码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('原密码');
  await page.getByLabel('原密码', { exact: true }).fill('1'); await page.getByRole('button', { name: '保存密码', exact: true }).click();
  await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '管理个人分组 资料研究' })).toBeVisible();
  await page.getByRole('button', { name: '管理个人分组 资料研究' }).click();
  await expect(page.getByRole('menuitem', { name: '整组迁移到团队项目' })).toBeVisible();
  await page.getByRole('menuitem', { name: '整组迁移到团队项目' }).click();
  await page.getByLabel('迁移目标团队项目').selectOption(project.id);
  await page.screenshot({ path: path.join(output, 'move-group.png') });
  await page.getByRole('button', { name: '迁移 2 条会话', exact: true }).click();
  await expect.poll(async () => (await snapshot()).settings.personalGroups.length).toBe(0);
  const after = await snapshot();
  for (const original of originals) { const moved = after.sessions.find((item: any) => item.id === original.id); assert(moved); assert.equal(moved.binding.project.id, project.id); assert.equal(moved.cwd, original.cwd); }
  assert.equal(after.drafts.find((item: any) => item.id === draft.id).binding.project.id, project.id);
  const movedResults = await page.evaluate(projectId => window.workbench.call<any[]>('conclusion.list', { projectId }), project.id);
  assert(movedResults.some((item: any) => item.id === results[0].id));
  const movedSession = after.sessions.find((item: any) => item.id === originals[0].id);
  await page.evaluate(id => window.workbench.call('session.send', { id, text: '迁移后继续', sourceIds: [], capabilities: [] }), movedSession.id);
  await expect.poll(async () => (await snapshot()).sessions.find((item: any) => item.id === movedSession.id)?.status).toBe('idle');
  await expect(page.getByRole('heading', { name: '整组迁移到团队项目', exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'moved.png') });
  await page.getByRole('button', { name: '暂不设置', exact: true }).click();
  // Disconnecting affects team services, not the persistent unassigned workspace.
  await page.evaluate(() => window.workbench.call('remote.disconnect'));
  await page.getByRole('button', { name: '未分组 0', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect.poll(async () => (await snapshot()).sessions.filter((item: any) => item.binding?.host === 'personal' && item.purpose === 'work').length).toBe(1);
  const personalId = (await snapshot()).sessions.find((item: any) => item.binding?.host === 'personal' && item.purpose === 'work').id;
  await page.locator('.topbar').getByRole('button', { name: '连接中央节点', exact: true }).click();
  await page.getByLabel('成员账号', { exact: true }).fill('owner'); await page.getByLabel('登录密码', { exact: true }).fill('1');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect.poll(async () => (await snapshot()).connection?.profile.username).toBe('owner');
  assert((await snapshot()).sessions.some((item: any) => item.id === personalId));
  assert(!(await snapshot()).sessions.some((item: any) => item.id === movedSession.id), 'another team account cannot see the migrated record');
  await page.evaluate(() => window.workbench.call('remote.disconnect'));
  await page.locator('.topbar').getByRole('button', { name: '连接中央节点', exact: true }).click();
  await page.getByLabel('成员账号', { exact: true }).fill('member'); await page.getByLabel('登录密码', { exact: true }).fill('1');
  await page.getByRole('button', { name: '连接', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('密码');
  await page.getByLabel('登录密码', { exact: true }).fill('2'); await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect.poll(async () => (await snapshot()).connection?.profile.username).toBe('member');
  assert((await snapshot()).sessions.some((item: any) => item.id === personalId));
  assert((await snapshot()).sessions.some((item: any) => item.id === movedSession.id));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, scenarios: ['skip-login-empty', 'personal-groups', 'local-ai-and-preparation', 'restart-persistence', 'login-keeps-personal-records', 'member-whole-group-move', 'offline-local-work', 'login-failure-skip', 'first-password', 'wrong-old-password', 'short-password', 'reuse-personal-result', 'resume-after-migration', 'account-switch-isolation', 'new-password-login-old-password-rejected'], data, output }));
} catch (error) { await page!.screenshot({ path: path.join(output, 'failure.png') }); console.error((await page!.locator('body').innerText()).slice(-10000)); throw error; } finally { await app!.close(); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
