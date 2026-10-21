import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JsonRpc } from '../src/core/rpc';
import { CodexMcp } from '../src/core/codex-mcp';
import { resolveProvider } from '../src/core/providers';
import { prepareCodexStorage, refreshCodexConfiguration } from '../src/core/codex-storage';
import type { AgentSession } from '../src/shared/types';

// Native CLI configuration and MCP transport only. No model turn or account login.
async function main() {
const root = path.join(process.cwd(), '.test-data', 'native-mcp-' + Date.now()), sourceHome = path.join(root, 'personal');
await fs.mkdir(sourceHome, { recursive: true });
const executable = await resolveProvider('codex');
const storage = await prepareCodexStorage(path.join(root, 'data'), { cwd: root, provider: 'codex', purpose: 'work' } as AgentSession, sourceHome);
const source = new JsonRpc(executable, ['app-server'], root, false, { CODEX_HOME: sourceHome });
const runtime = new JsonRpc(executable, storage.args, root, false, storage.env);
const initialize = async (rpc: JsonRpc) => { await rpc.request('initialize', { clientInfo: { name: 'mcp_protocol_smoke', version: '1' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized'); };
try {
  await initialize(source); await initialize(runtime);
  const service = new CodexMcp(runtime, storage, (method, params) => source.request(method, params), () => undefined);
  await service.write({ name: 'fixture', transport: 'stdio', command: process.execPath, args: [path.resolve('tests/fixtures/mcp-server.mjs')] });
  const saved = await fs.readFile(path.join(sourceHome, 'config.toml'), 'utf8');
  assert(saved.includes('[mcp_servers.fixture]')); assert(saved.includes('mcp-server.mjs'));
  await refreshCodexConfiguration(storage); await runtime.request('config/mcpServer/reload', null);
  let catalog = await service.list();
  for (let i = 0; i < 10 && !catalog.servers.find(server => server.name === 'fixture')?.tools.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 200)); catalog = await service.list();
  }
  assert.equal(catalog.servers.find(server => server.name === 'fixture')?.tools[0]?.name, 'ping');
  await service.write({ name: 'fixture', enabled: false });
  await refreshCodexConfiguration(storage); await runtime.request('config/mcpServer/reload', null);
  assert.equal((await service.list()).servers.find(server => server.name === 'fixture')?.state, 'disabled');
  const modes = await runtime.request('collaborationMode/list', {});
  assert(modes.data.some((mode: any) => mode.mode === 'plan'));
  const editable = await service.editable('fixture'); assert.equal(editable.transport, 'stdio');
  await service.write({ operation: 'update', server: { ...editable, args: [path.resolve('tests/fixtures/mcp-server.mjs'), 'updated'] } });
  assert((await fs.readFile(path.join(sourceHome, 'config.toml'), 'utf8')).includes('updated'));
  await service.write({ operation: 'remove', name: 'fixture' });
  assert(!(await fs.readFile(path.join(sourceHome, 'config.toml'), 'utf8')).includes('[mcp_servers.fixture]'));
  console.log('Native Codex MCP protocol passed: personal config write/version, isolated config reload, stdio tool discovery and disable; no model turn or login.');
} finally { await source.close(); await runtime.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
