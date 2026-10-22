import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { findCodexRollout, prepareCodexStorage } from '../src/core/codex-storage';
import { listNativeSessions, resolveNativeSession } from '../src/core/native-sessions';
import { readCodexTranscript, sameCodexRolloutPath } from '../src/core/native-transcript';
import { prepareDesktopRollout } from '../src/core/native-publish';
import { readCodexRollout } from '../src/core/codex-rollout';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import type { AgentSession } from '../src/shared/types';

const item = (id: string, type: string, text: string) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { id, type, content: [{ type: 'text', text }], command: ['echo', text], aggregated_output: text, exit_code: 0 } } });
const history = (id: string) => [
  { type: 'session_meta', payload: { id } }, item('user', 'UserMessage', '原问题'), item('tool', 'CommandExecution', '证据'), item('assistant', 'AgentMessage', '已验证'),
  { type: 'compacted', payload: { message: '完整压缩状态', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '原问题' }] }] } },
].map(value => JSON.stringify(value)).join('\n') + '\n';
const session = (id: string, root: string): AgentSession => ({ id: randomUUID(), nativeId: id, provider: 'codex', purpose: 'work', title: '压缩会话', cwd: root, createdAt: '', status: 'idle', messages: [], approvals: [], sources: [], handoffPath: '', autoUpload: false });
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wb-compressed-'))), home = path.join(root, 'codex');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('wb-compressed-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, home, async put(id: string, compressed = true, content = history(id)) {
    const file = path.join(home, 'sessions', 'rollout-' + id + '.jsonl' + (compressed ? '.zst' : ''));
    await fs.writeFile(file, compressed ? zstdCompressSync(content) : content); return file;
  }, index(rows: { id: string; archived?: number }[]) {
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE projects (id TEXT, name TEXT, position INTEGER); CREATE TABLE thread_sections (id TEXT, name TEXT); CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT);');
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) insert.run(row.id, '压缩会话', '', '', root, null, null, row.archived || 0, 1, null);
    } finally { db.close(); }
  } };
}

test('Codex discovery includes compressed history, deduplicates formats, and still excludes archived or missing records', async t => {
  const f = await fixture(t), ids = Array.from({ length: 23 }, () => randomUUID());
  for (const [i, id] of ids.entries()) if (i !== 22) await f.put(id, i >= 2);
  await f.put(ids[2], false);
  f.index(ids.map((id, i) => ({ id, archived: i === 21 ? 1 : 0 })));
  const catalog = await listNativeSessions('codex');
  assert.equal(catalog.sessions.length, 21); assert.equal(new Set(catalog.sessions.map(s => s.nativeId)).size, 21);
  assert.equal(catalog.sessions.filter(s => s.unavailable).length, 0);
  assert((await findCodexRollout(f.home, ids[2]))!.endsWith('.jsonl'), 'resumed plain history takes precedence over a compressed copy');
  assert((await resolveNativeSession('codex', ids[3]))!.nativePath.endsWith('.jsonl.zst'));
});

test('compressed transcripts preserve dialogue and tools; missing or invalid compressed files fail explicitly', async t => {
  const f = await fixture(t), id = randomUUID(), compressed = await f.put(id), before = await fs.readFile(compressed);
  const plain = await f.put(id, false);
  assert.deepEqual(await readCodexTranscript(compressed), await readCodexTranscript(plain));
  assert.deepEqual((await readCodexTranscript(compressed)).map(m => m.role), ['user', 'tool', 'assistant']);
  assert.equal((await readCodexRollout(compressed)).toString(), history(id));
  assert.deepEqual(await fs.readFile(compressed), before);
  await assert.rejects(readCodexTranscript(compressed + '.missing.zst'), /ENOENT/);
  const broken = path.join(f.root, 'broken.jsonl.zst'); await fs.writeFile(broken, 'not a compressed stream');
  await assert.rejects(readCodexTranscript(broken));
});

test('private imports preserve the original compressed record and carry its complete execution history', async t => {
  const f = await fixture(t), id = randomUUID(), file = await f.put(id), original = await fs.readFile(file);
  const s = { ...session(id, f.root), nativeLive: true, nativePath: file };
  const storage = await prepareCodexStorage(path.join(f.root, 'workbench'), s, f.home);
  assert.notEqual(storage.resumePath, file); assert(storage.resumePath!.endsWith('.jsonl.zst'));
  assert.equal((await readCodexRollout(storage.resumePath!)).toString(), history(id));
  assert.deepEqual(await fs.readFile(file), original); assert(s.codexPrivateFork);
});

test('desktop attachment compares decoded histories and retains tools and compaction without overwriting conflicts', async t => {
  const f = await fixture(t), id = randomUUID(), source = await f.put(id), desktop = path.join(f.root, 'desktop');
  const s = { ...session(id, f.root), codexStorage: 'workbench' as const, nativePath: source };
  const prepared = await prepareDesktopRollout(s, f.home, desktop);
  assert.equal((await fs.readFile(prepared.nativePath!)).toString(), history(id));
  assert.equal((await readCodexRollout(source)).toString(), history(id));
  // Different storage formats with identical execution history are the same record.
  await fs.writeFile(prepared.nativePath! + '.zst', zstdCompressSync(history(id))); await fs.unlink(prepared.nativePath!);
  assert.equal((await prepareDesktopRollout(s, f.home, desktop)).nativePath, prepared.nativePath! + '.zst');
  const different = zstdCompressSync(history(id) + JSON.stringify(item('new', 'UserMessage', '其他分支')) + '\n');
  await fs.writeFile(prepared.nativePath! + '.zst', different);
  await assert.rejects(prepareDesktopRollout(s, f.home, desktop), /内容不同/);
  assert.deepEqual(await fs.readFile(prepared.nativePath! + '.zst'), different);
});

test('native resume may materialize the same compressed path but must not redirect to another record', () => {
  const plain = path.resolve('sessions', 'rollout-' + randomUUID() + '.jsonl');
  assert(sameCodexRolloutPath(plain, plain + '.zst'));
  assert(sameCodexRolloutPath(plain + '.zst', plain + '.zst'));
  assert(!sameCodexRolloutPath(plain + '.zst', plain));
  assert(!sameCodexRolloutPath(path.join(path.dirname(plain), 'other.jsonl'), plain + '.zst'));
  assert(!sameCodexRolloutPath(path.join(path.dirname(plain), 'other', path.basename(plain)), plain + '.zst'));
});

test('an imported compressed chat follows native materialization and later recompression without losing new messages', async t => {
  const f = await fixture(t), id = randomUUID(), compressed = await f.put(id); f.index([{ id }]);
  const wb = new Workbench(path.join(f.root, 'workbench'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, f.root);
    const linked = await wb.linkNativeSession('codex', id, offlineProjectId);
    assert.equal(linked.messages.length, 3); assert.equal(linked.nativePath, compressed);
    const updated = history(id) + JSON.stringify(item('next', 'AgentMessage', '恢复后新回复')) + '\n';
    const plain = await f.put(id, false, updated);
    const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { assert(Date.now() < end, 'native transcript did not refresh'); await new Promise(resolve => setTimeout(resolve, 30)); } };
    await until(() => linked.nativePath === plain && linked.messages.some(m => m.text === '恢复后新回复'));
    await fs.writeFile(compressed, zstdCompressSync(updated)); await fs.unlink(plain);
    await until(() => linked.nativePath === compressed);
    assert.equal(linked.messages.length, 4);
  } finally { await wb.close(); }
});
