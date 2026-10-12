import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { decodeEgressInvite } from '../src/core/egress-config';
import type { AdminProfile, AdminSnapshot } from '../src/admin/types';
import { testTlsIdentity } from './fixtures/tls-identity';
import { reverseSshFixture } from './fixtures/reverse-ssh';

// Production IPC with in-memory Electron objects; SSH, TCP and TLS use real
// loopback sockets. No application window or external model request is started.
test('admin IPC authorizes reverse access, tests TLS, copies the pinned route and cleans up on logout', { timeout: 20000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-admin-reverse-')));
  const shared = await reverseSshFixture(), identity = testTlsIdentity(), sockets = new Set<net.Socket>();
  let accessCode = '', pings = 0;
  const gateway = tls.createServer(identity, socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString(); if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]);
      if (request.kind === 'ping' && request.accessCode === accessCode) { pings++; socket.end('{"ok":true}\n'); }
      else socket.end('{"ok":false,"error":"invalid test access"}\n');
    });
  });
  gateway.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const base = path.join(root, 'data'); await fs.mkdir(base);
  await fs.writeFile(path.join(base, 'egress.json'), JSON.stringify({ enabled: true, listenHost: '0.0.0.0', listenPort: (gateway.address() as net.AddressInfo).port, publicHost: 'unreachable.invalid' }));
  const app = new EventEmitter() as any, paths: Record<string, string> = { appData: root }, ipc = new Map<string, Function>();
  const opened: FakeWindow[] = [], errors: string[] = [], operations: any[] = [];
  let didQuit = false, copied = '', current: FakeConnection;
  Object.assign(app, { setName() {}, setPath(name: string, value: string) { paths[name] = value; }, getPath(name: string) { return paths[name]; }, requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() { didQuit = true; } });
  class FakeWindow {
    entry = '';
    webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } });
    constructor() { opened.push(this); }
    isDestroyed() { return false; } setMenuBarVisibility() {}
    async loadFile(file: string) { this.entry = file; }
  }
  class FakeConnection {
    snapshot: AdminSnapshot = { connected: false, verified: false, busy: false };
    constructor() { current = this; }
    async connect(profile: AdminProfile) {
      this.snapshot = { profile, connected: true, verified: profile.username === 'root', busy: false, role: profile.username === 'root' ? 'administrator' : undefined, state: { initialized: true, users: {}, groups: {}, egressJumpTargets: [{ host: 'other-admin.internal', port: 18443 }] } };
      return profile;
    }
    disconnect() { this.snapshot.connected = false; }
    async operation(request: any) {
      operations.push(request);
      assert.equal(request.op, 'egress_jump'); assert.equal(this.snapshot.role, 'administrator');
      this.snapshot.state!.egressJumpTargets!.push({ host: request.host, port: request.port }); return this.snapshot.state;
    }
  }
  class FakeHost extends EventEmitter {
    running = false;
    constructor(_entry: string, _config: unknown, secret: { accessCode: string }) { super(); accessCode = secret.accessCode; }
    snapshot() { return { running: this.running }; }
    async start() { this.running = true; this.emit('changed'); }
    async stop() { this.running = false; this.emit('changed'); }
  }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle(name: string, handler: Function) { ipc.set(name, handler); } }, dialog: { showErrorBox: (_title: string, message: string) => errors.push(message) }, clipboard: { writeText(value: string) { copied = value; } }, safeStorage: { isEncryptionAvailable: () => false }, utilityProcess: { fork() { throw new Error('Unexpected process launch'); } } };
  const loader = (Module as any)._load, oldData = process.env.WORKBENCH_ADMIN_DATA_DIR;
  (Module as any)._load = function (name: string, ...args: any[]) {
    if (name === 'electron') return electron;
    if (name === './connection' && args[0]?.filename?.endsWith(path.join('admin', 'main.ts'))) return { AdminConnection: FakeConnection };
    if (name === './egress-host') return { EgressHost: FakeHost };
    if (name === './egress-certificate') return { ensureEgressCertificate: async () => ({ fingerprint: identity.fingerprint }) };
    return loader.call(this, name, ...args);
  };
  process.env.WORKBENCH_ADMIN_DATA_DIR = base;
  async function until(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!check()) { if (Date.now() > deadline) throw new Error('Admin IPC timed out: ' + errors.join('; ')); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  t.after(async () => {
    app.emit('before-quit', { preventDefault() {} }); await until(() => didQuit);
    (Module as any)._load = loader;
    if (oldData === undefined) delete process.env.WORKBENCH_ADMIN_DATA_DIR; else process.env.WORKBENCH_ADMIN_DATA_DIR = oldData;
    await shared.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => gateway.close(() => resolve()));
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('workbench-admin-reverse-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await import('../src/admin/main'); await until(() => !!opened[0]?.entry);
  const window = opened[0];
  async function call(action: string, payload?: unknown) {
    const response = await ipc.get('admin')!({ sender: window.webContents, senderFrame: { url: pathToFileURL(window.entry).href } }, action, payload);
    if (!response.ok) throw new Error(response.error); return response.value;
  }
  await assert.rejects(call('egress.reverse.enable'), /管理账号/);
  await call('connect', { profile: { ...shared.profile, username: 'alice' }, password: 'test-password' });
  await assert.rejects(call('egress.reverse.enable'), /管理账号/); assert.equal(operations.length, 0);
  await call('connect', { profile: shared.profile, password: 'test-password' });
  await call('egress.reverse.enable');
  const enabled = await call('snapshot'), port = enabled.egress.reverse.remotePort;
  assert.equal(enabled.egress.reverse.state, 'connected'); assert.equal(enabled.egress.reverse.memberAccessConfigured, true);
  assert.deepEqual(operations, [{ op: 'egress_jump', enabled: true, host: '127.0.0.1', port }]);
  await call('egress.reverse.copy'); const invite = decodeEgressInvite(copied);
  assert.equal(invite.version, 2); if (invite.version !== 2) throw new Error('Expected reverse invite');
  assert.deepEqual(invite.sharedServer, { host: shared.profile.host, port: shared.profile.port, fingerprint: shared.profile.fingerprint, relayPort: port });
  assert.equal(invite.fingerprint, identity.fingerprint.replace(/:/g, ''));
  assert.equal(await call('egress.reverse.test'), true); assert.equal(pings, 1);
  const targets = current!.snapshot.state!.egressJumpTargets!;
  delete current!.snapshot.state!.egressJumpTargets;
  await assert.rejects(call('egress.reverse.copy'), /成员接入授权/);
  current!.snapshot.state!.egressJumpTargets = targets;
  await call('egress.reverse.disable'); await until(() => shared.listeners.size === 0);
  assert.equal((await call('snapshot')).egress.reverse.state, 'disabled'); assert.equal(targets.length, 2);
  await call('egress.reverse.enable'); assert.equal((await call('snapshot')).egress.reverse.remotePort, port);
  await call('disconnect'); await until(() => shared.listeners.size === 0);
  assert.equal((await call('snapshot')).egress.reverse.state, 'waiting-login');
  for (const name of ['connection.json', 'reverse-egress.json', 'egress.json']) assert.doesNotMatch(await fs.readFile(path.join(base, name), 'utf8'), /test-password/);
  assert.doesNotMatch(JSON.stringify(await call('snapshot')), /test-password/); assert.deepEqual(errors, []);
});
