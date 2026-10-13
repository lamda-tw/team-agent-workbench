import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnCLI, stopCLI } from './rpc';
import { WebSocketRpc } from './websocket-rpc';
import type { CodexDesktopBridge } from './codex-desktop-bridge';

const run = promisify(execFile);
export async function installedCodexDesktopExecutable(fallback: string) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return fallback;
  const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  const candidates: { file: string; time: number }[] = [];
  for (const name of await fs.readdir(bin).catch(() => [] as string[])) {
    const file = path.join(bin, name, 'codex.exe'), stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isFile()) candidates.push({ file, time: stat.mtimeMs });
  }
  return candidates.sort((a, b) => b.time - a.time)[0]?.file || fallback;
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

export async function startCodexSharedBackend(options: { executable: string; sourceHome: string; cwd: string; stateDirectory: string; env?: NodeJS.ProcessEnv; configArgs?: string[] }) {
  const backendPort = await availablePort();
  const backendToken = randomBytes(32).toString('hex'), route = '/rpc/' + randomBytes(32).toString('hex');
  const child = spawnCLI(options.executable, [
    ...(options.configArgs || ['-c', 'features.code_mode_host=true', '-c', 'features.prefer_mxc=true']),
    'app-server', '--listen', 'ws://127.0.0.1:' + backendPort, '--ws-auth', 'capability-token',
    '--ws-token-sha256', createHash('sha256').update(backendToken).digest('hex'),
    '-c', 'sqlite_home=' + JSON.stringify(options.sourceHome),
  ], options.cwd, { ...options.env, CODEX_HOME: options.sourceHome, CODEX_SQLITE_HOME: options.sourceHome });
  // Never persist raw diagnostics, messages, endpoint capabilities or credentials.
  child.stdout.resume(); child.stderr.resume();
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  child.on('exit', () => { failure = new Error('共享 Codex 后台已退出'); void close(); });
  const sockets = new Set<Duplex>();
  let closing: Promise<void> | undefined;
  const match = (target: string | undefined) => {
    if (!target || target.length !== route.length) return false;
    const candidate = Buffer.from(target), expected = Buffer.from(route);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, (request, response) => {
    const authorized = !request.headers.origin && match(request.url?.replace(/\/(readyz|stop)$/, ''));
    if (!authorized) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url === route + '/readyz') {
      response.writeHead(failure || closing ? 503 : 200); response.end();
    } else if (request.method === 'POST' && request.url === route + '/stop') {
      response.writeHead(200); response.end(); setImmediate(() => void close());
    } else { response.writeHead(404); response.end(); }
  });
  server.on('upgrade', (request, client, head) => {
    if (request.headers.origin || !match(request.url) || request.headers.upgrade?.toLowerCase() !== 'websocket' || !request.headers['sec-websocket-key'] || failure || closing) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const upstream = net.connect(backendPort, '127.0.0.1');
    sockets.add(client); sockets.add(upstream);
    const release = () => { sockets.delete(client); sockets.delete(upstream); client.destroy(); upstream.destroy(); };
    client.once('error', release); upstream.once('error', release); client.once('close', release); upstream.once('close', release);
    upstream.once('connect', () => {
      const headers = ['GET / HTTP/1.1', 'Host: 127.0.0.1:' + backendPort, 'Authorization: Bearer ' + backendToken];
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined || ['host', 'authorization', 'cookie', 'origin', 'proxy-authorization'].includes(key)) continue;
        headers.push(key + ': ' + (Array.isArray(value) ? value.join(', ') : value));
      }
      upstream.write(headers.join('\r\n') + '\r\n\r\n'); if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  async function close() {
    if (closing) return closing;
    return closing = (async () => {
      for (const socket of sockets) socket.destroy(); sockets.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await stopCLI(child);
      await fs.rm(path.join(options.stateDirectory, 'bridge.json'), { force: true });
    })();
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as net.AddressInfo).port;
    const descriptor: CodexDesktopBridge = { version: 1, endpoint: 'ws://127.0.0.1:' + port + route,
      sourceHome: path.resolve(options.sourceHome), executable: options.executable, pid: process.pid, expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const deadline = Date.now() + 20000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (failure) throw new Error('共享 Codex 后台未能启动');
      const rpc = new WebSocketRpc(descriptor.endpoint);
      try { await rpc.request('initialize', { clientInfo: { name: 'team_agent_desktop_beta_probe', version: '1' } }, 2500); rpc.notify('initialized'); ready = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 150)); }
      finally { await rpc.close(); }
    }
    if (!ready) throw new Error('共享 Codex 后台未就绪，未启动桌面版');
    await fs.writeFile(path.join(options.stateDirectory, 'bridge.json'), JSON.stringify(descriptor), { mode: 0o600 });
    return { descriptor, backendPort, close, hasClients: () => sockets.size > 0 };
  } catch (error) { await close(); throw error; }
}
