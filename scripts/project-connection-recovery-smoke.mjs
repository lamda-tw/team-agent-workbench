import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { teamServer } from '../tests/fixtures/team-server.mjs';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const root = process.cwd(), build = await fs.realpath(process.env.WORKBENCH_TEST_BUILD_ROOT || path.join(root, 'dist'));
const data = path.join(root, '.test-data', 'project-connection-recovery-' + Date.now()), store = path.join(data, 'user');
const server = await teamServer({ taowen: 'taowen', alice: 'alice' });
const profile = server.profile('taowen'), errors = [];
const existingId = 'project_' + 'a'.repeat(32), unavailableId = 'project_' + 'b'.repeat(32);
function seedProject(id, name, group = 'ocr') {
  const dir = '/projects/' + group + '/' + name;
  server.nodes.set(dir, { mode: 0o40755, uid: 0, gid: 100, data: Buffer.alloc(0) });
  server.nodes.set(dir + '/.workbench-project.json', { mode: 0o100644, uid: 0, gid: 100, data: Buffer.from(JSON.stringify({ version: 1, id, name })) });
}
seedProject(existingId, '算法研究');
seedProject(unavailableId, '另一个组的项目', 'denied');
await fs.mkdir(store, { recursive: true });
const cli = await authLauncher(path.join(data, 'cli'));
await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [profile], lastWorkspace: '', providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher } }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const call = (action, payload) => page.evaluate(([a, p]) => window.workbench.call(a, p), [action, payload]);
const snapshot = () => call('snapshot');
try {
  app = await electron.launch({ args: [path.join(build, 'user')], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  // Only approve this isolated fixture's first-connect dialog, never a real host.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  const refresh = page.getByRole('button', { name: '刷新工作组、项目和文件', exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole('heading', { name: '重新连接中央节点', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '跳过', exact: true }).click();

  await assert.rejects(call('remote.connect', { profile, password: 'wrong-password', projectId: unavailableId }), /authentication|密码/i);
  assert.equal((await snapshot()).connection, undefined);
  const result = await call('remote.connect', { profile, password: 'test-password', projectId: unavailableId });
  assert.equal(result.username, 'taowen');
  assert.equal(result.selectedProjectId, undefined);
  assert.match(result.connectionNotice, /已登录.*未出现在当前账号/);
  let state = await snapshot();
  assert.equal(state.connection.connected, true);
  assert(state.connection.profile.projects.some(p => p.id === existingId));
  assert(!state.connection.profile.projects.some(p => p.id === unavailableId));
  await assert.rejects(call('remote.list', { projectId: unavailableId, path: '/projects/denied' }), /项目入口不存在/);
  // Reusing the same authenticated connection also tolerates a removed selection.
  const reused = await call('project.connection.open', { key: state.reusableConnections[0].key, projectId: unavailableId });
  assert.equal(reused.newWindow, false); assert.equal(reused.projectId, undefined); assert.match(reused.notice, /已登录/);

  const deferredId = 'project_' + 'c'.repeat(32);
  seedProject(deferredId, '新加入的项目');
  await expect(page.getByTitle('项目设置：新加入的项目', { exact: true })).toHaveCount(0);
  // Refresh must reach the central node even with the personal workspace selected.
  await refresh.click();
  await expect(page.getByTitle('项目设置：新加入的项目', { exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();

  await call('remote.disconnect');
  await expect.poll(async () => !!(await snapshot()).connection).toBe(false);
  await expect(refresh).toBeEnabled(); await refresh.click();
  await expect(page.getByRole('heading', { name: '重新连接中央节点', exact: true })).toBeVisible();
  await expect(page.getByLabel('成员账号', { exact: true })).toHaveValue('taowen');
  await page.getByLabel('登录密码', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '重新连接中央节点', exact: true })).toHaveCount(0);
  await expect.poll(async () => !!(await snapshot()).connection?.connected).toBe(true);
  const skipDirectory = page.getByRole('button', { name: '暂不设置', exact: true });
  if (await skipDirectory.isVisible()) await skipDirectory.click();
  await expect(refresh).toBeEnabled();
  await page.screenshot({ path: path.join(data, 'reconnected.png') });
  assert.deepEqual(errors, []);
  const report = { passed: true, data, cases: ['disconnected refresh opens login', 'wrong password still rejected', 'missing project does not reject successful SSH login', 'unavailable project remains inaccessible', 'reuse accepts connection without stale project', 'personal view refreshes the team project list', 'disconnect and UI password login recover'] };
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {}); throw error;
} finally { await app?.close().catch(() => {}); await server.close(); }
