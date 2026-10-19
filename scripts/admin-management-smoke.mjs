import { releaseRoot } from './release-paths.mjs';
import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const data = path.resolve('.test-data', 'admin-management-' + Date.now()), shared = path.join(data, 'share'), store = path.join(data, 'admin');
await fs.mkdir(shared, { recursive: true }); await fs.mkdir(store);
const errors = [], checks = [];
let app, page;
async function launch() {
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(packaged ? { executablePath: path.join(releaseRoot, 'admin/win-unpacked/Team Agent Admin.exe'), args: [] } : { args: ['dist/admin'] }), cwd: process.cwd(), env });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
}
const confirm = async () => { await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0); };
const state = async () => (await page.evaluate(() => window.admin.call('snapshot'))).state;
const userRow = username => page.locator('.people-global [data-user="' + username + '"]');
const group = label => page.locator('[data-group="local_' + label + '"]');
async function fields(username) {
  await page.getByLabel('成员姓名', { exact: true }).fill(username === 'solo' ? '独立用户' : username);
  await page.getByLabel('登录账号', { exact: true }).fill(username);
  await expect(page.getByLabel('初始密码', { exact: true })).toHaveCount(0);
  await expect(page.locator('.modal')).toContainText('123456');
}
async function createGroup(label) {
  await page.getByRole('button', { name: '创建项目组', exact: true }).click();
  await page.getByLabel('项目组名称').fill(label); await confirm();
}
async function membership(select) {
  if (select) await select(); await confirm();
}
async function creationActions() {
  const actions = page.getByRole('group', { name: '创建账号与项目组', exact: true });
  const user = actions.getByRole('button', { name: '创建用户', exact: true }), group = actions.getByRole('button', { name: '创建项目组', exact: true });
  for (const view of ['全部用户', '按组查看']) {
    await page.getByRole('tab', { name: view, exact: true }).click();
    await expect(user).toBeEnabled(); await expect(group).toBeEnabled();
    await expect.poll(async () => {
      const a = await user.boundingBox(), b = await group.boundingBox();
      return !!a && !!b && Math.abs(a.y - b.y) <= 1 && b.x - a.x - a.width >= 0 && b.x - a.x - a.width <= 32;
    }).toBe(true);
    await expect(page.getByRole('button', { name: '创建项目组', exact: true })).toHaveCount(1);
    await user.click(); await expect(page.getByRole('heading', { name: '创建团队用户', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await group.click(); await expect(page.getByRole('heading', { name: '创建项目组', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  await page.getByRole('tab', { name: '全部用户', exact: true }).click();
}
try {
  await launch();
  await page.getByLabel('共享区类型').selectOption('local');
  await page.getByLabel('本地共享区根目录').fill(shared);
  await expect(page.getByLabel('管理账号', { exact: true })).toHaveCount(0); await expect(page.getByLabel('登录密码', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '创建账号与项目组' }).getByRole('button', { name: '创建用户', exact: true })).toBeDisabled();
  await expect(page.getByRole('group', { name: '创建账号与项目组' }).getByRole('button', { name: '创建项目组', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '初始化团队空间', exact: true }).click(); await confirm();
  await creationActions();
  const initialSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800));
  await creationActions();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), initialSize);
  checks.push('creation buttons are adjacent in both views and at 1100px; dialogs and initialization gating preserved');
  await page.getByRole('button', { name: '创建用户', exact: true }).click(); await fields('solo'); await confirm();
  await expect(userRow('solo')).toContainText('未分组'); assert.deepEqual((await state()).users.solo.groups, []);
  checks.push('create independent user before any groups exist');
  await createGroup('nlp'); await createGroup('ocr');
  await page.getByRole('button', { name: '创建用户', exact: true }).click(); await fields('alice');
  for (const label of ['nlp', 'ocr']) await page.getByRole('checkbox', { name: label, exact: true }).check();
  for (const label of ['nlp', 'ocr']) await expect(page.locator('.modal .check-row').filter({ hasText: label + ' · 内容管理者' }).locator('input')).toBeChecked();
  await page.locator('.modal .check-row').filter({ hasText: 'ocr · 内容管理者' }).locator('input').uncheck(); await confirm();
  await expect(userRow('alice').locator('.group-chip.subadmin')).toContainText('nlp');
  await expect(userRow('alice').locator('.group-chip')).toHaveCount(2);
  checks.push('global creation selects multiple groups and per-group subadmin');
  await page.getByRole('tab', { name: '按组查看', exact: true }).click();
  await expect(group('nlp').locator('[data-user="alice"]')).toContainText('管理者');
  await expect(group('ocr').locator('[data-user="alice"]')).toContainText('成员');
  await group('nlp').getByRole('button', { name: '组内创建用户', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'nlp', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'ocr', exact: true })).not.toBeChecked();
  await fields('bob'); await confirm(); assert.deepEqual((await state()).users.bob.groups, ['local_nlp']);
  checks.push('group creation preselects its group and updates hierarchy');
  await group('nlp').locator('[data-user="bob"]').getByRole('button', { name: '设为管理者', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual((await state()).users.bob.contentAdminGroups, []);
  checks.push('cancel role change leaves membership and permissions unchanged');
  await group('ocr').getByRole('button', { name: '添加已有用户', exact: true }).click();
  await expect(page.getByLabel('选择用户 alice', { exact: true })).toHaveCount(0);
  await page.getByLabel('选择用户 solo', { exact: true }).check(); await page.getByLabel('选择用户 bob', { exact: true }).check();
  await expect(page.getByText('已选择 2 位', { exact: true })).toBeVisible(); await page.getByLabel('成员身份').selectOption('member'); await confirm();
  assert((await state()).users.solo.groups.includes('local_ocr')); assert((await state()).users.bob.groups.includes('local_ocr'));
  await group('ocr').locator('[data-user="solo"]').getByRole('button', { name: '设为管理者', exact: true }).click(); await confirm();
  assert.deepEqual((await state()).users.solo.contentAdminGroups, ['local_ocr']);
  checks.push('group multi-selects existing users, applies one role, and excludes existing members');
  await page.getByRole('tab', { name: '全部用户', exact: true }).click();
  await userRow('solo').getByRole('button', { name: '加入用户组', exact: true }).click();
  await expect(page.getByLabel('选择已有用户组').locator('option[value="local_ocr"]')).toHaveCount(0);
  await page.getByLabel('选择已有用户组').selectOption('local_nlp'); await confirm();
  assert.deepEqual(new Set((await state()).users.solo.groups), new Set(['local_ocr', 'local_nlp']));
  assert.deepEqual((await state()).users.solo.contentAdminGroups, ['local_ocr']);
  checks.push('user adds an existing group without losing other memberships or roles');
  await userRow('alice').locator('.person-link').click();
  await expect(page.getByRole('checkbox', { name: 'nlp', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'ocr', exact: true }).uncheck(); await confirm();
  assert.deepEqual((await state()).users.alice.groups, ['local_nlp']);
  assert.deepEqual((await state()).users.alice.contentAdminGroups, ['local_nlp']);
  checks.push('click user to inspect and edit all memberships, removing one group preserves another role');
  await userRow('solo').locator('.group-chip').filter({ hasText: 'ocr' }).click();
  await page.getByLabel('成员身份').selectOption('remove'); await expect(page.locator('.membership-removal')).toContainText('账号、其他组身份及已上传内容保留'); await page.getByLabel('ocr 接任安排').selectOption('__vacant__'); await confirm();
  assert.deepEqual((await state()).users.solo.groups, ['local_nlp']); assert.deepEqual((await state()).users.solo.contentAdminGroups, []);
  checks.push('user-side removal revokes only that group and its subadmin role');
  await page.getByRole('tab', { name: '按组查看', exact: true }).click();
  await group('nlp').locator('[data-user="bob"]').getByRole('button', { name: '设为管理者', exact: true }).click(); await confirm();
  await expect(group('nlp').locator('[data-user="bob"]')).toContainText('管理者');
  await group('nlp').locator('[data-user="bob"]').getByRole('button', { name: '取消管理者', exact: true }).click(); await confirm();
  assert.deepEqual(new Set((await state()).users.bob.groups), new Set(['local_nlp', 'local_ocr'])); assert.deepEqual((await state()).users.bob.contentAdminGroups, []);
  await group('nlp').locator('[data-user="solo"]').getByRole('button', { name: '移出本组', exact: true }).click(); await confirm();
  assert((await state()).users.solo.enabled); await expect(page.locator('[data-group="unassigned"] [data-user="solo"]')).toBeVisible();
  checks.push('group-side promotion/demotion and removal; user remains enabled and appears unassigned');
  await group('nlp').locator('.group-heading').click(); await expect(group('nlp').locator('table')).toHaveCount(0);
  await group('nlp').locator('.group-heading').click(); await expect(group('nlp').locator('table')).toBeVisible();
  await page.getByRole('button', { name: '创建用户', exact: true }).click(); await fields('empty');
  await expect(page.locator('.modal .check-row input:checked')).toHaveCount(0); await confirm();
  checks.push('hierarchy expands/collapses; global creation from grouped view starts with no groups');
  await page.getByRole('button', { name: '创建用户', exact: true }).click(); await fields('bob');
  await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal [role="alert"]')).toContainText('已存在');
  await page.getByRole('button', { name: '取消', exact: true }).click(); assert.equal(Object.keys((await state()).users).length, 4);
  checks.push('duplicate creation surfaces error and leaves users unchanged');
  if (!packaged) await page.screenshot({ path: path.join(data, '按组查看.png') });
  await page.getByRole('tab', { name: '全部用户', exact: true }).click();
  await page.getByLabel('成员筛选').selectOption('unassigned'); await expect(page.locator('.people-global tbody tr')).toHaveCount(2);
  await page.getByLabel('成员筛选').selectOption('admins'); await expect(page.locator('.people-global tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.getByLabel('查找成员或用户组').fill('nlp'); await expect(page.locator('.people-global tbody tr')).toHaveCount(2);
  await page.getByLabel('查找成员或用户组').fill('no-such-member'); await expect(page.getByText('没有符合筛选条件的成员', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  if (!packaged) await page.screenshot({ path: path.join(data, '全部用户.png') });
  checks.push('search group/user, unassigned/subadmin filters and empty results');
  const finalState = await state(); await app.close(); await launch();
  await expect.poll(async () => (await page.evaluate(() => window.admin.call('snapshot'))).connected).toBe(true);
  await expect(page.locator('.modal')).toHaveCount(0);
  assert.deepEqual((await state()).users, finalState.users); await expect(page.locator('.people-global tbody tr')).toHaveCount(4);
  assert.deepEqual(errors, []); checks.push('restart keeps memberships and roles; no renderer errors');
  for (const username of ['张三', '10086', 'ZhangSan']) {
    await page.getByRole('button', { name: '创建用户', exact: true }).click(); await fields(username); await confirm();
    await expect(userRow(username)).toBeVisible();
  }
  await page.getByRole('button', { name: '创建用户', exact: true }).click(); await fields('invalid/name');
  await page.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.locator('.modal [role="alert"]')).toContainText('账号支持中文姓名');
  await expect(page.locator('.modal [role="alert"]')).not.toContainText('invalid_format');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  for (const username of ['张三', '10086', 'ZhangSan']) assert.equal((await state()).users[username].mustChangePassword, true);
  assert.deepEqual(errors, []);
  checks.push('Chinese name, numeric employee ID and mixed-case accounts use the default password and require first-login setup; invalid names show Chinese errors');

  // The administrator types the name members see; the Linux group name is derived from it.
  await page.getByRole('button', { name: '创建项目组', exact: true }).click();
  await page.getByLabel('项目组名称').fill('实体抽取'); await confirm();
  const derived = 'local_g' + createHash('sha256').update('实体抽取'.normalize('NFC'), 'utf8').digest('hex').slice(0, 13);
  await expect(page.locator('.admin-success')).toContainText('操作成功');
  await expect(page.locator('.admin-success')).toHaveCount(0, { timeout: 12000 });
  await page.getByRole('tab', { name: '按组查看', exact: true }).click();
  const card = page.locator('[data-group="' + derived + '"]');
  await expect(card).toContainText('实体抽取'); await expect(card).toContainText('/projects/实体抽取');
  assert.equal((await state()).groups[derived].label, '实体抽取');
  assert.deepEqual(errors, []);
  checks.push('a Chinese group name is accepted, the derived Linux group and Chinese workspace show on the card, and success notices dismiss themselves');

  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, packaged, data, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, packaged, data, cases: checks.length }, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(data, 'failure.png'), timeout: 5000 }).catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); }
