import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DatabaseSync } from 'node:sqlite';
import { AgentRuntime } from '../src/core/agents';
import { Workbench } from '../src/core/workbench';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { listNativeSessions, nativeRecordAllowed } from '../src/core/native-sessions';
import { applyNativeTranscript, nativeTranscriptChanged, readCodexTranscript, sameNativePath } from '../src/core/native-transcript';
import { firstSelectableNativeSession, NativeSessionBrowser, NativeSessionPicker, nativeSessionsInGroup, nextNativeGroupSelection, nextNativeSelection } from '../src/renderer/native-sessions';
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

test('Codex projects follow desktop membership during migration, then unambiguous workspace roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-projects-'));
  const home = path.join(root, 'codex'), workspace = path.join(root, 'workspace'), nested = path.join(workspace, 'nested');
  const ids = Array.from({ length: 8 }, () => randomUUID());
  try {
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    for (const id of ids) await fs.writeFile(path.join(home, 'sessions', 'rollout-' + id + '.jsonl'), '{}\n');
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    db.exec(`CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
      CREATE TABLE project_roots (project_id TEXT, path TEXT);
      CREATE TABLE project_idempotency_keys (key TEXT, project_id TEXT);
      CREATE TABLE thread_sections (id TEXT, name TEXT);
      CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT);`);
    const project = db.prepare('INSERT INTO projects VALUES (?, ?, ?)');
    project.run('project-a', '项目甲', 0); project.run('project-b', '项目乙', 1); project.run('project-c', '共享目录项目', 2);
    const roots = db.prepare('INSERT INTO project_roots VALUES (?, ?)');
    roots.run('project-a', workspace); roots.run('project-b', nested); roots.run('project-c', workspace);
    db.prepare('INSERT INTO project_idempotency_keys VALUES (?, ?)').run('legacy-c', 'project-c');
    const thread = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const formattedNested = process.platform === 'win32' ? '\\\\?\\' + nested.toUpperCase() + '\\' : nested;
    thread.run(ids[0], '迁移中的会话', '', '', workspace, null, null, 0, 10, null);
    thread.run(ids[1], '子目录会话', '', '', formattedNested, null, null, 0, 9, null);
    thread.run(ids[2], '同目录多个项目', '', '', workspace, null, null, 0, 8, null);
    thread.run(ids[3], '明确无项目', '', '', nested, null, null, 0, 7, null);
    thread.run(ids[4], '索引已有归属', '', '', nested, 'project-a', null, 0, 6, null);
    thread.run(ids[5], '只有桌面旧项目', '', '', root, null, null, 0, 5, null);
    thread.run(ids[6], '已删除的项目归属', '', '', nested, null, null, 0, 4, null);
    thread.run(ids[7], '通过幂等键迁移', '', '', workspace, null, null, 0, 3, null);
    db.close();
    const desktop = {
      'local-projects': { 'legacy-a': { name: '项目甲', rootPaths: [workspace] }, 'legacy-c': { name: '共享目录项目', rootPaths: [workspace] }, 'legacy-only': { name: '旧版桌面项目', rootPaths: [] } },
      'project-order': ['legacy-only', 'legacy-c', 'legacy-a'],
      'app-server-project-id-by-legacy-project-id-by-host': { ['remote:' + home]: { 'legacy-a': 'project-b' }, ['local:' + home]: { 'legacy-a': 'project-a' } },
      'thread-project-assignments': { [ids[0]]: { projectKind: 'local', projectId: 'legacy-a' }, [ids[5]]: { projectKind: 'local', projectId: 'legacy-only' }, [ids[6]]: { projectKind: 'local', projectId: 'deleted' }, [ids[7]]: { projectKind: 'local', projectId: 'legacy-c' } },
      'projectless-thread-ids': [ids[3]],
    };
    const state = path.join(home, '.codex-global-state.json'), bytes = JSON.stringify(desktop);
    await fs.writeFile(state, bytes);
    await withEnv('CODEX_HOME', home, async () => {
      const catalog = await listNativeSessions('codex'), indexed = new Map(catalog.sessions.map(session => [session.nativeId, session]));
      assert.equal(indexed.get(ids[0])?.groupId, 'project-a');
      assert.equal(indexed.get(ids[1])?.groupId, 'project-b', 'deepest root matches extended/case-insensitive Windows paths');
      assert.equal(indexed.get(ids[2])?.groupId, undefined, 'shared roots must not choose a project arbitrarily');
      assert.equal(indexed.get(ids[3])?.groupId, undefined, 'explicit projectless membership overrides root matching');
      assert.equal(indexed.get(ids[4])?.groupId, 'project-a', 'native membership overrides root inference');
      assert.equal(indexed.get(ids[5])?.groupId, 'legacy-only');
      assert.equal(indexed.get(ids[6])?.groupId, undefined);
      assert.equal(indexed.get(ids[7])?.groupId, 'project-c');
      assert.equal(catalog.groups.filter(group => group.name === '项目甲').length, 1, 'migration aliases must not duplicate project groups');
      assert.equal(catalog.groups[0].name, '旧版桌面项目');
      assert.equal(await fs.readFile(state, 'utf8'), bytes, 'listing never changes desktop membership');
      await fs.writeFile(state, 'invalid JSON');
      const fallback = await listNativeSessions('codex');
      assert.equal(fallback.sessions.find(session => session.nativeId === ids[1])?.groupId, 'project-b', 'SQLite roots still work with unreadable desktop JSON');
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
    assert.equal(nativeTranscriptChanged(messages, messages), false);
    assert.equal(nativeTranscriptChanged(messages, messages.slice(0, 2)), true);
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
    await assert.rejects(() => wb.linkNativeSession('codex', codexId, offlineProjectId), /不能重复导入/);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === codexId).length, 1);
    await assert.rejects(() => wb.linkNativeSessions('codex', [looseId, pinnedId], offlineProjectId), /目录丢了/);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === looseId).length, 0);
    await assert.rejects(() => wb.linkNativeSessions('codex', [looseId, codexId], offlineProjectId), /不能重复导入/);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === looseId).length, 0, 'reject stale batches before importing their new records');
    await wb.closeSession(linked.id);
    const closedAt = linked.closedAt;
    await assert.rejects(() => wb.linkNativeSession('codex', codexId.toUpperCase(), offlineProjectId), /不能重复导入/);
    assert.equal(linked.closedAt, closedAt, 'import must not reopen an existing closed session');
    const race = await Promise.allSettled([wb.linkNativeSessions('codex', [looseId, looseId], offlineProjectId), wb.linkNativeSession('codex', looseId, offlineProjectId)]);
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter(result => result.status === 'rejected').length, 1);
    const imported = wb.store.sessions.find(session => session.nativeId === looseId)!;
    assert.equal(imported.nativeLive, true);
    assert.equal(imported.nativePath, otherFile);
    assert.equal(wb.store.sessions.filter(session => session.nativeId === codexId || session.nativeId === looseId).length, 2);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await wb.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a linked Codex session follows later writes to the original rollout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-native-follow-'));
  const previous = process.env.CODEX_HOME;
  let broadcasts = 0, publishedReply = '';
  const wb: Workbench = new Workbench(path.join(root, 'data'), () => {
    broadcasts += 1; publishedReply = wb.store.sessions.find(session => session.nativeId === codexId)?.messages.at(-1)?.text || '';
  }, () => {});
  const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return true;
  };
  try {
    const codex = path.join(root, 'codex'), workspace = path.join(root, 'workspace');
    process.env.CODEX_HOME = codex;
    await fs.mkdir(path.join(codex, 'sessions', '2026', '10', '12'), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const file = path.join(codex, 'sessions', '2026', '10', '12', 'rollout-2026-10-12T00-00-00-' + codexId + '.jsonl');
    const line = (id: string, text: string, at: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: at, item: { type: id.startsWith('u') ? 'UserMessage' : 'AgentMessage', id, content: [{ type: 'text', text }] } } }) + '\n';
    await fs.writeFile(file, line('u1', '原来的问题', 1700000000000));
    const db = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
    db.exec('CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE thread_sections (id TEXT, name TEXT); CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT);');
    db.prepare('INSERT INTO threads (id, name, title, first_user_message, cwd, project_id, thread_section_id, archived, recency_at_ms, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(codexId, '继续修复用户端问题', '', '', workspace, null, null, 0, 10, null);
    db.close();
    await wb.store.init(); grantTestWorkspace(wb, workspace);
    const linked = await wb.linkNativeSession('codex', codexId, offlineProjectId);
    assert.equal(linked.messages.length, 1);
    await new Promise(resolve => setTimeout(resolve, 400));
    linked.status = 'running';
    await fs.appendFile(file, line('a1', '还在运行时写入', 1700000001000));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(linked.messages.length, 1);
    linked.status = 'idle';
    assert.equal(await waitFor(() => linked.messages.some(message => message.text === '还在运行时写入')), true);
    await fs.appendFile(file, line('a2', '桌面端新回复', 1700000002000));
    // The in-memory messages change before the filesystem checks and UI broadcast finish.
    assert.equal(await waitFor(() => publishedReply === '桌面端新回复'), true);
    const settled = broadcasts;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(broadcasts, settled);
    assert.equal(linked.messages.at(-1)?.text, '桌面端新回复');
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
  wb.desktopAppOpen = async () => false;
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
    let closedPrivateRuntime = false;
    (wb as any).runtimes.set(session.id, { session, close: async () => { closedPrivateRuntime = true; } });
    const published = await wb.publishToDesktop(session.id);
    assert.equal(closedPrivateRuntime, true, 'publishing must release the private runtime before continuing the desktop record');
    assert.equal((wb as any).runtimes.has(session.id), false);
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

test('an already open desktop app is reminded and its session files stay untouched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-open-desktop-'));
  const previousCodex = process.env.CODEX_HOME;
  const notices: string[] = [];
  const wb = new Workbench(path.join(root, 'data'), () => {}, message => notices.push(message));
  wb.desktopAppOpen = async () => true;
  try {
    const codex = path.join(root, 'codex'), workspace = path.join(root, 'workspace');
    process.env.CODEX_HOME = codex;
    await fs.mkdir(codex, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await wb.store.init(); grantTestWorkspace(wb, workspace);
    const session = await wb.createSession('codex', workspace, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    session.nativeLive = true; session.nativeId = codexId;
    await (wb as any).publishDesktopHistory(session);
    await (wb as any).publishDesktopHistory(session);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /桌面 Codex 正在运行/);
    assert.deepEqual(await fs.readdir(codex), []);
    let closed = false;
    (wb as any).runtimes.set(session.id, { session, close: async () => { closed = true; } });
    session.nativeLive = false; session.nativeId = undefined;
    await assert.rejects(() => wb.publishToDesktop(session.id), /不会改写已打开的会话数据/);
    assert.equal(closed, false);
    assert.equal((wb as any).runtimes.has(session.id), true);
    const cursorSession = await wb.createSession('cursor', workspace, offlineProjectId, 'work', undefined, undefined, 'inherit', false);
    await assert.rejects(() => wb.publishToDesktop(cursorSession.id), /Cursor 正在运行/);
    wb.desktopAppOpen = async () => { throw new Error('probe failed'); };
    await assert.rejects(() => wb.publishToDesktop(session.id), /无法确认桌面 Codex/);
    assert.deepEqual(await fs.readdir(codex), []);
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
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

test('import selection excludes linked and closed workbench chats while project filtering preserves selection', () => {
  const catalog = { provider: 'codex' as const, groups: [{ id: 'p', name: '项目甲', position: 0 }], sessions: [
    { nativeId: 'linked', name: '已加入的会话', groupId: 'p', cwd: '', updatedAt: 20, linkedSessionId: 'closed-workbench-session' },
    { nativeId: 'new', name: '新的会话', groupId: 'p', cwd: '', updatedAt: 10 },
    { nativeId: 'other', name: '其他会话', cwd: '', updatedAt: 1 },
  ] };
  assert.equal(firstSelectableNativeSession(catalog)?.nativeId, 'new');
  assert.deepEqual(nativeSessionsInGroup(catalog, 'p').map(session => session.nativeId), ['linked', 'new']);
  assert.deepEqual(nativeSessionsInGroup(catalog, '__ungrouped__').map(session => session.nativeId), ['other']);
  const html = renderToStaticMarkup(React.createElement(NativeSessionBrowser, { catalog, groupId: 'p', selectedIds: ['linked', 'new'], onChange: () => {} }));
  const linked = [...html.matchAll(/<button[\s\S]*?<\/button>/g)].find(match => match[0].includes('已加入的会话'))?.[0] || '';
  assert.match(linked, /disabled=""/); assert.match(linked, /aria-checked="false"/); assert.match(linked, /已在工作台/);
  assert.doesNotMatch(html, /其他会话/);
});
