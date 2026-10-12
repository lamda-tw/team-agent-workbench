import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexMcp, mcpServerInputSchema } from '../src/core/codex-mcp';
import { composerTrigger, removeComposerTrigger } from '../src/renderer/composer-command';
import type { CodexStorage } from '../src/core/codex-storage';
import type { JsonRpc } from '../src/core/rpc';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const storage = { home: 'D:/isolated', sourceHome: 'D:/personal' } as CodexStorage;
const fixture = (inventory: any[] = [], config: any = {}) => {
  const calls: any[] = [], writes: any[] = [];
  const configResult = { config: { mcp_servers: config, api_key: 'SECRET' }, layers: [{ name: { type: 'user' }, version: 'rev-1', config: { mcp_servers: config } }] };
  const rpc = { request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'config/read') return configResult;
    if (method === 'mcpServerStatus/list') return { data: inventory, nextCursor: null };
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://login.example.com/authorize' };
    throw Error(method);
  } } as unknown as JsonRpc;
  const service = new CodexMcp(rpc, storage, async (method, params) => {
    if (method === 'config/read') return configResult;
    writes.push(params); return {};
  }, () => 'thread-1');
  return { service, calls, writes, configResult, rpc };
};

test('MCP status preserves failed, disabled, unknown and login states without exposing config secrets', async () => {
  const { service } = fixture([
    { name: 'docs', runtimeStatus: 'connected', authStatus: 'unsupported', tools: { search: { name: 'search', description: 'Search docs', inputSchema: { secret: 'SECRET' } } } },
    { name: 'auth', authStatus: 'notLoggedIn', tools: {} },
    { name: 'bad', runtimeStatus: 'failed', authStatus: 'unknown', toolsError: 'SECRET', tools: {} },
  ], { docs: { url: 'https://example.com/?token=SECRET' }, auth: {}, bad: {}, off: { enabled: false, env: { TOKEN: 'SECRET' } }, pending: {} });
  const value = await service.list();
  assert.deepEqual(value.servers.map(item => [item.name, item.state]), [['docs', 'connected'], ['auth', 'authenticationRequired'], ['bad', 'failed'], ['off', 'disabled'], ['pending', 'unknown']]);
  assert.deepEqual(value.servers[0].tools, [{ name: 'search', description: 'Search docs' }]);
  assert(!JSON.stringify(value).includes('SECRET'));
});

test('MCP list follows pagination and rejects repeated cursors instead of losing servers or looping', async () => {
  const f = fixture(); let page = 0;
  f.rpc.request = async (method: string) => method === 'config/read' ? f.configResult : (++page === 1 ? { data: [{ name: 'first' }], nextCursor: 'next' } : { data: [{ name: 'last' }], nextCursor: null });
  assert.deepEqual((await f.service.list()).servers.map(item => item.name), ['first', 'last']);
  f.rpc.request = async (method: string) => method === 'config/read' ? f.configResult : { data: [], nextCursor: 'repeat' };
  await assert.rejects(f.service.list(), /列表读取未完成/);
});

test('MCP writes target personal config with version check and only touch the selected server', async () => {
  const f = fixture([], { docs: { command: 'node', args: ['server.js'], env: { KEEP: 'private' } } });
  await f.service.write({ name: 'docs', enabled: false });
  assert.equal(f.writes[0].keyPath, 'mcp_servers.docs.enabled'); assert.equal(f.writes[0].value, false);
  assert.equal(f.writes[0].expectedVersion, 'rev-1'); assert.match(f.writes[0].filePath, /personal[\\/]config.toml$/);
  await f.service.write({ name: 'added', transport: 'http', url: 'https://example.com/mcp', bearerTokenEnvVar: 'DOCS_TOKEN' });
  assert.deepEqual(f.writes[1].value, { url: 'https://example.com/mcp', bearer_token_env_var: 'DOCS_TOKEN' });
  await assert.rejects(f.service.write({ name: 'docs', transport: 'stdio', command: 'other' }), /名称已存在/);
  assert.equal(f.writes.length, 2);
});
test('MCP edit/delete preserve other personal servers and use native version checks', async () => {
  const f = fixture([], { docs: { url: 'https://old.invalid', http_headers: { Authorization: 'SECRET' } }, other: { command: 'keep' } });
  await f.service.write({ operation: 'update', server: { name: 'docs', transport: 'http', url: 'https://new.invalid' } });
  assert.equal(f.writes[0].value.docs.http_headers.Authorization, 'SECRET'); assert.equal(f.writes[0].value.other.command, 'keep'); assert.equal(f.writes[0].mergeStrategy, 'replace'); assert.equal(f.writes[0].expectedVersion, 'rev-1');
  await f.service.write({ operation: 'remove', name: 'docs' }); assert(!f.writes[1].value.docs); assert.equal(f.writes[1].value.other.command, 'keep');
});

test('project, plugin and managed MCP configuration cannot be overwritten from personal switches', async () => {
  for (const source of ['project', 'system', 'plugin']) {
    const f = fixture([{ name: 'docs', ...(source === 'plugin' ? { pluginId: 'p' } : {}) }], { docs: {} });
    if (source !== 'plugin') f.configResult.layers.push({ name: { type: source }, version: 'v', config: { mcp_servers: { docs: {} } } });
    assert.equal((await f.service.list()).servers[0].canToggle, false);
    await assert.rejects(f.service.write({ name: 'docs', enabled: false }), /由项目、插件或管理员配置/);
    assert.equal(f.writes.length, 0);
  }
});

test('MCP OAuth follows native URL/completion flow, prevents duplicate login and handles failure', async () => {
  const f = fixture([{ name: 'auth', authStatus: 'notLoggedIn' }], { auth: {} });
  assert.equal(await f.service.login('auth'), 'https://login.example.com/authorize');
  assert.equal((await f.service.list()).servers[0].loginPending, true);
  await assert.rejects(f.service.login('auth'), /完成浏览器/);
  f.service.completed({ name: 'auth', success: false });
  assert.equal((await f.service.list()).servers[0].loginError, '登录未完成，请重试');
  await f.service.login('auth'); f.service.completed({ name: 'auth', success: true });
  assert.equal((await f.service.list()).servers[0].loginPending, false);
  const original = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method: string, params: any) => method === 'mcpServer/oauth/login' ? { authorizationUrl: 'javascript:SECRET' } : original(method, params);
  await assert.rejects(f.service.login('auth'), /无法开始 MCP 登录/);
  assert(!JSON.stringify(await f.service.list()).includes('SECRET'));
});

test('MCP add validates transport, URLs, variable names and keys before native configuration writes', () => {
  for (const value of [{ name: 'a.b', transport: 'http', url: 'https://example.com' }, { name: 'a', transport: 'http', url: 'file:///tmp/server' }, { name: 'a', transport: 'stdio' }, { name: 'a', transport: 'http', url: 'https://example.com', bearerTokenEnvVar: 'invalid var' }]) assert.equal(mcpServerInputSchema.safeParse(value).success, false);
  assert.equal(mcpServerInputSchema.safeParse({ name: 'a', transport: 'stdio', command: 'C:/my tools/server.exe', args: ['literal arg'] }).success, true);
});

test('composer recognizes Codex slash commands and mentions at the caret without matching prose, paths or prices', () => {
  assert.deepEqual(composerTrigger('/mcp'), { kind: 'command', query: 'mcp', start: 0, end: 4 });
  const value = '请使用 $review 检查代码', trigger = composerTrigger(value, value.indexOf(' 检查'))!;
  assert.equal(trigger.kind, 'skill'); assert.equal(trigger.query, 'review');
  assert.equal(removeComposerTrigger(value, trigger), '请使用  检查代码');
  assert.equal(composerTrigger('@drive')?.kind, 'plugin');
  for (const value of ['a/b', 'a@example.com', '已经输入 /mcp 后继续工作', '/mcp ', '普通任务', '价格 $19.99', '/usr/bin']) assert.equal(composerTrigger(value), undefined);
});

test('workbench MCP management preserves active turns/drafts, refreshes other Codex runtimes and rejects closed/helper/foreign sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-mcp-')), originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'personal');
  const fixture = await authLauncher(root, { status: 'ready', turn: 'hang' });
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  const calls = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const a = await wb.createSession('codex', root, offlineProjectId), b = await wb.createSession('codex', root, offlineProjectId);
    await wb.mcpCatalog(a.id); await wb.mcpCatalog(b.id);
    assert.equal((await calls()).filter(value => ['thread/start', 'turn/start'].includes(value.method)).length, 0, 'management must work without starting model threads');
    assert.deepEqual(await wb.mcpWrite(a.id, { name: 'docs', transport: 'http', url: 'https://example.invalid/mcp' }), { pendingReload: 0 });
    assert.equal((await calls()).filter(value => value.method === 'config/mcpServer/reload').length, 2);
    await wb.send(a.id, '保持当前任务运行');
    const deadline = Date.now() + 10000; while (a.status !== 'running') { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
    const nativeId = a.nativeId, messages = structuredClone(a.messages), draft = { text: '我的草稿', sourceIds: [], answers: {} };
    wb.store.inputs[a.id] = draft;
    await wb.mcpWrite(a.id, { name: 'docs', enabled: false });
    assert.equal(a.status, 'running'); assert.equal(a.nativeId, nativeId); assert.deepEqual(a.messages, messages); assert.deepEqual(wb.store.inputs[a.id], draft);
    assert.equal((await calls()).filter(value => value.method === 'turn/start').length, 1);
    assert.equal((await calls()).filter(value => value.method === 'turn/interrupt').length, 0);
    const runtime = (wb as any).runtimes.get(a.id), reload = runtime.mcpReload;
    runtime.mcpReload = async () => { throw new Error('fixture reload failure'); };
    assert.deepEqual(await wb.mcpWrite(a.id, { name: 'docs', enabled: true }), { pendingReload: 2 });
    assert.equal((await wb.mcpCatalog(a.id)).servers[0].enabled, true, 'saved config must remain saved if reload failed');
    assert.equal(a.status, 'running'); assert.deepEqual(wb.store.inputs[a.id], draft);
    runtime.mcpReload = reload;
    await wb.closeSession(b.id); await assert.rejects(wb.mcpCatalog(b.id), /打开的 Codex 工作会话/);
    const helper = { ...b, id: 'helper', closedAt: undefined, purpose: 'prepare' as const }, other = { ...b, id: 'other-provider', closedAt: undefined, provider: 'cursor' as const }, foreign = { ...b, id: 'foreign', closedAt: undefined, binding: { ...b.binding!, username: 'bob' } };
    wb.store.sessions.push(helper, other, foreign);
    for (const id of [helper.id, foreign.id]) await assert.rejects(wb.mcpCatalog(id));
    assert(Array.isArray((await wb.mcpCatalog(other.id)).servers), 'Cursor has an independent MCP catalog');
  } finally { await wb.close(); if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome; await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
