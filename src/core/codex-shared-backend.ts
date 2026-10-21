import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv, stopCLI } from './rpc';
import { WebSocketRpc } from './websocket-rpc';
import type { CodexDesktopBridge } from './codex-desktop-bridge';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexApprovalRouter } from './codex-approval-router';
import { processAlive, processIdentity, sameProcess, stopOwnedProcess, type ProcessIdentity } from './codex-process';
import { sameNativePath } from './native-transcript';
import { extractedCodexCli } from './codex-installation';

const run = promisify(execFile);
export async function installedCodexDesktopExecutable(fallback: string) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return fallback;
  return await extractedCodexCli() || fallback;
}
async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export async function privateBridgeDirectory(parent: string) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true, timeout: 10000 });
    const sid = stdout.trim(); if (!/^S-1-5-[0-9-]+$/.test(sid)) throw new Error('无法确认当前 Windows 账号');
    await run('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, timeout: 10000 });
  } else await fs.chmod(directory, 0o700);
  return directory;
}

export interface BackendRecord { version: 1; endpoint: string; sourceHome: string; executable: string; port: number; token: string; process: ProcessIdentity }
export async function readBackendRecord(directory: string, bridge: CodexDesktopBridge): Promise<BackendRecord> {
  const value: BackendRecord = JSON.parse(await fs.readFile(path.join(directory, 'backend.json'), 'utf8'));
  if (value.version !== 1 || value.endpoint !== bridge.endpoint || !sameNativePath(value.sourceHome, bridge.sourceHome) || !sameNativePath(value.executable, bridge.executable)
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)
    || !Number.isInteger(value.process?.pid) || value.process.pid < 1 || !value.process.startedAt || !value.process.executable) throw new Error('无法核对原后台，已保留会话与连接记录');
  return value;
}
async function savePrivate(file: string, value: unknown) {
  const pending = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(pending, JSON.stringify(value), { mode: 0o600 });
  try { await fs.rename(pending, file); } finally { await fs.rm(pending, { force: true }); }
}
export async function startCodexSharedBackend(options: { executable: string; sourceHome: string; cwd: string; stateDirectory: string; env?: NodeJS.ProcessEnv; configArgs?: string[]; recover?: boolean }) {
  let prior: CodexDesktopBridge | undefined, record: BackendRecord | undefined;
  if (options.recover) {
    prior = JSON.parse(await fs.readFile(path.join(options.stateDirectory, 'bridge.json'), 'utf8'));
    record = await readBackendRecord(options.stateDirectory, prior!);
    if (!sameNativePath(prior!.sourceHome, options.sourceHome) || prior!.process && await sameProcess(prior!.process) !== false) throw new Error('原后台管理进程尚未退出，未启动另一份后台');
  }
  const previousUrl = prior && new URL(prior.endpoint);
  if (previousUrl && (previousUrl.hostname !== '127.0.0.1' || previousUrl.protocol !== 'ws:' || !/^\/rpc\/[a-f0-9]{64}$/.test(previousUrl.pathname))) throw new Error('原联动地址无效');
  let backendPort = 0, backendToken = randomBytes(32).toString('hex');
  const route = previousUrl?.pathname || '/rpc/' + randomBytes(32).toString('hex');
  let child: ChildProcess | undefined, identity: ProcessIdentity | undefined, adopted = false;
  let failure: Error | undefined, ready = false, probed = false, published = false, closing: Promise<void> | undefined;
  let descriptor: CodexDesktopBridge;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const clients = new Set<WebSocket>(), router = new CodexApprovalRouter();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const match = (target: string | undefined) => {
    if (!target || target.length !== route.length) return false;
    const candidate = Buffer.from(target), expected = Buffer.from(route);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => {
    const authorized = !request.headers.origin && match(request.url?.replace(/\/(readyz|renew|stop)$/, ''));
    if (!authorized) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url === route + '/readyz') {
      response.writeHead(!probed || failure || closing ? 503 : 200); response.end();
    } else if (request.method === 'POST' && request.url === route + '/renew' && ready && !closing) {
      void renew().then(() => { response.writeHead(200); response.end(); }, () => { response.writeHead(503); response.end(); });
    } else if (request.method === 'POST' && request.url === route + '/stop') {
      response.writeHead(200); response.end(); setImmediate(() => void close());
    } else { response.writeHead(404); response.end(); }
  });
  server.on('upgrade', (request, client, head) => {
    if (request.headers.origin || !match(request.url) || request.headers.upgrade?.toLowerCase() !== 'websocket' || !request.headers['sec-websocket-key'] || !ready || failure || closing) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    websocket.handleUpgrade(request, client, head, downstream => {
      const id = randomUUID(), upstream = new WebSocket('ws://127.0.0.1:' + backendPort, { headers: { Authorization: 'Bearer ' + backendToken }, maxPayload: 8 * 1024 * 1024 });
      clients.add(downstream);
      const queued: string[] = []; let bytes = 0;
      const send = (socket: WebSocket, message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
      const release = () => { router.remove(id); clients.delete(downstream); downstream.terminate(); upstream.terminate(); };
      router.add({ id, send: message => send(downstream, message), upstream: message => send(upstream, message) });
      const upstreamClosed = () => {
        release();
        if (adopted && identity && !closing) void sameProcess(identity).then(alive => {
          if (alive === false) { failure = new Error('共享 Codex 后台已退出'); void close(false, true); }
        });
      };
      downstream.on('error', release); upstream.on('error', upstreamClosed); downstream.on('close', release); upstream.on('close', upstreamClosed);
      downstream.on('message', data => {
        try {
          const text = data.toString(), message = JSON.parse(text);
          if (router.client(id, message)) return;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
          else { bytes += Buffer.byteLength(text); if (queued.length >= 64 || bytes > 4 * 1024 * 1024) return release(); queued.push(text); }
        } catch { release(); }
      });
      upstream.on('open', () => { for (const text of queued) upstream.send(text); queued.length = 0; });
      upstream.on('message', data => { try { const message = JSON.parse(data.toString()); if (!router.server(id, message)) send(downstream, message); } catch { release(); } });
    });
  });
  let renewing: Promise<void> | undefined;
  function renew() {
    return renewing ||= (async () => { descriptor.expiresAt = new Date(Date.now() + 86400000).toISOString(); await savePrivate(path.join(options.stateDirectory, 'bridge.json'), descriptor); })().finally(() => { renewing = undefined; });
  }
  async function close(stop = true, preserveRecord = false) {
    if (closing) return closing;
    return closing = (async () => {
      ready = false;
      clearInterval(monitor);
      for (const socket of clients) socket.terminate(); clients.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      websocket.close();
      if (stop) { if (child) await stopCLI(child); else if (identity) await stopOwnedProcess(identity); }
      if (published && !preserveRecord) {
        const file = path.join(options.stateDirectory, 'bridge.json'), current = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => undefined);
        if (current?.pid === process.pid && current.endpoint === descriptor.endpoint) await fs.rm(file, { force: true });
      }
    })();
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(previousUrl ? Number(previousUrl.port) : 0, '127.0.0.1', resolve); });
    const port = (server.address() as net.AddressInfo).port;
    const alive = record && await sameProcess(record.process);
    if (record && alive === undefined) throw new Error('无法核对原后台，未启动另一份后台');
    if (record && alive) { backendPort = record.port; backendToken = record.token; identity = record.process; adopted = true; }
    else {
      backendPort = await availablePort();
      const args = [ ...(options.configArgs || ['-c', 'features.code_mode_host=true', '-c', 'features.prefer_mxc=true']),
        'app-server', '--listen', 'ws://127.0.0.1:' + backendPort, '--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(backendToken).digest('hex'),
        '-c', 'sqlite_home=' + JSON.stringify(options.sourceHome) ];
      const javascript = /\.[cm]?js$/i.test(options.executable);
      const env = childEnv({ ...options.env, CODEX_HOME: options.sourceHome, CODEX_SQLITE_HOME: options.sourceHome });
      if (javascript && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      // A WebSocket backend must survive the manager's exit; inherited pipes would close with that manager.
      child = spawn(javascript ? process.execPath : options.executable, javascript ? [options.executable, ...args] : args,
        { cwd: options.cwd, env, detached: true, windowsHide: true, stdio: 'ignore' });
      child.unref();
      child.on('error', error => { failure = error; });
      child.on('exit', () => { failure = new Error('共享 Codex 后台已退出'); void close(false, true); });
      if (!child.pid) throw new Error('共享 Codex 后台未启动');
      identity = await processIdentity(child.pid);
      if (!identity) throw new Error('共享 Codex 后台已退出');
    }
    const runtimeExecutable = adopted ? record!.executable : options.executable;
    descriptor = { version: 1, endpoint: 'ws://127.0.0.1:' + port + route, approvalRoutingVersion: 1,
      sourceHome: path.resolve(options.sourceHome), executable: runtimeExecutable, pid: process.pid, process: await processIdentity(process.pid), expiresAt: new Date(Date.now() + 86400000).toISOString() };
    // These are local transport capabilities, never model-account credentials. The enclosing directory is private.
    await savePrivate(path.join(options.stateDirectory, 'backend.json'), { version: 1, endpoint: descriptor.endpoint, sourceHome: descriptor.sourceHome, executable: runtimeExecutable, port: backendPort, token: backendToken, process: identity } satisfies BackendRecord);
    const deadline = Date.now() + 20000;
    ready = true;
    while (!probed && Date.now() < deadline) {
      if (failure) throw new Error('共享 Codex 后台未能启动');
      const rpc = new WebSocketRpc(descriptor.endpoint);
      try { await rpc.request('initialize', { clientInfo: { name: 'team_agent_desktop_beta_probe', version: '1' } }, 2500); rpc.notify('initialized'); probed = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 150)); }
      finally { await rpc.close(); }
    }
    if (!probed) throw new Error('共享 Codex 后台未就绪，未启动桌面版');
    await savePrivate(path.join(options.stateDirectory, 'bridge.json'), descriptor);
    published = true;
    if (adopted) {
      monitor = setInterval(() => {
        if (identity && processAlive(identity.pid) === false) {
          failure = new Error('共享 Codex 后台已退出'); void close(false, true);
        }
      }, 2000);
      monitor.unref();
    }
    return { descriptor, backendPort, close, renew, hasClients: () => clients.size > 0 };
  } catch (error) { await close(!adopted); throw error; }
}
