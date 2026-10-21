import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { authFailure, inspectAuth, codexLoginStatus } from '../src/core/provider-auth';
import { ProviderAuthPanel } from '../src/renderer/provider-auth';
// @ts-expect-error Local CLI protocol fixture, never starts a real model.
import { authLauncher } from './fixtures/auth-launcher.mjs';

async function fixture(state: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-auth-recovery-'));
  const cli: { launcher: string; calls: () => Promise<string[]>; environments: () => Promise<Record<string, string>[]> } = await authLauncher(root, state);
  return { root, ...cli, requests: async () => (await fs.readFile(path.join(root, 'rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    clean: async () => { assert(root.startsWith(path.join(os.tmpdir(), 'wb-auth-recovery-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('a saved Codex login does not require workspace routing, token export, refresh, or a model turn', async () => {
  const f = await fixture({ status: 'ready' });
  try {
    const result = await inspectAuth('codex', f.launcher, f.root);
    assert.equal(result.status, 'authenticated'); assert.equal(result.verifiedLocally, true);
    const calls = await f.requests();
    assert.deepEqual(calls.find(call => call.method === 'getAuthStatus').params, { includeToken: false, refreshToken: false });
    assert(!calls.some(call => ['account/read', 'thread/start', 'turn/start', 'account/login/start'].includes(call.method)));
    assert(!JSON.stringify(result).includes('PRIVATE_FIXTURE_TOKEN'));
    const html = renderToStaticMarkup(React.createElement(ProviderAuthPanel, { provider: 'codex', auth: result, autoCheck: false }));
    assert.match(html, /已保存登录/); assert.match(html, /连通性/); assert(!html.includes('CLI 未提供账号名称'));
  } finally { await f.clean(); }
});

test('unsupported local status API falls back to account/read without forcing token refresh', async () => {
  const f = await fixture({ status: 'ready', authStatusUnsupported: true });
  try {
    const result = await inspectAuth('codex', f.launcher, f.root);
    assert.equal(result.status, 'authenticated'); assert.equal(result.identity, 'fake@example.com');
    assert.deepEqual((await f.requests()).find(call => call.method === 'account/read').params, { refreshToken: false });
    assert(!(await f.calls()).includes('login/status'));
  } finally { await f.clean(); }
});

test('network failure preserves confirmed local login and reports the routing failure separately', async () => {
  const f = await fixture({ status: 'none', savedLogin: true, authStatusError: 'workspace routing discovery timed out DO_NOT_FORWARD_THIS_SECRET' });
  try {
    const result = await inspectAuth('codex', f.launcher, f.root, undefined, 2000, { HTTPS_PROXY: 'http://fixture.invalid:18001' });
    assert.equal(result.status, 'authenticated'); assert.equal(result.verifiedLocally, true);
    assert.match(result.connectionIssue || '', /工作区路由发现超时/);
    assert(!JSON.stringify(result).includes('DO_NOT_FORWARD'));
    assert.deepEqual(await f.calls(), ['getAuthStatus', 'login/status']);
    assert((await f.environments()).every((env: any) => env.HTTPS_PROXY === 'http://fixture.invalid:18001'));
    const html = renderToStaticMarkup(React.createElement(ProviderAuthPanel, { provider: 'codex', auth: result, autoCheck: false }));
    assert.match(html, /已保存登录/); assert.match(html, /服务连接暂不可用/);
  } finally { await f.clean(); }
});

test('a confirmed expired credential is never overridden by a saved-login fallback', async () => {
  const f = await fixture({ status: 'expired', savedLogin: true });
  try {
    const result = await inspectAuth('codex', f.launcher, f.root);
    assert.equal(result.status, 'unauthenticated'); assert(!(await f.calls()).includes('login/status'));
  } finally { await f.clean(); }
});

test('a stalled protocol check has a bounded local fallback; it cannot hang the account panel forever', async () => {
  const f = await fixture({ status: 'hang', savedLogin: true });
  try {
    const result = await inspectAuth('codex', f.launcher, f.root, undefined, 1000);
    assert.equal(result.status, 'authenticated'); assert.match(result.connectionIssue || '', /网络/);
    assert((await f.calls()).includes('login/status'));
  } finally { await f.clean(); }
});

test('cancelling an in-flight auth check does not start fallback or replace cancellation with saved login', async () => {
  const f = await fixture({ status: 'hang', savedLogin: true }), controller = new AbortController();
  try {
    const job = inspectAuth('codex', f.launcher, f.root, controller.signal);
    const deadline = Date.now() + 5000;
    while (!(await f.calls().catch((): string[] => [])).includes('getAuthStatus')) {
      if (Date.now() > deadline) throw new Error('fixture did not start');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort();
    assert.match((await job).detail, /取消/);
    assert(!(await f.calls()).includes('login/status'));
  } finally { controller.abort(); await f.clean(); }
});

test('status parsing never exposes API-key previews or treats unknown output as logged in', () => {
  const api = codexLoginStatus('Logged in using an API key - sk-DO_NOT_FORWARD', 0);
  assert.equal(api?.status, 'configured'); assert(!JSON.stringify(api).includes('DO_NOT_FORWARD'));
  assert.equal(codexLoginStatus('Logged in using ChatGPT', 1), undefined);
  assert.equal(codexLoginStatus('something unexpected', 0), undefined);
  assert.equal(codexLoginStatus('Not logged in', 1)?.status, 'unauthenticated');
  assert.match(authFailure('certificate verify failed token=secret').detail, /证书/);
  assert(!authFailure('certificate verify failed token=secret').detail.includes('secret'));
});
