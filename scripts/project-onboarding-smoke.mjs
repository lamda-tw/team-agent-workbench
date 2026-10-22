import { _electron as electron, expect as baseExpect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { completeProjectSetup, completeProjectDirectory } from './onboarding-helpers.mjs';
import { memberProfile, setConnectionProfile } from './connection-helpers.mjs';
const expect = baseExpect.configure({ timeout: 20000 });
const root = process.cwd(), data = path.join(root, '.test-data', 'project-onboarding-ui-' + Date.now()), share = path.join(data, 'share'); await fs.mkdir(share, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
const apps = [], pages = [], errors = [];
async function launch(edition, name) {
  const store = path.join(data, name); await fs.mkdir(store, { recursive: true });
  if (edition === 'user' && !await fs.stat(path.join(store, 'settings.json')).catch(() => false)) await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [], providerPaths: { codex: cli.launcher, cursor: cli.launcher }, lastWorkspace: '' }));
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store, WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist/' + edition], cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); pages.push(page); page.on('pageerror', e => errors.push(e.message)); return { app, page };
}
const confirm = async page => { await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0); };
async function fields(page, username) {
  await page.getByLabel('成员姓名', { exact: true }).fill(username); await page.getByLabel('登录账号', { exact: true }).fill(username);
  await page.getByLabel('初始密码', { exact: true }).fill('1'); await page.getByLabel('再次输入密码', { exact: true }).fill('1');
}
async function login(user, username, first = false, profile) {
  const { page } = user;
  if (!first) {
    const loginOpen = await page.getByLabel('成员账号').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    if (!loginOpen) await page.locator('.connection-button').click();
  }
  if (first) await setConnectionProfile(user, profile);
  await page.getByLabel('成员账号').fill(username); await page.getByLabel('登录密码', { exact: true }).fill('1');
  await page.getByRole('button', { name: '连接', exact: true }).click(); await expect(page.getByLabel('成员账号')).toHaveCount(0);
}
try {
  const admin = await launch('admin', 'admin'), ap = admin.page;
  await ap.getByLabel('共享区类型').selectOption('local'); await ap.getByLabel('本地共享区根目录').fill(share);
  await ap.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(ap.locator('.modal')).toHaveCount(0);
  await ap.getByRole('button', { name: '初始化团队空间', exact: true }).click(); await confirm(ap);
  for (const username of ['bob', 'carol']) { await ap.getByRole('button', { name: '创建用户', exact: true }).click(); await fields(ap, username); await confirm(ap); }
  for (const label of ['alpha', 'beta', 'gamma']) { await ap.getByRole('button', { name: '创建项目组', exact: true }).click(); await ap.getByLabel('项目组名称').fill(label); await confirm(ap); }
  await ap.getByRole('tab', { name: '按组查看', exact: true }).click();
  const group = name => ap.locator(`[data-group="local_${name}"]`);
  for (const username of ['alice', 'dave']) {
    await group('alpha').getByRole('button', { name: '组内创建用户', exact: true }).click();
    const role = ap.locator('.modal .check-row').filter({ hasText: 'alpha · 内容组管理员' }).locator('input');
    if (username === 'alice') await expect(role).toBeChecked(); else await expect(role).not.toBeChecked();
    await fields(ap, username); await confirm(ap);
  }
  await group('beta').getByRole('button', { name: '添加已有用户', exact: true }).click();
  await expect(ap.getByLabel('成员身份')).toHaveValue('admin'); await ap.getByLabel('选择用户 bob', { exact: true }).check(); await confirm(ap);
  await ap.getByRole('tab', { name: '全部用户', exact: true }).click();
  await ap.locator('.people-global [data-user="carol"]').getByRole('button', { name: '加入用户组', exact: true }).click();
  await ap.getByLabel('选择已有用户组').selectOption('local_gamma'); await expect(ap.getByLabel('成员身份')).toHaveValue('admin');
  await ap.getByLabel('成员身份').selectOption('member'); await confirm(ap);
  const members = (await ap.evaluate(() => window.admin.call('snapshot'))).state.users;
  assert.deepEqual(members.alice.contentAdminGroups, ['local_alpha']); assert.deepEqual(members.dave.contentAdminGroups, []);
  assert.deepEqual(members.bob.contentAdminGroups, ['local_beta']); assert.deepEqual(members.carol.contentAdminGroups, []);
  await ap.screenshot({ path: path.join(data, 'admin-default-roles.png') });

  const profiles = Object.fromEntries(await Promise.all(['alice', 'dave'].map(async username => [username, await memberProfile(admin, username)])));
  let owner = await launch('user', 'owner'), up = owner.page;
  await login(owner, 'alice', true, profiles.alice);
  const guide = () => up.getByRole('dialog', { name: '完善项目资料', exact: true });
  await expect(guide()).toContainText('alpha · 项目初始化'); await expect(guide().getByRole('button', { name: '保存并创建项目' })).toBeDisabled();
  await guide().getByLabel('引导项目名称').fill('客户资料整理'); await guide().getByLabel('项目背景', { exact: true }).fill('暂存的背景：客户资料重复录入较多。');
  await guide().getByRole('button', { name: '稍后填写', exact: true }).click(); await expect(guide()).toHaveCount(0);
  await expect(up.getByRole('button', { name: '新建工作会话', exact: true })).toBeVisible(); assert.deepEqual(await fs.readdir(path.join(share, 'projects/alpha')), []);
  await up.locator('[data-group-name="local_alpha"]').getByRole('button', { name: '完善项目资料', exact: true }).click();
  await expect(guide().getByLabel('引导项目名称')).toHaveValue('客户资料整理'); await expect(guide().getByLabel('项目背景', { exact: true })).toHaveValue('暂存的背景：客户资料重复录入较多。');
  await guide().getByRole('button', { name: '稍后填写', exact: true }).click();
  await owner.app.close(); owner = await launch('user', 'owner'); up = owner.page; await login(owner, 'alice');
  await expect(guide().getByLabel('引导项目名称')).toHaveValue('客户资料整理'); await expect(guide().getByLabel('项目背景', { exact: true })).toHaveValue('暂存的背景：客户资料重复录入较多。');
  await guide().getByLabel('项目目标', { exact: true }).fill('提高处理效率与结果质量。'); await guide().getByLabel('验收标准', { exact: true }).fill('指定样例全部通过，由负责人评审。');
  await guide().getByText('补充范围、资料与协作约定（可选）', { exact: true }).click();
  for (const [label, value] of [['范围与非目标', '本轮只处理文本。'], ['交付物与里程碑', '两周内完成原型与说明。'], ['现有资料与入口', '先整理共享资料，暂时没有代码仓。'], ['约束与风险', '只使用脱敏样例，不共享密钥。'], ['协作约定', '每周评审，保留决定依据。']]) await guide().getByLabel(label, { exact: true }).fill(value);
  await up.setViewportSize({ width: 1100, height: 760 }); await guide().getByRole('button', { name: '保存并创建项目' }).scrollIntoViewIfNeeded();
  const box = await guide().getByRole('button', { name: '保存并创建项目' }).boundingBox(); assert(box && box.y >= 0 && box.y + box.height <= 760);
  await up.screenshot({ path: path.join(data, 'project-brief-form.png') });
  await guide().getByRole('button', { name: '保存并创建项目' }).click(); await expect(guide()).toHaveCount(0);
  await completeProjectDirectory(up);
  const file = path.join(share, 'projects/alpha/客户资料整理/项目说明.md'), text = await fs.readFile(file, 'utf8');
  assert(text.includes('暂存的背景')); assert(text.includes('没有代码仓')); assert(text.includes('每周评审'));
  assert((await fs.stat(path.join(share, 'projects/alpha/客户资料整理/trajectories'))).isDirectory());
  await up.locator('.file-row').filter({ hasText: '项目说明.md' }).click(); await expect(up.locator('.preview-content')).toContainText('提高处理效率');
  await up.screenshot({ path: path.join(data, 'shared-project-brief.png') });
  const teammate = await launch('user', 'teammate');
  // Reproduce a slow first-login settings save after groups have already been discovered.
  await teammate.app.evaluate(() => {
    const fs = process.getBuiltinModule('node:fs/promises'), rename = fs.rename;
    fs.rename = async (from, to) => { if (String(to).endsWith('settings.json')) { fs.rename = rename; await new Promise(resolve => setTimeout(resolve, 1200)); } return rename(from, to); };
  });
  await login(teammate, 'dave', true, profiles.dave); await expect(teammate.page.getByRole('dialog', { name: '完善项目资料' })).toHaveCount(0);
  await completeProjectDirectory(teammate.page);
  const sharedBrief = teammate.page.locator('.file-row').filter({ hasText: '项目说明.md' });
  await expect(sharedBrief).toBeVisible({ timeout: 5000 }); await sharedBrief.click(); await expect(teammate.page.locator('.preview-content')).toContainText('只使用脱敏样例');
  // Reconnect in the same desktop app: another account/group never receives Alice's draft.
  await login(owner, 'bob'); await expect(guide()).toContainText('beta · 项目初始化'); await expect(guide().getByLabel('引导项目名称')).toHaveValue('');
  await completeProjectSetup(up, '另一个组的项目'); assert((await fs.stat(path.join(share, 'projects/beta/另一个组的项目/项目说明.md'))).isFile());
  assert.equal(await fs.readFile(file, 'utf8'), text);
  await login(owner, 'alice'); await expect(up.locator('.workgroup-project')).toContainText('客户资料整理'); await expect(guide()).toHaveCount(0);
  await login(owner, 'carol'); await expect(up.locator('[data-group-name="local_gamma"]')).toBeVisible(); await expect(guide()).toHaveCount(0);
  await expect(up.getByRole('button', { name: '完善项目资料', exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, data, cases: ['first created member defaults admin', 'first added member defaults admin from both entry points', 'later member remains ordinary', 'explicit role override', 'automatic first-login prompt', 'defer without blocking local work', 'local draft and restart', 'all brief fields shared in project root', 'teammate reads brief after slow first-login persistence', 'account and group isolation', 'existing content and ordinary members do not prompt', '1100px layout'] }));
} catch (error) {
  for (const [index, page] of pages.entries()) if (!page.isClosed()) {
    await page.screenshot({ path: path.join(data, `failure-${index}.png`), timeout: 5000 }).catch(() => {});
    await fs.writeFile(path.join(data, `failure-${index}.txt`), await page.locator('body').innerText().catch(() => 'window closed'));
  }
  console.error('Onboarding UI evidence:', data); throw error;
} finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
