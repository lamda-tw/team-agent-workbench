import { clientWindowTitle } from '../shared/client-version';
import { ownDataDirectory } from '../shared/single-instance';
import { runtimeAssets } from '../shared/runtime-assets';
import { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, utilityProcess } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { errorMessage } from '../shared/errors';
import { AdminConnection } from './connection';
import { LocalAdminConnection } from './local-connection';
import { adminProfileSchema, adminConnectSchema, adminOperationSchema } from './types';
import { adminEgressConfigSchema, encodeEgressInvite } from '../core/egress-config';
import { EgressHost } from './egress-host';
import { ReverseEgressController } from './reverse-egress-controller';
import { EgressClientProxy } from '../core/egress';
import { ensureEgressCertificate } from './egress-certificate';
import type { AdminEgressConfig } from '../shared/egress';
app.setName('Team Agent Admin');
app.setPath('userData', process.env.WORKBENCH_ADMIN_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentAdmin'));
let window: BrowserWindow; let remote: AdminConnection | LocalAdminConnection; let egress: EgressHost; let egressConfig: AdminEgressConfig; let egressSecret: { accessCode: string; upstreamPassword?: string };
let storageAbort: AbortController | undefined;
let reverse: ReverseEgressController;
const entry = path.join(__dirname, runtimeAssets, 'index.html');
if (ownDataDirectory(() => window)) app.whenReady().then(async () => {
  const config = path.join(app.getPath('userData'), 'connection.json');
  const egressConfigFile = path.join(app.getPath('userData'), 'egress.json'), egressSecretFile = path.join(app.getPath('userData'), 'egress-secrets.bin');
  const changed = () => { if (window && !window.isDestroyed()) window.webContents.send('admin:changed'); };
  reverse = new ReverseEgressController(path.join(app.getPath('userData'), 'reverse-egress.json'), changed); await reverse.init();
  const protect = (value: string) => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8');
  const unprotect = (value: Buffer) => safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(value) : value.toString('utf8');
  egressConfig = { enabled: false, listenHost: '0.0.0.0', listenPort: 18443, publicHost: os.hostname(), upstreamMode: 'direct', upstreamHost: '', upstreamPort: 0, upstreamUsername: '', codex: true, cursor: true, claude: false };
  try { egressConfig = adminEgressConfigSchema.parse(JSON.parse(await fs.readFile(egressConfigFile, 'utf8'))); } catch {}
  try { egressSecret = JSON.parse(unprotect(await fs.readFile(egressSecretFile))); } catch { egressSecret = { accessCode: randomBytes(24).toString('base64url') }; }
  const certificate = await ensureEgressCertificate(path.join(app.getPath('userData'), 'egress-tls'));
  egress = new EgressHost(path.join(__dirname, runtimeAssets, 'egress-worker.cjs'), egressConfig, egressSecret, certificate,
    entry => utilityProcess.fork(entry, [], { serviceName: 'Team Agent Network Relay', stdio: 'ignore' })); egress.on('changed', () => {
      changed(); void reverse.setGateway(egressConfig.enabled && egress.snapshot().running, egressConfig.listenHost, egressConfig.listenPort);
    });
  const saveEgress = async () => { await fs.mkdir(app.getPath('userData'), { recursive: true }); await fs.writeFile(egressConfigFile, JSON.stringify(egressConfig, null, 2)); await fs.writeFile(egressSecretFile, protect(JSON.stringify(egressSecret)), { mode: 0o600 }); };
  await saveEgress(); if (egressConfig.enabled) await egress.start().catch(() => {});
  remote = new AdminConnection(path.join(__dirname, 'admin.py'), changed);
  try {
    const profile = adminProfileSchema.parse(JSON.parse(await fs.readFile(config, 'utf8')));
    remote.snapshot.profile = profile;
    reverse.select(profile);
    if (profile.mode === 'local') {
      remote = new LocalAdminConnection(changed); remote.snapshot.profile = profile;
      try { await remote.connect(profile, '', '', async () => false); }
      catch (error) { remote.snapshot.connectionError = errorMessage(error); }
    }
  } catch {}
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 1040, minHeight: 720, show: process.env.WORKBENCH_TEST !== '1', title: clientWindowTitle('管理员版'), backgroundColor: '#f6f7f9', webPreferences: { preload: path.join(__dirname, runtimeAssets, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.setMenuBarVisibility(false); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault()); window.webContents.session.setPermissionRequestHandler((_c, _p, cb) => cb(false));
  ipcMain.handle('admin', async (event, action: string, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try {
      let value;
      if (action === 'snapshot') value = { ...remote.snapshot, busy: remote.snapshot.busy || reverse.busy, egress: { config: egressConfig, ...egress.snapshot(), inviteCode: encodeEgressInvite({ version: 1, host: egressConfig.publicHost, port: egressConfig.listenPort, fingerprint: certificate.fingerprint, accessCode: egressSecret.accessCode }), hasUpstreamPassword: !!egressSecret.upstreamPassword, reverse: reverse.snapshot(remote.snapshot.state ? remote.snapshot.state.egressJumpTargets || [] : undefined) } };
      else if (action === 'egress.save') {
        if (reverse.busy) throw new Error('请等待反向隧道设置完成');
        const input = payload as any; const next = adminEgressConfigSchema.parse(input?.config);
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
        await reverse.enable(port => remote.operation({ op: 'egress_jump', enabled: true, host: '127.0.0.1', port })); value = true;
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
      else if (action === 'group.control') { const result = await remote.operation({op:'group_control', command: payload as any}); value = remote instanceof AdminConnection ? result.value : result; }
      else if (action === 'connect') {
        if (remote.snapshot.busy || reverse.busy) throw new Error('请等待当前管理操作完成后更换连接');
        storageAbort?.abort(); storageAbort = undefined;
        const input = adminConnectSchema.parse(payload);
        reverse.select(input.profile);
        remote.disconnect();
        remote = input.profile.mode === 'local' ? new LocalAdminConnection(changed) : new AdminConnection(path.join(__dirname, 'admin.py'), changed);
        value = await remote.connect(input.profile, input.password, input.sudoPassword, async fingerprint => (await dialog.showMessageBox(window, {
          type: 'question', title: '首次连接团队服务器', message: input.profile.host,
          detail: `当前管理员电脑尚未连接过这台服务器。请确认地址无误；确认后，本机会记住服务器身份，后续连接将自动验证。\n\n技术信息：${fingerprint}`,
          buttons: ['取消', '确认并连接'], defaultId: 0, cancelId: 0,
        })).response === 1);
        await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, JSON.stringify(value, null, 2));
        if (remote.snapshot.role === 'administrator' && remote.snapshot.profile?.mode !== 'local') await reverse.login(remote.snapshot.profile!, input.password);
      } else if (action === 'choose.directory') value = (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] || '';
      else if (action === 'disconnect') { if (remote.snapshot.busy || reverse.busy) throw new Error('请等待操作完成'); storageAbort?.abort(); storageAbort = undefined; reverse.disconnect(); remote.disconnect(); value = true; }
      else if (action === 'operation') { if (reverse.busy) throw new Error('请等待反向隧道设置完成'); value = await remote.operation(adminOperationSchema.parse(payload)); }
      else if (action === 'storage.scan') {
        if (storageAbort) throw new Error('共享空间统计正在进行，请等待完成或取消');
        const controller = new AbortController(); storageAbort = controller;
        try { value = await remote.storageUsage(payload as any, controller.signal); }
        finally { if (storageAbort === controller) storageAbort = undefined; }
      } else if (action === 'storage.cancel') { storageAbort?.abort(); value = true; }
      else if (action === 'project.catalog') value = await remote.projectCatalog();
      else if (action === 'project.purge') { const request = z.object({ projectId: z.string().regex(/^project_[a-f0-9]{32}$/), mode: z.enum(['all', 'keep_trajectories']) }).parse(payload); value = await remote.projectPurge(request.projectId, request.mode); }
      else throw new Error('管理员版不支持此操作');
      return { ok: true, value };
    } catch (error: any) { return { ok: false, error: errorMessage(error) }; }
  });
  await window.loadFile(entry);
}).catch(e => { dialog.showErrorBox('管理员版启动失败', e.message); app.quit(); });
let stopping = false, stopped = false;
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault(); if (stopping) return; stopping = true;
  storageAbort?.abort(); reverse?.disconnect(); remote?.disconnect();
  void Promise.resolve(egress?.stop()).finally(() => { stopped = true; app.quit(); });
});
