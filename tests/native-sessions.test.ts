import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DatabaseSync } from 'node:sqlite';
import { AgentRuntime } from '../src/core/agents';
import { Workbench } from '../src/core/workbench';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { listNativeSessions, nativeRecordAllowed } from '../src/core/native-sessions';
import { applyNativeTranscript, readCodexTranscript, sameNativePath } from '../src/core/native-transcript';
import { firstSelectableNativeSession, NativeSessionBrowser, NativeSessionPicker, nextNativeGroupSelection, nextNativeSelection } from '../src/renderer/native-sessions';
import type { AgentSession, Message } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const codexId = '01a0bc6c-6276-7110-bb10-8ab94a8fe0a0';
const looseId = '01a0d216-9636-70e3-bc68-f16e3c3938ae';
const pinnedId = '01a0ad02-ca87-7b51-bb4d-77ed8027ca90';
const archivedId = '01a0ad03-5cbe-7c52-91c2-5a020bba7662';
const cursorHomeId = '07597383-d4ce-4003-81ca-c0e546dbb1fe';
const cursorOtherId = '44d2840c-9f3c-4243-9b3f-17c1e527ff53';

function withEnv(name: string, value: string, run: () => Promise<void>) {
  const previous = process.env[name];
  process.env[name] = value;
  return run().finally(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test('native session names follow Codex project groups and Cursor workspace titles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-list-'));
  try {
    const codex = path.join(root, 'codex'), cursor = path.join(root, 'cursor-chats'), workspace = path.join(root, 'workspace');
    await fs.mkdir(path.join(codex, 'sessions', '2026', '10', '12'), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    for (const id of [codexId, looseId, pinnedId, archivedId]) await fs.writeFile(path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + id + '.jsonl'), '{}\n');
    const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
    db.exec(`CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
      CREATE TABLE thread_sections (id TEXT, name TEXT);
      CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT);`);
    db.prepare('INSERT INTO projects (id, name, position) VALUES (?, ?, ?)').run('project-1', '检索项目', 2);
    db.prepare('INSERT INTO thread_sections (id, name) VALUES (?, ?)').run('section-1', 'Pinned');
    const insert = db.prepare('INSERT INTO threads (id, name, title, first_user_message, cwd, project_id, thread_section_id, archived, recency_at_ms, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(codexId, '改排序', '这是一段很长的第一句，不应该当会话名', '第一句', workspace, 'project-1', null, 0, 3000, null);
    insert.run(looseId, '安装 jev', '另一段第一句', '', workspace, null, null, 0, 2000, null);
    insert.run(pinnedId, '置顶会话', '置顶第一句', '', workspace, null, 'section-1', 0, 1000, null);
    insert.run(archivedId, '已归档', '归档第一句', '', workspace, 'project-1', null, 1, 4000, null);
    db.close();
    await fs.mkdir(path.join(cursor, 'home-hash', cursorHomeId), { recursive: true });
    await fs.mkdir(path.join(cursor, 'other-hash', cursorOtherId), { recursive: true });
    await fs.writeFile(path.join(cursor, 'home-hash', cursorHomeId, 'meta.json'), JSON.stringify({ title: 'Team Agent Workbench', cwd: 'C:\\Users\\me', updatedAtMs: 5000, hasConversation: true }));
    await fs.writeFile(path.join(cursor, 'other-hash', cursorOtherId, 'meta.json'), JSON.stringify({ title: 'Hello There', cwd: 'C:\\windows\\system32', updatedAtMs: 1000, hasConversation: true }));
    await withEnv('CODEX_HOME', codex, async () => {
      const catalog = await listNativeSessions('codex');
      assert.deepEqual(catalog.groups.map(group => group.name), ['Pinned', '检索项目']);
      const named = Object.fromEntries(catalog.sessions.map(session => [session.nativeId, session]));
      assert.equal(named[codexId].name, '改排序');
      assert.equal(named[codexId].groupId, 'project-1');
      assert.equal(named[looseId].name, '安装 jev');
      assert.equal(named[looseId].groupId, undefined);
      assert.equal(named[pinnedId].groupId, 'section:section-1');
      assert.equal(named[archivedId], undefined);
    });
    await withEnv('WORKBENCH_CURSOR_CHATS', cursor, async () => {
      const catalog = await listNativeSessions('cursor');
      assert.deepEqual(catalog.groups.map(group => group.name), ['C:\\Users\\me', 'C:\\windows\\system32']);
      assert.deepEqual(catalog.sessions.map(session => session.name).sort(), ['Hello There', 'Team Agent Workbench']);
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Codex transcript keeps dialogue and operations and leaves the personal file in place', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-transcript-'));
  try {
    const personal = path.join(root, 'personal'), file = path.join(personal, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + codexId + '.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lines = [
      { type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000000000, item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '继续修复用户端' }] } } },
      { type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000001000, item: { type: 'Reasoning', id: 'r1', summary_text: [] } } },
      { type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000002000, item: { type: 'CommandExecution', id: 'c1', command: ['git', 'status'], exit_code: 0, aggregated_output: 'clean' } } },
      { type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000003000, item: { type: 'AgentMessage', id: 'a1', phase: 'final_answer', content: [{ type: 'text', text: '已经修好' }] } } },
    ];
    await fs.writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const messages = await readCodexTranscript(file);
    assert.deepEqual(messages.map(message => message.role), ['user', 'tool', 'assistant']);
    assert.equal(messages[0].text, '继续修复用户端');
    assert.match(messages[1].text, /git status/);
    assert.equal(messages[2].text, '已经修好');
    const previous: Message[] = [{ id: 'native:u1', role: 'user', text: '继续修复用户端', userText: '给人看的', context: { nativeId: codexId, accepted: true, workRecord: false, sourceHashes: {} }, createdAt: messages[0].createdAt }];
    const merged = applyNativeTranscript(previous, messages);
    assert.equal(merged[0].userText, '给人看的');
    assert.equal(merged[0].context?.accepted, true);
    assert.equal(applyNativeTranscript(messages, messages.slice(0, 1)).length, 3);
    assert.equal(sameNativePath('file:///C:/work/a.jsonl', 'C:\\work\\a.jsonl'), process.platform === 'win32');
    const session = { id: 's', title: '关联', provider: 'codex' as const, cwd: root, purpose: 'work' as const, createdAt: '', status: 'idle' as const, messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md'), nativeId: codexId, nativeLive: true };
    const storage = await prepareCodexStorage(path.join(root, 'data'), session, personal);
    assert.equal(storage.resumePath, file);
    assert.deepEqual(await fs.readdir(path.join(storage.home, 'sessions')), []);
    assert.equal(await fs.readFile(file, 'utf8'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('linking a Codex session keeps its project name and reads the original record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-link-'));
  const previous = process.env.CODEX_HOME;
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const codex = path.join(root, 'codex'), workspace = path.join(root, 'workspace');
    process.env.CODEX_HOME = codex;
    await fs.mkdir(path.join(codex, 'sessions', '2026', '10', '12'), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const file = path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + codexId + '.jsonl');
    const otherFile = path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + looseId + '.jsonl');
    const missingFile = path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + pinnedId + '.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000000000, item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '继续修复用户端' }] } } }) + '\n');
    await fs.writeFile(otherFile, '{}\n');
    await fs.writeFile(missingFile, '{}\n');
    const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
    db.exec('CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE thread_sections (id TEXT, name TEXT); CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT);');
    db.prepare('INSERT INTO projects (id, name, position) VALUES (?, ?, ?)').run('project-1', '检索项目', 1);
    const insert = db.prepare('INSERT INTO threads (id, name, title, first_user_message, cwd, project_id, thread_section_id, archived, recency_at_ms, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(codexId, '继续修复用户端问题', '很长的第一句', '很长的第一句', workspace, 'project-1', null, 0, 10, null);
    insert.run(looseId, '安装 jev', '', '', workspace, 'project-1', null, 0, 5, null);
    insert.run(pinnedId, '目录丢了', '', '', path.join(root, 'missing'), 'project-1', null, 0, 1, null);
    db.close();
    await wb.store.init(); grantTestWorkspace(wb, workspace);
    const catalog = await wb.listNativeSessions('codex');
    assert.equal(catalog.groups[0].name, '检索项目');
    assert.equal(catalog.sessions[0].name, '继续修复用户端问题');
    const linked = await wb.linkNativeSession('codex', codexId, offlineProjectId);
    assert.equal(linked.title, '继续修复用户端问题');
    assert.equal(linked.nativeLive, true);
    assert.equal(linked.nativePath, file);
    assert.equal(linked.codexStorage, undefined);
    assert.equal(linked.messages[0].text, '继续修复用户端');
    const again = await wb.linkNativeSession('codex', codexId, offlineProjectId);
    assert.equal(again.id, linked.id);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === codexId).length, 1);
    await assert.rejects(() => wb.linkNativeSessions('codex', [looseId, pinnedId], offlineProjectId), /目录丢了/);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === looseId).length, 0);
    const imported = await wb.linkNativeSessions('codex', [codexId, looseId, codexId], offlineProjectId);
    assert.deepEqual(imported.map(session => session.nativeId), [codexId, looseId]);
    assert.equal(imported[0].id, linked.id);
    assert.equal(imported[1].nativeLive, true);
    assert.equal(imported[1].nativePath, otherFile);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === codexId || session.nativeId === looseId).length, 2);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await wb.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Codex and Cursor links stay inside their own records', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-split-'));
  const previousCodex = process.env.CODEX_HOME, previousCursor = process.env.WORKBENCH_CURSOR_CHATS;
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const codex = path.join(root, 'codex'), cursor = path.join(root, 'cursor-chats'), workspace = path.join(root, 'workspace');
    const rollout = path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + codexId + '.jsonl');
    const missingRollout = path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + looseId + '.jsonl');
    const chat = path.join(cursor, 'home-hash', cursorHomeId);
    const emptyChat = path.join(cursor, 'other-hash', cursorOtherId);
    process.env.CODEX_HOME = codex; process.env.WORKBENCH_CURSOR_CHATS = cursor;
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.mkdir(chat, { recursive: true });
    await fs.mkdir(emptyChat, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(rollout, '{}\n');
    await fs.writeFile(missingRollout, '{}\n');
    await fs.writeFile(path.join(chat, 'meta.json'), JSON.stringify({ title: 'Team Agent Workbench', cwd: workspace, updatedAtMs: 5000, hasConversation: true }));
    await fs.writeFile(path.join(emptyChat, 'meta.json'), JSON.stringify({ title: '没有目录', cwd: '', updatedAtMs: 1000, hasConversation: true }));
    const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
    db.exec('CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE thread_sections (id TEXT, name TEXT); CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT);');
    const insert = db.prepare('INSERT INTO threads (id, name, title, first_user_message, cwd, project_id, thread_section_id, archived, recency_at_ms, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(codexId, '继续修复用户端问题', '', '', workspace, null, null, 0, 10, null);
    insert.run(looseId, '目录丢了', '', '', path.join(root, 'missing'), null, null, 0, 9, null);
    db.close();
    assert.equal(nativeRecordAllowed('codex', rollout), true);
    assert.equal(nativeRecordAllowed('cursor', rollout), false);
    assert.equal(nativeRecordAllowed('cursor', chat), true);
    assert.equal(nativeRecordAllowed('codex', chat), false);
    await wb.store.init(); grantTestWorkspace(wb, workspace);
    const codexList = await wb.listNativeSessions('codex');
    const cursorList = await wb.listNativeSessions('cursor');
    assert.deepEqual(codexList.sessions.map(session => session.nativeId), [codexId, looseId]);
    assert.equal(codexList.sessions[0].unavailable, undefined);
    assert.equal(codexList.sessions[1].unavailable, '工作目录已经不在，无法在工作台继续');
    assert.equal(firstSelectableNativeSession(codexList)?.nativeId, codexId);
    assert.equal(codexList.provider, 'codex');
    assert.deepEqual(cursorList.sessions.map(session => session.nativeId).sort(), [cursorHomeId, cursorOtherId].sort());
    assert.equal(cursorList.sessions.find(session => session.nativeId === cursorHomeId)?.unavailable, undefined);
    assert.equal(cursorList.sessions.find(session => session.nativeId === cursorOtherId)?.unavailable, '没有工作目录，无法在工作台继续');
    assert.equal(cursorList.provider, 'cursor');
    await assert.rejects(() => wb.linkNativeSession('codex', cursorHomeId, offlineProjectId), /找不到这条 Codex 会话/);
    await assert.rejects(() => wb.linkNativeSession('cursor', codexId, offlineProjectId), /找不到这条 Cursor 会话/);
    const linked = await wb.linkNativeSession('cursor', cursorHomeId, offlineProjectId);
    assert.equal(linked.provider, 'cursor');
    assert.equal(linked.nativeLive, true);
    assert.equal(linked.nativeId, cursorHomeId);
    assert.equal(linked.nativePath, chat);
    assert.equal(linked.codexStorage, undefined);
    linked.nativePath = rollout;
    await assert.rejects(() => wb.refreshNativeTranscript(linked.id), /Cursor 关联只能读取 Cursor 自己的会话记录/);
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
    if (previousCursor === undefined) delete process.env.WORKBENCH_CURSOR_CHATS; else process.env.WORKBENCH_CURSOR_CHATS = previousCursor;
    await wb.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a linked Cursor session keeps its original id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-live-'));
  const previousConfig = process.env.CURSOR_CONFIG_DIR;
  process.env.CURSOR_CONFIG_DIR = root;
  const script = path.join(root, 'rpc-agent.mjs');
  const log = path.join(root, 'rpc.log');
  await fs.writeFile(script, `import readline from 'node:readline';\nimport fs from 'node:fs';\nconst send = value => process.stdout.write(JSON.stringify(value) + '\\n');\nreadline.createInterface({ input: process.stdin }).on('line', line => {\n  const message = JSON.parse(line);\n  fs.appendFileSync(process.env.RPC_LOG, message.method + '\\n');\n  if (message.method === 'session/load') send({ id: message.id, result: { sessionId: process.env.RETURN_SESSION_ID || '' } });\n  else if (message.id !== undefined) send({ id: message.id, result: {} });\n});\n`);
  const session = (nativeId?: string): AgentSession => ({ id: '11111111-1111-4111-8111-111111111111', provider: 'cursor', title: '原会话', cwd: root, createdAt: new Date().toISOString(), purpose: 'work', status: 'idle', nativeLive: true, nativeId, messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') });
  const start = (value: AgentSession, returned?: string) => new AgentRuntime(value, script, { changed: () => {}, event: () => {}, done: () => {} }, undefined, { RPC_LOG: log, ...(returned ? { RETURN_SESSION_ID: returned } : {}) });
  let runtime: AgentRuntime | undefined;
  try {
    const missing = session();
    runtime = start(missing);
    await assert.rejects(() => runtime!.start(), /这条会话还没有原会话标识/);
    assert.equal(missing.nativeId, undefined);
    await runtime.close();
    const forked = session(cursorHomeId);
    await fs.writeFile(log, '');
    runtime = start(forked, '44d2840c-9f3c-4243-9b3f-17c1e527ff53');
    await assert.rejects(() => runtime!.start(), /Cursor 打开了另一条会话，已停止/);
    assert.equal(forked.nativeId, cursorHomeId);
    assert.equal(forked.status, 'error');
    assert.doesNotMatch(await fs.readFile(log, 'utf8'), /session\/new/);
    await runtime.close();
    const kept = session(cursorHomeId);
    await fs.writeFile(log, '');
    runtime = start(kept, cursorHomeId);
    await runtime.start();
    assert.equal(kept.nativeId, cursorHomeId);
    assert.equal(kept.status, 'idle');
    const methods = await fs.readFile(log, 'utf8');
    assert.match(methods, /session\/load/);
    assert.doesNotMatch(methods, /session\/new/);
  } finally {
    await runtime?.close();
    if (previousConfig === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = previousConfig;
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
});

test('publishing a workbench session registers it in the desktop Codex and Cursor lists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-publish-'));
  const previousCodex = process.env.CODEX_HOME, previousCursor = process.env.WORKBENCH_CURSOR_CHATS;
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const codex = path.join(root, 'codex'), cursor = path.join(root, 'cursor-chats'), workspace = path.join(root, 'workspace');
    process.env.CODEX_HOME = codex; process.env.WORKBENCH_CURSOR_CHATS = cursor;
    await fs.mkdir(path.join(codex), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
    db.exec(`CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
    CREATE TABLE thread_sections (id TEXT, name TEXT);
    CREATE TABLE threads (
      id TEXT, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL,
      model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      cli_version TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '', memory_mode TEXT NOT NULL DEFAULT 'enabled',
      preview TEXT NOT NULL DEFAULT '', recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
      history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, thread_source TEXT, originator TEXT, model TEXT,
      project_id TEXT, thread_section_id TEXT
    );`);
    const taken = '01a0bc6c-6276-7110-bb10-8ab94a8fe0a0';
    const takenFile = path.join(codex, 'sessions', '2026', '01', '02', `rollout-2026-01-02T00-00-00-${taken}.jsonl`);
    await fs.mkdir(path.dirname(takenFile), { recursive: true });
    await fs.writeFile(takenFile, '{"keep":true}\n');
    db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, name) VALUES (?, ?, 1, 1, 'cli', 'openai', ?, '已有', '{"type":"workspace-write"}', 'on-request', '已有')`).run(taken, takenFile, workspace);
    db.close();
    await wb.store.init(); grantTestWorkspace(wb, workspace);
    const blocked = await wb.createSession('codex', workspace, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    blocked.nativeId = taken;
    await wb.store.save();
    await assert.rejects(() => wb.publishToDesktop(blocked.id), /没有覆盖/);
    assert.notEqual(blocked.nativeLive, true);
    assert.equal(await fs.readFile(takenFile, 'utf8'), '{"keep":true}\n');
    const session = await wb.createSession('codex', workspace, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    session.title = '继续修复用户端问题';
    session.messages.push({ id: 'm1', role: 'user', text: '你好', createdAt: new Date().toISOString() });
    await wb.store.save();
    const published = await wb.publishToDesktop(session.id);
    assert.equal(published.nativeLive, true);
    assert.equal(published.codexStorage, undefined);
    assert.equal(published.messages.some(message => message.text === '你好'), true);
    assert.match(await fs.readFile(published.nativePath!, 'utf8'), /你好/);
    assert.ok(published.nativeId);
    assert.match(await fs.readFile(path.join(codex, 'session_index.jsonl'), 'utf8'), new RegExp(published.nativeId));
    const listed = await wb.listNativeSessions('codex');
    assert.equal(listed.sessions.find(item => item.nativeId === published.nativeId)?.name, '继续修复用户端问题');
    await assert.rejects(() => wb.publishToDesktop(session.id), /已经在桌面 Codex/);
    const cursorSession = await wb.createSession('cursor', workspace, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    cursorSession.title = 'Team Agent Workbench';
    cursorSession.messages.push({ id: 'c1', role: 'user', text: '看看桌面', createdAt: new Date().toISOString() });
    await wb.store.save();
    const shown = await wb.publishToDesktop(cursorSession.id);
    assert.equal(shown.nativeLive, true);
    assert.equal(shown.messages.some(message => message.text === '看看桌面'), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(shown.nativePath!, 'meta.json'), 'utf8')).cwd, shown.cwd);
    const store = new DatabaseSync(path.join(shown.nativePath!, 'store.db'), { readOnly: true });
    try { assert.match(store.prepare('SELECT data FROM blobs').all().map((row: { data?: Uint8Array }) => Buffer.from(row.data || []).toString('utf8')).join('\n'), /看看桌面/); }
    finally { store.close(); }
    const cursorList = await wb.listNativeSessions('cursor');
    assert.equal(cursorList.sessions.find(item => item.nativeId === shown.nativeId)?.name, 'Team Agent Workbench');
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
    if (previousCursor === undefined) delete process.env.WORKBENCH_CURSOR_CHATS; else process.env.WORKBENCH_CURSOR_CHATS = previousCursor;
    await wb.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('session picker shows Codex group and session names without inventing a group', () => {
  assert.deepEqual(nextNativeSelection(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(nextNativeSelection(['a', 'b'], 'b', true), ['a']);
  assert.deepEqual(nextNativeSelection(['a'], 'b', false), ['a']);
  assert.deepEqual(nextNativeGroupSelection(['a'], ['b', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(nextNativeGroupSelection(['b', 'c', 'a'], ['b', 'c']), ['a']);
  const html = renderToStaticMarkup(React.createElement(NativeSessionBrowser, { selectedIds: [looseId], onChange: () => {}, catalog: { provider: 'codex', groups: [{ id: 'section-1', name: 'Pinned', position: -1 }, { id: 'project-1', name: '检索项目', position: 2 }], sessions: [{ nativeId: pinnedId, name: '置顶会话', groupId: 'section-1', cwd: '', updatedAt: 1000 }, { nativeId: codexId, name: '改排序', groupId: 'project-1', cwd: 'D:\\project', updatedAt: 3000, unavailable: '工作目录已经不在，无法在工作台继续' }, { nativeId: looseId, name: '安装 jev', cwd: 'C:\\Users\\me', updatedAt: 2000 }] } }));
  assert.ok(html.indexOf('Pinned') < html.indexOf('检索项目'));
  assert.ok(html.indexOf('检索项目') < html.indexOf('改排序'));
  assert.match(html, /安装 jev/);
  assert.match(html, /全选本组/);
  assert.doesNotMatch(html, /未归入项目|未分组/);
  const buttons = [...html.matchAll(/<button[\s\S]*?<\/button>/g)].map(match => match[0]);
  assert.match(buttons.find(button => button.includes('改排序')) || '', /disabled=""/);
  assert.match(buttons.find(button => button.includes('改排序')) || '', /工作目录已经不在，无法在工作台继续/);
  const kept = buttons.find(button => button.includes('安装 jev')) || '';
  assert.doesNotMatch(kept, /disabled/);
  assert.match(kept, /aria-checked="true"/);
  const codexPicker = renderToStaticMarkup(React.createElement(NativeSessionPicker, { provider: 'codex', projectId: 'project-1', close: () => {}, linked: () => {} }));
  const cursorPicker = renderToStaticMarkup(React.createElement(NativeSessionPicker, { provider: 'cursor', projectId: 'project-1', close: () => {}, linked: () => {} }));
  assert.match(codexPicker, /接入 Codex 会话/);
  assert.match(codexPicker, /可以勾选多条，一次导入/);
  assert.match(codexPicker, /导入所选/);
  assert.doesNotMatch(codexPicker, /Cursor/);
  assert.match(cursorPicker, /接入 Cursor 会话/);
  assert.match(cursorPicker, /Cursor 自己的工作目录和会话名/);
  assert.doesNotMatch(cursorPicker, /Codex/);
});
