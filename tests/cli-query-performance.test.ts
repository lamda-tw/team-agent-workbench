import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentRuntime } from '../src/core/agents';
import { ClaudeRuntime } from '../src/core/claude-runtime';
import { CapabilityCache } from '../src/core/capability-cache';
import { emptyCapabilityCatalog } from '../src/core/provider-capabilities';
import { Workbench } from '../src/core/workbench';
import { inspectCatalog } from '../src/core/provider-catalog';
import type { AgentSession } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Local protocol fixture, no online models.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const hooks = { changed() {}, event() {}, done() {} };
const session = (cwd: string, provider: 'codex' | 'cursor' | 'claude' = 'codex'): AgentSession => ({ id: 's', title: 'session', provider, cwd, purpose: 'work', status: 'idle', messages: [], sources: [], approvals: [], createdAt: '', handoffPath: '', autoUpload: false });
async function calls(root: string) { const text = await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }); return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []; }
async function cleanup(root: string) { assert(root.startsWith(path.join(os.tmpdir(), 'wb-query-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

test('cold Codex skill browsing and resolving are independent of slow plugins and do not create or probe a conversation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-skill-'));
  const fixture = await authLauncher(root, { status: 'ready', rpcDelays: { 'initialize': 80, 'plugin/installed': 700 } });
  const runtime = new AgentRuntime(session(root), fixture.launcher, hooks);
  try {
    let pluginFinished = false;
    const plugin = runtime.capabilities(false, 'plugin').then(result => { pluginFinished = true; return result; });
    const skill = await runtime.capabilities(false, 'skill');
    assert.equal(pluginFinished, false, 'slow plugins cannot hold back usable skills');
    const native = await runtime.resolveCapabilities([{ id: skill.skills[0].id, kind: 'skill' }]);
    assert.equal(native[0].path, skill.skills[0].path); assert.equal(pluginFinished, false);
    let requests = await calls(root);
    assert.equal(requests.filter(item => item.method === 'initialize').length, 1);
    assert(!requests.some(item => ['thread/start', 'thread/resume', 'turn/start', 'command/exec'].includes(item.method)));
    await Promise.all([runtime.ensureStarted(), runtime.ensureStarted()]);
    await plugin;
    requests = await calls(root);
    assert.equal(requests.filter(item => item.method === 'initialize').length, 1);
    assert.equal(requests.filter(item => item.method === 'thread/start').length, 1);
    assert.equal(requests.filter(item => item.method === 'skills/list').length, 1);
    assert.equal(requests.filter(item => item.method === 'plugin/installed').length, 1);
    await runtime.capabilities(); assert.equal((await calls(root)).length, requests.length);
    await runtime.capabilities(true, 'skill');
    assert.equal((await calls(root)).filter(item => item.method === 'skills/list').length, 2);
  } finally { await runtime.close(); await cleanup(root); }
});

test('two workbench capability sections share authentication and one isolated runtime; pinned routes use the recent login check', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-runtime-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const fixture = await authLauncher(root, { status: 'ready', rpcDelays: { 'initialize': 40 } });
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const work = await wb.createSession('codex', root, offlineProjectId);
    await Promise.all([wb.capabilities(work.id, false, 'skill'), wb.capabilities(work.id, false, 'plugin')]);
    let requests = await calls(root), initialized = requests.filter(item => item.method === 'initialize');
    assert.equal(initialized.filter(item => item.params.clientInfo.name === 'team_agent_workbench').length, 1);
    assert(!requests.some(item => item.method === 'thread/start'));
    const count = requests.length;
    await wb.capabilities(work.id, false, 'skill'); assert.equal((await calls(root)).length, count, 'cached metadata must not spawn another authentication check');
    await fixture.write({ status: 'none' });
    wb.accounts.invalidate('codex');
    await assert.rejects(wb.capabilities(work.id, false, 'skill'), /登录|检测/);
  } finally { await wb.close(); await cleanup(root); }
});

test('model queries coalesce, reuse cached display data, force refresh and isolate directory, route, environment and account changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-model-'));
  let proxy = 'http://fixture.invalid:1';
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, undefined, () => ({ HTTPS_PROXY: proxy }));
  try {
    const fixture = await authLauncher(root, { status: 'ready', rpcDelays: { 'model/list': 80 } });
    await wb.store.init(); wb.store.settings.providerPaths.codex = fixture.launcher;
    const coldStart = performance.now();
    const [first, second] = await Promise.all([wb.catalog('codex', root, 'direct'), wb.catalog('codex', root, 'direct')]); const coldMs = performance.now() - coldStart;
    assert.equal(first.models.length, 2); assert.deepEqual(first, second);
    const count = (await calls(root)).filter(item => item.method === 'initialize').length; assert.equal(count, 1);
    const start = performance.now(); await wb.catalog('codex', root, 'direct'); const cachedMs = performance.now() - start;
    assert.equal((await calls(root)).filter(item => item.method === 'initialize').length, 1);
    first.models.length = 0; assert.equal((await wb.catalog('codex', root, 'direct')).models.length, 2, 'callers cannot modify cached data');
    await wb.catalog('codex', root, 'direct', true);
    await wb.catalog('codex', root, 'management');
    const other = path.join(root, 'other'); await fs.mkdir(other); await wb.catalog('codex', other, 'direct');
    proxy = 'http://fixture.invalid:2'; await wb.catalog('codex', root, 'direct');
    wb.accounts.states.codex = { status: 'authenticated', detail: 'test', identity: 'another-account' };
    await wb.catalog('codex', root, 'direct');
    assert.equal((await calls(root)).filter(item => item.method === 'initialize').length, 6);
    const requests = await calls(root); assert(!requests.some(item => ['turn/start', 'thread/start'].includes(item.method)));
    console.log(`Simulated model query: cold ${coldMs.toFixed(2)} ms, cached ${cachedMs.toFixed(2)} ms; two simultaneous reads launched one CLI.`);
  } finally { await wb.close(); await cleanup(root); }
});

test('capability cache expires, retries a failed read, isolates callers and coalesces forced concurrent refreshes', async () => {
  const cache = new CapabilityCache('codex', 10); let count = 0;
  const load = async () => { count++; await new Promise(resolve => setTimeout(resolve, 10)); return { ...emptyCapabilityCatalog('codex'), skills: [{ id: 'skill:x', kind: 'skill' as const, name: 'x', invocation: 'x', description: '', enabled: true }] }; };
  const [one, two] = await Promise.all([cache.get(true, 'skill', load), cache.get(true, 'skill', load)]); assert.equal(count, 1);
  one.skills[0].enabled = false; assert.equal(two.skills[0].enabled, true);
  await new Promise(resolve => setTimeout(resolve, 15)); await cache.get(false, 'skill', load); assert.equal(count, 2);
  cache.invalidate();
  await assert.rejects(cache.get(false, 'skill', async () => { throw Error('failed'); }), /failed/);
  await cache.get(false, 'skill', load); assert.equal(count, 3);
});

test('Claude local skill resolution never launches the unrelated plugin command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-claude-'));
  await fs.mkdir(path.join(root, '.claude', 'skills', 'local-only'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude', 'skills', 'local-only', 'SKILL.md'), '---\ndescription: Local skill\n---\n');
  const runtime = new ClaudeRuntime(session(root, 'claude'), path.join(root, 'missing-cli.exe'), hooks);
  try {
    const selected = await runtime.resolveCapabilities([{ id: 'skill:local-only', kind: 'skill' }]);
    assert.equal(selected[0].invocation, 'local-only');
    assert.equal((await runtime.capabilities(false, 'skill')).skills.some(item => item.invocation === 'local-only'), true);
  } finally { await runtime.close(); await cleanup(root); }
});

test('a hanging quota lookup cannot hold a usable Codex model list until the full query timeout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-quota-'));
  const fixture = await authLauncher(root, { status: 'ready', quota: 'hang' });
  try {
    const start = performance.now(); const result = await inspectCatalog('codex', fixture.launcher, root, undefined, 8000); const elapsed = performance.now() - start;
    assert.equal(result.models.length, 2); assert.equal(result.quota.windows.length, 0);
    assert(elapsed < 6500, `quota exceeded its independent budget: ${elapsed.toFixed(0)} ms`);
    assert.match(result.quota.detail, /不代表额度为零/);
  } finally { await cleanup(root); }
});

test('Cursor plugins stay separate from MCP, require no native session, and empty commands do not repeatedly wait', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-cursor-'));
  const fixture = await authLauncher(root, { status: 'ready', cursorCommands: [] });
  await fs.mkdir(path.join(root, '.cursor'));
  await fs.writeFile(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'fixture-database': { type: 'http', url: 'https://example.invalid/mcp' } } }));
  await fs.mkdir(path.join(root,'.cursor','plugins','fixture-plugin'),{recursive:true});
  await fs.writeFile(path.join(root,'.cursor','plugins','fixture-plugin','plugin.json'),JSON.stringify({name:'fixture-plugin',description:'Isolated local plugin'}));
  const runtime = new AgentRuntime(session(root, 'cursor'), fixture.launcher, hooks);
  try {
    const plugins = await runtime.capabilities(false, 'plugin'); assert(plugins.plugins.some(item => item.name === 'fixture-plugin'));assert(!plugins.plugins.some(item=>item.name==='fixture-database'));
    assert(!(await calls(root)).some(item => item.method === 'initialize'));
    assert.deepEqual((await runtime.capabilities(false, 'skill')).skills, []);
    const start = performance.now(); assert.deepEqual((await runtime.capabilities(true, 'skill')).skills, []);
    assert(performance.now() - start < 800, 'an empty native result is ready, not an outstanding notification');
  } finally { await runtime.close(); await cleanup(root); }
});

test('closing during metadata initialization cancels the connection and never creates a conversation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-close-'));
  const fixture = await authLauncher(root, { status: 'ready', rpcDelays: { initialize: 500 } });
  const runtime = new AgentRuntime(session(root), fixture.launcher, hooks);
  try {
    const pending = runtime.capabilities(false, 'skill'); pending.catch(() => {});
    const end = Date.now() + 5000;
    while (!(await calls(root)).some(item => item.method === 'initialize')) { if (Date.now() > end) throw Error('initialize not sent'); await new Promise(resolve => setTimeout(resolve, 20)); }
    await runtime.close(); await assert.rejects(pending, /关闭/);
    assert(!(await calls(root)).some(item => item.method === 'thread/start'));
    await assert.rejects(runtime.capabilities(false, 'skill'), /关闭/);
  } finally { await runtime.close(); await cleanup(root); }
});

test('changing the CLI path during a shared model query rejects every old caller and leaves the new query usable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-query-change-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const first = await authLauncher(root, { status: 'ready', rpcDelays: { 'model/list': 300 } });
    const second = await authLauncher(path.join(root, 'other-cli'), { status: 'ready' });
    await wb.store.init(); wb.store.settings.providerPaths.codex = first.launcher;
    const one = wb.catalog('codex', root), two = wb.catalog('codex', root); one.catch(() => {}); two.catch(() => {});
    const end = Date.now() + 5000;
    while (!(await calls(root)).some(item => item.method === 'model/list')) { if (Date.now() > end) throw Error('model request not sent'); await new Promise(resolve => setTimeout(resolve, 20)); }
    wb.store.settings.providerPaths.codex = second.launcher;
    await Promise.all([assert.rejects(one, /查询范围/), assert.rejects(two, /查询范围/)]);
    assert.equal((await wb.catalog('codex', root)).models.length, 2);
  } finally { await wb.close(); await cleanup(root); }
});
