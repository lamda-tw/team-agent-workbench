import { releaseRoot } from './release-paths.mjs';
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const packaged = process.argv.includes('--packaged');
const data = path.resolve('.test-data', 'local-admin-access-' + Date.now()), share = path.join(data, 'share'), store = path.join(data, 'admin');
await fs.mkdir(share, { recursive: true });
const configFile = path.join(store, 'connection.json'), registryFile = path.join(share, '.workbench-local/registry.json');
const checks = [], errors = []; let app, page;
async function launch() {
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(packaged ? { executablePath: path.join(releaseRoot, 'admin/win-unpacked/Team Agent Admin.exe'), args: [] } : { args: ['dist/admin'] }), cwd: process.cwd(), env });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
}
const snapshot = () => page.evaluate(() => window.admin.call('snapshot'));
async function noCredentials() {
  await expect(page.getByLabel('管理账号', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('登录密码', { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
}
try {
  await launch();
  await page.getByLabel('共享区类型').selectOption('local'); await noCredentials();
  await expect(page.getByRole('button', { name: '打开共享目录', exact: true })).toBeDisabled();
  await page.getByLabel('本地共享区根目录').fill(share);
  await page.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await page.getByRole('button', { name: '初始化团队空间', exact: true }).click();
  await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await page.evaluate(() => window.admin.call('operation', { op: 'group_create', label: 'demo' }));
  await page.evaluate(() => window.admin.call('operation', { op: 'user_create', username: '张三', name: '张三', password: '1', groups: ['local_demo'], contentAdminGroups: ['local_demo'] }));
  assert.equal((await snapshot()).actor, '本地管理员');
  let registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  assert(!Object.hasOwn(registry.credentials, registry.administrator));
  const config = JSON.parse(await fs.readFile(configFile, 'utf8')); assert(!Object.hasOwn(config, 'password'));
  checks.push('first use: only a local directory; initialize and manage users without administrator credentials');
  await app.close();

  // Legacy identity and hashes are metadata; opening must not rewrite them.
  registry.administrator = '旧管理员'; registry.credentials['旧管理员'] = 'legacy-credential-kept';
  await fs.writeFile(registryFile, JSON.stringify(registry, null, 2));
  const before = await fs.readFile(registryFile, 'utf8');
  await fs.writeFile(configFile, JSON.stringify({ ...config, username: '旧管理员' }));
  await launch(); await expect.poll(async () => (await snapshot()).connected).toBe(true);
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('[data-user="张三"]')).toContainText('张三');
  assert.equal(await fs.readFile(registryFile, 'utf8'), before);
  checks.push('restart: auto-opens legacy local space, preserves accounts, roles and old credential records');

  await page.getByRole('button', { name: '连接设置', exact: true }).click(); await noCredentials();
  await page.getByRole('button', { name: '断开', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '打开本地共享目录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '配置连接', exact: true }).click();
  await page.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  checks.push('disconnect/reconnect remains credential-free and uses local-specific instructions');

  await app.close();
  const moved = path.join(data, 'moved-share'); assert.equal(path.dirname(share), data); assert.equal(path.dirname(moved), data);
  await fs.rename(share, moved);
  await launch();
  await expect(page.locator('.modal [role="alert"]')).toContainText('本地共享目录不存在'); await noCredentials();
  assert.equal((await snapshot()).connected, false);
  await page.getByLabel('本地共享区根目录').fill(moved);
  await page.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.admin-alert')).toHaveCount(0);
  assert.equal((await snapshot()).state.users['张三'].username, '张三');
  checks.push('missing saved directory surfaces an error; choosing the moved directory recovers without passwords or data loss');

  await page.getByRole('button', { name: '连接设置', exact: true }).click(); await page.getByLabel('共享区类型').selectOption('sftp');
  await expect(page.getByLabel('管理账号', { exact: true })).toBeVisible(); await expect(page.getByLabel('登录密码', { exact: true })).toBeVisible();
  await page.getByLabel('中央节点地址').fill('127.0.0.1'); await page.getByLabel('管理账号', { exact: true }).fill('root');
  await expect(page.getByRole('button', { name: '连接并验证权限', exact: true })).toBeDisabled();
  await assert.rejects(page.evaluate(() => window.admin.call('connect', { profile: { mode: 'sftp', host: '127.0.0.1', port: 22, username: 'root', root: '/srv/teamspace' } })), /请输入服务器登录密码/);
  checks.push('Linux mode still requires credentials in both the UI and IPC validation');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, packaged, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, packaged, data, cases: checks.length }, null, 2));
} finally { await app?.close().catch(() => {}); }
