import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Workbench } from '../src/core/workbench';
import { SharedFiles } from '../src/core/shared-files';
import { accountDirectory } from '../src/core/account-workspaces';
import type { Snapshot } from '../src/shared/types';
import { encodeEgressInvite } from '../src/core/egress-config';
// @ts-expect-error Background-only SSH protocol fixture.
import { teamServer } from './fixtures/team-server.mjs';

// Exercise the production IPC/window lifecycle with in-memory Electron objects.
// No browser, desktop process, input simulation or real model is started.
test('production window routing restores the account in any window, isolates failed logins and survives switching/closing shared views', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-window-routing-'))), base = path.join(root, 'data'), server = await teamServer();
  const seed = new Workbench(base, () => {}, () => {}); await seed.store.init();
  await seed.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true);
  const project = await seed.createProject('算法大赛'), session = await seed.createSession('codex', root, project.id);
  const profile = structuredClone(seed.remote.profile!); await seed.close();
  // Reproduce the report: Alice's sessions live in slot 2, now last used by Bob.
  const slot2 = path.join(base, 'instances', '2'); await fs.mkdir(path.dirname(slot2), { recursive: true });
  for (const name of ['settings', 'sessions', 'inputs', 'drafts', 'transfers', 'conclusions']) {
    await fs.mkdir(slot2, { recursive: true }); await fs.copyFile(path.join(base, name + '.json'), path.join(slot2, name + '.json'));
  }
  const oldSettings = JSON.parse(await fs.readFile(path.join(slot2, 'settings.json'), 'utf8')); oldSettings.workspaceSnapshot.profile.username = 'bob';
  await fs.writeFile(path.join(slot2, 'settings.json'), JSON.stringify(oldSettings)); await fs.writeFile(path.join(base, 'sessions.json'), '[]');
  const opened: FakeWindow[] = [], dialogs: string[] = [], app = new EventEmitter() as any, ipc = new Map<string, Function>(), appPaths: Record<string, string> = { appData: root, home: root };
  let didQuit = false;
  Object.assign(app, { setName() {}, setAppUserModelId() {}, setPath(name: string, value: string) { appPaths[name] = value; }, getPath(name: string) { return appPaths[name]; }, requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() { didQuit = true; } });
  class FakeWindow extends EventEmitter {
    destroyed = false; entry = ''; notices: unknown[] = [];
    webContents = Object.assign(new EventEmitter(), { send: (_name: string, value: unknown) => this.notices.push(value), setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } });
    constructor(_options: unknown) { super(); opened.push(this); }
    static fromWebContents(contents: unknown) { return opened.find(window => window.webContents === contents); }
    static getFocusedWindow() { return opened.find(window => !window.destroyed); }
    isDestroyed() { return this.destroyed; } isFocused() { return false; } isMinimized() { return false; }
    flashFrame() {} setMenuBarVisibility() {} focus() {} show() {} restore() {}
    async loadFile(file: string) { this.entry = file; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() { this.emit('close', { preventDefault() {} }); }
  }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle(name: string, handler: Function) { ipc.set(name, handler); } }, dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: (_title: string, message: string) => dialogs.push(message) }, safeStorage: { isEncryptionAvailable: () => false }, shell: {}, clipboard: {} };
  const loader = (Module as any)._load, detect = Workbench.prototype.detect, oldData = process.env.WORKBENCH_DATA_DIR, oldTest = process.env.WORKBENCH_TEST;
  (Module as any)._load = function (name: string, ...args: any[]) { return name === 'electron' ? electron : loader.call(this, name, ...args); };
  Workbench.prototype.detect = async function () { return []; };
  process.env.WORKBENCH_DATA_DIR = base; process.env.WORKBENCH_TEST = '1';
  async function until(check: () => boolean | Promise<boolean>) {
    const end = Date.now() + 10000;
    while (!(await check())) { if (Date.now() > end) throw new Error('window lifecycle timed out: ' + dialogs.join('; ')); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} }); await until(() => didQuit);
    (Module as any)._load = loader; Workbench.prototype.detect = detect;
    if (oldData === undefined) delete process.env.WORKBENCH_DATA_DIR; else process.env.WORKBENCH_DATA_DIR = oldData;
    if (oldTest === undefined) delete process.env.WORKBENCH_TEST; else process.env.WORKBENCH_TEST = oldTest;
    await server.close(); assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('workbench-window-routing-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await import('../src/main/index');
  await until(() => !!opened[0]?.entry);
  async function call(window: FakeWindow, action: string, payload?: unknown) {
    const response = await ipc.get('workbench')!({ sender: window.webContents, senderFrame: { url: pathToFileURL(window.entry).href } }, action, payload);
    if (!response.ok) throw new Error(response.error); return response.value;
  }
  const snapshot = (window: FakeWindow): Promise<Snapshot> => call(window, 'snapshot');
  const login = (window: FakeWindow, username: string, password = 'test-password') => call(window, 'remote.connect', { profile: server.profile(username), password, localPath: '' });
  const first = opened[0]; assert.deepEqual((await snapshot(first)).sessions.map(s => s.id), [session.id]);
  await login(first, 'alice');
  app.emit('second-instance'); await until(() => !!opened[1]?.entry); const second = opened[1];
  assert.equal((await snapshot(second)).settings.workspaceSnapshot?.profile.username, 'bob', 'relaunch restores an unopened account first');
  assert.equal((await snapshot(second)).sessions.length, 0);
  await login(second, 'alice'); assert.deepEqual((await snapshot(second)).sessions.map(s => s.id), [session.id]);
  await call(first, 'layout.sidebar', { height: 320 }); await call(second, 'layout.sidebar', { height: 640 });
  assert.equal((await snapshot(first)).settings.sidebarProjectHeight, 320); assert.equal((await snapshot(second)).settings.sidebarProjectHeight, 640);
  await call(second, 'session.rename', { id: session.id, title: '任意窗口都能看到' });
  assert.equal((await snapshot(first)).sessions[0].title, '任意窗口都能看到');
  await assert.rejects(login(second, 'bob', 'wrong-password'));
  const selectedServer = { host: profile.host, port: profile.port, fingerprint: profile.fingerprint, relayPort: 30123 };
  const selectedEgress = { enabled: true, viaSharedServer: false, inviteCode: encodeEgressInvite({ version: 2, host: 'admin.invalid', port: 443, fingerprint: 'AA'.repeat(32), accessCode: 'fixture-access-code-for-jump-test', sharedServer: selectedServer }) };
  await assert.rejects(call(second, 'remote.connect', { profile: server.profile('bob'), password: 'wrong-password', egress: selectedEgress }));
  assert.equal((await snapshot(first)).settings.egress, undefined, 'failed login must not change the old account route');
  assert.equal((await snapshot(second)).connection?.profile.username, 'alice');
  assert.equal((await snapshot(first)).connection?.connected, true);
  const readHandoff = Workbench.prototype.readHandoff;
  let finishRead!: (value: string) => void;
  Workbench.prototype.readHandoff = async () => new Promise<string>(resolve => { finishRead = resolve; });
  const oldRead = assert.rejects(call(second, 'handoff.read', { id: session.id }), /账号已改变/);
  await until(() => !!finishRead);
  await call(second, 'remote.connect', { profile: server.profile('bob'), password: 'test-password', egress: selectedEgress }); finishRead('private prior account text'); await oldRead; Workbench.prototype.readHandoff = readHandoff;
  assert.equal((await snapshot(second)).settings.egress?.viaSharedServer, true);
  assert.deepEqual((await snapshot(second)).settings.egress?.sharedServer, selectedServer);
  assert.equal((await snapshot(second)).egress?.viaSharedServer, true);
  assert.equal((await snapshot(first)).settings.egress, undefined, 'new login choices belong only to the authenticated account');
  assert.equal((await snapshot(second)).sessions.length, 0);
  assert.equal((await snapshot(first)).sessions[0].id, session.id); assert.equal((await snapshot(first)).connection?.connected, true);
  await assert.rejects(call(second, 'session.rename', { id: session.id, title: '不能修改' }), /不属于当前账号/);
  await login(second, 'alice');
  // A duplicate stored slot is not another dormant account. Once the two
  // existing windows are open, relaunching must still create a login window.
  await fs.writeFile(path.join(base, 'window-state', '3.json'), JSON.stringify({ profile }));
  const extraStart = opened.length;
  app.emit('second-instance');
  await until(() => !!opened[extraStart]?.entry);
  assert.equal(opened.filter(window => !window.destroyed).length, 3);
  // Requests made while the previous window is opening must not be discarded.
  app.emit('second-instance'); app.emit('second-instance');
  await until(() => !!opened[extraStart + 2]?.entry);
  const additional = opened.slice(extraStart);
  for (const window of additional) {
    const state = await snapshot(window);
    assert.equal(state.settings.workspaceSnapshot, undefined);
    assert.equal(state.settings.defaultServer?.host, profile.host);
    assert.equal(state.settings.defaultServer?.port, profile.port);
    assert.deepEqual(state.sessions, []);
  }
  assert.equal((await snapshot(first)).connection?.profile.username, 'alice');
  assert.equal((await snapshot(second)).connection?.profile.username, 'alice');
  for (const window of additional) window.close();
  await until(() => additional.every(window => window.destroyed));
  first.close(); await until(() => first.destroyed);
  assert.equal((await snapshot(second)).connection?.connected, true);
  await call(second, 'session.rename', { id: session.id, title: '原窗口关闭后继续' });
  // Closing during password verification must not attach a context to a dead window.
  const nextIndex = opened.length;
  await call(second, 'window.new'); await until(() => !!opened[nextIndex]?.entry); const third = opened[nextIndex];
  const connect = SharedFiles.prototype.connect;
  let resumeLogin!: () => void, entered = false;
  SharedFiles.prototype.connect = async function (...args) { entered = true; await new Promise<void>(resolve => { resumeLogin = resolve; }); return connect.apply(this, args); };
  const abandoned = assert.rejects(login(third, 'bob'), /窗口正在关闭/);
  await until(() => entered); third.close(); await until(() => third.destroyed); resumeLogin(); await abandoned; SharedFiles.prototype.connect = connect;
  assert.equal((await snapshot(second)).connection?.connected, true);
  const requireAuth = Workbench.prototype.requireAuth;
  try {
    const checkedRoutes: (string | undefined)[] = [];
    Workbench.prototype.requireAuth = async (_provider, _cwd, route) => { checkedRoutes.push(route); throw new Error('CLI 尚未登录'); };
    const offlineSession = await call(second, 'session.create', { provider: 'codex', cwd: root, projectId: project.id });
    assert.equal(offlineSession.binding.project.id, project.id, 'creating a local session must not require a model login');
    await assert.rejects(call(second, 'session.create', { provider: 'codex', cwd: root, projectId: project.id, networkRoute: 'management' }), /CLI 尚未登录/, 'a management-route session requires a verified model account');
    await assert.rejects(call(second, 'session.send', { id: offlineSession.id, text: '开始任务' }), /CLI 尚未登录/);
    assert.deepEqual(checkedRoutes, ['management', 'direct'], 'creation and sending check the actual route of each session');
  } finally { Workbench.prototype.requireAuth = requireAuth; }
  // Repeated launcher invocations must create a window for every request,
  // including bursts after all stored account slots are already in use.
  const burstStart = opened.length;
  app.emit('second-instance'); app.emit('second-instance'); app.emit('second-instance');
  await until(() => !!opened[burstStart + 2]?.entry);
  for (const window of opened.slice(burstStart, burstStart + 3)) {
    assert.equal(window.destroyed, false);
    assert(Array.isArray((await snapshot(window)).sessions));
  }
  assert.equal((await snapshot(second)).connection?.connected, true);
  app.emit('before-quit', { preventDefault() {} }); await until(() => didQuit);
  const stored = JSON.parse(await fs.readFile(path.join(accountDirectory(base, profile), 'sessions.json'), 'utf8'));
  assert.equal(stored.find((item: { id: string }) => item.id === session.id)?.title, '原窗口关闭后继续'); assert.deepEqual(dialogs, []);
});
