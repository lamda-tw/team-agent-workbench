import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderConnection } from '../src/renderer/provider-connection-check';
import type { ProviderAuth, ProviderCatalog } from '../src/shared/types';

const auth: ProviderAuth = { status: 'authenticated', detail: '已登录', cwd: 'D:/work', checkedAt: '2026-09-23' };
const catalog: ProviderCatalog = { models: [{ id: 'default', name: '默认模型', isDefault: true }], quota: { windows: [], detail: '未返回额度', url: '' }, checkedAt: '2026-09-23' };

test('saved login with a known connection failure does not trigger another slow model probe', async () => {
  const calls: string[] = [], saved: ProviderAuth = { ...auth, verifiedLocally: true, connectionIssue: 'Codex 工作区路由发现超时' };
  const result = await checkProviderConnection(async <T,>(action: string): Promise<T> => {
    calls.push(action); return (action === 'provider.auth' ? saved : { enabled: false }) as T;
  }, 'codex', 'D:/work');
  assert.equal(result.auth, saved); assert.equal(result.catalog, undefined);
  assert(!calls.includes('provider.catalog'));
});

test('applying a connection rechecks the selected provider and directory only after the switch succeeds', async () => {
  const calls: { action: string; payload: any }[] = [];
  const call = async <T,>(action: string, payload?: unknown): Promise<T> => {
    calls.push({ action, payload });
    return (action === 'egress.test' ? { enabled: true, available: true } : action === 'provider.auth' ? auth : action === 'provider.catalog' ? catalog : true) as T;
  };
  const result = await checkProviderConnection(call, 'cursor', 'D:/work', { enabled: true, inviteCode: 'test-invite' });
  assert.deepEqual(calls.map(value => value.action), ['egress.configure', 'egress.test', 'providers.detect', 'provider.auth', 'provider.catalog']);
  assert.deepEqual(calls[3].payload, { provider: 'cursor', cwd: 'D:/work' }); assert.deepEqual(calls[4].payload, calls[3].payload);
  assert.deepEqual(result, { auth, catalog, issues: [] });
});

test('a rejected switch does not recheck or report success using the previous route', async () => {
  const calls: string[] = [];
  await assert.rejects(checkProviderConnection(async <T,>(action: string): Promise<T> => { calls.push(action); throw new Error('任务运行中'); }, 'codex', 'D:/work', { enabled: true }), /任务运行中/);
  assert.deepEqual(calls, ['egress.configure']);
});

test('failed relay connectivity still refreshes login state without displaying stale models as available', async () => {
  const calls: string[] = [];
  const result = await checkProviderConnection(async <T,>(action: string): Promise<T> => {
    calls.push(action); if (action === 'egress.test') throw new Error('出口不可达');
    return (action === 'provider.auth' ? auth : []) as T;
  }, 'codex', 'D:/work');
  assert.deepEqual(calls, ['egress.test', 'providers.detect', 'provider.auth']);
  assert.equal(result.auth, auth); assert.equal(result.catalog, undefined); assert.match(result.issues[0], /出口不可达/);
});

test('switching context during a connection check cannot launch a late auth check in the old directory', async () => {
  const calls: string[] = []; let current = true;
  await assert.rejects(checkProviderConnection(async <T,>(action: string): Promise<T> => {
    calls.push(action); current = false; return { enabled: false } as T;
  }, 'codex', 'D:/old-work', undefined, () => current), /检测范围已改变/);
  assert.deepEqual(calls, ['egress.test']);
});

test('a new direct session checks its own route without changing an active management connection', async () => {
  const calls: { action: string; payload: unknown }[] = [];
  const result = await checkProviderConnection(async <T,>(action: string, payload?: unknown): Promise<T> => {
    calls.push({ action, payload });
    return (action === 'egress.test' ? { enabled: false, available: true } : action === 'provider.auth' ? auth : action === 'provider.catalog' ? catalog : true) as T;
  }, 'codex', 'D:/work', undefined, () => true, 'direct');
  assert.deepEqual(calls.map(item => item.action), ['egress.test', 'providers.detect', 'provider.auth', 'provider.catalog']);
  assert.deepEqual(calls[0].payload, { networkRoute: 'direct' });
  assert.deepEqual(calls[2].payload, { provider: 'codex', cwd: 'D:/work', networkRoute: 'direct' });
  assert.deepEqual(result, { auth, catalog, issues: [] });
});
