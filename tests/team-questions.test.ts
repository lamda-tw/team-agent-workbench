import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { Questions } from '../src/core/questions';
import { memberProfile } from './fixtures/member-profile';
import { changeQuestion, questionView, type TeamQuestion, type QuestionCommand, type QuestionMember } from '../src/shared/questions';
import { QuestionDetail, QuestionCard, questionUnread } from '../src/renderer/team-questions';
import type { AgentSession } from '../src/shared/types';
// @ts-expect-error Shared background CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const members: QuestionMember[] = ['alice', 'bob', 'carol', 'dave'].map(username => ({ username, name: username }));
const projectId = 'project_' + 'a'.repeat(32);
const create = () => ({ kind: 'create' as const, id: randomUUID(), sessionId: randomUUID(), title: '验收口径', body: '需要使用哪一版数据？', context: '任务 A', recipients: ['bob', 'carol'] });
const mutate = (items: TeamQuestion[], username: string, command: QuestionCommand) => changeQuestion(items, projectId, members.find(m => m.username === username)!, members, command, new Date().toISOString());

test('question permissions, append-only replies, retry deduplication, explicit closure and recipient privacy', () => {
  const items: TeamQuestion[] = [], input = create();
  const q = mutate(items, 'alice', input);
  assert.equal(mutate(items, 'alice', input).id, q.id); assert.equal(items.length, 1);
  assert.throws(() => mutate(items, 'alice', { ...input, title: 'changed' }), /编号/);
  assert.throws(() => mutate(items, 'alice', { ...create(), recipients: ['outside'] }), /其他有效成员/);
  assert.throws(() => mutate(items, 'alice', { ...create(), recipients: ['alice'] }), /其他有效成员/);
  assert.equal(questionView(q, 'dave'), undefined);
  assert.throws(() => mutate(items, 'bob', { kind: 'close', id: q.id }), /发问人/);
  const runs = new Map<string, string>(), sessions = new Map<string, string>();
  for (const username of ['bob', 'carol']) {
    const sessionId = randomUUID(), runId = randomUUID(); runs.set(username, runId); sessions.set(username, sessionId);
    mutate(items, username, { kind: 'link', id: q.id, sessionId });
    mutate(items, username, { kind: 'run', id: q.id, sessionId, runId });
    assert.equal(q.activityRevision, 1, 'internal progress must not create unread dynamics');
    assert.throws(() => mutate(items, username, { kind: 'run', id: q.id, sessionId, runId: randomUUID() }), /其他窗口/);
  }
  mutate(items, 'bob', { kind: 'reply', id: q.id, runId: runs.get('bob')!, body: 'bob answer' });
  assert.equal(questionView(q, 'carol')!.activityRevision, 1, 'another recipient answer does not create a private unread event');
  mutate(items, 'carol', { kind: 'reply', id: q.id, runId: runs.get('carol')!, body: 'carol answer' });
  assert.equal(q.closedAt, undefined, 'even all replies leave the question open');
  assert.equal(q.recipients.flatMap(r => r.answers).length, 2);
  const view = questionView(q, 'bob')!;
  assert.equal(view.sessionId, ''); assert.deepEqual(view.recipients.map(r => r.username), ['bob']);
  assert(!JSON.stringify(view).includes('carol answer'));
  const revision = q.revision;
  mutate(items, 'bob', { kind: 'reply', id: q.id, runId: runs.get('bob')!, body: 'bob answer' });
  assert.equal(q.revision, revision);
  mutate(items, 'alice', { kind: 'close', id: q.id });
  assert.equal(q.activityRevision, q.revision);
  assert.equal(q.recipients[0].sessionId, sessions.get('bob'), 'closing a question preserves its Session link');
  mutate(items, 'bob', { kind: 'reply', id: q.id, runId: runs.get('bob')!, body: 'bob answer' });
  assert.throws(() => mutate(items, 'carol', { kind: 'reply', id: q.id, runId: randomUUID(), body: 'too late' }), /已关闭/);
  assert.throws(() => mutate(items, 'carol', { kind: 'link', id: q.id, sessionId: randomUUID() }), /已关闭/);
});

async function fixture(run: (value: { alice: Workbench; bob: Workbench; carol: Workbench; dave: Workbench; project: string; root: string; admin: LocalAdminConnection }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-member-questions-')), share = path.join(root, 'share'); await fs.mkdir(share);
  const admin = new LocalAdminConnection(() => {}), clients: Workbench[] = [];
  try {
    await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: 'research' });
    for (const name of ['alice', 'bob', 'carol', 'dave']) await admin.operation({ op: 'user_create', username: name, name, password: '1', groups: ['local_research'], contentAdminGroups: name === 'alice' ? ['local_research'] : [] });
    const connect = async (name: string) => { const wb = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '1', root, async () => false); return wb; };
    const alice = await connect('alice');
    const project = await alice.createProject('问答验证', 'local_research', { background: '项目背景', objectives: '目标', acceptance: '验收', scope: '', deliverables: '', resources: '', constraints: '', collaboration: '' });
    const bob = await connect('bob'), carol = await connect('carol'), dave = await connect('dave');
    await run({ alice, bob, carol, dave, project: project.id, root, admin });
  } finally { for (const wb of clients) await wb.close(); admin.disconnect(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-member-questions-'))); await fs.rm(root, { recursive: true, force: true, maxRetries: 8 }); }
}
function newSession(wb: Workbench, project: string) {
  const id = randomUUID();
  const s: AgentSession = { id, title: '测试 Session', provider: 'codex', purpose: 'work', cwd: wb.store.root, createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], binding: wb.remote.binding(project), autoUpload: true, handoffPath: path.join(wb.store.sessionDir(id), 'handoff.md') };
  wb.store.sessions.push(s); return s;
}
const until = async (check: () => boolean) => { for (let n = 0; !check(); n++) { if (n > 300) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('real local storage serializes simultaneous recipients and enforces fresh membership', () => fixture(async ({ alice, bob, carol, dave, project, admin }) => {
  const ask = newSession(alice, project), q = await alice.questions.create(ask.id, create());
  const request = (wb: Workbench, command?: QuestionCommand) => wb.remote.questionRequest(wb.remote.binding(project), command);
  assert.equal((await bob.questions.members(project) as QuestionMember[]).length, 3, 'ordinary members can ask');
  assert.deepEqual(await request(dave), []);
  await assert.rejects(request(dave, { kind: 'close', id: q.id }), /无权/);
  const replies = [bob, carol].map(wb => ({ wb, sessionId: randomUUID(), runId: randomUUID() }));
  await Promise.all(replies.map(async ({ wb, sessionId, runId }) => {
    await request(wb, { kind: 'link', id: q.id, sessionId });
    await request(wb, { kind: 'run', id: q.id, sessionId, runId });
    await request(wb, { kind: 'reply', id: q.id, runId, body: wb.remote.profile!.username + ' reply' });
  }));
  const all = await request(alice) as TeamQuestion[];
  assert.deepEqual(all[0].recipients.map(r => r.answers.length), [1, 1]);
  assert.equal((await request(bob) as TeamQuestion[])[0].recipients.length, 1);
  await alice.questions.closeQuestion(project, q.id);
  await Promise.all(replies.map(({ wb, sessionId }) => assert.rejects(request(wb, { kind: 'link', id: q.id, sessionId }), /已关闭/)));
  await admin.operation({ op: 'user_enabled', username: 'bob', enabled: false });
  await assert.rejects(request(bob), /禁用|停用|不可用/);
}));

test('queued answers run one per Session, survive lost reply receipts, and closure never stops Sessions', () => fixture(async ({ alice, bob, project }) => {
  const ask = newSession(alice, project), responder = newSession(bob, project), notices: string[] = [], started: string[] = [];
  bob.questions = new Questions(bob.store, bob.remote, { profile: () => bob.remote.profile, session: id => bob.session(id), changed: () => {}, notice: text => notices.push(text), send: async (id, text, runId) => {
    started.push(runId); const s = bob.session(id); s.status = 'running';
    s.messages.push({ id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString(), context: { nativeId: 'test', accepted: true, workRecord: false, sourceHashes: {}, questionRunId: runId } }); return true;
  } });
  const finish = async (text: string) => { responder.messages.push({ id: randomUUID(), role: 'assistant', text, createdAt: new Date().toISOString() }); responder.status = 'idle'; await bob.questions.completed(responder); };
  const first = await alice.questions.create(ask.id, create()), second = await alice.questions.create(ask.id, create());
  await bob.questions.sync(); assert.equal(notices.length, 2);
  responder.status = 'running'; await bob.questions.link(project, first.id, responder.id); await bob.questions.link(project, second.id, responder.id);
  await bob.questions.sync(); assert.equal(started.length, 0, 'busy Session queues instead of injecting');
  responder.status = 'idle'; await bob.questions.sync(); await until(() => started.length === 1);
  await bob.questions.sync(); assert.equal(started.length, 1); assert.equal(notices.length, 2, 'progress changes do not re-notify');
  const original = bob.remote.questionRequest.bind(bob.remote); let loseReply = true;
  bob.remote.questionRequest = async (binding, command) => { const result = await original(binding, command); if (typeof command === 'object' && command.kind === 'reply' && loseReply) { loseReply = false; throw new Error('lost receipt'); } return result; };
  await finish('已核实，请使用 v2 数据。'); await bob.questions.sync(); await bob.questions.sync();
  await until(() => started.length === 2); await bob.questions.sync();
  assert.equal(bob.questions.view().jobs[0].phase, 'sent');
  await alice.questions.sync(); const received = alice.questions.view().items.find(q => q.id === first.id)!;
  assert.equal(received.recipients[0].answers.length, 1, 'lost acknowledgement never duplicates an answer');
  assert.equal(responder.autoUpload, false);
  const reference = ask.sources.find(s => s.sourcePath === 'question:' + first.id)!;
  assert.match(await fs.readFile(reference.localPath, 'utf8'), /v2 数据/);
  assert((await (alice as any).availableSessionContext(ask, '继续', [])).sources.some((s: any) => s.id === reference.id));
  await alice.questions.closeQuestion(project, second.id); await bob.questions.sync();
  assert.equal(responder.status, 'running'); assert.equal(responder.closedAt, undefined);
  await finish('关闭后完成的本地结果'); await bob.questions.sync();
  assert.equal(bob.questions.view().jobs[1].phase, 'closed');
  assert.equal(bob.questions.view().items.find(q => q.id === second.id)!.recipients[0].answers.length, 0);
  assert(responder.messages.some(m => m.text === '关闭后完成的本地结果'));
  assert(notices.some(n => n.startsWith('问题已关闭：')));
  await bob.questions.read(second.id, 1);
  assert(questionUnread(bob.questions.view().items.find(q => q.id === second.id)!, bob.questions.view()), 'old read receipt cannot clear closure');
  await bob.questions.read(second.id, bob.questions.view().items.find(q => q.id === second.id)!.activityRevision);
  const restored = new Questions(bob.store, bob.remote, { profile: () => bob.remote.profile, session: id => bob.session(id), changed: () => {}, notice: () => {}, send: async () => { throw new Error('must not resend'); } });
  try { await restored.init(); assert.equal(restored.view().jobs[0].phase, 'sent'); assert.equal(restored.view().jobs[1].phase, 'closed'); await restored.sync(); } finally { await restored.close(); }
}));

test('closed question UI retains link and answers, removes answer and closure actions', () => {
  const items: TeamQuestion[] = [], q = mutate(items, 'alice', create()), sessionId = randomUUID();
  mutate(items, 'bob', { kind: 'link', id: q.id, sessionId }); mutate(items, 'alice', { kind: 'close', id: q.id });
  const session = { id: sessionId, title: '回答 Session', purpose: 'work', binding: { project: { id: projectId } } } as AgentSession;
  const inbox = { items, jobs: [], read: {} };
  const recipient = renderToStaticMarkup(React.createElement(QuestionDetail, { question: questionView(q, 'bob')!, inbox, username: 'bob', sessions: [session], changed: async () => {}, openSession: () => {} }));
  assert.match(recipient, /已关闭/); assert.match(recipient, /打开关联 Session/); assert.match(recipient, /手动关闭/);
  assert.doesNotMatch(recipient, /关联并回答|回答 Session<\/option>|>关闭问题</);
  const card = renderToStaticMarkup(React.createElement(QuestionCard, { question: q, unread: true, open: () => {} }));
  assert.match(card, /已关闭/); assert.match(card, /有新动态/);
});

test('stopping a responder releases its claim; completion during account switching stays with its owner', () => fixture(async ({ alice, bob, project }) => {
  const ask = newSession(alice, project), responder = newSession(bob, project);
  let profile = bob.remote.profile, sends = 0;
  bob.questions = new Questions(bob.store, bob.remote, { profile: () => profile, session: id => bob.session(id), changed: () => {}, notice: () => {}, send: async (_id, text, runId) => {
    sends++; responder.status = 'running'; responder.messages.push({ id: randomUUID(), role: 'user', text, createdAt: '', context: { nativeId: 'test', accepted: true, workRecord: false, sourceHashes: {}, questionRunId: runId } }); return true;
  } });
  const q = await alice.questions.create(ask.id, create());
  await bob.questions.link(project, q.id, responder.id); await bob.questions.sync(); await until(() => sends === 1);
  await bob.stop(responder.id); await bob.questions.sync();
  assert.equal(bob.questions.view().jobs[0].phase, 'error');
  assert.equal(bob.questions.view().items[0].recipients[0].state, 'linked');
  responder.stoppedAt = undefined;
  await bob.questions.link(project, q.id, responder.id); await bob.questions.sync(); await until(() => sends === 2);
  profile = undefined;
  assert.deepEqual(bob.questions.view().items, []);
  responder.status = 'idle'; responder.messages.push({ id: randomUUID(), role: 'assistant', text: '账号切换期间完成的答复', createdAt: '' });
  await bob.questions.completed(responder); await bob.questions.sync();
  assert.deepEqual(bob.questions.view().jobs, []);
  profile = bob.remote.profile;
  assert.equal(bob.questions.view().jobs[1].phase, 'ready');
  await bob.questions.sync(); assert.equal(bob.questions.view().jobs[1].phase, 'sent');
  await alice.questions.sync(); assert.equal(alice.questions.view().items[0].recipients[0].answers.length, 1);
}));

test('Codex and Cursor protocol runtimes preserve question context and return completed answers', () => fixture(async ({ alice, bob, project, root }) => {
  const ask = newSession(alice, project);
  const cli = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success' });
  for (const provider of ['codex', 'cursor'] as const) {
    bob.store.settings.providerPaths[provider] = cli.launcher;
    const responder = await bob.createSession(provider, root, project);
    const q = await alice.questions.create(ask.id, create());
    await bob.questions.link(project, q.id, responder.id); await bob.questions.sync();
    await until(() => bob.questions.view().jobs.find(j => j.questionId === q.id)?.phase === 'ready' || bob.questions.view().jobs.find(j => j.questionId === q.id)?.phase === 'sent');
    await bob.questions.sync(); await alice.questions.sync();
    assert.equal(alice.questions.view().items.find(item => item.id === q.id)!.recipients[0].answers.length, 1);
    assert(responder.messages.some(m => m.role === 'user' && m.context?.questionRunId));
  }
}));
