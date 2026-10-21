import { clientWindowTitle } from '../shared/client-version';
import { ownDataDirectory } from '../shared/single-instance';
import { runtimeAssets } from '../shared/runtime-assets';
import { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, utilityProcess, Tray, Menu, nativeImage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../shared/errors';
import { AdminConnection } from './connection';
import { LocalAdminConnection } from './local-connection';
import { adminConnectSchema, adminOperationSchema } from './types';
import { adminEgressConfigSchema, encodeEgressInvite } from '../core/egress-config';
import { EgressHost } from './egress-host';
import { ReverseEgressController } from './reverse-egress-controller';
import { EgressClientProxy } from '../core/egress';
import { ensureEgressCertificate } from './egress-certificate';
import { attachAdminBackground } from './background-mode';
import type { AdminEgressConfig } from '../shared/egress';
import type { AdminProfile } from './types';
import { AdminWindowStore, adminNodeKey, adminNodeLabel, isAdminWindowSource } from './window-store';
import { AdminMemberSync } from './member-sync';
import { memberCommandSchema, memberCreateSchema } from './member-protocol';
app.setName('Team Agent Admin');
app.setPath('userData', process.env.WORKBENCH_ADMIN_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentAdmin'));
const entry = path.join(__dirname, runtimeAssets, 'index.html');
const store = new AdminWindowStore(app.getPath('userData'));
type AdminContext = { slot: number; window: BrowserWindow; profile(): AdminProfile | undefined; connected(): boolean; dispatch(action: string, payload: unknown): Promise<any>; stop(): Promise<void>; closing?: Promise<void> };
const contexts = new Map<BrowserWindow, AdminContext>();
let quitting = false, stopped = false, ready = false, pendingLaunches = 0;
let windowOperations: Promise<unknown> = Promise.resolve();
function routeWindow<T>(fn: () => Promise<T>): Promise<T> {
  const task = windowOperations.catch(() => {}).then(() => { if (quitting) throw new Error('管理端正在退出'); return fn(); });
  windowOperations = task; return task;
}
function showWindow(window: BrowserWindow) { if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
async function closeWindow(context: AdminContext) {
  if (context.closing) return context.closing;
  context.closing = (async () => {
    try { await context.stop(); }
    catch (error) { console.error('中央节点关闭失败', errorMessage(error)); }
    finally { contexts.delete(context.window); if (!context.window.isDestroyed()) context.window.destroy(); store.release(context.slot); }
  })();
  return context.closing;
}
async function createWindow(preferred?: number, fresh = false) {
  const slot = await store.claim(preferred, fresh);
  try { return await initializeWindow(slot); }
  catch (error) { store.release(slot); throw error; }
}
async function initializeWindow(slot: number): Promise<AdminContext> {
  let window!: BrowserWindow; let remote!: AdminConnection | LocalAdminConnection; let egress!: EgressHost;
  let egressConfig: AdminEgressConfig; let egressSecret: { accessCode: string; upstreamPassword?: string };
  let storageAbort: AbortController | undefined;
  let members: AdminMemberSync | undefined;
  let background: ReturnType<typeof attachAdminBackground> | undefined, tray: Tray | undefined;
  let boundProfile = await store.profile(slot), changing = false, stopTask: Promise<void> | undefined;
  const directory = store.directory(slot);
  const egressConfigFile = path.join(directory, 'egress.json'), egressSecretFile = path.join(directory, 'egress-secrets.bin');
  const changed = () => {
    if (window && !window.isDestroyed()) {
      const label = adminNodeLabel(boundProfile);
      window.setTitle(clientWindowTitle('管理员版') + ' · ' + label);
      tray?.setToolTip(('团队工作台 · ' + label + ' · 转发端口 ' + egressConfig.listenPort).slice(0, 120));
      window.webContents.send('admin:changed');
    }
  };
  const reverse = new ReverseEgressController(path.join(directory, 'reverse-egress.json'), changed); await reverse.init();
  try {
  const protect = (value: string) => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  const unprotect = (value: Buffer) => safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8');
  egressConfig = { enabled: false, listenHost: '0.0.0.0', listenPort: await store.defaultPort(slot), publicHost: os.hostname(), upstreamMode: 'direct', upstreamHost: '', upstreamPort: 0, upstreamUsername: '', codex: true, cursor: true, claude: false };
  try { egressConfig = adminEgressConfigSchema.parse(JSON.parse(await fs.readFile(egressConfigFile, 'utf8'))); } catch {}
  try { egressSecret = JSON.parse(unprotect(await fs.readFile(egressSecretFile))); } catch { egressSecret = { accessCode: randomBytes(24).toString('base64url') }; }
  const certificate = await ensureEgressCertificate(path.join(directory, 'egress-tls'));
  egress = new EgressHost(path.join(__dirname, runtimeAssets, 'egress-worker.cjs'), egressConfig, egressSecret, certificate,
    entry => utilityProcess.fork(entry, [], { serviceName: 'Team Agent Network Relay', stdio: 'ignore' })); egress.on('changed', () => {
      changed(); void reverse.setGateway(egressConfig.enabled && egress.snapshot().running, egressConfig.listenHost, egressConfig.listenPort);
    });
  const saveEgress = async () => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(egressConfigFile, JSON.stringify(egressConfig, null, 2)); await fs.writeFile(egressSecretFile, protect(JSON.stringify(egressSecret)), { mode: 0o600 }); };
  await saveEgress(); if (egressConfig.enabled) await egress.start().catch(() => {});
  remote = new AdminConnection(path.join(__dirname, 'admin.py'), changed);
  try {
    const profile = boundProfile;
    if (!profile) throw new Error('尚未连接中央节点');
    remote.snapshot.profile = profile;
    reverse.select(profile);
    if (profile.mode === 'local') {
      remote = new LocalAdminConnection(changed); remote.snapshot.profile = profile;
      try { await remote.connect(profile, '', '', async () => false); }
      catch (error) { remote.snapshot.connectionError = errorMessage(error); }
    }
  } catch {}
  members = new AdminMemberSync(directory, () => remote, changed, () => !changing && !reverse.busy);
  await members.init();
  if (quitting) throw new Error('管理端正在退出');
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 1040, minHeight: 720, show: process.env.WORKBENCH_TEST !== '1', title: clientWindowTitle('管理员版'), backgroundColor: '#f6f7f9', webPreferences: { preload: path.join(__dirname, runtimeAssets, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  background = attachAdminBackground(window, {
    enabled: () => egressConfig.enabled,
    requestQuit: () => { void closeWindow(context); },
    createTray: controls => {
      // Small code-generated icon; no external image file is needed by the launcher.
      const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAK0lEQVR4nGNgGDJAozTkPyV4iBtILBhGBqJjXIaMGjhqID0NJAbT3sBBCwAp6V6natekBwAAAABJRU5ErkJggg==');
      tray = new Tray(icon);
      const nodeTray = tray;
      try {
        tray.setToolTip(('团队工作台 · ' + adminNodeLabel(boundProfile) + ' · 转发端口 ' + egressConfig.listenPort).slice(0, 120));
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '打开管理员端', click: controls.open },
          { type: 'separator' },
          { label: '关闭此节点并停止其转发', click: controls.quit },
        ]));
        tray.on('double-click', controls.open);
      } catch (error) { tray.destroy(); throw error; }
      return { destroy: () => nodeTray.destroy(), notify: () => nodeTray.displayBalloon({ title: '网络出口继续在后台运行', content: adminNodeLabel(boundProfile) + '；双击此托盘图标重新打开，托盘菜单可停止此节点的转发。', noSound: true }) };
    },
  });
  window.setMenuBarVisibility(false); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault()); window.webContents.session.setPermissionRequestHandler((_c, _p, cb) => cb(false));
  const dispatch = async (action: string, payload: unknown) => {
    if (changing && action !== 'snapshot') throw new Error('此节点正在更新连接或出口，请稍候');
    const exclusive = ['connect', 'disconnect', 'egress.save', 'egress.rotate'].includes(action);
    if (exclusive) changing = true;
    try {
      let value;
      if (action === 'snapshot') value = { ...members!.snapshot(), busy: changing || remote.snapshot.busy || reverse.busy, egress: { background: background?.available || false, config: egressConfig, ...egress.snapshot(), inviteCode: encodeEgressInvite({ version: 1, host: egressConfig.publicHost, port: egressConfig.listenPort, fingerprint: certificate.fingerprint, accessCode: egressSecret.accessCode }), hasUpstreamPassword: !!egressSecret.upstreamPassword, reverse: reverse.snapshot(remote.snapshot.state ? remote.snapshot.state.egressJumpTargets || [] : undefined) } };
      else if (action === 'egress.save') {
        if (reverse.busy) throw new Error('请等待反向隧道设置完成');
        const input = payload as any; const next = adminEgressConfigSchema.parse(input?.config);
        await store.reservePort(slot, next.listenPort);
        egressConfig = next;
        if (typeof input?.upstreamPassword === 'string' && input.upstreamPassword) egressSecret.upstreamPassword = input.upstreamPassword;
        if (input?.clearUpstreamPassword) delete egressSecret.upstreamPassword;
        await saveEgress(); await egress.restart(egressConfig, egressSecret); value = true;
      } else if (action === 'egress.rotate') {
        if (reverse.busy) throw new Error('请等待反向隧道设置完成');
        egressSecret.accessCode = randomBytes(24).toString('base64url'); await saveEgress(); await egress.restart(egressConfig, egressSecret); changed(); value = true;
      } else if (action === 'egress.copy') {
        const invite = encodeEgressInvite({ version: 1, host: egressConfig.publicHost, port: egressConfig.listenPort, fingerprint: certificate.fingerprint, accessCode: egressSecret.accessCode }); clipboard.writeText(invite); value = true;
      } else if (action === 'egress.test') { const input = z.object({ provider: z.enum(['codex', 'cursor', 'claude']) }).parse(payload); value = await egress.probe(input.provider); }
      else if (action === 'egress.reverse.enable') {
        if (!(remote instanceof AdminConnection) || !remote.snapshot.connected || !remote.snapshot.verified || remote.snapshot.role !== 'administrator' || !remote.snapshot.state?.initialized) throw new Error('请先以 root / sudo 管理账号连接并初始化共享服务器');
        if (remote.snapshot.busy) throw new Error('请等待当前管理操作完成');
        await reverse.enable(port => members!.operation({ op: 'egress_jump', enabled: true, host: '127.0.0.1', port })); value = true;
      } else if (action === 'egress.reverse.disable') { await reverse.disable(); value = true; }
      else if (action === 'egress.reverse.copy' || action === 'egress.reverse.test') {
        const sharedServer = reverse.route(remote.snapshot.state ? remote.snapshot.state.egressJumpTargets || [] : undefined);
        const invite = { version: 2 as const, host: egressConfig.publicHost, port: egressConfig.listenPort, fingerprint: certificate.fingerprint, accessCode: egressSecret.accessCode, sharedServer };
        if (action === 'egress.reverse.copy') { clipboard.writeText(encodeEgressInvite(invite)); value = true; }
        else {
          const probe = new EgressClientProxy({ enabled: true, viaSharedServer: true, sharedServer, host: invite.host, port: invite.port, certificateFingerprint: invite.fingerprint, accessCode: invite.accessCode, username: 'admin-test' }, (_host, _port, signal) => reverse.tunnel.openChannel(signal));
          try { value = await probe.probe(); } finally { await probe.stop(); }
        }
      }
      else if (action === 'members.sync') { await members!.sync(); value = true; }
      else if (action === 'members.create') { const input = z.object({ command: memberCreateSchema, requestId: z.string().uuid() }).parse(payload); value = await members!.create(input.command, input.requestId); }
      else if (action === 'members.apply') { const input = z.object({ command: memberCommandSchema, requestId: z.string().uuid() }).parse(payload); value = await members!.apply(input.command, input.requestId); }
      else if (action === 'members.removePending') { value = await members!.removePending(z.string().uuid().parse(payload)); }
      else if (action === 'group.control') { const result = await members!.operation({op:'group_control', command: payload as any}); value = remote instanceof AdminConnection ? result.value : result; }
      else if (action === 'connect') {
        if (remote.snapshot.busy || reverse.busy) throw new Error('请等待当前管理操作完成后更换连接');
        storageAbort?.abort(); storageAbort = undefined;
        const input = adminConnectSchema.parse(payload);
        if (boundProfile && adminNodeKey(boundProfile) !== adminNodeKey(input.profile)) throw new Error('不同中央节点必须使用独立窗口');
        await members!.settle();
        input.profile.teamId = members!.view().teamId || boundProfile?.teamId || input.profile.teamId;
        reverse.select(input.profile);
        remote.disconnect();
        remote = input.profile.mode === 'local' ? new LocalAdminConnection(changed) : new AdminConnection(path.join(__dirname, 'admin.py'), changed);
        value = await remote.connect(input.profile, input.password, input.sudoPassword, async fingerprint => (await dialog.showMessageBox(window, {
          type: 'question', title: '首次连接团队服务器', message: input.profile.host,
          detail: `当前管理员电脑尚未连接过这台服务器。请确认地址无误；确认后，本机会记住服务器身份，后续连接将自动验证。\n\n技术信息：${fingerprint}`,
          buttons: ['取消', '确认并连接'], defaultId: 0, cancelId: 0,
        })).response === 1);
        if (remote.snapshot.verified) { await store.saveProfile(slot, value); boundProfile = value; }
        if (remote.snapshot.role === 'administrator' && remote.snapshot.profile?.mode !== 'local') await reverse.login(remote.snapshot.profile!, input.password);
      } else if (action === 'choose.directory') value = (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || '';
      else if (action === 'disconnect') { if (remote.snapshot.busy || reverse.busy) throw new Error('请等待操作完成'); await members!.settle(); storageAbort?.abort(); storageAbort = undefined; reverse.disconnect(); remote.disconnect(); value = true; }
      else if (action === 'operation') { if (reverse.busy) throw new Error('请等待反向隧道设置完成'); value = await members!.operation(adminOperationSchema.parse(payload)); }
      else if (action === 'storage.scan') {
        if (storageAbort) throw new Error('共享空间统计正在进行，请等待完成或取消');
        const controller = new AbortController(); storageAbort = controller;
        try { value = await remote.storageUsage(payload as any, controller.signal); }
        finally { if (storageAbort === controller) storageAbort = undefined; }
      } else if (action === 'storage.cancel') { storageAbort?.abort(); value = true; }
      else if (action === 'project.catalog') value = await remote.projectCatalog();
      else if (action === 'project.purge') { const request = z.object({ projectId: z.string().regex(/^project_[a-f0-9]{32}$/), mode: z.enum(['all', 'keep_trajectories']) }).parse(payload); value = await remote.projectPurge(request.projectId, request.mode); }
      else throw new Error('管理员版不支持此操作');
      return value;
    } finally { if (exclusive) { changing = false; changed(); if (action === 'connect') void members!.sync(); } }
  };
  const context: AdminContext = {
    slot, window, profile: () => boundProfile, connected: () => remote.snapshot.connected, dispatch,
    stop() {
      if (!stopTask) {
        members?.stop(); background?.beginQuit(); storageAbort?.abort(); reverse.disconnect(); remote.disconnect();
        stopTask = Promise.resolve(egress.stop()).finally(() => background?.dispose());
      }
      return stopTask;
    },
  };
  contexts.set(window, context);
  // Background close handling is registered first; only a real close stops this node.
  window.on('close', event => {
    if (event.defaultPrevented || context.closing || quitting) return;
    event.preventDefault(); void closeWindow(context);
  });
  window.on('closed', () => { if (!context.closing && !quitting) void closeWindow(context); });
  window.on('focus', () => { void members?.sync(); });
  await window.loadFile(entry);
  if (quitting) throw new Error('管理端正在退出');
  members.start(); void members.sync(); changed(); return context;
  } catch (error) {
    const registered = window && contexts.get(window);
    if (registered) await closeWindow(registered);
    else {
      members?.stop(); reverse.disconnect(); remote?.disconnect(); await egress?.stop().catch(() => {}); background?.dispose();
      if (window && !window.isDestroyed()) window.destroy();
    }
    throw error;
  }
}
async function connectWindow(source: AdminContext, payload: unknown) {
  if (source.window.isDestroyed() || source.closing || quitting) throw new Error('原窗口已关闭，未继续连接');
  const input = adminConnectSchema.parse(payload), key = adminNodeKey(input.profile);
  const existingSlot = await store.find(input.profile);
  let target = existingSlot === undefined ? undefined : [...contexts.values()].find(item => item.slot === existingSlot);
  if (target?.closing) throw new Error('此中央节点窗口正在关闭，请稍后重试');
  if (!target) {
    if (existingSlot !== undefined) target = await createWindow(existingSlot);
    else if (!source.profile() || adminNodeKey(source.profile()!) === key) target = source;
    else target = await createWindow(undefined, true);
  }
  if (source.window.isDestroyed() || source.closing || quitting) throw new Error('原窗口已关闭，未继续连接');
  if (target !== source) {
    showWindow(target.window);
    if (target.connected()) return { openedElsewhere: true };
    // An existing node retains its previously verified identity when reopened.
    if (target.profile()?.fingerprint) input.profile.fingerprint = target.profile()!.fingerprint;
  }
  await target.dispatch('connect', input);
  return { openedElsewhere: target !== source };
}
function queueLauncherWindow() {
  if (quitting) return;
  pendingLaunches++;
  if (!ready) return;
  while (pendingLaunches > 0) {
    pendingLaunches--;
    void routeWindow(() => createWindow()).catch(error => { if (!quitting) dialog.showErrorBox('管理窗口启动失败', errorMessage(error)); });
  }
}
if (ownDataDirectory(() => [...contexts.keys()].at(-1), queueLauncherWindow)) app.whenReady().then(async () => {
  ipcMain.handle('admin', async (event, action: string, payload: unknown) => {
    const context = [...contexts.values()].find(item => item.window.webContents === event.sender);
    if (!context || !isAdminWindowSource(event.senderFrame?.url, entry)) return { ok: false, error: '不允许的调用来源' };
    try {
      if (quitting || context.closing) throw new Error('此管理窗口正在关闭');
      const value = action === 'connect' ? await routeWindow(() => connectWindow(context, payload))
        : action === 'window.new' ? await routeWindow(async () => { if (context.closing || context.window.isDestroyed()) throw new Error('原窗口已关闭'); await createWindow(undefined, true); return true; })
        : await context.dispatch(action, payload);
      if (context.closing) throw new Error('此管理窗口已关闭');
      return { ok: true, value };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  });
  await routeWindow(() => createWindow(1)); ready = true; const waiting = pendingLaunches; pendingLaunches = 0; for (let i = 0; i < waiting; i++) queueLauncherWindow();
}).catch(error => { dialog.showErrorBox('管理员版启动失败', errorMessage(error)); app.quit(); });
app.on('window-all-closed', () => { if (!contexts.size) app.quit(); });
app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault(); if (quitting) return; quitting = true;
  void Promise.allSettled([...contexts.values()].map(context => closeWindow(context))).finally(() => { stopped = true; app.quit(); });
});
