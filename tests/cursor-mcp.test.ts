import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CursorMcp } from '../src/core/cursor-mcp';
import { Store } from '../src/core/store';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared JS fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('Cursor MCP preserves config, keeps project overrides read-only and does not invent runtime status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-mcp-')), home = path.join(root, 'home'), cwd = path.join(root, 'project');
  await fs.mkdir(path.join(home, '.cursor'), { recursive: true }); await fs.mkdir(path.join(cwd, '.cursor'), { recursive: true });
  const file = path.join(home, '.cursor', 'mcp.json');
  await fs.writeFile(file, JSON.stringify({ extra: 'keep', mcpServers: { docs: { url: 'https://example.invalid', headers: { Authorization: 'SECRET' } }, overridden: { command: 'node' } } }));
  await fs.writeFile(path.join(cwd, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { overridden: { command: 'project', env: { TOKEN: 'SECRET' } } } }));
  const fixture = await authLauncher(root, { status: 'ready' }), service = new CursorMcp(cwd, fixture.launcher, {}, home);
  try {
    const list = await service.list(); assert(!JSON.stringify(list).includes('SECRET')); assert.equal(list.servers[0].state, 'unknown');
    assert.equal(list.servers.find(server => server.name === 'overridden')?.canToggle, false);
    await assert.rejects(service.write({ operation: 'remove', name: 'overridden' }), /项目配置/);
    await assert.rejects(service.write({ name: 'docs', transport: 'http', url: 'https://new.invalid' }), /名称已存在/);
    await service.write({ operation: 'update', server: { name: 'docs', transport: 'http', url: 'https://new.invalid/mcp' } });
    let config = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(config.extra, 'keep'); assert.equal(config.mcpServers.docs.headers.Authorization, 'SECRET');
    assert.equal(config.mcpServers.overridden.command, 'node');
    await service.write({ name: 'local', transport: 'stdio', command: 'C:/tools/node.exe', args: ['literal argument'] });
    assert.equal((await service.editable('local')).command, 'C:/tools/node.exe');
    await service.write({ operation: 'remove', name: 'local' }); config = JSON.parse(await fs.readFile(file, 'utf8')); assert(!config.mcpServers.local);
    await fs.writeFile(file + '.workbench.lock', JSON.stringify({ pid: process.pid, token: 'another-window' }));
    await assert.rejects(service.write({ name: 'blocked', transport: 'http', url: 'https://x.invalid' }), /其他窗口/);
    await fs.unlink(file + '.workbench.lock');
    await fs.writeFile(file, '{bad json'); await assert.rejects(service.list(), /格式有误/);
    await assert.rejects(service.write({ name: 'no-loss', transport: 'stdio', command: 'node' }), /格式有误/); assert.equal(await fs.readFile(file, 'utf8'), '{bad json');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('upgrade removes legacy per-message Cursor MCP choices and preserves drafts, skills and history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-mcp-upgrade-'));
  try {
    const store = new Store(root); await store.init();
    store.sessions = [{ id: 'legacy', provider: 'cursor', purpose: 'work', status: 'idle', messages: [{ id: 'message', role: 'user', text: 'historical MCP hint', createdAt: '' }], approvals: [], sources: [] } as any];
    store.inputs.legacy = { text: 'unfinished work', sourceIds: ['ref'], answers: {}, capabilities: [{ id: 'plugin:mcp:docs', kind: 'plugin', name: 'docs' }, { id: 'skill:review', kind: 'skill', name: 'review' }] };
    await store.save(); const upgraded = new Store(root); await upgraded.init();
    assert.equal(upgraded.inputs.legacy.text, 'unfinished work'); assert.deepEqual(upgraded.inputs.legacy.sourceIds, ['ref']); assert.deepEqual(upgraded.inputs.legacy.capabilities?.map(item => item.id), ['skill:review']);
    assert.equal(upgraded.sessions[0].messages[0].text, 'historical MCP hint');
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
test('Cursor MCP refresh preserves active replies and reports saved config when reloading fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-refresh-'));
  const fixture = await authLauncher(root, { status: 'ready', turn: 'hang' }), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  let saved = false;
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.cursor = fixture.launcher;
    const session = await wb.createSession('cursor', root, offlineProjectId);
    const send = wb.send(session.id, 'Active work');
    const deadline = Date.now() + 10000; while (session.status !== 'running') { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 20)); }
    const native = session.nativeId, input = { text: 'next draft', sourceIds: [], answers: {} }; wb.store.inputs[session.id] = input;
    (wb as any).cursorMcp = async () => ({ write: async () => { saved = true; }, list: async () => ({ servers: [], checkedAt: '' }) });
    assert.deepEqual(await wb.mcpWrite(session.id, { name: 'docs', transport: 'http', url: 'https://example.invalid' }), { pendingReload: 1 });
    await wb.mcpCatalog(session.id, true); assert.equal(session.status, 'running'); assert.equal(session.nativeId, native); assert.deepEqual(wb.store.inputs[session.id], input);
    const update = (wb as any).updateSessionSettings; (wb as any).updateSessionSettings = async () => { throw new Error('reload unavailable'); };
    assert.deepEqual(await wb.mcpWrite(session.id, { name: 'docs', enabled: true }), { pendingReload: 1 }); assert.equal(saved, true);
    (wb as any).updateSessionSettings = update;
    await wb.stop(session.id); await send;
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
