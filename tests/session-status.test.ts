import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import type { AgentSession } from '../src/shared/types';
import { hasUnreadCompletion, observeVisibleCompletion, SessionStatusIndicator } from '../src/renderer/session-status';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const until = async (check: () => boolean) => {
  const end = Date.now() + 15000;
  while (!check()) { if (Date.now() > end) throw new Error('session state timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const markup = (session: AgentSession, sending = false) => renderToStaticMarkup(React.createElement(SessionStatusIndicator, { session, sending }));
const spinner = /class="[^"]*\bspin\b[^"]*"/;
async function withWorkbench(run: (wb: Workbench, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-session-status-'));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    await run(wb, root);
  } finally {
    await wb.close();
    assert(root.startsWith(path.join(os.tmpdir(), 'wb-session-status-')));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('sidebar distinguishes ongoing turns, approvals, completed unread replies and failures', () => {
  const s = { purpose: 'work', status: 'idle' } as AgentSession;
  assert.equal(markup(s), '', 'new and legacy idle sessions are not suddenly unread');
  assert.match(markup(s, true), spinner);
  s.completion = { id: randomUUID() };
  assert.match(markup(s), /session-unread-dot/);
  assert.doesNotMatch(markup(s), spinner);
  for (const status of ['starting', 'running', 'approval'] as const) {
    s.status = status;
    assert.match(markup(s), spinner);
    assert.doesNotMatch(markup(s), /session-unread-dot/);
  }
  assert.match(markup(s), /等待确认/);
  s.status = 'error'; assert.match(markup(s), /对话未完成/); assert.doesNotMatch(markup(s), /session-unread-dot/); assert.doesNotMatch(markup(s), spinner);
  s.status = 'idle'; s.stoppedAt = new Date().toISOString(); assert.equal(markup(s), '');
  delete s.stoppedAt; s.completion.readAt = new Date().toISOString(); assert.equal(markup(s), '');
  delete s.completion.readAt; s.closedAt = new Date().toISOString(); assert.equal(markup(s), '');
});

for (const provider of ['codex', 'cursor'] as const) test(provider + ': completion and read state survive restart; stale reads, failure and stop cannot acknowledge a new reply', () => withWorkbench(async (wb, root) => {
  const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  wb.store.settings.providerPaths[provider] = fixture.launcher;
  const s = await wb.createSession(provider, root, offlineProjectId);
  await wb.send(s.id, 'first'); await until(() => !!s.completion);
  const first = s.completion!.id;
  assert(hasUnreadCompletion(s));
  await wb.store.save();
  const unreadStore = new Store(wb.store.root); await unreadStore.init();
  assert(hasUnreadCompletion(unreadStore.sessions.find(item => item.id === s.id)!));
  assert.equal(await wb.readSessionCompletion(s.id, first), true);
  assert(!hasUnreadCompletion(s));
  const readStore = new Store(wb.store.root); await readStore.init();
  assert(!hasUnreadCompletion(readStore.sessions.find(item => item.id === s.id)!));

  await wb.send(s.id, 'second'); await until(() => s.completion!.id !== first);
  const second = s.completion!.id;
  assert.equal(await wb.readSessionCompletion(s.id, first), false);
  assert(hasUnreadCompletion(s), 'a read from an old UI snapshot must leave the new completion unread');

  await fixture.write({ status: 'ready', turn: 'network' });
  await wb.send(s.id, 'fails'); await until(() => s.status === 'error');
  assert.equal(s.completion!.id, second); assert(!hasUnreadCompletion(s));
  await fixture.write({ status: 'ready', turn: 'hang' });
  const pending = wb.send(s.id, 'stop this turn');
  await until(() => s.status === 'running');
  await wb.stop(s.id); await pending;
  assert.equal(s.completion!.id, second); assert(!hasUnreadCompletion(s));
}));

test('Claude remains spinning during approvals and only marks successful completion unread', () => withWorkbench(async (wb, root) => {
  wb.store.settings.providerPaths.claude = path.resolve('tests/fixtures/claude-cli.cjs');
  const s = await wb.createSession('claude', root, offlineProjectId, 'work', undefined, undefined, 'review');
  const pending = wb.send(s.id, 'first');
  await until(() => s.approvals.length > 0);
  assert.match(markup(s), spinner); assert.equal(s.completion, undefined);
  await wb.answer(s.id, s.approvals[0].id, 'accept');
  await until(() => !!s.approvals[0]?.questions?.length);
  assert.match(markup(s), /等待确认/); assert.equal(s.completion, undefined);
  await wb.answer(s.id, s.approvals[0].id, 'answer', { '0': 'B' });
  await pending; await until(() => !!s.completion);
  assert(hasUnreadCompletion(s));
  await wb.readSessionCompletion(s.id, s.completion!.id); assert(!hasUnreadCompletion(s));
}));

test('reading one session is isolated by session/account and a failed save stays retryable', () => withWorkbench(async (wb, root) => {
  const first = await wb.createSession('codex', root, offlineProjectId), second = await wb.createSession('cursor', root, offlineProjectId);
  first.completion = { id: randomUUID() }; second.completion = { id: randomUUID() };
  const save = wb.store.save.bind(wb.store);
  wb.store.save = async () => { throw new Error('fixture disk unavailable'); };
  await assert.rejects(wb.readSessionCompletion(first.id, first.completion.id), /disk unavailable/);
  assert(hasUnreadCompletion(first));
  wb.store.save = save;
  await wb.readSessionCompletion(first.id, first.completion.id);
  assert(!hasUnreadCompletion(first)); assert(hasUnreadCompletion(second));
  second.binding = { ...second.binding!, username: 'another-account' };
  await assert.rejects(wb.readSessionCompletion(second.id, second.completion.id), /不属于当前账号/);
  assert(hasUnreadCompletion(second));
}));

test('only a visible foreground conversation acknowledges a completion, once; changing views stops observation', async () => {
  let focused = false, reads = 0, release!: () => void;
  const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' as DocumentVisibilityState, hasFocus: () => focused });
  const host = new EventTarget();
  const stop = observeVisibleCompletion(() => { reads++; return new Promise<void>(resolve => { release = resolve; }); }, assert.fail, page, host);
  assert.equal(reads, 0);
  page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(reads, 0, 'a background window must leave the dot unread');
  focused = true; host.dispatchEvent(new Event('focus')); host.dispatchEvent(new Event('focus'));
  assert.equal(reads, 1, 'pending reads are deduplicated');
  release(); await new Promise(resolve => setImmediate(resolve));
  host.dispatchEvent(new Event('focus')); assert.equal(reads, 1);
  stop();
  focused = false;
  const stopNext = observeVisibleCompletion(async () => { reads++; }, assert.fail, page, host);
  stopNext(); focused = true; host.dispatchEvent(new Event('focus'));
  assert.equal(reads, 1, 'a previously selected session must not be read from another page');
});

test('read persistence failures report once and retry when the conversation is revisited', async () => {
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState, hasFocus: () => true });
  const host = new EventTarget();
  let attempts = 0, errors = 0;
  const stop = observeVisibleCompletion(async () => { if (++attempts === 1) throw new Error('unavailable'); }, () => { errors++; }, page, host);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors, 1); assert.equal(attempts, 1);
  host.dispatchEvent(new Event('focus')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2); assert.equal(errors, 1);
  stop();
});
