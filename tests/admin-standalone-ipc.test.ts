import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { decodeEgressInvite } from '../src/core/egress-config';

test('administrator does not start or reconfigure a standalone-owned relay and still copies the original invitation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-standalone-ipc-'));
  const accessCode = 'existing-access-code-for-standalone';
  await fs.writeFile(path.join(root, 'standalone-egress.json'), '{}');
  await fs.writeFile(path.join(root, 'egress.json'), JSON.stringify({ enabled: true, publicHost: 'relay.internal' }));
  await fs.writeFile(path.join(root, 'egress-secrets.bin'), JSON.stringify({ accessCode }));
  const app = new EventEmitter() as any, ipc = new Map<string, Function>();
  let currentWindow: FakeWindow, starts = 0, logins = 0, copied = '', quit = false;
  const errors: string[] = [];
  Object.assign(app, { setName() {}, setPath() {}, getPath: () => root, requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() { quit = true; } });
  class FakeWindow {
    entry = '';
    webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } });
    constructor() { currentWindow = this; } isDestroyed() { return false; } setMenuBarVisibility() {}
    async loadFile(file: string) { this.entry = file; }
  }
  class Host extends EventEmitter { snapshot() { return { running: false }; } async start() { starts++; } async stop() {} }
  class Reverse { async init() {} select() {} disconnect() {} snapshot() { return {}; } async login() { logins++; } }
  class Connection { snapshot: any = { busy: false }; disconnect() {} async connect(profile: unknown) { this.snapshot = { ...this.snapshot, profile, role: 'administrator' }; return profile; } }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle(name: string, handler: Function) { ipc.set(name, handler); } }, dialog: { showErrorBox: (_title: string, text: string) => errors.push(text) }, clipboard: { writeText(text: string) { copied = text; } }, safeStorage: { isEncryptionAvailable: () => false } };
  const loader = (Module as any)._load, originalRoot = process.env.WORKBENCH_ADMIN_DATA_DIR;
  (Module as any)._load = function (name: string, ...args: any[]) {
    if (args[0]?.filename?.endsWith(path.join('admin', 'main.ts'))) {
      if (name === 'electron') return electron;
      if (name === './egress-host') return { EgressHost: Host };
      if (name === './reverse-egress-controller') return { ReverseEgressController: Reverse };
      if (name === './connection') return { AdminConnection: Connection };
      if (name === './egress-certificate') return { ensureEgressCertificate: async (_root: string, existingOnly: boolean) => { assert.equal(existingOnly, true); return { fingerprint: 'A'.repeat(64) }; } };
    }
    if (name === 'electron') return electron;
    return loader.call(this, name, ...args);
  };
  process.env.WORKBENCH_ADMIN_DATA_DIR = root;
  const until = async (check: () => boolean) => { for (let i = 0; !check(); i++) { if (i > 100) throw new Error('IPC not ready: ' + errors.join(';')); await new Promise(r => setTimeout(r, 10)); } };
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} }); await until(() => quit);
    (Module as any)._load = loader;
    if (originalRoot === undefined) delete process.env.WORKBENCH_ADMIN_DATA_DIR; else process.env.WORKBENCH_ADMIN_DATA_DIR = originalRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  await import('../src/admin/main'); await until(() => !!currentWindow?.entry);
  const call = async (action: string, payload?: unknown) => ipc.get('admin')!({ sender: currentWindow.webContents, senderFrame: { url: pathToFileURL(currentWindow.entry).href } }, action, payload);
  assert.equal(starts, 0); assert.equal((await call('snapshot')).value.egress.standalone, true);
  for (const action of ['egress.save', 'egress.rotate', 'egress.reverse.enable', 'egress.reverse.disable']) assert.match((await call(action)).error, /独立开机任务/);
  await call('egress.copy'); assert.equal(decodeEgressInvite(copied).accessCode, accessCode);
  const before = await fs.readFile(path.join(root, 'egress-secrets.bin'), 'utf8');
  await call('connect', { profile: { host: 'ssh.internal', port: 22, username: 'root', root: '/srv/teamspace', fingerprint: 'SHA256:' + 'a'.repeat(43) }, password: 'fixture-password' });
  assert.equal(logins, 0); assert.equal(await fs.readFile(path.join(root, 'egress-secrets.bin'), 'utf8'), before); assert.deepEqual(errors, []);
});
