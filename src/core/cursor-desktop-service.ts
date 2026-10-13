import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AgentSession } from '../shared/types';
import { CursorDesktopCdp, type CursorDesktopClient, type CursorDesktopChat } from './cursor-desktop-client';
import { privateBridgeDirectory } from './codex-shared-backend';
import { userDesktopAppOpen } from './desktop-app-open';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface CursorDesktopIntegration {
  prepare(session: AgentSession, launch?: boolean, persist?: () => Promise<void>): Promise<void>;
  list(cwd: string, launch?: boolean): Promise<CursorDesktopChat[]>;
  open(session: AgentSession, persist?: () => Promise<void>): Promise<void>;
  release(sessionId: string): void;
  close(): Promise<void>;
}
interface Options {
  parent?: string;
  privateDirectory?: (parent: string) => Promise<string>;
  running?: () => Promise<boolean>;
  launch?: (cwd: string, port: number) => Promise<void>;
  connect?: (endpoint: string) => CursorDesktopClient;
  discover?: (port: number) => Promise<string>;
}
async function freePort() {
  const server = http.createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export function cursorAgentsLaunchArgs(cwd: string, port: number) {
  return ['--glass', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, cwd];
}
async function launchCursor(cwd: string, port: number) {
  if (process.platform !== 'win32') throw new Error('Cursor 桌面联动暂仅支持 Windows');
  const candidates = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe'), path.join(process.env.ProgramFiles || '', 'Cursor', 'Cursor.exe')];
  let executable: string | undefined;
  for (const file of candidates) if (await fs.stat(file).then(s => s.isFile()).catch(() => false)) { executable = file; break; }
  if (!executable) throw new Error('未找到 Cursor 桌面版，请先安装 Cursor');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable!, cursorAgentsLaunchArgs(cwd,port), { stdio: 'ignore', detached: true, windowsHide: true });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function discover(port: number) {
  const value: any = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500), redirect: 'error' })).json();
  const endpoint = new URL(value.webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== String(port) || !/^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Cursor 联动地址不匹配');
  return endpoint.href;
}

/** Managed by the ordinary Workbench process. No test account, database write or CLI fallback. */
export class CursorDesktopService implements CursorDesktopIntegration {
  private client?: CursorDesktopClient;
  private connecting?: Promise<CursorDesktopClient>;
  private directory?: string;
  private port?: number;
  private server?: http.Server;
  private entries = new Map<string, { id: string; cwd: string; owner: string; session: AgentSession }>();
  private persistence = new Map<string, () => Promise<void>>();
  private associations = new Map<string, Promise<void>>();
  private publication: Promise<unknown> = Promise.resolve();
  private closed = false;
  readonly parent: string;
  constructor(private options: Options = {}) { this.parent = options.parent || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TeamAgentWorkbench', 'cursor-desktop'); }
  private async ensure(launch: boolean, cwd: string) {
    if (this.closed) throw new Error('Cursor 联动已关闭');
    if (this.connecting) return this.connecting;
    const job = this.establish(launch, cwd); this.connecting = job;
    try { return await job; } finally { if (this.connecting === job) this.connecting = undefined; }
  }
  private async establish(launch: boolean, cwd: string): Promise<CursorDesktopClient> {
    if (this.client) {
      try { await this.client.list(); return this.client; }
      catch { this.client.close(); this.client = undefined; }
    }
    const activeFile = path.join(this.parent, 'active.json');
    let registry: { file: string } | undefined;
    try { registry = JSON.parse(await fs.readFile(activeFile, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Cursor 联动记录不可用，请保留记录后检查'); }
    if (registry) {
      const relative = typeof registry.file === 'string' ? path.relative(this.parent, registry.file) : '..';
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Cursor 联动记录不属于当前用户');
      let saved: { endpoint: string } | undefined;
      try { saved = JSON.parse(await fs.readFile(registry.file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Cursor 联动记录不可用'); }
      if (saved) {
        try { const client = (this.options.connect || (endpoint => new CursorDesktopCdp(endpoint)))(saved.endpoint); this.client = client; await client.list(); this.port = Number(new URL(saved.endpoint).port); return client; }
        catch { this.client?.close(); this.client = undefined; }
      }
    }
    if (!launch) throw new Error('Cursor 联动窗口尚未打开，点击“在 Cursor Agents 中打开”连接');
    if (await (this.options.running || (() => userDesktopAppOpen('cursor')))()) throw new Error('请先保存并退出已打开的 Cursor，再从工作台打开桌面联动；不会关闭或改写现有窗口');
    await fs.mkdir(this.parent, { recursive: true });
    // A failed/uncertain launch is not automatically repeated by another Workbench instance.
    let lock;
    try { lock = await fs.open(path.join(this.parent, 'launch.lock'), 'wx', 0o600); }
    catch {
      let reaper;
      try {
        reaper = await fs.open(path.join(this.parent, 'launch.reap'), 'wx', 0o600);
        const prior = JSON.parse(await fs.readFile(path.join(this.parent, 'launch.lock'), 'utf8'));
        if (!Number.isInteger(prior.pid) || prior.pid <= 0) throw new Error();
        try { process.kill(prior.pid, 0); } catch (error: any) {
          if (error.code === 'ESRCH') { await fs.unlink(path.join(this.parent, 'launch.lock')); return this.establish(launch, cwd); }
        }
      } catch { /* A live or unverifiable launcher must not be replaced. */ }
      finally { if (reaper) { await reaper.close(); await fs.unlink(path.join(this.parent, 'launch.reap')).catch(() => {}); } }
      throw new Error('Cursor 正在建立联动，请稍后从工作台重新打开');
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      this.directory ||= await (this.options.privateDirectory || privateBridgeDirectory)(this.parent);
      const port = await freePort();
      await (this.options.launch || launchCursor)(cwd, port);
      let endpoint: string | undefined;
      for (let i = 0; i < 50 && !this.closed; i++) { try { endpoint = await (this.options.discover || discover)(port); break; } catch { await pause(200); } }
      if (!endpoint) throw new Error('Cursor 已启动但联动尚未就绪，请保存并退出 Cursor 后重新连接');
      const record = path.join(this.directory, 'desktop.json');
      await fs.writeFile(record, JSON.stringify({ endpoint }), { mode: 0o600 });
      await fs.writeFile(activeFile, JSON.stringify({ file: record }), { mode: 0o600 });
      this.client = (this.options.connect || (value => new CursorDesktopCdp(value)))(endpoint);
      this.port = port;
      // Window initialization may lag behind the debug endpoint. Do not create a chat in another workspace.
      for (let i = 0; i < 50; i++) { if (await this.client.hasWorkspace(cwd)) return this.client; await pause(200); }
      throw new Error('Cursor 工作目录尚未就绪，请在原生窗口完成登录或信任工作区后重新打开联动');
    } finally { await lock.close(); await fs.unlink(path.join(this.parent, 'launch.lock')).catch(() => {}); }
  }
  private async workspace(client: CursorDesktopClient, cwd: string) {
    if (await client.hasWorkspace(cwd)) return;
    if (!this.port) throw new Error('Cursor 联动记录无效');
    await (this.options.launch || launchCursor)(cwd, this.port);
    for (let i = 0; i < 50; i++) { if (await client.hasWorkspace(cwd)) return; await pause(200); }
    throw new Error('Cursor Agents 项目尚未就绪，请在侧栏添加并展开对应本地目录');
  }
  async list(cwd: string, launch = false) { const client=await this.ensure(launch,cwd); if(launch)await this.workspace(client,cwd);return client.list(); }
  async prepare(session: AgentSession, launch = true, persist?: () => Promise<void>) {
    if (!session.cursorNative?.managed || !/^[0-9a-f-]{36}$/i.test(session.id) || session.provider !== 'cursor' || session.purpose !== 'work' || session.networkRoute === 'management' || session.closedAt) throw new Error('此会话不能使用 Cursor 桌面联动');
    if(persist)this.persistence.set(session.id,persist);
    const existing = this.associations.get(session.id); if (existing) return existing;
    const job = this.publication.then(() => this.associate(session, launch));
    this.publication = job.catch(() => {}); this.associations.set(session.id, job);
    try { await job; } finally { if (this.associations.get(session.id) === job) this.associations.delete(session.id); }
  }
  private async associate(session: AgentSession, launch: boolean) {
    const client = await this.ensure(launch, session.cwd);
    if (launch) await this.workspace(client, session.cwd);
    if (!session.nativeId) {
      if (!launch) return;
      if (session.cursorNative!.creationUnconfirmed) throw new Error('上次新建结果未确认，请在 Cursor Agents 中核对，再用“接入 Cursor 会话”关联已有会话');
      try { const chat = await client.create(session.cwd); session.nativeId = chat.nativeId; session.nativeLive = true; }
      catch (error: any) { if (error.code === 'CURSOR_CREATE_UNCONFIRMED') session.cursorNative!.creationUnconfirmed = true; throw error; }
    }
    if (!session.nativeId) return;
    if (session.closedAt || this.closed) throw new Error('会话或工作台已经关闭，未建立联动');
    this.directory ||= await (this.options.privateDirectory || privateBridgeDirectory)(this.parent);
    if (!this.server) {
      this.server = http.createServer((req, res) => void this.handle(req, res));
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
      this.server.unref();
    }
    const token = [...this.entries].find(([,entry])=>entry.owner===session.id && entry.id===session.nativeId && entry.cwd===session.cwd)?.[0] || randomBytes(32).toString('hex');
    this.entries.set(token, { id: session.nativeId, cwd: session.cwd, owner: session.id, session });
    await this.writeDescriptor(session,token);
  }
  private async writeDescriptor(session:AgentSession,token:string) {
    // This path is managed locally, not taken from a renderer or remote account record.
    const file = path.join(this.directory!, session.id + '.json');
    const pending = file + '.pending';
    await fs.writeFile(pending, JSON.stringify({ version: 1, endpoint: `http://127.0.0.1:${(this.server!.address() as { port: number }).port}/native/${token}`, sessionId: session.nativeId, workspace: session.cwd, expiresAt: new Date(Date.now() + 365 * 86400000).toISOString() }), { mode: 0o600 });
    await fs.rename(pending, file);
    session.cursorNative!.descriptorFile = file;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const respond = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const match = /^\/native\/([a-f0-9]{64})\/(snapshot|send|stop|focus)$/.exec(req.url || '');
    const entry = match && this.entries.get(match[1]);
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${(this.server?.address() as { port: number } | null)?.port}` || !entry || !match) { respond(403, {}); return; }
    const operation = match[2];
    if (req.method !== (operation === 'snapshot' ? 'GET' : 'POST')) { respond(405, {}); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 256 * 1024) throw new Error('消息过长'); }
      const client = await this.ensure(false, entry.cwd);
      if(this.entries.get(match[1])!==entry||entry.session.closedAt)throw new Error('此会话关联已关闭');
      if (operation === 'snapshot') { respond(200, await client.snapshot(entry.id, entry.cwd)); return; }
      if (operation === 'send') {
        const text = JSON.parse(body).text;
        if (typeof text !== 'string' || !text.trim()) throw new Error('请输入任务内容');
        const acknowledgement=await client.send(entry.id, entry.cwd, text);
        if(acknowledgement.sessionId && acknowledgement.sessionId!==entry.id) {
          if(!/^[0-9a-f-]{36}$/i.test(acknowledgement.sessionId))throw new Error('Cursor Agents 返回的正式会话 ID 无效，请核对已发送的消息');
          const prior=entry.id;entry.id=acknowledgement.sessionId;entry.session.nativeId=entry.id;
          for(const message of entry.session.messages)if(message.context?.nativeId===prior)message.context.nativeId=entry.id;
          await this.persistence.get(entry.owner)?.();
          await this.writeDescriptor(entry.session,match[1]);
        }
        respond(200,acknowledgement);return;
      }
      if (operation === 'focus') await client.focus(entry.id, entry.cwd); else await client.stop(entry.id, entry.cwd);
      respond(200, { ok: true });
    } catch (error: any) { respond(409, { message: error.message || 'Cursor 原生窗口暂时不可用' }); }
  }
  async open(session: AgentSession, persist?: () => Promise<void>) { await this.prepare(session,true,persist); await this.client!.focus(session.nativeId!, session.cwd); }
  release(sessionId: string) { for(const [token,entry] of this.entries)if(entry.owner===sessionId)this.entries.delete(token);this.persistence.delete(sessionId); }
  async close() {
    this.closed = true;
    await this.connecting?.catch(() => {});
    await Promise.allSettled(this.associations.values());
    this.client?.close(); this.client = undefined;
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.entries.clear(); this.persistence.clear();
  }
}
