import { _electron as electron, expect as baseExpect, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { memberProfile } from '../tests/fixtures/member-profile';
import { diskPath } from '../src/core/local-space';
// @ts-expect-error Shared fixture.
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const call = (page: Page, action: string, payload?: unknown): Promise<any> => page.evaluate(([a, p]) => (window as any).workbench.call(a, p), [action, payload]);
const root = process.cwd(), data = path.join(root, '.test-data', 'sidebar-layout-' + Date.now()), share = path.join(data, 'shared');
const admin = new LocalAdminConnection(() => {}), member = new Workbench(path.join(data, 'member'), () => {}, () => {});
let app: ElectronApplication | undefined;
const errors: string[] = [];

async function layout(page: Page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>('.sidebar')!, rect = sidebar.getBoundingClientRect();
    const panes = ['workgroup', 'session'].map(name => {
      const node = document.querySelector<HTMLElement>(`#sidebar-${name}-list`)!;
      const bounds = node.getBoundingClientRect();
      return { name, top: bounds.top, bottom: bounds.bottom, height: bounds.height, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
    });
    const controls = Array.from(document.querySelectorAll<HTMLElement>('.sidebar-head, .sidebar .pad, .path-row, .search, .session-heading, .sidebar-splitter, .closed-toggle')).map(node => ({ name: node.textContent || node.getAttribute('aria-label'), top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }));
    return { top: rect.top, bottom: rect.bottom, height: sidebar.clientHeight, scrollHeight: sidebar.scrollHeight, scrollTop: sidebar.scrollTop, overflow: getComputedStyle(sidebar).overflowY, documentOverflow: document.documentElement.scrollHeight > window.innerHeight, panes, controls };
  });
}

async function verifyBounds(page: Page) {
  await expect.poll(async () => {
    const state = await layout(page);
    return state.scrollHeight <= state.height + 1;
  }).toBe(true);
  const state = await layout(page);
  assert.equal(state.overflow, 'hidden');
  assert.equal(state.scrollTop, 0);
  assert.equal(state.documentOverflow, false);
  for (const pane of state.panes) {
    assert(pane.height >= 79, `${pane.name} must remain usable`);
    assert(pane.top >= state.top && pane.bottom <= state.bottom + 1, `${pane.name} must remain inside the sidebar`);
  }
  for (const control of state.controls) assert(control.top >= state.top && control.bottom <= state.bottom + 1, `${control.name} must stay visible`);
  return state;
}

async function main() {
await fs.mkdir(share, { recursive: true });
try {
  await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', root: '/srv/teamspace', fingerprint: '' }, '', '', async () => false);
  await admin.operation({ op: 'initialize' });
  for (const label of ['算法研究', '软件开发', '算法工程', '竞赛优化']) await admin.operation({ op: 'group_create', label });
  const groups = Object.values(admin.snapshot.state!.groups).map(group => group.name);
  await admin.operation({ op: 'user_create', username: 'alice', name: 'Alice', password: '123', groups, contentAdminGroups: groups });
  const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'alice');
  await member.store.init(); await member.configureWorkspace(profile, '123', data, async () => false);
  await member.remote.changePassword('123', 'sidebar-test-123');
  const cli = await authLauncher(path.join(data, 'cli'), { status: 'ready', turn: 'success' });
  member.store.settings.providerPaths = { codex: cli.launcher, cursor: cli.launcher };
  const projects = [];
  for (const group of groups) for (let index = 1; index <= 3; index++) projects.push(await member.createProject(`方案迭代 ${index}`, group, { background: '侧栏布局验证', objectives: '独立滚动与窗口缩放', acceptance: '所有入口始终可见', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' }));
  await member.projectSync.sync();
  const project = member.projectBinding(projects[0].id).project;
  const projectPath = await diskPath(share, project.remoteRoot);
  for (let index = 1; index <= 24; index++) await fs.writeFile(path.join(projectPath, `迭代记录-${String(index).padStart(2, '0')}.md`), `# 记录 ${index}`);
  for (let index = 1; index <= 16; index++) {
    const session = await member.createSession('codex', data, project.id);
    session.title = `优化会话 ${index}`;
  }
  await member.store.save(); await member.close();

  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: member.store.root }; delete env.ELECTRON_RUN_AS_NODE;
  const entry = path.join(data, 'test-entry.cjs');
  await fs.writeFile(entry, `const fs = require('node:fs');\nrequire('electron').dialog.showErrorBox = (title, message) => fs.appendFileSync(${JSON.stringify(path.join(data, 'startup-error.log'))}, title + '\\n' + message + '\\n');\nrequire(${JSON.stringify(path.join(root, 'dist/user/main.cjs'))});\n`);
  app = await electron.launch({ args: [entry], cwd: root, env, timeout: 60000 });
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  const login = page.locator('.modal').filter({ hasText: '连接中央节点' });
  await login.waitFor({ timeout: 1500 }).catch(() => {});
  await call(page, 'remote.connect', { profile, password: 'sidebar-test-123', localPath: data });
  if (await login.isVisible()) await login.getByRole('button', { name: '取消', exact: true }).click();
  await page.locator(`[data-project-id="${project.id}"]`).click();
  await page.getByLabel('代码目录（选填）', { exact: true }).fill(data);
  await page.getByRole('button', { name: '保存并进入项目', exact: true }).click();
  await expect(page.locator('#sidebar-file-list')).toHaveCount(0);
  await expect(page.locator('.sidebar').getByRole('button', { name: '项目成果库', exact: true })).toHaveCount(0);
  await expect(page.locator('.session-row')).toHaveCount(16);
  await verifyBounds(page);
  await page.screenshot({ path: path.join(data, 'sidebar-default.png') });

  for (const pane of ['workgroup', 'session']) {
    const node = page.locator(`#sidebar-${pane}-list`);
    await node.hover(); await page.mouse.wheel(0, 600);
    await expect.poll(() => node.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const state = await verifyBounds(page);
    assert(state.panes.find(item => item.name === pane)!.scrollTop > 0);
  }
  const before = await layout(page);
  const sidebar = await page.locator('.sidebar-head').boundingBox();
  await page.mouse.move(sidebar!.x + sidebar!.width / 2, sidebar!.y + 10); await page.mouse.wheel(0, 1200);
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.scrollTop)).toBe(0);
  assert.deepEqual((await layout(page)).panes.map(pane => pane.scrollTop), before.panes.map(pane => pane.scrollTop));

  for (const [width, height] of [[1100, 720], [1280, 820], [1520, 980], [1600, 1200]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
    await verifyBounds(page);
    if (height === 720) await page.screenshot({ path: path.join(data, 'sidebar-minimum.png') });
  }
  await call(page, 'layout.sidebar', { workgroups: 2000, files: 2000, sessions: 2000 });
  await page.reload(); await expect(page.locator('.workgroup')).toHaveCount(4);
  await verifyBounds(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 720));
  await verifyBounds(page);
  await page.screenshot({ path: path.join(data, 'sidebar-large-saved-panes.png') });

  // The project region can still resize without losing the session controls.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1200));
  await call(page, 'layout.sidebar', { workgroups: 180, files: 220, sessions: 240 });
  await page.reload(); await expect(page.locator('.workgroup')).toHaveCount(4);
  const splitter = page.getByRole('separator', { name: '调整工作组高度', exact: true });
  const box = await splitter.boundingBox(), original = await layout(page);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 40); await page.mouse.up();
  await expect.poll(async () => (await layout(page)).panes[0].height).toBeGreaterThan(original.panes[0].height + 30);
  const resized = await verifyBounds(page);
  const projectGrowth = resized.panes[0].height - original.panes[0].height;
  const sessionShrink = original.panes[1].height - resized.panes[1].height;
  assert(Math.abs(projectGrowth - sessionShrink) < 1, 'Session list must fill the space remaining after the project region resizes');
  await page.locator(`[data-project-id="${project.id}"]`).locator('..').getByRole('button', { name: '项目设置：' + project.name, exact: true }).click();
  const settingsDialog = page.getByRole('dialog', { name: '项目设置 · ' + project.name, exact: true });
  await expect(settingsDialog.getByLabel('项目背景', { exact: true })).toHaveValue('侧栏布局验证');
  await settingsDialog.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await verifyBounds(page);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, cases: ['four groups and twelve projects', 'independent list scrolling', 'no outer or document scrolling', 'four window sizes', 'oversized saved pane heights', 'independent resizing', 'project brief remains accessible'], screenshots: ['sidebar-default.png', 'sidebar-minimum.png', 'sidebar-large-saved-panes.png'] }, null, 2));
  console.log(JSON.stringify({ passed: true, data }));
} catch (error) {
  const page = app && await app.firstWindow().catch(() => undefined);
  if (page) {
    await page.screenshot({ path: path.join(data, 'failure.png') }).catch(() => {});
    await page.content().then(html => fs.writeFile(path.join(data, 'failure.html'), html)).catch(() => {});
  }
  const startupError = await fs.readFile(path.join(data, 'startup-error.log'), 'utf8').catch(() => '');
  if (startupError) console.error(startupError);
  throw error;
} finally {
  await app?.close(); admin.disconnect(); await member.close();
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
