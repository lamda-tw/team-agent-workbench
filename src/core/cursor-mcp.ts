import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store';
import { mcpServerInputSchema } from './codex-mcp';
import { spawnCLI, stopCLI } from './rpc';
import type { McpCatalog, McpMutation, McpServerInput } from '../shared/mcp';

// Cursor owns connections and OAuth. Configuration presence does not prove connectivity.
export class CursorMcp {
  readonly file: string;
  constructor(private cwd: string, private executable: string, private env: NodeJS.ProcessEnv = {}, home = os.homedir()) { this.file = path.join(home, '.cursor', 'mcp.json'); }
  private async read(file: string) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object' || value.mcpServers && (typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers))) throw new Error();
      return value;
    } catch (e: any) { if (e.code === 'ENOENT') return {}; throw new Error('Cursor MCP 配置格式有误，请在设置中检查配置文件。'); }
  }
  private async definitions() {
    const definitions = new Map<string, { value: any; source: string }>();
    const add = async (file: string, source: string) => { const config = await this.read(file); for (const [name, value] of Object.entries(config.mcpServers || {})) definitions.set(name, { value, source }); };
    await add(this.file, '个人配置');
    const dirs: string[] = []; let dir = path.resolve(this.cwd);
    for (;;) { dirs.unshift(dir); const parent = path.dirname(dir); if (parent === dir) break; dir = parent; }
    for (const dir of dirs) await add(path.join(dir, '.cursor', 'mcp.json'), '当前项目');
    return definitions;
  }
  async list(): Promise<McpCatalog> {
    const defs = await this.definitions();
    return { checkedAt: new Date().toISOString(), servers: [...defs].map(([name, { value, source }]) => ({ name, title: name, enabled: value.disabled !== true,
      state: value.disabled ? 'disabled' : 'unknown', authStatus: 'unknown', source, canToggle: source === '个人配置' && /^[a-zA-Z0-9_-]{1,80}$/.test(name), canLogin: !!value.url, tools: [] })) };
  }
  async editable(name: string): Promise<McpServerInput> {
    const found = (await this.definitions()).get(name);
    if (!found || found.source !== '个人配置') throw new Error('请在项目配置中修改此 MCP');
    const value = found.value;
    return { name, transport: value.command ? 'stdio' : 'http', ...(value.command ? { command: value.command, args: Array.isArray(value.args) ? value.args : [] } : { url: value.url }) };
  }
  private async cli(args: string[], timeout = 15000) {
    const child = spawnCLI(this.executable, ['mcp', ...args], this.cwd, this.env);
    child.stdout.resume(); child.stderr.resume();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { void stopCLI(child); reject(new Error('Cursor MCP 操作超时，请重试。')); }, timeout);
      child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 Cursor MCP 操作。')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Cursor MCP 操作未完成，请检查 CLI 配置和网络。')); });
    });
  }
  async login(name: string) {
    if (!(await this.list()).servers.some(value => value.name === name && value.enabled && value.canLogin)) throw new Error('此 MCP 不支持登录或尚未启用');
    await this.cli(['login', name], 120000); return true;
  }
  async write(input: McpMutation) {
    const name = 'operation' in input && input.operation === 'update' ? input.server.name : input.name;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('MCP 名称无效');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lockPath = this.file + '.workbench.lock', token = randomUUID();
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch {
      try {
        const previous = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error();
        try { process.kill(previous.pid, 0); throw new Error('active'); }
        catch (e: any) { if (e.code !== 'ESRCH') throw e; }
        // Recover only a lock whose owning process is confirmed to have exited.
        if (await fs.readFile(lockPath, 'utf8') === JSON.stringify(previous)) await fs.unlink(lockPath);
        lock = await fs.open(lockPath, 'wx', 0o600);
      } catch { throw new Error('其他窗口正在修改 Cursor MCP，请稍后重试。'); }
    }
    let written = false;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, token })); written = true;
      const config = await this.read(this.file), defs = await this.definitions();
      const existing = defs.get(name);
      if (('enabled' in input || 'operation' in input) && (!existing || existing.source !== '个人配置')) throw new Error('此 MCP 由项目配置，请在对应配置中修改');
      const servers = { ...(config.mcpServers || {}) };
      if ('enabled' in input) {
        await this.cli([input.enabled ? 'enable' : 'disable', name]);
        // The native command can update approvals/config; re-read before preserving other fields.
        const latest = await this.read(this.file);
        await atomicJson(this.file, { ...latest, mcpServers: { ...latest.mcpServers, [name]: { ...latest.mcpServers?.[name], disabled: !input.enabled } } });
        return;
      }
      if ('operation' in input && input.operation === 'remove') delete servers[name];
      else {
        const value = mcpServerInputSchema.parse('operation' in input ? input.server : input);
        if (value.bearerTokenEnvVar) throw new Error('请在 Cursor 配置文件中设置认证 Headers');
        if (!('operation' in input) && existing) throw new Error('此名称已存在，请使用另一个 MCP 名称');
        const old = 'operation' in input ? servers[name] : {};
        const next = { ...old }; delete next.url; delete next.command; delete next.args; delete next.type;
        if (value.transport === 'stdio') Object.assign(next, { command: value.command, args: value.args || [] });
        else Object.assign(next, { url: value.url });
        servers[name] = next;
      }
      await atomicJson(this.file, { ...config, mcpServers: servers });
    } finally { await lock.close(); if (!written) await fs.unlink(lockPath); else { const value = JSON.parse(await fs.readFile(lockPath, 'utf8')); if (value.token === token) await fs.unlink(lockPath); } }
  }
}
