import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { findCodexRollout, prepareCodexStorage } from '../src/core/codex-storage';
import { codexRolloutPath, readCodexRollout } from '../src/core/codex-rollout';
import { listNativeSessions, resolveNativeSession } from '../src/core/native-sessions';
import { readCodexTranscript } from '../src/core/native-transcript';
import { prepareDesktopRollout } from '../src/core/native-publish';
import { canImportNativeSession } from '../src/shared/native-sessions';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import type { AgentSession } from '../src/shared/types';

const history = (id: string, cwd: string) => [
  { type: 'session_meta', payload: { id, cwd, history_mode: 'paginated' } },
  { type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000000000, item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '原来的问题' }] } } },
  { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":"echo evidence"}' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'evidence' } },
  { type: 'compacted', payload: { message: '保留项目约定', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '原来的问题' }] }] } },
  { type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: 1700000001000, item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'text', text: '原来的回复' }] } } },
].map(item => JSON.stringify(item)).join('\n') + '\n';

async function fixture(run: (value: { root: string; home: string; workspace: string; ids: string[]; file: (id: string) => string }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-codex-compressed-'));
  const home = path.join(root, 'personal'), workspace = path.join(root, 'workspace');
  const previousHome = process.env.CODEX_HOME, previousBridge = process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  process.env.CODEX_HOME = home; delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  try {
    const directory = path.join(home, 'sessions', '2026', '10', '08');
    await fs.mkdir(directory, { recursive: true }); await fs.mkdir(workspace);
    const ids = Array.from({ length: 68 }, () => randomUUID());
    const file = (id: string) => path.join(directory, 'rollout-2026-10-08T09-00-00-' + id + '.jsonl.zst');
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      db.exec(`CREATE TABLE projects (id TEXT, name TEXT, position INTEGER);
        CREATE TABLE thread_sections (id TEXT, name TEXT);
        CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT, source TEXT);
        INSERT INTO projects VALUES ('p', '原 Codex 项目', 0);`);
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [index, id] of ids.entries()) {
        const source = index === 65 ? JSON.stringify({ subagent: { other: 'guardian' } }) : index === 66 ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: ids[0] } } }) : 'vscode';
        insert.run(id, index === 0 ? 'Guardian 使用说明' : '历史会话 ' + index, '', '', workspace, 'p', null, index === 67 ? 1 : 0, 1000 + index, null, source);
        if (index !== 64) await fs.writeFile(file(id), zstdCompressSync(history(id, workspace)));
      }
    } finally { db.close(); }
    await run({ root, home, workspace, ids, file });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousBridge === undefined) delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE; else process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE = previousBridge;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('lists all compressed Codex chats beyond a page, preserves projects and reports missing histories while excluding subagents', async () => {
  await fixture(async ({ ids, file }) => {
    const catalog = await listNativeSessions('codex', new Map([[ids[1], 'already-linked']]));
    assert.equal(catalog.sessions.length, 65);
    assert.equal(catalog.groups[0].name, '原 Codex 项目');
    assert(catalog.sessions.every(session => session.groupId === 'p'));
    assert.equal(catalog.sessions.find(session => session.nativeId === ids[0])?.name, 'Guardian 使用说明', 'filter metadata, never user-visible titles');
    assert.equal(canImportNativeSession(catalog.sessions.find(session => session.nativeId === ids[1])!), false);
    assert.match(catalog.sessions.find(session => session.nativeId === ids[64])?.unavailable || '', /历史文件未找到/);
    assert.equal(catalog.sessions.filter(canImportNativeSession).length, 63);
    assert.equal((await resolveNativeSession('codex', ids[2]))?.nativePath, file(ids[2]));
    for (const index of [64, 65, 66, 67]) assert.equal(await resolveNativeSession('codex', ids[index]), undefined);
  });
});

test('reads compressed dialogue, prefers a current uncompressed rollout, and rejects corrupt or missing input', async () => {
  await fixture(async ({ ids, file, home, workspace }) => {
    const compressed = file(ids[0]), original = await fs.readFile(compressed);
    assert.deepEqual((await readCodexTranscript(compressed)).map(message => message.text), ['原来的问题', '原来的回复']);
    assert.equal((await readCodexRollout(compressed)).toString(), history(ids[0], workspace));
    assert.equal(await findCodexRollout(home, ids[0]), compressed);
    const plain = codexRolloutPath(compressed);
    await fs.writeFile(plain, 'new live history\n');
    assert.equal(await findCodexRollout(home, ids[0]), plain);
    assert.deepEqual(await fs.readFile(compressed), original);
    await fs.writeFile(compressed, 'invalid Zstandard');
    await assert.rejects(readCodexTranscript(compressed));
    await fs.unlink(compressed);
    await fs.unlink(plain);
    await assert.rejects(readCodexTranscript(compressed));
  });
});

test('an imported transcript follows native decompression and later recompression without reimporting', async () => {
  await fixture(async ({ ids, file, root, workspace }) => {
    const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert(check(), 'native transcript did not follow the history format change');
    };
    try {
      await wb.store.init(); grantTestWorkspace(wb, workspace);
      const session = await wb.linkNativeSession('codex', ids[0], offlineProjectId);
      const compressed = file(ids[0]), plain = codexRolloutPath(compressed);
      const event = (id: string, text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id, content: [{ type: 'text', text }] } } }) + '\n';
      const continued = history(ids[0], workspace) + event('a2', '原生续聊');
      await fs.writeFile(plain, continued); await fs.unlink(compressed);
      assert.equal((await readCodexTranscript(compressed)).at(-1)?.text, '原生续聊', 'reads tolerate a native format change between discovery and import');
      await waitFor(() => session.nativePath === plain && session.messages.at(-1)?.text === '原生续聊');
      await fs.writeFile(compressed, zstdCompressSync(continued + event('a3', '再次压缩后续聊'))); await fs.unlink(plain);
      await waitFor(() => session.nativePath === compressed && session.messages.at(-1)?.text === '再次压缩后续聊');
      await assert.rejects(wb.linkNativeSession('codex', ids[0], offlineProjectId), /不能重复导入/);
    } finally { await wb.close(); }
  });
});

test('batch imports compressed chats with dialogue and deduplication; private continuation retains exact tools and compaction', async () => {
  await fixture(async ({ ids, file, root, workspace, home }) => {
    const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
    try {
      await wb.store.init(); grantTestWorkspace(wb, workspace);
      const originals = await Promise.all(ids.slice(0, 2).map(id => fs.readFile(file(id))));
      const sessions = await wb.linkNativeSessions('codex', ids.slice(0, 2), offlineProjectId);
      assert.equal(sessions.length, 2);
      for (const [index, session] of sessions.entries()) {
        assert.equal(session.nativePath, file(ids[index]));
        assert.deepEqual(session.messages.map(message => message.text), ['原来的问题', '原来的回复']);
      }
      await assert.rejects(wb.linkNativeSessions('codex', [ids[2], ids[0]], offlineProjectId), /不能重复导入/);
      assert.equal(wb.store.sessions.filter(session => session.nativeId === ids[2]).length, 0);
      const copy = structuredClone(sessions[0]);
      const storage = await prepareCodexStorage(path.join(root, 'private'), copy, home);
      assert(storage.resumePath?.endsWith('.jsonl'));
      assert.equal(await fs.readFile(storage.resumePath!, 'utf8'), history(ids[0], workspace));
      assert.equal(copy.nativeSourceId, ids[0]); assert.equal(copy.codexPrivateFork, true);
      for (let index = 0; index < 2; index++) assert.deepEqual(await fs.readFile(file(ids[index])), originals[index]);
      const legacy = await prepareCodexStorage(path.join(root, 'legacy'), { ...sessions[1], nativeLive: false }, home);
      assert.equal(await fs.readFile(legacy.resumePath!, 'utf8'), history(ids[1], workspace));
      await wb.closeSession(sessions[0].id);
      assert.equal((await wb.listNativeSessions('codex')).sessions.find(session => session.nativeId === ids[0])?.linkedSessionId, sessions[0].id);
    } finally { await wb.close(); }
  });
});

test('desktop publication validates full compressed history and reuses an identical compressed desktop record', async () => {
  await fixture(async ({ ids, file, home, root, workspace }) => {
    const desktop = path.join(root, 'desktop'); await fs.mkdir(desktop);
    const session = { provider: 'codex', purpose: 'work', nativeId: ids[0], nativePath: file(ids[0]), codexStorage: 'workbench', messages: [] } as unknown as AgentSession;
    const prepared = await prepareDesktopRollout(session, home, desktop);
    assert(prepared.nativePath?.endsWith('.jsonl'));
    assert.equal(await fs.readFile(prepared.nativePath!, 'utf8'), history(ids[0], workspace));
    const compressed = prepared.nativePath! + '.zst';
    await fs.writeFile(compressed, zstdCompressSync(history(ids[0], workspace))); await fs.unlink(prepared.nativePath!);
    assert.equal((await prepareDesktopRollout(session, home, desktop)).nativePath, compressed);
    const original = await fs.readFile(compressed);
    await fs.writeFile(file(ids[0]), zstdCompressSync(history(ids[0], workspace) + '{}\n'));
    await assert.rejects(prepareDesktopRollout(session, home, desktop), /内容不同/);
    assert.deepEqual(await fs.readFile(compressed), original);
  });
});
