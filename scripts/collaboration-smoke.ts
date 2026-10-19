import { _electron as electron, expect as baseExpect, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';
import { Workbench } from '../src/core/workbench';
// @ts-expect-error fixture
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
async function main() {
const root = process.cwd(), data = path.join(root, '.test-data', 'collaboration-ui-' + Date.now()), share = path.join(data, 'shared');
await fs.mkdir(share, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
const admin = new LocalAdminConnection(() => {});
await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', root: '/srv/teamspace', fingerprint: '' }, '', '', async () => false);
await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
for (const username of ['alice', 'bob']) await admin.operation({ op: 'user_create', username, name: username, password: '1', groups: ['local_research'], contentAdminGroups: username === 'alice' ? ['local_research'] : [] });
const profiles = Object.fromEntries(['alice', 'bob'].map(name => [name, memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name)]));
const alice = new Workbench(path.join(data, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(data, 'bob'), () => {}, () => {});
const brief = { background: '项目背景', objectives: '提高质量', acceptance: '指标验收', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' };
await alice.store.init(); await alice.configureWorkspace(profiles.alice, '1', data, async () => false);
const project = await alice.createProject('方案迭代', 'local_research', brief);
await bob.store.init(); await bob.configureWorkspace(profiles.bob, '1', data, async () => false);
for (const wb of [alice, bob]) { wb.store.settings.providerPaths = { codex: cli.launcher, cursor: cli.launcher }; await wb.createSession('codex', data, project.id); }
const file = path.join(data, 'report.md'); await fs.writeFile(file, '原始结论');
for (const name of ['第一项结论', '第二项结论']) await bob.remote.upload(bob.remote.binding(project.id), file, bob.remote.binding(project.id).project.uploadPath + '/' + name + '.md', () => {}, { kind: 'contribution', title: name, description: '待整理依据 ' + name });
await alice.close(); await bob.close(); admin.disconnect();
const apps: ElectronApplication[] = [], pages: Page[] = [], errors: string[] = [];
async function launch(edition: string, user: string) {
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: path.join(data, user), WORKBENCH_ADMIN_DATA_DIR: path.join(data, user) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist/' + edition], cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); pages.push(page); page.on('pageerror', e => errors.push(e.message)); return { app, page, env };
}
const call = (page: Page, action: string, payload?: unknown): Promise<any> => page.evaluate(([a, p]) => (window as any).workbench.call(a, p), [action, payload]);
try {
  const a = await launch('user', 'alice'), b = await launch('user', 'bob'), management = await launch('admin', 'admin');
  for (const [client, name] of [[a, 'alice'], [b, 'bob']] as const) {
    const login = client.page.locator('.modal').filter({ hasText: '登录团队工作台' });
    await login.waitFor();
    await call(client.page, 'remote.connect', { profile: profiles[name], password: '1', localPath: data });
    await login.getByRole('button', { name: '取消', exact: true }).click();
  }
  const ap = a.page, bp = b.page, mp = management.page;
  // Reopening loads the next existing account dataset; it must not create an unrelated empty slot.
  const duplicate = spawn(electronPath as unknown as string, ['dist/user'], { cwd: root, env: b.env, windowsHide: true, stdio: 'ignore' });
  const exitCode = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { duplicate.kill(); reject(new Error('duplicate instance did not exit')); }, 10000); duplicate.on('exit', code => { clearTimeout(timer); resolve(code); }); duplicate.on('error', reject); });
  assert.equal(exitCode, 0); await expect.poll(() => b.app.windows().length).toBe(2);
  const secondBobWindow = b.app.windows().find(page => page !== bp)!; pages.push(secondBobWindow); secondBobWindow.on('pageerror', error => errors.push(error.message));
  await secondBobWindow.getByText('登录团队工作台', { exact: true }).waitFor();
  assert.equal((await call(secondBobWindow, 'snapshot')).sessions.length, 0);
  await call(secondBobWindow, 'remote.connect', { profile: profiles.alice, password: '1', localPath: data });
  assert.equal((await call(bp, 'snapshot')).connection.profile.username, 'bob');
  assert.equal((await call(secondBobWindow, 'snapshot')).connection.profile.username, 'alice');
  assert.equal((await call(bp, 'snapshot')).sessions.length, 1); assert.equal((await call(secondBobWindow, 'snapshot')).sessions.length, 0);
  const primarySidebarHeight = Number(await bp.getByRole('separator', { name: '调整会话列表高度' }).getAttribute('aria-valuenow'));
  const secondarySplitter = secondBobWindow.getByRole('separator', { name: '调整会话列表高度' });
  const secondarySidebarHeight = Number(await secondarySplitter.getAttribute('aria-valuenow'));
  const secondaryWorkgroups = Number(await secondBobWindow.getByRole('separator', { name: '调整工作组高度' }).getAttribute('aria-valuenow'));
  await secondarySplitter.press('ArrowDown');
  await expect(secondarySplitter).toHaveAttribute('aria-valuenow', String(secondarySidebarHeight + 24));
  await expect(secondBobWindow.getByRole('separator', { name: '调整工作组高度' })).toHaveAttribute('aria-valuenow', String(secondaryWorkgroups));
  await expect(bp.getByRole('separator', { name: '调整会话列表高度' })).toHaveAttribute('aria-valuenow', String(primarySidebarHeight));
  assert.equal((await call(secondBobWindow, 'snapshot')).settings.sidebarPanes?.sessions, secondarySidebarHeight + 24);
  assert.notEqual((await call(bp, 'snapshot')).settings.sidebarPanes?.sessions, secondarySidebarHeight + 24);
  await secondBobWindow.close(); await expect.poll(() => b.app.windows().length).toBe(1);
  await mp.getByLabel('共享区类型').selectOption('local'); await mp.getByLabel('本地共享区根目录').fill(share);
  await mp.getByRole('button', { name: '打开共享目录', exact: true }).click();
  // The admin window shares the same team state but no longer carries an offline validity setting.
  await expect(mp.locator('.admin-content')).not.toContainText('离线工作');
  await call(bp, 'remote.manifest');
  await ap.getByRole('button', { name: '项目设置：方案迭代', exact: true }).click();
  await expect(ap.getByRole('dialog', { name: '项目设置 · 方案迭代', exact: true })).toBeVisible();
  await expect(ap.getByLabel('项目背景', { exact: true })).toHaveValue('项目背景'); await ap.getByLabel('项目目标', { exact: true }).fill('提高质量和效率'); await ap.getByRole('button', { name: '保存项目设置', exact: true }).click();
  const briefFile = path.join(share, ...project.remoteRoot.split('/').filter(Boolean), '项目说明.md');
  await expect.poll(async () => fs.readFile(briefFile, 'utf8')).toMatch(/## 项目目标\s+提高质量和效率/);
  await ap.getByRole('button', { name: '关闭窗口', exact: true }).click();
  // Wait for Alice's asynchronous save before Bob re-reads the manifest, or Bob legitimately still sees version 1.
  await expect.poll(async () => (await call(ap, 'snapshot')).connection.profile.projects.find((item: { id: string }) => item.id === project.id).briefRevision).toBe(2);
  await call(bp, 'remote.manifest'); await expect(bp.locator('.session-materials .materials-update')).toHaveCount(0);
  await expect(bp.getByRole('button', { name: '更新项目说明', exact: true })).toHaveCount(0);
  assert.equal((await call(bp, 'snapshot')).sessions[0].projectBrief.revision, 1);
  await call(bp, 'session.send', { id: (await call(bp, 'snapshot')).sessions[0].id, text: '继续当前项目' });
  await expect.poll(async () => (await call(bp, 'snapshot')).sessions[0].projectBrief.revision).toBe(2);
  await expect(ap.locator('.content-update-toast')).toContainText('bob');
  await ap.getByTitle('关闭本轮动态提示', { exact: true }).click(); await expect(ap.locator('.content-update-toast')).toHaveCount(0);
  await ap.getByTitle('团队动态', { exact: true }).click(); await expect(ap.getByRole('heading', { name: '团队动态', exact: true })).toBeVisible(); await expect(ap.locator('.update-entry')).toHaveCount(2); await expect(ap.locator('.update-feed')).toContainText('上传成果');
  await bp.getByTitle('项目成果库', { exact: true }).click(); await bp.getByRole('tab', { name: '团队', exact: true }).click(); await bp.locator('.content-card').filter({ hasText: '第一项结论' }).locator('.content-card-summary').click();
  await bp.locator('.result-card.is-expanded').getByRole('button', { name: '修改自己的提交', exact: true }).click(); await bp.getByLabel('团队成果内容').fill('Bob 补充的验证依据'); await bp.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(bp.locator('.result-card.is-expanded')).toContainText('Bob 补充的验证依据');
  await ap.locator('.sidebar').getByRole('button', { name: '项目成果库', exact: true }).click(); await ap.getByRole('tab', { name: '团队', exact: true }).click(); await ap.getByRole('button', { name: '多选语义合并', exact: true }).click();
  await expect(ap.getByLabel('团队成果类别')).toHaveValue('all');
  await ap.getByLabel('选择合并：第一项结论').check();
  await ap.getByLabel('搜索团队成果').fill('不存在的成果'); await expect(ap.locator('.content-card')).toHaveCount(0);
  await ap.getByRole('button', { name: '清除筛选', exact: true }).click(); await expect(ap.getByLabel('选择合并：第一项结论')).not.toBeChecked();
  await ap.getByLabel('选择合并：第一项结论').check(); await ap.getByLabel('选择合并：第二项结论').check();
  await ap.getByRole('button', { name: '开始语义合并（2 条）', exact: true }).click();
  await expect(ap.getByLabel('融合后的项目文档')).toContainText('统一结论');
  await ap.getByLabel('合并后标题').fill('Alice 统一整理的结论');
  for (const checkbox of await ap.locator('.merge-replacement-choice input[type="checkbox"]').all()) await checkbox.check();
  await ap.getByRole('button', { name: '保存新成果，2 条来源移入历史', exact: true }).click();
  await expect(ap.locator('.content-card')).toHaveCount(1);
  await expect(ap.getByLabel('团队成果类别')).toHaveValue('all');
  await expect(ap.getByLabel('团队成果操作状态')).toHaveCount(0);
  await expect(ap.getByRole('button', { name: /删除团队成果：.*Alice 统一整理的结论/ })).toBeVisible();
  await ap.getByRole('button', { name: '打开成果整理', exact: true }).click();
  const savedMerge = ap.locator('.draft-task-card').filter({ hasText: 'Alice 统一整理的结论' });
  await expect(savedMerge).toContainText('已保存到公共区'); await expect(savedMerge).toContainText('已保留，不可删除');
  await ap.getByTitle('项目成果库', { exact: true }).click(); await ap.getByRole('tab', { name: '团队', exact: true }).click();

  await bp.getByRole('button', { name: '刷新', exact: true }).click(); await bp.getByLabel('搜索团队成果').fill('统一整理');
  await expect(bp.locator('.content-card')).toHaveCount(1); await bp.locator('.content-card-summary').click();
  await expect(bp.getByRole('button', { name: '修改自己的提交', exact: true })).toHaveCount(0);
  await expect(bp.locator('.result-card.is-expanded').getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
  await expect(bp.locator('.result-card.is-expanded')).not.toContainText('已整理');
  await bp.locator('.result-card.is-expanded').getByRole('button', { name: '加入会话', exact: true }).click(); await bp.getByLabel('选择会话：新会话').check(); await bp.getByRole('button', { name: '加入 1 个会话', exact: true }).click(); await expect(bp.locator('.toast').filter({ hasText: '加入会话：新会话' })).toBeVisible(); await bp.getByTitle('工作会话', { exact: true }).click();
  await expect(bp.locator('.source-chips')).toContainText('Alice 统一整理的结论 · v1');
  const snapshot = await call(bp, 'snapshot'), reference = snapshot.sessions[0].sources.find((s: any) => s.name.includes('Alice 统一整理的结论') && s.name.endsWith('· v1'));
  assert((await fs.readFile(reference.localPath, 'utf8')).includes('Alice 统一整理'));
  assert(snapshot.inputs[snapshot.sessions[0].id].sourceIds.includes(reference.id));
  await bp.getByTitle('项目成果库', { exact: true }).click(); await bp.getByRole('tab', { name: '个人', exact: true }).click(); await expect(bp.getByRole('heading', { name: `项目成果库 · ${project.name}`, exact: true })).toBeVisible(); await expect(bp.locator('.conclusion-library')).toContainText('Alice 统一整理的结论');
  await bp.getByRole('button', { name: '新建成果', exact: true }).click(); await bp.getByLabel('项目成果标题').fill('手工发布检查'); await bp.getByLabel('项目成果内容').fill('这条内容由用户手工填写，不调用 AI。'); await bp.getByRole('button', { name: '保存成果', exact: true }).click(); await expect(bp.locator('.conclusion-library')).toContainText('手工发布检查');
  const extraSession = await call(bp, 'session.create', { provider: 'codex', cwd: data, projectId: project.id });
  await call(bp, 'session.rename', { id: extraSession.id, title: '另一个验证会话' });
  await bp.locator('.result-card.is-expanded').getByRole('button', { name: '加入会话', exact: true }).click();
  await expect(bp.getByLabel('使用成果的会话：新会话')).not.toBeChecked();
  await bp.getByLabel('使用成果的会话：新会话').check(); await bp.getByLabel('使用成果的会话：另一个验证会话').check();
  await bp.getByRole('button', { name: '加入 2 个会话', exact: true }).click();
  await expect(bp.getByRole('dialog', { name: '选择使用成果的会话' })).toHaveCount(0);
  await bp.locator('.result-card.is-expanded').getByRole('button', { name: '加入会话', exact: true }).click();
  for (const name of ['新会话', '另一个验证会话']) { await expect(bp.getByLabel(`使用成果的会话：${name}`)).toBeChecked(); await expect(bp.getByLabel(`使用成果的会话：${name}`)).toBeDisabled(); }
  await expect(bp.getByRole('button', { name: '加入 0 个会话', exact: true })).toBeDisabled();
  await bp.getByRole('button', { name: '关闭', exact: true }).click();
  await bp.getByTitle('工作会话', { exact: true }).click(); await bp.getByLabel('任务输入').fill('Alice 统一整理的结论是否支持后续验证？'); await bp.getByTitle('发送任务', { exact: true }).click();
  await expect(bp.getByRole('heading', { name: '选择这次会话要参考的项目成果', exact: true })).toBeVisible(); await expect(bp.getByLabel(/带入成果：.*Alice 统一整理的结论/)).toBeChecked(); await bp.getByRole('button', { name: '带入 1 条并发送', exact: true }).click(); await expect(bp.locator('.message.user')).toContainText('是否支持后续验证');
  // An existing group still requires a brief for every new project, or explicit deferral.
  await ap.getByTitle('在 research 创建项目', { exact: true }).click(); await ap.getByLabel('项目名称', { exact: true }).fill('第二个项目');
  await expect(ap.getByRole('dialog', { name: '项目说明' }).getByRole('button', { name: '创建项目', exact: true })).toBeDisabled();
  await ap.getByText('先创建目录，稍后完善项目说明', { exact: true }).click(); await ap.getByRole('dialog', { name: '项目说明' }).getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(ap.getByRole('button', { name: '项目说明', exact: true })).toBeVisible();
  await ap.getByRole('button', { name: '项目说明', exact: true }).click();
  await ap.getByLabel('项目背景', { exact: true }).fill('新项目背景'); await ap.getByLabel('项目目标', { exact: true }).fill('新目标'); await ap.getByLabel('验收标准', { exact: true }).fill('新指标'); await ap.getByRole('button', { name: '保存新版本', exact: true }).click();
  await expect.poll(async () => (await call(ap, 'snapshot')).connection.profile.projects.find((item: { name: string }) => item.name === '第二个项目').briefRevision).toBe(1);
  await ap.setViewportSize({ width: 1100, height: 760 }); await ap.getByTitle('项目成果库', { exact: true }).click(); await ap.getByRole('tab', { name: '团队', exact: true }).click();
  await ap.locator(`[data-project-id="${project.id}"]`).click(); await ap.locator('.content-card-summary').click();
  await ap.screenshot({ path: path.join(data, 'public-content.png') }); await mp.screenshot({ path: path.join(data, 'admin-management.png') });
  await expect.poll(async () => (await call(bp, 'snapshot')).sessions.every((session: any) => session.status === 'idle')).toBe(true);
  const beforeRestart = JSON.parse(JSON.stringify(await call(bp, 'snapshot'))), conclusionsBefore = JSON.parse(JSON.stringify(await call(bp, 'conclusion.list', { projectId: project.id, includeArchived: true })));
  await b.app.close();
  const reopened = await launch('user', 'bob');
  await reopened.page.locator('.modal').filter({ hasText: '登录团队工作台' }).getByRole('button', { name: '取消', exact: true }).click();
  const afterRestart = await call(reopened.page, 'snapshot');
  assert.deepEqual(afterRestart.sessions, beforeRestart.sessions); assert.deepEqual(afterRestart.inputs, beforeRestart.inputs);
  assert.deepEqual(afterRestart.settings.contentUpdates, beforeRestart.settings.contentUpdates);
  assert.deepEqual(await call(reopened.page, 'conclusion.list', { projectId: project.id, includeArchived: true }), conclusionsBefore);
  await expect(reopened.page.locator(`.session-row[data-session-id="${extraSession.id}"]`)).toBeVisible();
  await reopened.page.getByTitle('项目成果库', { exact: true }).click(); await reopened.page.getByRole('tab', { name: '个人', exact: true }).click();
  await reopened.page.locator('.content-card').filter({ hasText: '手工发布检查' }).locator('.content-card-summary').click();
  await reopened.page.locator('.result-card.is-expanded').getByRole('button', { name: '加入会话', exact: true }).click();
  await expect(reopened.page.getByLabel('使用成果的会话：另一个验证会话')).toBeChecked(); await expect(reopened.page.getByLabel('使用成果的会话：另一个验证会话')).toBeDisabled();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, data, cases: ['concurrent distinct users/admin', 'multi-window user edition with isolated accounts, sessions and sidebar proportions', 'teammate content notification', 'admin window without an offline setting', 'project settings synchronize 项目说明.md', 'project brief versions and explicit adoption', 'author revision', 'subadmin semantic merge/review/lock', 'search and frozen session reuse', 'every-project brief lifecycle', '1100px layout', 'unprocessed/processed groups and cleared hidden selections', 'multi-session conclusion selection locks existing context', 'application restart preserves local sessions, drafts, events and conclusion usage'] }));
} catch (error) {
  for (const [i, page] of pages.entries()) { await page.screenshot({ path: path.join(data, 'failure-' + i + '.png') }).catch(() => {}); await fs.writeFile(path.join(data, 'failure-' + i + '.txt'), await page.locator('body').innerText().catch(() => 'closed')); }
  throw error;
} finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }

}
main().catch(error => { console.error(error); process.exitCode = 1; });
