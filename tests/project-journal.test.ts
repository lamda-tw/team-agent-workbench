import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import { journalDirectory } from '../src/core/project-journal';
import { textHash } from '../src/core/activity-assistant';
import { preparationSnapshot } from '../src/core/preparation-snapshot';
import type { AgentSession } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-project-journal-'));
  const wb = new Workbench(root, () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root);
  const prompts: any[] = [];
  wb.activity.runText = async (_session, prompt) => {
    const input = JSON.parse(prompt.split('\n').at(-1)!); prompts.push(input);
    return JSON.stringify({ summary: '本轮完成：' + input.delta.map((m: any) => m.text).join(' '), log: '完成本轮检查：' + input.delta[0].text.slice(0, 30) });
  };
  wb.activity.setProject('window', offlineProjectId);
  const create = async (provider: 'codex' | 'cursor' = 'codex') => {
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd);
    return wb.createSession(provider, cwd, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
  };
  return { root, wb, prompts, create, close: async () => { await wb.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
function round(s: AgentSession, text: string, steering = false) {
  const turnId = randomUUID(), at = new Date().toISOString();
  s.messages.push({ id: turnId, role: 'user', text, createdAt: at }, ...(steering ? [{ id: randomUUID(), role: 'user' as const, steering: true, text: '补充约束', createdAt: at }] : []), { id: randomUUID(), role: 'assistant', text: '已检查，验证通过。', createdAt: at });
  return turnId;
}
function accept(s: AgentSession, journal: NonNullable<Awaited<ReturnType<Workbench['journal']['context']>>>, accepted = true) {
  const input = sessionContext(s, '继续', [], journal);
  s.messages.push({ id: randomUUID(), role: 'user', text: input.text, userText: '继续', createdAt: new Date().toISOString(), context: { ...input.context, nativeId: s.nativeId!, accepted } });
}

test('worker serializes per-turn summary and log commits, caps each session at five, and survives restart', async () => {
  const x = await fixture();
  try {
    const a = await x.create(), b = await x.create('cursor'); const ids: string[] = [];
    for (let i = 0; i < 7; i++) { ids.push(round(a, '任务 ' + i, i === 2)); await x.wb.activity.tick(); }
    round(b, '另一个会话'); await x.wb.activity.tick();
    const view = await x.wb.projectJournal(a.id);
    assert(!view.text.includes(ids[0])); assert(!view.text.includes(ids[1]));
    for (const id of ids.slice(2)) assert.equal(view.text.split(id).length - 1, 1);
    assert(view.text.includes('另一个会话')); assert.equal(x.prompts.length, 8);
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 8, 'same turn never generates twice');
    assert.equal(x.prompts[2].delta.length, 3, 'steering is part of the original turn');
    const before = await x.wb.readHandoff(a.id); assert(before.includes('任务 6'));
    await x.wb.store.save(); await x.wb.close();
    const restored = new Workbench(x.root, () => {}, () => {}); await restored.store.init(); grantTestWorkspace(restored, x.root);
    try { assert.equal((await restored.projectJournal(a.id)).text, view.text); assert.equal(await restored.readHandoff(a.id), before); }
    finally { await restored.close(); }
  } finally { await x.close(); }
});

test('first full, accepted deltas only, native context reset, expiry and session removals', async () => {
  const x = await fixture();
  try {
    const a = await x.create(), b = await x.create('cursor'); b.nativeId = 'native-a';
    const firstId = round(a, '第一轮'); await x.wb.activity.tick();
    const first = (await x.wb.journal.context(b))!; assert.match(first.text, /首次全量/); assert(first.text.includes(firstId));
    accept(b, first, false); assert.match((await x.wb.journal.context(b))!.text, /首次全量/, 'failed send must not advance cursor');
    accept(b, first); assert.equal(await x.wb.journal.context(b), undefined);
    // Avoid the background scanner treating our synthetic receipt messages as actual rounds.
    b.handoffState = { messageCount: b.messages.length, hash: '', version: 0 }; b.closedAt = new Date().toISOString();
    for (let i = 0; i < 5; i++) { round(a, '后续 ' + i); await x.wb.activity.tick(); }
    b.closedAt = undefined;
    const delta = (await x.wb.journal.context(b))!; assert.match(delta.text, /增量更新/); assert.match(delta.text, /淘汰旧日志条目/); assert(!delta.text.includes('完成本轮检查：第一轮'));
    accept(b, delta); b.nativeId = 'native-b'; assert.match((await x.wb.journal.context(b))!.text, /首次全量/);
    b.nativeId = 'native-a';
    await x.wb.closeSession(a.id); await x.wb.deleteSession(a.id);
    const removal = (await x.wb.journal.context(b))!; assert(removal.text.includes('移除会话及其日志：' + a.id));
    assert(!(await x.wb.projectJournal(b.id)).text.includes(firstId));
    await assert.rejects(fs.stat(path.join(journalDirectory(b), a.id + '.md')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(x.root, 'project-journals', a.id + '.json')), { code: 'ENOENT' });
    assert.equal(await x.wb.journal.commit(a, '', 99, '迟到数据', { turnId: 'late', at: '', text: '迟到' }), false);
  } finally { await x.close(); }
});

test('cross-CLI references are local read-only copies; account/project scopes and changed copies are enforced', async () => {
  const x = await fixture();
  try {
    const a = await x.create(), b = await x.create('cursor'), foreign = await x.create();
    foreign.binding = { ...foreign.binding!, username: 'another-user' };
    round(a, '跨 CLI 检查'); await x.wb.activity.tick();
    const result = (await x.wb.journal.context(b))!;
    const copy = path.join(journalDirectory(b), a.id + '.md');
    assert(result.text.includes(copy)); assert(!result.text.includes(a.handoffPath)); assert(!result.text.includes(foreign.id));
    assert.equal(await fs.readFile(copy, 'utf8'), await x.wb.readHandoff(a.id));
    assert.equal((await fs.stat(copy)).mode & 0o222, 0, 'snapshot is stored read-only');
    await fs.chmod(copy, 0o600); await fs.writeFile(copy, '误改副本'); await x.wb.journal.context(b);
    assert.equal(await fs.readFile(copy, 'utf8'), await x.wb.readHandoff(a.id));
    assert(!(await x.wb.journal.context(foreign))!.text.includes(a.id));
  } finally { await x.close(); }
});

test('multiple queued rounds get one record each and failed generation retries without losing the round', async () => {
  const x = await fixture();
  try {
    const s = await x.create(); const a = round(s, '第一项'), b = round(s, '第二项');
    const original = x.wb.activity.runText; x.wb.activity.runText = async () => JSON.stringify({ summary: '有效摘要', log: '不合格\n日志' });
    await x.wb.activity.tick(); assert(s.handoffState?.error); assert(!(await x.wb.projectJournal(s.id)).text.includes(a));
    x.wb.activity.runText = original; delete s.handoffState!.retryAt; await x.wb.activity.tick();
    assert.equal(x.prompts.length, 0, 'a timer cannot retry a failed summary generation');
    const c = round(s, '第三项'); x.wb.activity.completed(s.id); await x.wb.activity.tick();
    assert.equal(x.prompts[0].turnId, a); assert(!x.prompts[0].delta.some((m: any) => m.text === '第二项'));
    await x.wb.activity.tick(); assert.equal(x.prompts[1].turnId, b);
    await x.wb.activity.tick(); assert.equal(x.prompts[2].turnId, c);
    const journal = await x.wb.projectJournal(s.id); assert(journal.text.includes(a) && journal.text.includes(b) && journal.text.includes(c));
  } finally { await x.close(); }
});

test('closing/deleting during generation discards its late log and summary', async () => {
  const x = await fixture();
  try {
    const s = await x.create(); round(s, '等待后台');
    let finish!: (value: string) => void;
    const started = new Promise<void>(resolve => { x.wb.activity.runText = async () => { resolve(); return new Promise<string>(r => { finish = r; }); }; });
    const task = x.wb.activity.tick(); await started;
    await x.wb.closeSession(s.id); await x.wb.deleteSession(s.id);
    finish(JSON.stringify({ summary: '迟到摘要', log: '迟到日志' })); await task;
    assert(!x.wb.store.sessions.some(value => value.id === s.id));
    await assert.rejects(fs.stat(path.join(x.root, 'project-journals', s.id + '.json')), { code: 'ENOENT' });
  } finally { await x.close(); }
});

test('concurrent commits and stale replay cannot duplicate or overwrite a committed round', async () => {
  const x = await fixture();
  try {
    const s = await x.create(), id = round(s, '并发任务');
    const before = textHash(await x.wb.readHandoff(s.id)), entry = { turnId: id, at: new Date().toISOString(), text: '完成并发检查。' };
    const results = await Promise.all([
      x.wb.journal.commit(s, before, s.messages.length, '摘要甲', entry),
      x.wb.journal.commit(s, before, s.messages.length, '摘要乙', entry),
    ]);
    assert.deepEqual(results, [true, false]); assert.equal(await x.wb.readHandoff(s.id), '摘要甲');
    assert.equal((await x.wb.projectJournal(s.id)).text.split(id).length - 1, 1);
    await x.wb.saveHandoff(s.id, '人工更正'); assert.equal(await x.wb.readHandoff(s.id), '人工更正');
    assert.equal(await x.wb.journal.commit(s, textHash('人工更正'), s.messages.length, '旧轮次重放', entry), false);
  } finally { await x.close(); }
});

test('durable journal repairs a interrupted handoff projection without replaying its turn', async () => {
  const x = await fixture(); let restored: Workbench | undefined;
  try {
    const s = await x.create(), before = await x.wb.readHandoff(s.id), id = round(s, '恢复事务'); await x.wb.activity.tick();
    const after = await x.wb.readHandoff(s.id); await x.wb.store.save(); await x.wb.close();
    // Simulate exit after the canonical JSON transaction but before its two projections.
    await fs.writeFile(s.handoffPath, before);
    const filename = path.join(x.root, 'sessions.json'); const saved = JSON.parse(await fs.readFile(filename, 'utf8')); delete saved[0].handoffState; await fs.writeFile(filename, JSON.stringify(saved));
    restored = new Workbench(x.root, () => {}, () => {}); await restored.store.init(); grantTestWorkspace(restored, x.root);
    await restored.journal.ready(); assert.equal(await restored.readHandoff(s.id), after);
    assert.equal(restored.store.sessions[0].handoffState!.messageCount, s.messages.length);
    assert.equal((await restored.projectJournal(s.id)).text.split(id).length - 1, 1);
  } finally { await restored?.close(); await x.close(); }
});

test('cross-directory snapshots reject junction escapes and automatic logs stay out of result preparation', async () => {
  const x = await fixture();
  try {
    const a = await x.create(), b = await x.create('cursor'); b.nativeId = 'cursor-native';
    round(a, '私人会话内容'); await x.wb.activity.tick();
    const journal = (await x.wb.journal.context(b))!; accept(b, journal);
    const directory = path.join(x.root, 'prepare'); await preparationSnapshot(b, directory);
    const conversation = JSON.parse(await fs.readFile(path.join(directory, 'conversation.json'), 'utf8'));
    assert.equal(conversation[0].text, '继续'); assert(!JSON.stringify(conversation).includes('私人会话内容'));
    const c = await x.create(), outside = path.join(x.root, 'outside'); await fs.mkdir(outside);
    const target = path.join(c.cwd, '.workbench', 'sessions', c.id, 'project-journal');
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(x.wb.journal.context(c), /符号链接/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await x.close(); }
});
