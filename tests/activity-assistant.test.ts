import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { textHash } from '../src/core/activity-assistant';
import { activityPending } from '../src/shared/activity-assistant';
import { accountIdentity } from '../src/shared/account-data';
import type { SharedContent } from '../src/shared/content';
import type { AgentSession, ContentUpdate } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const timestamp = new Date().toISOString();
const item = (title = '批处理实验'): SharedContent => ({ id: randomUUID(), title, description: '批大小增加后吞吐提升，但尾延迟增加。', revision: 1, category: 'exploration', kind: 'contribution', path: '/projects/test/result.md', author: 'bob', updatedBy: 'bob', state: 'submitted', createdAt: timestamp, updatedAt: timestamp, sha256: 'a'.repeat(64), size: 100 });
const event = (source: SharedContent): ContentUpdate => ({ eventId: `new:${source.id}:${source.revision}`, projectId: offlineProjectId, projectName: '测试项目', id: source.id, title: source.title, revision: source.revision, author: source.author, updatedBy: source.updatedBy, change: 'new', occurredAt: timestamp, detectedAt: timestamp });
const message = (text: string) => ({ id: randomUUID(), role: 'user' as const, text, createdAt: timestamp });

async function fixture(count = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-activity-assistant-'));
  const wb = new Workbench(root, () => {}, () => {}); await wb.store.init(); grantTestWorkspace(wb, root);
  const sessions: AgentSession[] = [];
  for (let i = 0; i < count; i++) {
    const s = await wb.createSession('codex', root, offlineProjectId); s.messages.push(message('原始私密完整对话不应进入匹配输入'));
    await wb.saveHandoff(s.id, `会话 ${i} 正在验证批处理延迟。`); s.handoffState!.messageCount = s.messages.length; sessions.push(s);
  }
  let connected = true;
  const profile = wb.store.settings.workspaceSnapshot!.profile;
  Object.defineProperty(wb.remote, 'connected', { get: () => connected });
  Object.defineProperty(wb.remote, 'profile', { get: () => profile });
  Object.defineProperty(wb.remote, 'workspaces', { get: () => wb.store.settings.workspaceSnapshot!.workspaces });
  wb.remote.binding = () => sessions[0].binding!;
  wb.remote.channel = () => undefined as any;
  const items: SharedContent[] = [];
  wb.remote.contentList = async () => structuredClone(items); wb.remote.contentHistory = async () => [];
  const prompts: string[] = [];
  wb.activity.runText = async (_s, prompt) => {
    prompts.push(prompt); const data = JSON.parse(prompt.split('\n').at(-1)!);
    return data.delta ? JSON.stringify({ summary: '当前目标：验证批处理延迟。新增结果已经记录。', log: '记录批处理延迟的新结论，待实验验证。' }) : JSON.stringify({ matches: data.sessions.flatMap((s: any) => s.eventIds.map((eventId: string) => ({ sessionId: s.sessionId, eventId, reason: '此结果补充了当前批处理延迟验证。', excerpt: data.updates.find((d: any) => d.eventId === eventId).body.slice(0, 12) }))) });
  };
  wb.activity.setProject('window-1', offlineProjectId);
  const owner = accountIdentity(profile);
  wb.activity.observe(offlineProjectId, owner, []);
  const add = (...values: SharedContent[]) => { items.push(...values); wb.activity.observe(offlineProjectId, owner, values.map(event)); };
  return { root, wb, sessions, items, prompts, owner, add, online: (value: boolean) => { connected = value; }, close: async () => { await wb.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-activity-assistant-'))); await fs.rm(root, { recursive: true, force: true }); } };
}

test('new activities match every open session; archive, ownership, baseline, duplicate and project boundaries are respected', { timeout: 5000 }, async () => {
  const x = await fixture(3);
  try {
    const [a, b, archived] = x.sessions; archived.closedAt = timestamp;
    x.wb.store.sessions.push({ ...a, id: randomUUID(), binding: { ...a.binding!, username: 'mallory' } });
    const own = { ...item(), updatedBy: 'alice' }; x.add(own);
    assert.equal(x.wb.store.activity.jobs.length, 0);
    const result = item(); x.add(result); x.wb.activity.observe(offlineProjectId, x.owner, [event(result)]);
    assert.deepEqual(new Set(x.wb.store.activity.jobs.map(j => j.sessionId)), new Set([a.id, b.id]));
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 1, JSON.stringify(x.wb.activity.view()));
    assert(!x.prompts[0].includes('原始私密完整对话'));
    assert(x.wb.store.activity.jobs.every(j => j.status === 'matched' && j.reason && j.excerpt));
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 1, 'unchanged activity does not invoke CLI again');
    const second = item(); second.revision = 2; x.add(second); await x.wb.activity.tick(); assert.equal(x.prompts.length, 2);
    x.wb.activity.setProject('window-1', 'another-project'); x.add(item()); assert.equal(x.wb.store.activity.jobs.length, 4);
    x.wb.store.activity.baselines = {}; x.wb.activity.setProject('window-1', offlineProjectId); x.add(item()); assert.equal(x.wb.store.activity.jobs.length, 4, 'first snapshot is only a baseline');
  } finally { await x.close(); }
});

test('main-process detection creates durable new-only work and parallel window scans coalesce', { timeout: 5000 }, async () => {
  const x = await fixture();
  try {
    x.wb.store.activity.baselines = {};
    const old = item(); x.items.push(old); await x.wb.syncContentUpdates(); assert.equal(x.wb.store.activity.jobs.length, 0);
    const fresh = item(); x.items.push(fresh);
    await Promise.all([x.wb.syncContentUpdates(), x.wb.syncContentUpdates()]); assert.equal(x.wb.store.activity.jobs.length, 2);
    const restored = new Store(x.root); await restored.init(); assert.equal(restored.activity.jobs.length, 2);
    await x.wb.activity.tick(); await x.wb.syncContentUpdates(); assert.equal(x.wb.store.activity.jobs.length, 2);
  } finally { await x.close(); }
});

test('summary is session-local, incrementally refreshed, and matching waits until the main round finishes', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const s = x.sessions[0]; s.messages.push(message('本轮新增结论')); s.status = 'running'; x.add(item());
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 0);
    s.status = 'idle'; await x.wb.activity.tick(); assert.equal(x.prompts.length, 2, JSON.stringify(x.wb.activity.view()));
    const summaryInput = JSON.parse(x.prompts[0].split('\n').at(-1)!);
    assert.equal(summaryInput.delta.length, 1); assert.equal(summaryInput.delta[0].text, '本轮新增结论');
    assert.equal(s.handoffState!.messageCount, s.messages.length);
    assert.equal(s.handoffState!.hash, textHash(await x.wb.readHandoff(s.id)));
    assert.equal(x.wb.store.activity.jobs[0].status, 'matched');
  } finally { await x.close(); }
});

test('late summary cannot overwrite manual corrections; optimistic edit conflict preserves the winning file', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const s = x.sessions[0], before = await x.wb.readHandoff(s.id); s.messages.push(message('追加'));
    let finish!: (text: string) => void; const started = new Promise<void>(resolve => { x.wb.activity.runText = async () => { resolve(); return new Promise<string>(r => { finish = r; }); }; });
    const job = x.wb.activity.tick(); await started;
    await x.wb.saveHandoff(s.id, '人工核对后的摘要', before); finish(JSON.stringify({ summary: '迟到的旧摘要', log: '迟到的日志。' })); await job;
    assert.equal(await x.wb.readHandoff(s.id), '人工核对后的摘要');
    await assert.rejects(x.wb.saveHandoff(s.id, '另一窗口旧编辑', before), /已更新/);
    assert.equal(await x.wb.readHandoff(s.id), '人工核对后的摘要');
  } finally { await x.close(); }
});

test('failed new activities wait for a new event or restored connection instead of retrying on a timer', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const value = item(); x.add(value); let calls = 0;
    x.wb.activity.runText = async (_s, prompt) => { calls++; const data = JSON.parse(prompt.split('\n').at(-1)!); return JSON.stringify({ matches: [{ sessionId: x.sessions[0].id, eventId: data.updates[0].eventId, reason: '有关', excerpt: '模型编造的原文' }] }); };
    await x.wb.activity.tick(); const job = x.wb.store.activity.jobs[0]; assert.equal(job.status, 'pending'); assert.match(job.error!, /非原文/);
    job.retryAt = 0; // An expired retry from an older build does not trigger work.
    x.wb.activity.observe(offlineProjectId, x.owner, [event(value)]);
    x.wb.activity.setProject('window-1', offlineProjectId);
    x.wb.activity.summaryChanged(x.sessions[0].id);
    for (let i = 0; i < 3; i++) await x.wb.activity.tick();
    assert.equal(calls, 1, 'repeated scans, ticks, project selection and summary updates do not rejudge failures');
    x.wb.activity.runText = async () => { calls++; throw new Error('模拟断线'); };
    x.add(item('真正的新动态')); await x.wb.activity.tick(); assert.equal(calls, 2); assert.match(job.error!, /模拟断线/);
    x.wb.activity.runText = async () => { calls++; return '{"matches":[]}'; };
    await x.wb.activity.tick(); assert.equal(calls, 2);
    x.online(false); await x.wb.activity.tick(); x.online(true); await x.wb.activity.tick();
    assert.equal(job.status, 'unrelated'); assert.equal(calls, 3);
    await x.wb.activity.tick(); assert.equal(calls, 3);
  } finally { await x.close(); }
});

test('archiving or changing conversation while CLI runs discards stale matching results', { timeout: 5000 }, async () => {
  const x = await fixture(2);
  try {
    x.add(item()); const normal = x.wb.activity.runText; let finish!: () => void;
    const started = new Promise<void>(resolve => { x.wb.activity.runText = async (s, p, signal) => { resolve(); await new Promise<void>(r => { finish = r; }); return normal(s, p, signal); }; });
    const job = x.wb.activity.tick(); await started;
    x.sessions[0].closedAt = timestamp; x.sessions[1].messages.push(message('新的任务方向')); finish(); await job;
    assert(x.wb.store.activity.jobs.every(j => j.status === 'pending'));
  } finally { await x.close(); }
});

test('attach-only, save-only and both are independent; other sessions retain their own notification decisions', { timeout: 5000 }, async () => {
  const x = await fixture(2);
  try {
    const first = item('第一条'), second = item('第二条'); x.add(first, second); await x.wb.activity.tick();
    const [a, b] = x.sessions, jobs = x.wb.store.activity.jobs.filter(j => j.sessionId === a.id);
    const result = await x.wb.applyActivity(a.id, [{ jobId: jobs[0].id, attach: true, save: false }, { jobId: jobs[1].id, attach: false, save: true }]);
    assert(result.every(r => !r.error)); assert.equal(a.sources.length, 1); assert.equal(x.wb.store.conclusions.length, 1);
    assert.equal(x.wb.store.conclusions[0].sources[0].id, second.id);
    assert.deepEqual(x.wb.store.inputs[a.id].sourceIds, [a.sources[0].id]);
    const others = x.wb.activityView().jobs.filter(j => j.sessionId === b.id); assert(others.every(activityPending)); assert(others[1].availableConclusionId);
    await x.wb.markActivity(a.id, [jobs[0].id], true); assert(!others[0].ignoredAt);
    const both = await x.wb.applyActivity(b.id, [{ jobId: others[0].id, attach: true, save: true }]); assert(both[0].sourceId && both[0].conclusionId);
    await x.wb.applyActivity(b.id, [{ jobId: others[0].id, attach: true, save: true }]); assert.equal(b.sources.length, 1); assert.equal(x.wb.store.conclusions.length, 2);
    assert.equal(x.wb.store.inputs[b.id].sourceIds.length, 1);
    await assert.rejects(x.wb.applyActivity(b.id, [{ jobId: jobs[1].id, attach: true, save: true }]), /不可用/);
  } finally { await x.close(); }
});

test('version changes reject adoption, partial success survives and retry never duplicates it', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const value = item(); x.add(value); await x.wb.activity.tick(); const s = x.sessions[0], job = x.wb.store.activity.jobs[0];
    const original = x.wb.importContentConclusion.bind(x.wb);
    x.wb.importContentConclusion = async () => { throw new Error('模拟存库失败'); };
    const first = (await x.wb.applyActivity(s.id, [{ jobId: job.id, attach: true, save: true }]))[0]; assert(first.sourceId); assert.match(first.error!, /存库失败/);
    x.wb.importContentConclusion = original;
    const retried = (await x.wb.applyActivity(s.id, [{ jobId: job.id, attach: true, save: true }]))[0]; assert(!retried.error); assert.equal(s.sources.length, 1);
    value.revision++;
    const stale = (await x.wb.applyActivity(s.id, [{ jobId: job.id, attach: true, save: true }]))[0]; assert.match(stale.error!, /版本已变化/); assert.equal(s.sources.length, 1);
  } finally { await x.close(); }
});

test('presented/ignored decisions persist, do not mark global activity read, and foreign accounts see no recommendations', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const value = item(); x.add(value); x.wb.store.settings.contentUpdates = [event(value)]; await x.wb.activity.tick();
    const s = x.sessions[0], job = x.wb.store.activity.jobs[0]; await x.wb.markActivity(s.id, [job.id]); assert(job.presentedAt); assert(!job.ignoredAt);
    await x.wb.markActivity(s.id, [job.id], true); assert(job.ignoredAt); assert(!x.wb.store.settings.contentUpdates[0].readAt);
    const store = new Store(x.root); await store.init(); assert(store.activity.jobs[0].ignoredAt);
    x.wb.store.settings.workspaceSnapshot!.profile.username = 'other';
    assert.equal(x.wb.snapshot().activity!.jobs.length, 0);
  } finally { await x.close(); }
});

test('completed recommendations survive summary changes and a broken summary does not block other sessions', { timeout: 5000 }, async () => {
  const x = await fixture(2);
  try {
    x.add(item()); await x.wb.activity.tick(); assert.equal(x.wb.activityView().jobs.length, 2);
    const [a, b] = x.sessions; a.messages.push(message('改变当前问题'));
    assert(x.wb.activityView().jobs.some(j => j.sessionId === a.id), 'completed judgments stay available without another model call');
    a.handoffPath = x.root; // Directory read fails, independently of the other session.
    x.add(item('新实验')); await x.wb.activity.tick();
    assert(a.handoffState?.error);
    assert(x.wb.store.activity.jobs.some(j => j.sessionId === b.id && j.event.title === '新实验' && j.status === 'matched'));
  } finally { await x.close(); }
});

test('an unavailable dynamic does not prevent matching other new dynamics in the batch', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const missing = { ...item('缺失原文'), files: { body: 'missing' as const, attachments: {} } }, available = item('可读原文');
    x.add(missing, available); await x.wb.activity.tick();
    assert.equal(x.wb.store.activity.jobs.find(j => j.event.id === missing.id)?.status, 'pending');
    assert.equal(x.wb.store.activity.jobs.find(j => j.event.id === available.id)?.status, 'matched');
  } finally { await x.close(); }
});

test('new rounds and edited summaries never rejudge old matches; only a new dynamic enters matching', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const s = x.sessions[0], old = item(); x.add(old); await x.wb.activity.tick();
    const judged = structuredClone(x.wb.store.activity.jobs[0]);
    await x.wb.saveHandoff(s.id, '更新后的工作范围'); await x.wb.activity.tick();
    assert.equal(x.prompts.length, 1); assert.deepEqual(x.wb.store.activity.jobs[0], judged);
    s.messages.push(message('新一轮完成')); x.wb.activity.completed(s.id); await x.wb.activity.tick();
    assert.equal(x.prompts.length, 2); assert(JSON.parse(x.prompts[1].split('\n').at(-1)!).delta);
    assert.equal(x.wb.activityView().jobs[0].id, judged.id);
    x.wb.activity.observe(offlineProjectId, x.owner, [event(old)]); await x.wb.activity.tick();
    assert.equal(x.prompts.length, 2);
    const fresh = item('新增结果'); x.add(fresh); await x.wb.activity.tick();
    const input = JSON.parse(x.prompts[2].split('\n').at(-1)!);
    assert.deepEqual(input.updates.map((update: any) => update.eventId), [event(fresh).eventId]);
    assert.deepEqual(x.wb.store.activity.jobs[0], judged);
  } finally { await x.close(); }
});

test('a restored source retries only its failed new dynamic, without creating a restoration recommendation', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const missing = { ...item('待恢复原文'), files: { body: 'missing' as const, attachments: {} } }, good = item('已有判断');
    x.add(missing, good); await x.wb.activity.tick();
    assert.equal(x.prompts.length, 1);
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 1);
    x.items[0].files = { body: 'ok', attachments: {} };
    const restored = { ...event(missing), eventId: 'restored-source', change: 'files_restored' as const };
    const normal = x.wb.activity.runText; let failures = 0;
    x.wb.activity.runText = async () => { failures++; throw new Error('恢复原文后 CLI 暂不可用'); };
    x.wb.activity.observe(offlineProjectId, x.owner, [restored]); await x.wb.activity.tick();
    x.wb.activity.observe(offlineProjectId, x.owner, [restored]); await x.wb.activity.tick();
    assert.equal(failures, 1, 'the same restoration event does not authorize repeated attempts');
    x.wb.activity.runText = normal;
    x.wb.activity.providerRecovered('codex', x.sessions[0].networkRoute, x.sessions[0].cwd);
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 2);
    const input = JSON.parse(x.prompts[1].split('\n').at(-1)!);
    assert.deepEqual(input.updates.map((update: any) => update.eventId), [event(missing).eventId]);
    assert.equal(x.wb.store.activity.jobs.length, 2); assert(x.wb.store.activity.jobs.every(job => job.status === 'matched'));
  } finally { await x.close(); }
});

test('summary failures recover on the matching provider service or next completed round, not a timer', { timeout: 5000 }, async () => {
  const x = await fixture(2);
  try {
    const [a, b] = x.sessions; b.provider = 'cursor';
    a.messages.push(message('第一项待记录')); b.messages.push(message('第二项待记录'));
    const normal = x.wb.activity.runText; let failures = 0;
    x.wb.activity.runText = async () => { failures++; throw new Error('服务暂不可用'); };
    await x.wb.activity.tick(); await x.wb.activity.tick();
    assert.equal(failures, 2); assert(a.handoffState?.error && b.handoffState?.error);
    a.handoffState.retryAt = 0; b.handoffState.retryAt = 0;
    await x.wb.activity.tick(); assert.equal(failures, 2);
    x.wb.activity.runText = normal;
    x.wb.activity.providerRecovered('cursor', 'management', b.cwd); await x.wb.activity.tick(); assert.equal(x.prompts.length, 0);
    x.wb.activity.providerRecovered('cursor', b.networkRoute, b.cwd); await x.wb.activity.tick();
    assert.equal(x.prompts.length, 1); assert(!b.handoffState.error); assert(a.handoffState.error);
    a.messages.push(message('第三项已完成')); x.wb.activity.completed(a.id); await x.wb.activity.tick(); await x.wb.activity.tick();
    assert(!a.handoffState.error); assert.equal(a.handoffState.messageCount, a.messages.length);
    assert.equal(x.wb.store.activity.jobs.length, 0, 'summary recovery never creates activity work');
  } finally { await x.close(); }
});

test('returning to a project resumes persisted pending work once without replaying successful judgments', { timeout: 5000 }, async () => {
  const x = await fixture(1);
  try {
    const old = item('已判断'); x.add(old); await x.wb.activity.tick();
    const normal = x.wb.activity.runText;
    x.wb.activity.runText = async () => { throw new Error('CLI 失败'); };
    const pending = item('失败待恢复'); x.add(pending); await x.wb.activity.tick();
    const stored = new Store(x.root); await stored.init();
    assert(stored.activity.jobs.find(j => j.event.id === pending.id)?.error);
    x.wb.store.activity = stored.activity; x.wb.activity.runText = normal;
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 1);
    x.wb.activity.removeWindow('window-1'); x.wb.activity.setProject('window-1', offlineProjectId);
    await x.wb.activity.tick(); assert.equal(x.prompts.length, 2);
    const input = JSON.parse(x.prompts[1].split('\n').at(-1)!);
    assert.deepEqual(input.updates.map((update: any) => update.eventId), [event(pending).eventId]);
    x.wb.activity.setProject('window-1', offlineProjectId); await x.wb.activity.tick(); assert.equal(x.prompts.length, 2);
  } finally { await x.close(); }
});
