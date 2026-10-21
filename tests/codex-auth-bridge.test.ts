import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import { CodexAuthBridge } from '../src/core/codex-auth-bridge';
import type { AgentRpc } from '../src/core/rpc';
import { prepareCodexStorage } from '../src/core/codex-storage';
import type { AgentSession } from '../src/shared/types';
// @ts-expect-error Shared CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('a bridge reuses valid credentials and refreshes only near expiry or on a runtime refresh request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-bridge-'));
  const expires = Math.floor(Date.now() / 1000);
  const f = await authLauncher(root, { status: 'ready', tokenExpiresAt: expires + 3600 });
  const bridge = new CodexAuthBridge(f.launcher, root, path.join(root, 'personal'));
  let logins = 0, replies = 0;
  const runtime = { request: async (method: string) => { assert.equal(method, 'account/login/start'); logins++; }, respond: () => { replies++; }, reject: () => assert.fail('refresh must succeed') } as unknown as AgentRpc;
  const reads = async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(call => call.method === 'getAuthStatus');
  try {
    await bridge.login(runtime);
    assert.deepEqual((await reads()).map(call => call.params.refreshToken), [false]);
    await bridge.refresh(runtime, 42);
    assert.equal(replies, 1);
    assert.deepEqual((await reads()).map(call => call.params.refreshToken), [false, true]);
    await f.write({ status: 'ready', tokenExpiresAt: expires - 1, refreshedTokenExpiresAt: expires + 3600 });
    await bridge.login(runtime);
    assert.equal(logins, 2);
    assert.deepEqual((await reads()).map(call => call.params.refreshToken), [false, true, false, true]);
    await f.write({ status: 'ready', tokenExpiresAt: expires - 1 });
    await assert.rejects(bridge.login(runtime), /登录已过期/); assert.equal(logins, 2);
  } finally { await bridge.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-auth-bridge-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('routing errors from credential acquisition retain a safe actionable reason', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-bridge-'));
  const f = await authLauncher(root, { status: 'ready', authStatusError: 'workspace routing discovery timed out PRIVATE_SECRET' });
  const bridge = new CodexAuthBridge(f.launcher, root, root);
  try {
    await assert.rejects(bridge.login({ request: () => assert.fail('must not log in with missing credentials') } as unknown as AgentRpc), error => {
      assert.match(String(error), /工作区路由发现超时/); assert(!String(error).includes('PRIVATE_SECRET')); return true;
    });
    let rejected = '';
    await bridge.refresh({ reject: (_id: unknown, reason: string) => { rejected = reason; } } as unknown as AgentRpc, 7);
    assert.match(rejected, /工作区路由发现超时/); assert(!rejected.includes('PRIVATE_SECRET')); assert(!rejected.includes('请重新登录'));
  } finally { await bridge.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-auth-bridge-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
test('isolated Codex uses personal login and refreshes in memory without leaking credentials; changed accounts fail closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-bridge-'));
  const f = await authLauncher(path.join(root, 'cli'), { status: 'ready', refreshAuth: true });
  const events: unknown[] = [];
  const s: AgentSession = { id: randomUUID(), title: '登录桥接', provider: 'codex', cwd: root, purpose: 'work', createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') };
  const storage = await prepareCodexStorage(path.join(root, 'data'), s, path.join(root, 'personal'));
  const runtime = new AgentRuntime(s, f.launcher, { changed: () => {}, done: () => {}, event: e => events.push(e) }, storage);
  const finished = async () => { const end = Date.now() + 20000; while (s.status === 'running') { if (Date.now() > end) throw new Error('refresh timeout'); await new Promise(r => setTimeout(r, 20)); } };
  try {
    await runtime.prompt('refresh'); await finished(); assert.equal(s.status, 'idle'); assert((await f.calls()).includes('auth-refresh-ok'));
    await f.write({ status: 'ready', refreshAuth: true, accountId: 'different-person' });
    await runtime.prompt('must not change accounts'); await finished(); assert.equal(s.status, 'error'); assert((await f.calls()).includes('auth-refresh-rejected'));
    assert(!JSON.stringify({ events, session: s }).includes('PRIVATE_FIXTURE_TOKEN'));
    assert(!JSON.stringify(events).includes('account/chatgptAuthTokens/refresh'));
    await assert.rejects(fs.access(path.join(storage.home, 'auth.json')));
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
