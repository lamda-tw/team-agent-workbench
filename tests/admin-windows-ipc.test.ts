import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { AdminProfile, AdminSnapshot } from '../src/admin/types';
import { decodeEgressInvite } from '../src/core/egress-config';

test('production admin IPC isolates nodes, ports, codes, operations and per-window shutdown', { timeout: 15000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'admin-multi-ipc-')));
  const app = new EventEmitter() as any, paths: Record<string, string> = { appData: root }, ipc = new Map<string, Function>();
  const windows: FakeWindow[] = [], hosts: FakeHost[] = [], trays: FakeTray[] = [], errors: string[] = [], operations: string[] = [];
  let didQuit = false;
  Object.assign(app, { setName() {}, setPath(name: string, value: string) { paths[name] = value; }, getPath: (name: string) => paths[name], requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() { didQuit = true; } });
  class FakeWindow extends EventEmitter {
    entry = ''; title = ''; destroyed = false; hidden = false; focused = false;
    webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } });
    constructor() { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; } setMenuBarVisibility() {} setTitle(value: string) { this.title = value; }
    isMinimized() { return false; } restore() {} show() { this.hidden = false; } hide() { this.hidden = true; } focus() { this.focused = true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    close() { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; this.emit('close', event); if (!event.defaultPrevented) this.destroy(); }
    async loadFile(file: string) { this.entry = file; }
  }
  class FakeTray extends EventEmitter {
    menu: any[] = []; destroyed = false; tooltip = '';
    constructor() { super(); trays.push(this); }
    setToolTip(value: string) { this.tooltip = value; } setContextMenu(value: any[]) { this.menu = value; }
    destroy() { this.destroyed = true; } displayBalloon() {}
  }
  class FakeConnection {
    snapshot: AdminSnapshot = { connected: false, verified: false, busy: false };
    constructor(_script: string, private changed: () => void) {}
    async connect(profile: AdminProfile) {
      if (profile.host === 'failed') throw new Error('连接测试失败');
      this.snapshot = { profile, connected: true, verified: true, busy: false, role: 'administrator', state: { initialized: true, users: {}, groups: {} } };
      this.changed(); return profile;
    }
    disconnect() { this.snapshot.connected = false; this.changed(); }
    async operation(input: any) { operations.push(this.snapshot.profile!.host + ':' + input.op); return this.snapshot.profile!.host; }
  }
  class FakeHost extends EventEmitter {
    running = false; stopped = 0;
    constructor(_entry: string, private config: any, public secret: any) { super(); hosts.push(this); }
    snapshot() { return { running: this.running, activeConnections: 0, events: [], fingerprint: 'A'.repeat(64) }; }
    async start() { this.running = this.config.enabled; this.emit('changed'); }
    async stop() { this.running = false; this.stopped++; }
    async restart(config: any, secret: any) { this.config = config; this.secret = secret; await this.start(); }
  }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle(name: string, fn: Function) { ipc.set(name, fn); } }, dialog: { showErrorBox: (_title: string, message: string) => errors.push(message) }, safeStorage: { isEncryptionAvailable: () => false }, utilityProcess: {}, Tray: FakeTray, Menu: { buildFromTemplate: (items: any[]) => items }, nativeImage: { createFromDataURL() {} } };
  const loader = (Module as any)._load, previousData = process.env.WORKBENCH_ADMIN_DATA_DIR;
  (Module as any)._load = function(name: string, ...args: any[]) {
    if (name === 'electron') return electron;
    if (name === './connection' && args[0]?.filename?.endsWith(path.join('admin', 'main.ts'))) return { AdminConnection: FakeConnection };
    if (name === './egress-host') return { EgressHost: FakeHost };
    if (name === './egress-certificate') return { ensureEgressCertificate: async () => ({ fingerprint: 'A'.repeat(64) }) };
    return loader.call(this, name, ...args);
  };
  process.env.WORKBENCH_ADMIN_DATA_DIR = root;
  async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Timeout: ' + errors.join(';')); await new Promise(resolve => setTimeout(resolve, 10)); } }
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} }); await until(() => didQuit);
    (Module as any)._load = loader;
    if (previousData === undefined) delete process.env.WORKBENCH_ADMIN_DATA_DIR; else process.env.WORKBENCH_ADMIN_DATA_DIR = previousData;
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('admin-multi-ipc-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await import('../src/admin/main'); await until(() => !!windows[0]?.entry);
  const call = async (window: FakeWindow, action: string, payload?: unknown) => {
    const reply = await ipc.get('admin')!({ sender: window.webContents, senderFrame: { url: pathToFileURL(window.entry).href } }, action, payload);
    if (!reply.ok) throw new Error(reply.error); return reply.value;
  };
  const connection = (host: string) => ({ profile: { host, port: 22, username: 'root', fingerprint: '', root: '/srv/teamspace' }, password: 'DO_NOT_PERSIST' });
  const a = windows[0]; await call(a, 'connect', connection('node-a'));
  await call(a, 'egress.save', { config: { ...(await call(a, 'snapshot')).egress.config, enabled: true } });
  const first = await call(a, 'snapshot');
  assert.deepEqual(await call(a, 'connect', connection('node-b')), { openedElsewhere: true });
  const b = windows[1]; const second = await call(b, 'snapshot');
  assert.equal((await call(a, 'snapshot')).profile.host, 'node-a'); assert.equal(second.profile.host, 'node-b');
  assert.notEqual(first.egress.config.listenPort, second.egress.config.listenPort);
  const inviteA = decodeEgressInvite(first.egress.inviteCode), inviteB = decodeEgressInvite(second.egress.inviteCode);
  assert.notEqual(inviteA.accessCode, inviteB.accessCode); assert.notEqual(inviteA.port, inviteB.port);
  assert.equal(await call(a, 'operation', { op: 'status' }), 'node-a'); assert.equal(await call(b, 'operation', { op: 'status' }), 'node-b');
  assert.deepEqual(operations, ['node-a:status', 'node-b:status']);
  await call(a, 'connect', connection('node-b')); assert.equal(windows.length, 2, 'same node reuses its existing window'); assert(b.focused);
  await assert.rejects(call(b, 'egress.save', { config: { ...second.egress.config, listenPort: first.egress.config.listenPort, enabled: true } }), /另一中央节点/);
  assert.equal((await call(a, 'snapshot')).egress.inviteCode, first.egress.inviteCode);
  await assert.rejects(call(a, 'connect', connection('failed')), /连接测试失败/);
  assert((await call(a, 'snapshot')).connected); assert((await call(b, 'snapshot')).connected);
  const failed = windows[2]; failed.close(); await until(() => failed.destroyed);
  a.close(); assert(a.hidden); assert(!a.destroyed); assert(hosts[0].running, 'closing a relay window retains its own tray backend');
  const stopA = trays[0].menu.find(item => item.label === '关闭此节点并停止其转发'); stopA.click(); await until(() => a.destroyed);
  assert(!hosts[0].running); assert((await call(b, 'snapshot')).connected); assert(!b.destroyed);
  const bSecret = (await call(b, 'snapshot')).egress.inviteCode;
  await call(b, 'disconnect'); assert.equal((await call(b, 'snapshot')).connected, false);
  await call(b, 'connect', connection('node-b')); assert.equal((await call(b, 'snapshot')).egress.inviteCode, bSecret);
  const alien = await ipc.get('admin')!({ sender: b.webContents, senderFrame: { url: 'https://untrusted.invalid' } }, 'operation', { op: 'status' }); assert.equal(alien.ok, false);
  app.emit('second-instance'); await until(() => !!windows[3]?.entry);
  const reopened = await call(windows[3], 'snapshot');
  assert.equal(reopened.profile.host, 'node-a'); assert.equal(reopened.egress.inviteCode, first.egress.inviteCode);
  app.emit('second-instance'); app.emit('second-instance'); await until(() => !!windows[5]?.entry);
  assert.equal(new Set(windows.filter(w => !w.destroyed)).size, 4, 'more than two windows are supported');
  for (const dir of [root, path.join(root, 'nodes/2')]) assert.doesNotMatch(await fs.readFile(path.join(dir, 'connection.json'), 'utf8'), /DO_NOT_PERSIST/);
  assert.deepEqual(errors, []);
});
