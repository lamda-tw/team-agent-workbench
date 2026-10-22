import { _electron as electron, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

// Exercise the real IPC + renderer with empty local conversations; no model calls.
const expect = baseExpect.configure({ timeout: 15000 });
const root = process.cwd(), build = await fs.realpath(process.env.WORKBENCH_TEST_BUILD_ROOT || path.join(root, 'dist'));
const data = path.join(root, '.test-data', 'subsession-close-' + Date.now()), store = path.join(data, 'user'), cwd = path.join(data, 'work');
await Promise.all([store, cwd].map(dir => fs.mkdir(dir, { recursive: true })));
const cli = await authLauncher(path.join(data, 'cli'));
await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [], lastWorkspace: '', providerPaths: { codex: cli.launcher, cursor: cli.launcher, claude: cli.launcher } }));
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
let app, page; const errors = [];
const call = (action, payload) => page.evaluate(([a, p]) => window.workbench.call(a, p), [action, payload]);
const snapshot = () => call('snapshot');
try {
  app = await electron.launch({ args: [path.join(build, 'user')], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: '新建会话', exact: true }).waitFor();
  const parent = await call('personal:session.create', { provider: 'codex', cwd, projectId: '__personal__', includeBrief: false });
  await call('session.rename', { id: parent.id, title: '父会话保留' });
  const child = await call('subsession.create', { parentId: parent.id, focus: '待关闭的子会话', selectedText: '关闭后保留的草稿' });
  const sibling = await call('subsession.create', { parentId: parent.id, focus: '其他子会话保留' });
  await page.getByRole('button', { name: '展开会话菜单：父会话保留', exact: true }).click();
  await page.locator(`[data-session-id="${child.id}"]`).click();
  const panel = page.getByRole('region', { name: '子会话：待关闭的子会话', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox', { name: '子会话输入', exact: true })).toHaveValue('关闭后保留的草稿');
  await panel.getByRole('button', { name: '更多子会话操作', exact: true }).click();
  await panel.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开子会话', exact: true })).toBeVisible();
  await expect(page.locator(`[data-session-id="${child.id}"]`)).toHaveCount(0);
  let state = await snapshot();
  assert(state.sessions.find(s => s.id === child.id).closedAt);
  assert(!state.sessions.find(s => s.id === parent.id).closedAt);
  assert(!state.sessions.find(s => s.id === sibling.id).closedAt);
  assert.equal(state.inputs[child.id].text, '关闭后保留的草稿');
  assert.equal(state.sessions.find(s => s.id === child.id).fork.parentId, parent.id);

  await page.getByRole('button', { name: '已关闭会话（1）', exact: true }).click();
  await page.locator(`[data-session-id="${child.id}"]`).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('已关闭');
  await expect(panel.getByRole('textbox', { name: '子会话输入', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '更多子会话操作', exact: true }).click();
  await panel.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: '子会话输入', exact: true })).toHaveValue('关闭后保留的草稿');
  state = await snapshot(); assert(!state.sessions.find(s => s.id === child.id).closedAt);
  assert.equal(state.sessions.length, 3);
  await page.screenshot({ path: path.join(data, 'reopened.png') });
  assert.deepEqual(errors, []);
  const report = { passed: true, data, cases: ['close dismisses the right-hand conversation', 'closed child leaves active list', 'parent and sibling remain open', 'history and draft survive closing', 'closed history is explicitly read-only', 'reopen restores input and original draft'] };
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {}); throw error; }
finally { await app?.close().catch(() => {}); }
