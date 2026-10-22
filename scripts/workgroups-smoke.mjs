import { _electron as electron, expect as baseExpect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { completeProjectSetup } from './onboarding-helpers.mjs';
import { memberProfile, setConnectionProfile } from './connection-helpers.mjs';
const expect = baseExpect.configure({ timeout: 20000 });

const root = process.cwd(), data = path.join(root, '.test-data', 'workgroups-ui-' + Date.now()), share = path.join(data, 'share');
await fs.mkdir(share, { recursive: true });
const fixture = await authLauncher(path.join(data, 'cli')); await fixture.write({ status: 'ready' });
const apps = [], errors = [];
async function launch(edition) {
  const store = path.join(data, edition); await fs.mkdir(store);
  if (edition === 'user') {
    const settings = { connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher, claude: fixture.launcher }, lastWorkspace: '' };
    for (const directory of [path.join(store, 'window-state', '1'), path.join(store, 'personal')]) {
      await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings));
    }
  }
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store, WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist/' + edition], cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); return { app, page };
}
async function confirm(page) { await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0); }
try {
  const admin = await launch('admin'), ap = admin.page;
  await ap.getByLabel('共享区类型').selectOption('local'); await ap.getByLabel('本地共享区根目录').fill(share);
  await ap.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(ap.locator('.modal')).toHaveCount(0);
  await ap.getByRole('button', { name: '初始化团队空间', exact: true }).click(); await confirm(ap);
  for (const label of ['ocr', 'nlp', 'secret']) {
    await ap.getByRole('button', { name: '创建项目组', exact: true }).click(); await ap.getByLabel('项目组名称').fill(label); await confirm(ap);
  }
  await ap.getByRole('button', { name: '创建用户', exact: true }).click();
  await ap.getByLabel('成员姓名', { exact: true }).fill('测试成员'); await ap.getByLabel('登录账号', { exact: true }).fill('test1');
  await expect(ap.getByLabel('初始密码', { exact: true })).toHaveCount(0); await confirm(ap);
  const row = ap.locator('tbody tr').filter({ hasText: 'test1' });
  const config = await memberProfile(admin, 'test1'); assert.equal(config.workPath, ''); assert.deepEqual(config.projects, []);
  const user = await launch('user'), up = user.page;
  await setConnectionProfile(user, config);
  await up.getByLabel('成员账号').fill('test1'); await up.getByLabel('登录密码', { exact: true }).fill('123456');
  await expect(up.getByLabel('共享工作路径', { exact: true })).toHaveCount(0); await expect(up.getByLabel('Linux 工作路径', { exact: true })).toHaveCount(0);
  await up.getByRole('button', { name: '连接', exact: true }).click();
  await up.getByLabel('新密码', { exact: true }).fill('1'); await up.getByLabel('确认新密码', { exact: true }).fill('1');
  await up.getByRole('button', { name: '连接', exact: true }).click(); await expect(up.locator('.modal')).toHaveCount(0);
  await expect(up.locator('.workgroup')).toHaveCount(0); await expect(up.getByLabel('空白工作台')).toBeVisible(); await up.screenshot({ path: path.join(data, 'no-groups.png') });
  await expect(up.getByTitle('新建会话', { exact: true })).toBeEnabled();
  const snap = () => up.evaluate(() => window.workbench.call('snapshot'));
  assert.equal((await snap()).sessions.length, 0);
  await assert.rejects(up.evaluate(data => window.workbench.call('session.create', { provider: 'codex', cwd: data, projectId: 'unauthorized-team-project' }), data), /没有加入工作组/);
  for (const group of ['local_ocr', 'local_nlp']) {
    await row.getByRole('button', { name: '加入用户组', exact: true }).click(); await ap.getByLabel('选择已有用户组').selectOption(group);
    await ap.getByLabel('成员身份', { exact: true }).selectOption('admin'); await confirm(ap);
  }
  await up.getByRole('button', { name: '刷新工作组、项目和文件', exact: true }).click(); await expect(up.locator('.workgroup')).toHaveCount(2);
  await expect(up.getByText('还没有加入工作组', { exact: true })).toHaveCount(0); await expect(up.locator('[data-group-name="local_secret"]')).toHaveCount(0);
  for (const group of ['ocr', 'nlp']) {
    await up.getByTitle('在 ' + group + ' 创建项目', { exact: true }).click();
    await expect(up.getByRole('dialog', { name: '完善项目资料' })).toContainText(group + ' · 项目初始化');
    await fs.mkdir(path.join(data, group), { recursive: true });
    await completeProjectSetup(up, '同名项目', path.join(data, group));
  }
  await expect(up.locator('.workgroup-project')).toHaveCount(2);
  // One saved account/connection discovers both groups again on the next login.
  await up.locator('.connection-button').click();
  await expect(up.getByRole('button', { name: '添加其他服务器', exact: true })).toHaveCount(0);
  await expect(up.getByLabel('本地共享区根目录', { exact: true })).toHaveCount(0);
  await up.getByLabel('登录密码', { exact: true }).fill('1');
  await up.getByRole('button', { name: '连接', exact: true }).click();
  await expect(up.locator('.modal')).toHaveCount(0);
  await expect(up.locator('.workgroup')).toHaveCount(2);
  await expect(up.locator('.workgroup-project')).toHaveCount(2);
  assert.equal((await snap()).settings.connections.length, 1);
  assert.equal((await snap()).connection.profile.localRoot, share);
  const projects = (await snap()).connection.profile.projects, ocr = projects.find(p => p.groupName === 'local_ocr');
  await up.locator('[data-project-id="' + ocr.id + '"]').click();
  await up.getByTitle('新建会话', { exact: true }).click(); await up.getByLabel('Codex 登录状态').getByText('已登录', { exact: true }).waitFor();
  await expect(up.getByLabel('绑定共享项目')).toHaveCount(0);
  await up.getByRole('button', { name: '创建会话', exact: true }).click(); await expect(up.locator('.modal')).toHaveCount(0);
  const bound = (await snap()).sessions.find(s => s.binding?.project.id === ocr.id); assert(bound); assert.equal(bound.cwd, await fs.realpath(path.join(data, 'ocr')));
  await up.locator('[data-group-name="local_nlp"] .workgroup-project').click();
  assert.equal((await snap()).sessions.find(s => s.id === bound.id).binding.project.id, ocr.id);
  await up.screenshot({ path: path.join(data, 'two-groups.png') });
  // Canceling the native picker must not create a task, show success, or navigate.
  const transferIds = (await snap()).transfers.map(task => task.id);
  await user.app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await up.getByTitle('上传文件到当前目录', { exact: true }).click();
  assert.deepEqual((await snap()).transfers.map(task => task.id), transferIds);
  await expect(up.getByRole('button', { name: '工作会话', exact: true })).toHaveClass(/active/);
  await expect(up.getByRole('heading', { name: '传输记录', exact: true })).toHaveCount(0);
  await expect(up.locator('.toast').filter({ hasText: '文件已加入上传队列' })).toHaveCount(0);
  // A real selection still queues the file and opens transfer records.
  const uploadSource = path.join(data, 'picker-upload.md'); await fs.writeFile(uploadSource, '# File picker upload');
  await user.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, uploadSource);
  await up.getByTitle('上传文件到当前目录', { exact: true }).click();
  await expect(up.getByRole('heading', { name: '传输记录', exact: true })).toBeVisible();
  await expect(up.locator('.toast')).toContainText('文件已加入上传队列');
  await expect.poll(async () => (await snap()).transfers.find(task => task.name === 'picker-upload.md')?.status).toBe('done');
  const uploaded = (await snap()).transfers.find(task => task.name === 'picker-upload.md');
  assert.equal(await fs.readFile(path.join(share, ...uploaded.target.split('/').filter(Boolean)), 'utf8'), '# File picker upload');
  await up.getByRole('button', { name: '工作会话', exact: true }).click();
  // A single refresh updates both membership and the selected project's files.
  const nlp = projects.find(p => p.groupName === 'local_nlp');
  const refreshButton = up.getByRole('button', { name: '刷新工作组、项目和文件', exact: true });
  await expect(refreshButton).toHaveCount(1);
  await expect(up.getByTitle('刷新文件', { exact: true })).toHaveCount(0);
  await expect(up.locator('.file-row').filter({ hasText: 'refresh-check.md' })).toHaveCount(0);
  // Change role and membership through administrator UI while the user stays connected.
  await row.getByTitle('管理 nlp 成员身份', { exact: true }).click(); await ap.getByLabel('成员身份', { exact: true }).selectOption('member'); await ap.getByLabel('nlp 接任安排').selectOption('__vacant__'); await confirm(ap);
  await fs.writeFile(path.join(share, ...nlp.remoteRoot.split('/').filter(Boolean), 'refresh-check.md'), '# Newly shared file');
  await up.getByTitle('刷新工作组、项目和文件', { exact: true }).click(); await expect(up.locator('.toast')).toContainText('账号身份与工作组已刷新'); await expect(up.getByTitle('在 nlp 创建项目', { exact: true })).toHaveCount(0);
  await expect(up.locator('.file-row').filter({ hasText: 'refresh-check.md' })).toBeVisible({ timeout: 5000 });
  await expect(refreshButton).toBeEnabled();
  await expect(up.getByTitle('在 ocr 创建项目', { exact: true })).toHaveCount(1);
  await assert.rejects(up.evaluate(() => window.workbench.call('project.create', { name: '越权创建', groupName: 'local_nlp' })), /组管理员|权限|管理/);
  await up.screenshot({ path: path.join(data, 'independent-roles.png') });
  await row.getByTitle('管理 ocr 成员身份', { exact: true }).click(); await ap.getByLabel('成员身份', { exact: true }).selectOption('remove'); await ap.getByLabel('ocr 接任安排').selectOption('__vacant__'); await confirm(ap);
  await up.getByTitle('刷新工作组、项目和文件', { exact: true }).click(); await expect(up.locator('.workgroup')).toHaveCount(1);
  assert.equal((await snap()).sessions.find(s => s.id === bound.id).binding.project.id, ocr.id);
  await assert.rejects(up.evaluate(id => window.workbench.call('session.uploadTrajectory', { id }), bound.id), /项目入口配置已改变/);
  await fs.rename(path.join(share, 'projects', 'nlp'), path.join(share, 'projects', 'nlp-missing'));
  await up.getByTitle('刷新工作组、项目和文件', { exact: true }).click(); await expect(up.locator('.workgroup .inline-error')).toBeVisible();
  await expect(up.getByText('还没有加入工作组', { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, cases: ['unassigned login and admin config import', 'no shared root or shared path input', 'unassigned users retain personal work but cannot create team sessions', 'live group assignment', 'one saved account login discovers two groups', 'separate groups and same-name projects', 'independent subadmin/member roles and backend denial', 'canceled upload preserves view with no task or success toast', 'selected upload queues and reaches shared filesystem', 'one refresh updates both membership and current project files', 'separate file refresh removed', 'user refreshes identity after administrator changes', 'session stays bound after switching groups', 'membership revocation blocks upload', 'inaccessible group differs from no groups'], screenshots: ['no-groups.png', 'two-groups.png', 'independent-roles.png'] }, null, 2));
  console.log(JSON.stringify({ passed: true, data }));
} finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
