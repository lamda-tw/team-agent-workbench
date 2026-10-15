import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { freezeFile } from '../src/core/artifacts';
import { acceptedSessionContext } from '../src/shared/session-context';
import type { AgentSession, SessionInput, WorkbenchAPI } from '../src/shared/types';
import { ComposerActions, composerMode } from '../src/renderer/composer-actions';
import { submitComposerInput } from '../src/renderer/composer-input';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Shared fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const until = async (fn: () => boolean) => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw new Error('steering test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
async function setup(state: Record<string, unknown> = {}, provider: 'codex' | 'cursor' = 'codex') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-steering-'));
  const config = { status: 'ready', turn: 'hang', ...state };
  const fixture = await authLauncher(path.join(root, 'cli'), config);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths[provider] = fixture.launcher;
  const s = await wb.createSession(provider, root, offlineProjectId); s.autoUpload = false;
  const calls = async () => (await fs.readFile(path.join(root, 'cli/rpc-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, wb, s, calls, set: (next: Record<string, unknown>) => fixture.write({ ...config, ...next }),
    cleanup: async () => { await wb.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-steering-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } };
}

test('Codex steer uses the same active turn, includes newly selected context/capabilities, and persists accepted history', async () => {
  const t = await setup();
  try {
    const { wb, s } = t;
    await wb.send(s.id, '原始任务'); assert.equal(wb.snapshot().activeTurns?.[s.id], 'fake-turn');
    const file = path.join(t.root, '参考.md'); await fs.writeFile(file, '保持主路径不变');
    const source = await freezeFile(file, path.join(t.root, 'sources')); s.sources.push(source);
    const catalog = await wb.capabilities(s.id), skill = catalog.skills[0], plugin = catalog.plugins[0];
    await wb.steer(s.id, 'fake-turn', '先检查测试', [source.id], [skill, plugin]);
    assert.equal(s.status, 'running'); assert.equal(s.nativeId, 'fake-thread');
    const message = s.messages.find(m => m.steering)!;
    assert.equal(message.userText, '先检查测试'); assert.equal(message.context?.accepted, true);
    assert.equal(acceptedSessionContext(s).sourceHashes[source.id], source.sha256);
    assert(s.messages.indexOf(message) < s.messages.findIndex(m => m.text === '收到补充要求。'));
    const calls = await t.calls(), steer = calls.find(m => m.method === 'turn/steer');
    assert.deepEqual(Object.keys(steer.params).sort(), ['expectedTurnId', 'input', 'threadId']);
    assert.equal(steer.params.expectedTurnId, 'fake-turn'); assert.equal(steer.params.threadId, 'fake-thread');
    assert(steer.params.input[0].text.includes(source.sha256));
    assert.deepEqual(steer.params.input.slice(1).map((item: any) => item.type), ['skill', 'mention']);
    assert.equal(calls.filter(m => m.method === 'turn/start').length, 1);
    assert.equal(calls.filter(m => m.method === 'turn/interrupt').length, 0);
    await wb.steer(s.id, 'fake-turn', '继续', [source.id]);
    assert.equal((await t.calls()).filter(m => m.method === 'turn/steer').at(-1).params.input[0].text, '继续');
    await wb.close(); const restored = new Store(wb.store.root); await restored.init();
    assert.deepEqual(restored.sessions[0].messages, s.messages);
    assert.deepEqual(wb.snapshot().activeTurns, {}, 'runtime turn IDs are never restored from disk');
  } finally { await t.cleanup(); }
});

test('stale/rejected/unsupported steering never fails the running task, accepts references, or starts another turn', async () => {
  const t = await setup();
  try {
    const { wb, s } = t; await wb.send(s.id, '原始任务');
    const input = { text: '保留我的引导', sourceIds: [], answers: {} }; await wb.saveInput(s.id, input);
    await assert.rejects(wb.steer(s.id, 'old-turn', input.text), /轮次已结束或发生变化/);
    await assert.rejects(wb.steer(s.id, 'fake-turn', input.text, ['foreign-source']), /不属于当前会话/);
    const file = path.join(t.root, 'context.md'); await fs.writeFile(file, 'reference');
    const source = await freezeFile(file, path.join(t.root, 'sources')); s.sources.push(source);
    const original = await fs.readFile(source.localPath); await fs.writeFile(source.localPath, 'changed');
    await assert.rejects(wb.steer(s.id, 'fake-turn', input.text, [source.id]), /快照已改变/);
    await fs.writeFile(source.localPath, original);
    for (const [steer, error] of [['reject', /No matching active turn/], ['unsupported', /更新 Codex CLI/], ['wrong-turn', /未能确认引导送达/]] as const) {
      await t.set({ steer }); await assert.rejects(wb.steer(s.id, 'fake-turn', input.text, [source.id]), error);
      assert.equal(s.status, 'running'); assert.equal(s.error, undefined); assert.equal(s.messages.filter(m => m.steering).length, 0);
      assert.equal(acceptedSessionContext(s).sourceHashes[source.id], undefined); assert.deepEqual(wb.store.inputs[s.id], input);
    }
    assert.equal((await t.calls()).filter(m => m.method === 'turn/start').length, 1);
    await t.set({ steer: 'finish-reject' }); await assert.rejects(wb.steer(s.id, 'fake-turn', input.text), /No matching active turn/);
    assert.equal(s.status, 'idle'); assert.equal(s.error, undefined); assert.equal(wb.snapshot().activeTurns?.[s.id], undefined);
    await assert.rejects(wb.steer(s.id, 'fake-turn', input.text), /轮次已结束或发生变化/);
  } finally { await t.cleanup(); }
});

test('steering during approval retains approvals; repeated clicks are rejected; a late acceptance cannot revive a completed turn', async () => {
  const t = await setup({ toolApproval: true, steerDelay: 100 });
  try {
    const { wb, s } = t; await wb.send(s.id, '原始任务'); await until(() => s.status === 'approval');
    const approvals = structuredClone(s.approvals);
    const first = wb.steer(s.id, 'fake-turn', '补充要求');
    await assert.rejects(wb.steer(s.id, 'fake-turn', '重复点击'), /上一条引导正在发送/);
    await first; assert.equal(s.status, 'approval'); assert.deepEqual(s.approvals, approvals);
    assert.equal((await t.calls()).filter(m => m.method === 'turn/steer').length, 1);
    wb.answer(s.id, approvals[0].id, 'decline'); await until(() => s.status === 'idle');
    await t.set({ toolApproval: false, turnId: 'second-turn', steer: 'finish-accept' });
    await wb.send(s.id, '下一轮'); await wb.steer(s.id, 'second-turn', '最后补充');
    assert.equal(s.status, 'idle'); assert.equal(wb.snapshot().activeTurns?.[s.id], undefined);
    assert.equal(s.messages.filter(m => m.steering).length, 2);
  } finally { await t.cleanup(); }
});

test('stop while preparing or awaiting steering keeps input and cannot send to a resumed turn', async () => {
  const t = await setup({ steer: 'hang' });
  try {
    const { wb, s } = t; await wb.send(s.id, '原始任务'); await wb.saveInput(s.id, { text: '待发送的要求', sourceIds: [], answers: {} });
    const runtime = (wb as any).runtimes.get(s.id);
    let release!: () => void, resolving = false;
    runtime.resolveCapabilities = async () => { resolving = true; await new Promise<void>(resolve => { release = resolve; }); return []; };
    const pending = wb.steer(s.id, 'fake-turn', '待发送的要求');
    const rejection = assert.rejects(pending, /会话已关闭或正在停止/);
    await until(() => resolving); await wb.stop(s.id); release(); await rejection;
    assert.equal((await t.calls()).filter(m => m.method === 'turn/steer').length, 0);
    await t.set({ turnId: 'resumed-turn', steer: 'hang' }); await wb.send(s.id, '继续');
    await assert.rejects(wb.steer(s.id, 'fake-turn', '旧界面的引导'), /轮次已结束或发生变化/);
    const inFlight = wb.steer(s.id, 'resumed-turn', '待发送的要求');
    const closed = assert.rejects(inFlight, /未能确认引导是否送达/);
    await until(() => (wb as any).runtimes.get(s.id)?.steering === true);
    await wb.stop(s.id); await closed;
    assert.equal(s.status, 'idle'); assert.equal(s.messages.filter(m => m.steering).length, 0);
    assert.equal(wb.store.inputs[s.id].text, '待发送的要求');
    await wb.closeSession(s.id); await assert.rejects(wb.steer(s.id, 'resumed-turn', '已关闭'), /会话已关闭/);
  } finally { await t.cleanup(); }
});

test('Cursor does not send a concurrent prompt or present unsupported steering as accepted', async () => {
  const t = await setup({}, 'cursor');
  try {
    const { wb, s } = t;
    const running = wb.send(s.id, '原始任务'); await until(() => s.status === 'running');
    await assert.rejects(wb.steer(s.id, 'fake-turn', '补充要求'), /Cursor 接入暂不支持/);
    assert.equal(wb.snapshot().activeTurns?.[s.id], undefined);
    assert.equal((await t.calls()).filter(m => m.method === 'turn/steer').length, 0);
    await wb.stop(s.id); await running;
  } finally { await t.cleanup(); }
});

test('composer renders steer and stop together only for a ready Codex turn, without opening windows', () => {
  const s = { provider: 'codex', status: 'running' } as AgentSession;
  const render = (session: AgentSession, activeTurnId?: string, busy = false, text = '追加要求') => renderToStaticMarkup(createElement(ComposerActions, { session, activeTurnId, busy, text, send: () => {}, stop: () => {} }));
  const html = render(s, 'turn'); assert.match(html, /aria-label="引导当前任务"/); assert.match(html, /aria-label="停止当前任务"/); assert.doesNotMatch(html, /disabled=""|aria-label="发送任务"/);
  for (const [session, id, busy, text] of [[s, undefined, false, '要求'], [s, 'turn', true, '要求'], [s, 'turn', false, '  '], [{ ...s, status: 'starting' }, 'turn', false, '要求']] as const) assert.match(render(session as AgentSession, id, busy, text), /disabled=""/);
  assert.equal(composerMode({ ...s, status: 'approval' }, 'turn'), 'steer');
  assert.equal(composerMode({ ...s, status: 'idle' }, 'old-turn'), 'send');
  assert.equal(composerMode({ ...s, provider: 'cursor' }, 'turn'), 'wait');
  assert.doesNotMatch(render({ ...s, provider: 'cursor' }, 'turn'), /引导当前任务|发送任务/);
  assert.equal(render({ ...s, closedAt: 'closed' }, 'turn'), '');
  assert.match(render({ ...s, status: 'idle' }), /aria-label="发送任务"/);
  assert.doesNotMatch(render({ ...s, status: 'idle' }), /继续对话/);
  const paused = renderToStaticMarkup(createElement(ComposerActions, { session: { ...s, status: 'idle', stoppedAt: '2026-10-15T00:00:00Z' }, text: '', busy: false, send: () => {}, stop: () => {}, resume: () => {} }));
  assert.match(paused, /aria-label="继续对话"/);
  assert.match(paused, /从停下的地方继续这次对话/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ComposerActions, { session: { ...s, status: 'running', stoppedAt: '2026-10-15T00:00:00Z' }, activeTurnId: 'turn', text: '要求', busy: false, send: () => {}, stop: () => {}, resume: () => {} })), /继续对话/);
});

test('composer waits for acceptance, retains failures/new edits, and clears only the originating session draft', async () => {
  const sent: SessionInput = { text: '追加要求', sourceIds: ['source'], answers: {}, capabilities: [] };
  for (const change of ['none', 'text', 'source', 'capability', 'reject'] as const) {
    let resolve!: (value: boolean) => void, reject!: (error: Error) => void;
    const calls: any[] = [], cleared: string[] = []; let latest = structuredClone(sent);
    const api = { call: (action: string, payload: unknown) => { calls.push({ action, payload }); return new Promise<boolean>((yes, no) => { resolve = yes; reject = no; }); } } as WorkbenchAPI;
    const pending = submitComposerInput(api, 'original-session', sent, 'turn-1', () => latest, id => cleared.push(id));
    assert.equal(calls[0].action, 'session.steer'); assert.equal(calls[0].payload.expectedTurnId, 'turn-1'); assert.deepEqual(cleared, []);
    if (change === 'text') latest.text = '等待时继续输入';
    if (change === 'source') latest.sourceIds.push('another');
    if (change === 'capability') latest.capabilities = [{ id: 'new', name: 'new', kind: 'skill' }];
    if (change === 'reject') { reject(new Error('未送达')); await assert.rejects(pending, /未送达/); }
    else { resolve(true); await pending; }
    assert.deepEqual(cleared, change === 'none' ? ['original-session'] : []);
    assert.equal(calls.length, 1, 'never fall back to turn/start or retry automatically');
  }
});
