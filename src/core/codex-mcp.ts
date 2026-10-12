import path from 'node:path';
import { z } from 'zod';
import type { McpCatalog, McpMutation, McpServerInput, McpServerView } from '../shared/mcp';
import type { JsonRpc } from './rpc';
import type { CodexStorage } from './codex-storage';

export const mcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  transport: z.enum(['http', 'stdio']), url: z.url().max(4096).optional(),
  command: z.string().trim().min(1).max(4096).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  bearerTokenEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.transport === 'http' && (!value.url || !/^https?:\/\//i.test(value.url))) ctx.addIssue({ code: 'custom', message: '请输入 HTTP 或 HTTPS 服务地址', path: ['url'] });
  if (value.transport === 'stdio' && !value.command) ctx.addIssue({ code: 'custom', message: '请输入启动命令', path: ['command'] });
});

type ConfigRequest = (method: 'config/read' | 'config/value/write', params: unknown) => Promise<any>;
const states = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled']);
const clean = (value: unknown, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
const mutations = new Map<string, Promise<unknown>>();

// Never expose full config, endpoints, headers, environment values or OAuth URLs in snapshots.
export class CodexMcp {
  private logins = new Map<string, { expires: number; error?: string }>();
  constructor(private rpc: JsonRpc, private storage: CodexStorage, private sourceRequest: ConfigRequest,
    private threadId: () => string | undefined) {}

  async list(): Promise<McpCatalog> {
    const config = await this.rpc.request('config/read', { includeLayers: true });
    return this.catalog(config);
  }
  async catalog(config: any): Promise<McpCatalog> {
    const inventory: any[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.rpc.request('mcpServerStatus/list', { threadId: this.threadId(), cursor, limit: 100, detail: 'toolsAndAuthOnly' }, 20000);
      inventory.push(...(Array.isArray(page.data) ? page.data : []));
      cursor = page.nextCursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error('MCP 列表读取未完成，请刷新重试');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 100) throw new Error('MCP 列表过大，请减少配置后重试');
    } while (cursor);
    const definitions = config?.config?.mcp_servers || {};
    const names = new Set([...Object.keys(definitions), ...inventory.map(item => clean(item.name, 80)).filter(Boolean)]);
    const servers: McpServerView[] = [...names].map(name => {
      const item = inventory.find(value => value.name === name), definition = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
      const layers = (config?.layers || []).filter((layer: any) => !layer.disabledReason && Object.hasOwn(layer.config?.mcp_servers || {}, name));
      const managed = layers.some((layer: any) => !['user', 'project'].includes(layer.name?.type));
      const project = layers.some((layer: any) => layer.name?.type === 'project');
      const profile = layers.some((layer: any) => layer.name?.type === 'user' && layer.name.profile);
      const enabled = definition?.enabled !== false && item?.runtimeStatus !== 'disabled';
      const authStatus = clean(item?.authStatus, 40) || 'unknown';
      const state = !enabled ? 'disabled' : states.has(item?.runtimeStatus) ? item.runtimeStatus : authStatus === 'notLoggedIn' ? 'authenticationRequired' : 'unknown';
      const login = this.logins.get(name);
      return { name, title: clean(item?.serverInfo?.title, 200) || name, enabled, state, authStatus,
        source: item?.pluginId ? '插件' : managed ? '管理员配置' : project ? '当前项目' : profile ? '配置方案' : '个人配置',
        canToggle: !!definition && /^[a-zA-Z0-9_-]{1,80}$/.test(name) && !item?.pluginId && !managed && !project && !profile,
        tools: Object.entries(item?.tools || {}).map(([key, tool]: [string, any]) => ({ name: clean(tool?.name, 200) || key, description: clean(tool?.description, 500) })),
        loginPending: !!login && login.expires > Date.now() && !login.error,
        loginError: login?.error || (login && login.expires <= Date.now() ? '登录已超时，请重试' : undefined) };
    });
    return { servers, checkedAt: new Date().toISOString() };
  }
  async login(name: string) {
    const current = (await this.list()).servers.find(item => item.name === name);
    if (!current?.enabled) throw new Error('此 MCP 尚未启用');
    if (current.loginPending) throw new Error('请先完成浏览器中的登录');
    this.logins.set(name, { expires: Date.now() + 125000 });
    try {
      const { authorizationUrl } = await this.rpc.request('mcpServer/oauth/login', { name, threadId: this.threadId(), timeoutSecs: 120 }, 20000);
      const url = new URL(authorizationUrl);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid URL');
      return url.href;
    } catch { this.logins.set(name, { expires: 0, error: '无法开始登录，请刷新后重试' }); throw new Error('无法开始 MCP 登录，请刷新后重试'); }
  }
  completed(value: { name: string; success: boolean }) {
    if (value.success) this.logins.delete(value.name);
    else this.logins.set(value.name, { expires: 0, error: '登录未完成，请重试' });
  }
  async editable(name: string): Promise<McpServerInput> {
    const found = (await this.list()).servers.find(server => server.name === name);
    if (!found?.canToggle) throw new Error('请在项目、插件或管理员配置中修改此 MCP');
    const config = await this.sourceRequest('config/read', { includeLayers: true });
    const value = config.layers?.find((layer: any) => layer.name?.type === 'user' && !layer.name.profile)?.config?.mcp_servers?.[name];
    if (!value) throw new Error('MCP 已改变，请刷新后重试');
    return { name, transport: value.command ? 'stdio' : 'http', ...(value.command ? { command: value.command, args: value.args || [] } : { url: value.url, bearerTokenEnvVar: value.bearer_token_env_var }) };
  }
  async write(input: McpMutation) {
    if ('enabled' in input) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.name) || typeof input.enabled !== 'boolean') throw new Error('MCP 名称或启用设置无效');
    } else if (!('operation' in input)) input = mcpServerInputSchema.parse(input);
    else if (input.operation === 'update') input = { operation: 'update', server: mcpServerInputSchema.parse(input.server) };
    else if (input.operation !== 'remove' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.name)) throw new Error('MCP 操作无效');
    const key = this.storage.sourceHome;
    const previous = mutations.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const config = await this.sourceRequest('config/read', { includeLayers: true });
      const personal = (config.layers || []).find((layer: any) => layer.name?.type === 'user' && !layer.name.profile);
      const filePath = path.join(this.storage.sourceHome, 'config.toml'), version = personal?.version ? { expectedVersion: personal.version } : {};
      if ('operation' in input) {
        const name = input.operation === 'update' ? input.server.name : input.name;
        if (!(await this.list()).servers.find(server => server.name === name)?.canToggle) throw new Error('此 MCP 由项目、插件或管理员配置，请在对应配置中修改');
        const servers = { ...personal?.config?.mcp_servers };
        if (!Object.hasOwn(servers, name)) throw new Error('MCP 已改变，请刷新后重试');
        if (input.operation === 'remove') delete servers[name];
        else {
          const value = input.server, old = { ...servers[name] }; delete old.url; delete old.command; delete old.args;
          servers[name] = { ...old, ...(value.transport === 'http' ? { url: value.url, bearer_token_env_var: value.bearerTokenEnvVar || null } : { command: value.command, args: value.args || [] }) };
          // Null TOML values are not supported; explicitly omit an unset optional token source.
          if (servers[name].bearer_token_env_var === null) delete servers[name].bearer_token_env_var;
        }
        await this.sourceRequest('config/value/write', { keyPath: 'mcp_servers', value: servers, mergeStrategy: 'replace', filePath, ...version }); return;
      }
      if ('enabled' in input) {
        const server = (await this.list()).servers.find(item => item.name === input.name);
        if (!server?.canToggle) throw new Error('此 MCP 由项目、插件或管理员配置，请在对应配置中修改');
      } else if (Object.hasOwn(config.config?.mcp_servers || {}, input.name)) throw new Error('此名称已存在，请使用另一个 MCP 名称');
      const value = 'enabled' in input ? input.enabled : input.transport === 'http'
        ? { url: input.url, ...(input.bearerTokenEnvVar ? { bearer_token_env_var: input.bearerTokenEnvVar } : {}) }
        : { command: input.command, args: input.args || [] };
      await this.sourceRequest('config/value/write', { keyPath: 'mcp_servers.' + input.name + ('enabled' in input ? '.enabled' : ''), value, mergeStrategy: 'upsert',
        filePath: path.join(this.storage.sourceHome, 'config.toml'), ...(personal?.version ? { expectedVersion: personal.version } : {}) });
    });
    mutations.set(key, job);
    try { await job; } finally { if (mutations.get(key) === job) mutations.delete(key); }
  }
}
