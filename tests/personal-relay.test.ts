import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { assertPersonalRelay } from '../src/core/personal-relay';
import { backgroundTextTask } from '../src/core/background-text';
// @ts-expect-error Shared protocol fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

test('personal ownership and relay authentication are independent axes', () => {
  for (const account of [undefined, 'alice', 'bob']) {
    assert.doesNotThrow(() => assertPersonalRelay('direct', true, account, { relayAccount: 'alice' }));
    assert.doesNotThrow(() => assertPersonalRelay('management', false, account, { relayAccount: 'alice' }));
  }
  assert.throws(() => assertPersonalRelay('management', true, undefined), /登录中央节点/);
  assert.throws(() => assertPersonalRelay('management', true, 'bob', { relayAccount: 'alice' }), /原来使用的中央账号/);
  assert.doesNotThrow(() => assertPersonalRelay('management', true, 'alice', { relayAccount: 'alice' }));
});

test('cached runtimes, preparation helpers and background summaries keep the original relay identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-relay-'));
  const cli = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  let account: string | undefined = 'alice';
  const env = (route: any, session?: any) => { assertPersonalRelay(route, true, account, session); return {}; };
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {}, undefined, env, undefined, undefined, undefined, true);
  try {
    await wb.store.init(); await wb.restoreLocalWorkspace();
    wb.store.settings.providerPaths.codex = cli.launcher;
    wb.store.settings.egress = { enabled: true, viaSharedServer: true, host: 'test', port: 443, certificateFingerprint: '' };
    const session = await wb.createSession('codex', root, undefined, 'work', undefined, undefined, 'inherit', false, 'management');
    session.relayAccount = 'alice';
    // Keep the automatic summarizer out of this targeted runtime test.
    await wb.activity.pause();
    await wb.send(session.id, 'first');
    for (let i = 0; session.status !== 'idle' && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(session.status, 'idle'); const count = session.messages.length;
    account = 'bob'; await assert.rejects(wb.send(session.id, 'must not send'), /原来使用的中央账号/);
    account = undefined; await assert.rejects(wb.send(session.id, 'must not send'), /登录中央节点/);
    assert.equal(session.messages.length, count);
    const helper = await wb.createSession('codex', root, undefined, 'prepare', session.id);
    assert.equal(helper.relayAccount, 'alice');
    account = 'bob';
    const summarize = backgroundTextTask(root, () => cli.launcher, s => env(s.networkRoute, s));
    await assert.rejects(summarize(session, 'summarize', new AbortController().signal), /原来使用的中央账号/);
    await wb.changeNetworkRoute(session.id, 'direct'); assert.equal(session.relayAccount, undefined);
    await wb.send(session.id, 'direct still works');
    await assert.rejects(wb.archive(session.id), /先将会话迁移/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});
