import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };
export interface AgentRpc extends EventEmitter {
  request(method: string, params?: unknown, timeout?: number, onWritten?: () => void): Promise<any>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  reject(id: number | string, message?: string): void;
  close(): Promise<void>;
}
const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function stopCLI(child: ChildProcess): Promise<void> {
  const pending = stopping.get(child); if (pending) return pending;
  const operation = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); resolve(); }); killer.on('close', () => resolve());
    } else { child.kill(); resolve(); }
  });
  stopping.set(child, operation); return operation;
}
export function childEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'NODE_TLS_REJECT_UNAUTHORIZED']) delete env[key];
  return env;
}
export function spawnCLI(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const dir = path.dirname(executable);
  // JavaScript CLI entry points (including protocol fixtures) run directly, without a shell shim.
  if (/\.[cm]?js$/i.test(executable)) {
    const runtimeEnv = childEnv(env);
    if (process.versions.electron) runtimeEnv.ELECTRON_RUN_AS_NODE = '1';
    return spawn(process.execPath, [executable, ...args], { cwd, env: runtimeEnv, windowsHide: true, shell: false, stdio: 'pipe' });
  }
  if (/cursor-agent\.(cmd|ps1)$/i.test(executable) && fs.existsSync(path.join(dir, 'node.exe')) && fs.existsSync(path.join(dir, 'index.js'))) {
    return spawn(path.join(dir, 'node.exe'), [path.join(dir, 'index.js'), ...args], { cwd, env: childEnv(env), windowsHide: true, stdio: 'pipe' });
  }
  if (process.platform === 'win32' && path.basename(executable).toLowerCase() === 'claude.cmd') {
    const native = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(native)) return spawn(native, args, { cwd, env: childEnv(env), windowsHide: true, stdio: 'pipe' });
  }
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(executable)) {
    const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new(); & ' + [executable, ...args].map(quote).join(' ')], { cwd, env: childEnv(env), windowsHide: true, stdio: 'pipe' });
  }
  return spawn(executable, args, { cwd, env: childEnv(env), windowsHide: true, stdio: 'pipe' });
}
export class JsonRpc extends EventEmitter {
  private seq = 0;
  private pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  readonly process: ChildProcessWithoutNullStreams;
  private closed = false;
  constructor(executable: string, args: string[], cwd: string, private envelope = true, env: NodeJS.ProcessEnv = {}) {
    super();
    this.process = spawnCLI(executable, args, cwd, env);
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', line => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { this.emit('diagnostic', line); return; }
      if (message.method) this.emit('message', message);
      else if (typeof message.id === 'number') {
        const call = this.pending.get(message.id); if (!call) return;
        this.pending.delete(message.id); clearTimeout(call.timer);
        message.error ? call.reject(Object.assign(new Error(message.error.message), { data: message.error.data })) : call.resolve(message.result);
      }
    });
    this.process.stderr.on('data', data => this.emit('diagnostic', data.toString()));
    this.process.on('error', e => this.finish(e));
    this.process.on('exit', code => this.finish(new Error('CLI 进程已退出（' + code + '）')));
    this.process.stdin.on('error', e => this.finish(e));
  }
  private finish(error: Error) { if (this.closed) return; this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); this.emit('closed', error); }
  private write(value: RpcMessage) { if (this.closed) throw new Error('CLI 连接已关闭'); this.process.stdin.write(JSON.stringify(this.envelope ? { jsonrpc: '2.0', ...value } : value) + '\n'); }
  request(method: string, params: unknown = {}, timeout = 60000, onWritten?: () => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' 超时')); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); onWritten?.(); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  notify(method: string, params: unknown = {}) { this.write({ method, params }); }
  respond(id: number | string, result: unknown) { this.write({ id, result }); }
  reject(id: number | string, message = '客户端暂不支持此请求') { this.write({ id, error: { code: -32601, message } }); }
  close() { this.finish(new Error('连接已关闭')); this.process.stdin.end(); return stopCLI(this.process); }
}
