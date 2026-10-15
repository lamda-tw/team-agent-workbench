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
import { fillFollowNotice, incomingQuestionNotice, incomingReplyNotice, sessionMessageText } from '../src/shared/session-context-text';
import { historyMarkdown } from '../src/core/artifacts';
import { QuestionDetail, QuestionCard, questionUnread } from '../src/renderer/team-questions';
import type { AgentSession } from '../src/shared/types';
// @ts-expect-error Shared background CLI fixture.
import { authLauncher } from './fixtures/auth-launcher.mjs';

const members: QuestionMember[] = ['alice', 'bob', 'carol', 'dave'].map(username => ({ username, name: username }));
const projectId = 'project_' + 'a'.repeat(32);
const create = () => ({ kind: 'create' as const, id: randomUUID(), sessionId: randomUUID(), title: '验收口径', body: '需要使用哪一版数据？', context: '任务 A', recipients: ['bob', 'carol'] });
const mutate = (items: TeamQuestion[], username: string, command: QuestionCommand) => changeQuestion(items, projectId, members.find(m => m.username === username)!, members, command, new Date().toISOString());

test('incoming question notice is hidden from the visible transcript and does not swallow later prose', () => {
  const session = { id: 's', provider: 'codex', title: 't', cwd: 'D:/test', purpose: 'work', createdAt: '', status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: 'D:/test/handoff.md' } as AgentSession;
  const notice = incomingQuestionNotice('李\n四」');
  assert.match(notice, /团队成员「李 四」发来的信息/);
  const visible = '问题：验收口径\n需要使用哪一版数据？\n\n附带资料：\n任务 A';
  assert.equal(sessionMessageText(session, { id: '1', role: 'user', text: notice + visible, createdAt: '' }), visible);
  const quoted = '请保留这段说明：' + notice;
  assert.equal(sessionMessageText(session, { id: '2', role: 'user', text: quoted, createdAt: '' }), quoted);
  assert.doesNotMatch(historyMarkdown({ ...session, messages: [{ id: '1', role: 'user', text: notice + visible, createdAt: '' }] }), /成员提问接入/);
  const reply = incomingReplyNotice('王五');
  assert.match(reply, /对同一提问的回复/);
  assert.equal(sessionMessageText(session, { id: '3', role: 'user', text: reply + '回复人：王五\n用 v2', createdAt: '' }), '回复人：王五\n用 v2');
  assert.doesNotMatch(historyMarkdown({ ...session, messages: [{ id: '3', role: 'user', text: reply + '回复人：王五\n用 v2', createdAt: '' }] }), /成员回复接入/);
  const draft = fillFollowNotice('bob');
  assert.match(draft, /起草继续提问/);
  assert.equal(sessionMessageText(session, { id: '4', role: 'user', text: draft + '问题：验收口径', createdAt: '' }), '问题：验收口径');
  const hidden = historyMarkdown({ ...session, messages: [
    { id: '4', role: 'user', text: draft + '问题：验收口径', createdAt: '', context: { nativeId: 'n', accepted: true, workRecord: false, sourceHashes: {}, questionFill: true } },
    { id: '5', role: 'assistant', text: '请补充样本', createdAt: '' },
    { id: '6', role: 'user', text: '继续看结果', createdAt: '' },
  ] });
  assert.doesNotMatch(hidden, /请补充样本|起草继续提问/);
  assert.match(hidden, /继续看结果/);
});

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
  const followId = randomUUID();
  mutate(items, 'alice', { kind: 'follow', id: q.id, followId, body: '请改成 v3' });
  assert.equal(q.followUps?.[0].body, '请改成 v3');
  assert.equal(mutate(items, 'alice', { kind: 'follow', id: q.id, followId, body: '请改成 v3' }).revision, q.revision);
  assert.throws(() => mutate(items, 'bob', { kind: 'follow', id: q.id, followId: randomUUID(), body: '越权' }), /发问人/);
  assert.equal(questionView(q, 'bob')!.followUps?.[0].body, '请改成 v3');
  const hidden = randomUUID();
  mutate(items, 'alice', { kind: 'follow', id: q.id, followId: hidden, body: '只给 bob', target: 'bob' });
  assert.equal(questionView(q, 'bob')!.followUps?.some(item => item.body === '只给 bob'), true);
  assert.equal(questionView(q, 'carol')!.followUps?.some(item => item.body === '只给 bob'), false);
  mutate(items, 'bob', { kind: 'suggest', id: q.id, username: 'bob' });
  assert.equal(q.closedAt, undefined);
  assert.ok(q.recipients.find(r => r.username === 'bob')!.endSuggestedAt);
  assert.throws(() => mutate(items, 'carol', { kind: 'suggest', id: q.id, username: 'bob' }), /建议结束/);
  mutate(items, 'alice', { kind: 'resume', id: q.id, username: 'bob' });
  assert.equal(q.recipients.find(r => r.username === 'bob')!.endSuggestedAt, undefined);
  const halfway = mutate(items, 'alice', create());
  mutate(items, 'bob', { kind: 'link', id: halfway.id, sessionId: randomUUID() });
  mutate(items, 'bob', { kind: 'close', id: halfway.id });
  assert.ok(halfway.closedAt);
  mutate(items, 'alice', { kind: 'close', id: q.id });
  assert.throws(() => mutate(items, 'alice', { kind: 'follow', id: q.id, followId: randomUUID(), body: '太晚' }), /已关闭/);
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
    const connect = async (name: string) => { const wb = new Workbench(path.join(root, name), () => {}, () => {}); clients.push(wb); await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, name), '1', root, async () => false); for (const provider of ['codex', 'cursor', 'claude'] as const) wb.store.settings.providerPaths[provider] = path.join(root, 'missing-cli.exe'); return wb; };
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

test('manual recipient replies are independent, idempotent and do not take over a model run', () => {
  const items: TeamQuestion[] = [], q = mutate(items, 'alice', create()), answerId = randomUUID();
  const manual = { kind: 'answer' as const, id: q.id, answerId, body: '直接回复，不需要 Session' };
  mutate(items, 'bob', manual); const revision = q.revision;
  mutate(items, 'bob', manual); assert.equal(q.revision, revision);
  assert.equal(q.recipients[0].answers.length, 1);
  assert.equal(q.recipients[0].sessionId, undefined);
  assert.equal(questionView(q, 'carol')!.activityRevision, 1);
  assert.throws(() => mutate(items, 'alice', manual), /指定接收人/);
  assert.throws(() => mutate(items, 'dave', manual), /无权/);
  const sessionId = randomUUID(), runId = randomUUID();
  mutate(items, 'bob', { kind: 'link', id: q.id, sessionId });
  mutate(items, 'bob', { kind: 'run', id: q.id, sessionId, runId });
  mutate(items, 'bob', { ...manual, answerId: randomUUID(), body: '补充' });
  assert.equal(q.recipients[0].state, 'running'); assert.equal(q.recipients[0].runId, runId);
  mutate(items, 'bob', { kind: 'reply', id: q.id, runId, body: '模型回复' });
  assert.equal(q.recipients[0].answers.length, 3);
  mutate(items, 'alice', { kind: 'close', id: q.id });
  mutate(items, 'bob', manual);
  assert.throws(() => mutate(items, 'bob', { ...manual, answerId: randomUUID() }), /已关闭/);
});

test('both sides share the conversation composer; recipient can type before linking a Session', () => {
  const items: TeamQuestion[] = [], q = mutate(items, 'alice', create());
  const render = (username: string, replyModes?: Record<string, 'manual' | 'auto'>, sessions: AgentSession[] = []) => renderToStaticMarkup(React.createElement(QuestionDetail, { question: questionView(q, username)!, username, inbox: { items, jobs: [], read: {}, replyModes }, sessions, changed: async () => {}, openSession: () => {} }));
  for (const markup of [render('alice'), render('bob')]) {
    assert.match(markup, /team-question-thread/);
    assert.match(markup, /team-question-composer[\s\S]*<textarea[\s\S]*team-question-composer-bar[\s\S]*结束提问[\s\S]*team-question-send[\s\S]*发送/);
    assert.doesNotMatch(markup, /team-question-answer|关联并回答|选择回答问题的 Session/);
  }
  assert.match(render('bob'), /aria-label="回复alice"/);
  const sid = randomUUID(); mutate(items, 'bob', { kind: 'link', id: q.id, sessionId: sid });
  const linked = { id: sid, purpose: 'work', binding: { project: { id: q.projectId } } } as AgentSession;
  assert.match(render('bob', { [q.id]: 'auto' }, [linked]), /正在与alice自动对话/);
  assert.doesNotMatch(render('bob', { [q.id]: 'auto' }, [linked]), /<textarea/);
  assert.match(render('bob', { [q.id]: 'manual' }, [linked]), /<textarea/);
  assert.match(render('bob', { [q.id]: 'auto' }), /<textarea/, 'a Session on another client must not hide direct replies');
  assert.match(render('bob', { [q.id]: 'auto' }, [{ ...linked, closedAt: new Date().toISOString() }]), /<textarea/, 'a closed Session cannot continue automatically');
});

test('recipient can switch between direct replies and automatic replies without returning a stopped run', () => fixture(async ({ alice, bob, project }) => {
  const ask = newSession(alice, project), responder = newSession(bob, project);
  const q = await alice.questions.create(ask.id, create()); let sends = 0;
  bob.questions = new Questions(bob.store, bob.remote, { profile: () => bob.remote.profile, session: id => bob.session(id), notice: () => {}, changed: () => {}, send: async (_id, text, runId) => {
    sends++; responder.status = 'running'; responder.messages.push({ id: randomUUID(), role: 'user', text, createdAt: '', context: { nativeId: 'test', accepted: true, workRecord: false, sourceHashes: {}, questionRunId: runId } }); return true;
  } });
  await bob.questions.sync();
  const answerId = randomUUID();
  await bob.questions.answer(project, q.id, answerId, '我先确认一下');
  await bob.questions.answer(project, q.id, answerId, '我先确认一下');
  await bob.questions.startAuto(project, q.id, 'alice', responder.id); await until(() => sends === 1);
  assert.equal(bob.questions.lockedPeer(responder.id), 'alice');
  await bob.questions.stopAuto(project, q.id, 'alice'); await bob.questions.sync();
  assert.equal(bob.questions.lockedPeer(responder.id), undefined);
  assert.equal(bob.questions.view().replyModes?.[q.id], 'manual');
  assert.equal(responder.status, 'running'); assert.equal(responder.closedAt, undefined);
  responder.messages.push({ id: randomUUID(), role: 'assistant', text: '停止后完成的结果', createdAt: '' }); responder.status = 'idle';
  await bob.questions.completed(responder); await bob.questions.sync();
  await alice.questions.follow(project, q.id, randomUUID(), '现在有新问题', 'bob'); await bob.questions.sync();
  assert.equal(sends, 1, 'manual mode must not queue new model work');
  await bob.questions.answer(project, q.id, randomUUID(), '手动补充'); await alice.questions.sync();
  assert.deepEqual(alice.questions.view().items[0].recipients[0].answers.map(a => a.body), ['我先确认一下', '手动补充']);
  await bob.questions.startAuto(project, q.id, 'alice', responder.id); await until(() => sends === 2);
  assert.equal(bob.questions.view().replyModes?.[q.id], 'auto');
}));

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
  assert.doesNotMatch(recipient, /关联并回答|回答 Session<\/option>|>结束提问<|发送后续信息|引入到 Session/);
  const author = renderToStaticMarkup(React.createElement(QuestionDetail, { question: q, inbox, username: 'alice', sessions: [{ id: q.sessionId, title: '发问 Session', purpose: 'work', binding: { project: { id: projectId } } } as AgentSession], changed: async () => {}, openSession: () => {} }));
  assert.match(author, /已关闭/); assert.doesNotMatch(author, /发送后续信息|继续同一问题|引入到 Session|结束提问|与bob自动对话/);
  const openItems: TeamQuestion[] = [], openQuestion = mutate(openItems, 'alice', create()), openRun = randomUUID();
  mutate(openItems, 'bob', { kind: 'link', id: openQuestion.id, sessionId: randomUUID() });
  mutate(openItems, 'bob', { kind: 'run', id: openQuestion.id, sessionId: openQuestion.recipients[0].sessionId!, runId: openRun });
  mutate(openItems, 'bob', { kind: 'reply', id: openQuestion.id, runId: openRun, body: '先用 v2' });
  mutate(openItems, 'alice', { kind: 'follow', id: openQuestion.id, followId: randomUUID(), body: '请改成 v3', target: 'bob' });
  const thread = renderToStaticMarkup(React.createElement(QuestionDetail, { question: openQuestion, inbox: { items: openItems, jobs: [], read: {} }, username: 'alice', sessions: [], changed: async () => {}, openSession: () => {} }));
  assert.match(thread, /我/); assert.match(thread, /请改成 v3/); assert.match(thread, /先用 v2/);
  assert.match(thread, /team-question-resize[\s\S]*结束提问[\s\S]*自动对话[\s\S]*自动填入[\s\S]*team-question-send[\s\S]*发送/);
  assert.doesNotMatch(thread, /发给bob|发送给|<select/);
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

test('replies stay manual until one auto session tracks a single person', () => fixture(async ({ alice, bob, carol, project }) => {
  const ask = newSession(alice, project), autoSession = newSession(alice, project), responder = newSession(bob, project);
  const q = await alice.questions.create(ask.id, create());
  await alice.questions.close(); await bob.questions.close(); await carol.questions.close();
  const prompts: { who: string; text: string; notice: string }[] = [], notices: string[] = [];
  const wire = (wb: Workbench, who: string) => {
    const questions = new Questions(wb.store, wb.remote, {
      profile: () => wb.remote.profile, session: id => wb.session(id), changed: () => {}, notice: text => { if (who === 'alice') notices.push(text); },
      send: async (id, text, runId, notice) => {
        prompts.push({ who, text, notice });
        const mine = prompts.filter(item => item.who === who).length;
        const script = ['看到了', '[[继续提问]]\n请改成 v3', '[[建议结束]]\n可以收尾'];
        const s = wb.session(id); s.status = 'running';
        s.messages.push({ id: randomUUID(), role: 'user', text: notice + text, userText: text, createdAt: new Date().toISOString(), context: { nativeId: 'test', accepted: true, workRecord: false, sourceHashes: {}, questionRunId: runId } });
        s.messages.push({ id: randomUUID(), role: 'assistant', text: who === 'alice' ? script[mine - 1] || '不再继续' : '答复 ' + mine, createdAt: new Date().toISOString() });
        s.status = 'idle'; await questions.completed(s); return true;
      },
    });
    wb.questions = questions; return questions;
  };
  const aliceQ = wire(alice, 'alice'), bobQ = wire(bob, 'bob'), carolQ = wire(carol, 'carol');
  await aliceQ.init(); await bobQ.init(); await carolQ.init();
  await bobQ.link(project, q.id, responder.id); await bobQ.sync();
  await until(() => prompts.some(item => item.who === 'bob')); await bobQ.sync(); await aliceQ.sync();
  assert.equal(prompts.filter(item => item.who === 'alice').length, 0, 'a reply waits for manual import');
  const answerId = aliceQ.view().items[0].recipients.find(item => item.username === 'bob')!.answers[0].id;
  await aliceQ.importReply(project, q.id, ask.id, answerId); await aliceQ.sync();
  await until(() => prompts.some(item => item.who === 'alice'));
  const imported = prompts.find(item => item.who === 'alice')!;
  assert.match(imported.text, /答复 /); assert.match(imported.notice, /对同一提问的回复/); assert.doesNotMatch(imported.notice, /自动对话/);
  const visible = ask.messages.find(message => message.context?.questionRunId)!;
  assert.match(sessionMessageText(ask, visible), /答复 /);
  assert.doesNotMatch(sessionMessageText(ask, visible), /成员回复接入/);
  assert.doesNotMatch(historyMarkdown(ask), /成员回复接入/);
  const settle = async (check: () => boolean) => { for (let n = 0; !check(); n++) { if (n > 40) throw new Error('timed out'); await bobQ.sync(); await aliceQ.sync(); await new Promise(r => setTimeout(r, 20)); } };
  await aliceQ.startAuto(project, q.id, 'bob', autoSession.id);
  await settle(() => prompts.filter(item => item.who === 'bob').length >= 2);
  assert.match(prompts.filter(item => item.who === 'bob')[1].text, /请改成 v3/);
  assert.match(prompts.filter(item => item.who === 'bob')[1].notice, /继续发来的信息/);
  await settle(() => !!aliceQ.view().items[0].recipients.find(item => item.username === 'bob')?.endSuggestedAt);
  assert.equal(prompts.filter(item => item.who === 'bob').length, 2);
  assert.equal(aliceQ.view().items[0].closedAt, undefined);
  assert.equal(aliceQ.view().dialogues?.[0].suggested, true);
  assert.equal(aliceQ.view().jobs.filter(job => job.mode === 'auto' && job.phase === 'tracked').length, 2);
  const carolSession = newSession(carol, project);
  await carolQ.link(project, q.id, carolSession.id);
  await until(() => carolQ.view().jobs.some(job => job.questionId === q.id && (job.phase === 'ready' || job.phase === 'sent' || job.phase === 'error')));
  await carolQ.sync(); await aliceQ.sync();
  const carolAnswer = aliceQ.view().items[0].recipients.find(item => item.username === 'carol')!.answers.at(-1)!.id;
  await assert.rejects(aliceQ.importReply(project, q.id, autoSession.id, carolAnswer), /只跟一个人/);
  await assert.rejects(alice.send(autoSession.id, '手动插入'), /不能手动发送/);
  const before = autoSession.messages.length;
  await bobQ.closeQuestion(project, q.id); await aliceQ.sync();
  assert.ok(aliceQ.view().items[0].closedAt);
  assert.equal(autoSession.messages.length, before);
  assert(notices.some(item => item.startsWith('问题已关闭：')));
  assert.equal(aliceQ.lockedPeer(autoSession.id), undefined);
}));

test('auto fill writes a draft and does not send it', () => fixture(async ({ alice, project }) => {
  const ask = newSession(alice, project);
  const q = await alice.questions.create(ask.id, create());
  await alice.questions.close();
  let drafted = false;
  const questions = new Questions(alice.store, alice.remote, {
    profile: () => alice.remote.profile, session: id => alice.session(id), changed: () => {}, notice: () => {},
    send: async (id, text, runId, notice, draft) => {
      assert.equal(draft, true);
      assert.match(notice || '', /起草继续提问/);
      assert.match(text, /需要使用哪一版数据/);
      const s = alice.session(id); s.status = 'running';
      s.messages.push({ id: randomUUID(), role: 'user', text: (notice || '') + text, userText: text, createdAt: new Date().toISOString(), context: { nativeId: 'test', accepted: true, workRecord: false, sourceHashes: {}, questionRunId: runId, questionFill: true } });
      s.messages.push({ id: randomUUID(), role: 'assistant', text: '[[继续提问]]\n请补充样本', createdAt: new Date().toISOString() });
      s.status = 'idle'; await questions.completed(s); drafted = true; return true;
    },
  });
  alice.questions = questions;
  await questions.init();
  await questions.fillDraft(project, q.id, 'bob');
  await until(() => drafted);
  const job = questions.view().jobs.find(item => item.mode === 'fill' && item.questionId === q.id);
  assert.equal(job?.phase, 'tracked');
  assert.equal(job?.answer, '请补充样本');
  assert.equal(questions.view().items.find(item => item.id === q.id)?.followUps?.length || 0, 0);
  assert.doesNotMatch(historyMarkdown(ask), /请补充样本|起草继续提问/);
  const inbox = (questions as any).inbox();
  inbox.dialogues = [{ questionId: q.id, projectId: project, peer: 'bob', sessionId: ask.id, mode: 'auto' }];
  await assert.rejects(questions.fillDraft(project, q.id, 'carol'), /正在自动对话/);
  inbox.dialogues[0].suggested = true;
  ask.status = 'running';
  await assert.rejects(questions.fillDraft(project, q.id, 'bob'), /正在处理/);
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
    const prompt = responder.messages.find(m => m.role === 'user' && m.context?.questionRunId);
    assert(prompt);
    const notice = incomingQuestionNotice('alice');
    assert(prompt.text.startsWith(notice));
    assert.match(prompt.text, /需要使用哪一版数据/);
    assert.equal(prompt.userText?.includes('成员提问接入'), false);
    assert.match(sessionMessageText(responder, prompt), /需要使用哪一版数据/);
    assert.doesNotMatch(sessionMessageText(responder, prompt), /成员提问接入|不是当前用户本人输入/);
    assert.doesNotMatch(historyMarkdown(responder), /成员提问接入|不是当前用户本人输入/);
  }
}));
