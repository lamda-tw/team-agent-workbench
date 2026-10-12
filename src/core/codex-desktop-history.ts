import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SyncResult = 'copied' | 'current' | 'behind' | 'unavailable';
type Row = Record<string, string | number | null>;

async function newestSqlite(directory: string, prefix: string) {
  const names = (await fs.readdir(directory).catch((error: any) => { if (error.code === 'ENOENT') return [] as string[]; throw error; })).filter(name => new RegExp('^' + prefix + '\\d+\\.sqlite$').test(name));
  names.sort((left, right) => Number(left.match(/\d+/)![0]) - Number(right.match(/\d+/)![0]));
  return names.length ? path.join(directory, names[names.length - 1]) : undefined;
}

function columns(db: DatabaseSync, table: string) {
  return (db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map(column => column.name);
}

function sharedColumns(source: DatabaseSync, target: DatabaseSync, table: string) {
  const present = new Set(columns(target, table));
  return columns(source, table).filter(name => present.has(name));
}

function projection(db: DatabaseSync, threadId: string) {
  const row = db.prepare('SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id = ?').get(threadId) as { next_rollout_byte_offset: number; next_rollout_ordinal: number } | undefined;
  return { offset: row?.next_rollout_byte_offset || 0, ordinal: row?.next_rollout_ordinal || 0 };
}

function messageText(row: Row) {
  if (row.item_type !== 'userMessage' && row.item_type !== 'agentMessage' || typeof row.item_json !== 'string') return;
  try {
    const text = JSON.parse(row.item_json).text;
    if (typeof text === 'string' && text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, 240);
  } catch { return; }
}

function openWritable(file: string) {
  try { return new DatabaseSync(file, { timeout: 1500 }); }
  catch (error: any) { throw new Error('桌面 Codex 的会话索引正被占用，请稍后重新打开这条会话：' + (error?.message || error)); }
}

function copyRows(source: DatabaseSync, target: DatabaseSync, table: string, threadId: string, ordinal: number, idColumn: string) {
  const names = sharedColumns(source, target, table);
  if (!names.includes('rollout_ordinal') || !names.includes(idColumn)) return [] as Row[];
  const rows = source.prepare('SELECT ' + names.join(', ') + ' FROM ' + table + ' WHERE thread_id = ? AND rollout_ordinal >= ? ORDER BY rollout_ordinal').all(threadId, ordinal) as Row[];
  const existing = target.prepare('SELECT ' + idColumn + ' AS id FROM ' + table + ' WHERE thread_id = ? AND rollout_ordinal = ?');
  const insert = target.prepare('INSERT INTO ' + table + ' (' + names.join(', ') + ') VALUES (' + names.map(() => '?').join(', ') + ')');
  for (const row of rows) {
    const current = existing.get(threadId, row.rollout_ordinal) as { id?: string } | undefined;
    if (current?.id && current.id !== row[idColumn]) throw new Error('桌面 Codex 的会话索引与原会话记录不一致，已停止写入');
    if (!current?.id) insert.run(...names.map(name => row[name]));
  }
  return rows;
}

function rememberProjection(target: DatabaseSync, threadId: string, offset: number, ordinal: number) {
  target.prepare(`INSERT INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET next_rollout_byte_offset = excluded.next_rollout_byte_offset, next_rollout_ordinal = excluded.next_rollout_ordinal
    WHERE excluded.next_rollout_byte_offset > thread_history_projection_state.next_rollout_byte_offset`).run(threadId, offset, ordinal);
}

async function rememberThread(personalHome: string, privateSqlite: string, threadId: string, preview?: string) {
  const personal = await newestSqlite(personalHome, 'state_');
  const isolated = await newestSqlite(privateSqlite, 'state_');
  if (!personal || !isolated) return;
  const source = new DatabaseSync(isolated, { readOnly: true, timeout: 1500 });
  let target: DatabaseSync | undefined;
  try {
    const row = source.prepare('SELECT updated_at, updated_at_ms, recency_at, recency_at_ms FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    if (!row) return;
    target = openWritable(personal);
    const present = new Set(columns(target, 'threads'));
    const assignments: string[] = [];
    const values: (string | number | null)[] = [];
    for (const name of ['updated_at', 'updated_at_ms', 'recency_at', 'recency_at_ms']) if (present.has(name) && row[name] != null) { assignments.push(name + ' = ?'); values.push(row[name]); }
    if (preview && present.has('preview')) { assignments.push('preview = ?'); values.push(preview); }
    if (!assignments.length) return;
    values.push(threadId);
    const newer = present.has('updated_at_ms') && row.updated_at_ms != null ? ' AND (updated_at_ms IS NULL OR updated_at_ms < ?)' : '';
    if (newer) values.push(row.updated_at_ms);
    target.prepare('UPDATE threads SET ' + assignments.join(', ') + ' WHERE id = ?' + newer).run(...values);
  } finally { source.close(); target?.close(); }
}

export async function syncCodexDesktopHistory(threadId: string, personalHome: string, privateSqlite: string): Promise<SyncResult> {
  if (!threadIdPattern.test(threadId)) return 'unavailable';
  const personalHistory = await newestSqlite(personalHome, 'thread_history_');
  const isolatedHistory = await newestSqlite(privateSqlite, 'thread_history_');
  if (!personalHistory || !isolatedHistory) return 'unavailable';
  const source = new DatabaseSync(isolatedHistory, { readOnly: true, timeout: 1500 });
  let target: DatabaseSync | undefined;
  try {
    const incoming = projection(source, threadId);
    target = openWritable(personalHistory);
    const current = projection(target, threadId);
    if (incoming.offset <= current.offset) { await rememberThread(personalHome, privateSqlite, threadId); return 'current'; }
    const pending = source.prepare('SELECT COUNT(*) AS count FROM thread_items WHERE thread_id = ? AND rollout_ordinal >= ?').get(threadId, current.ordinal) as { count: number };
    if (!pending.count) return 'behind';
    let preview: string | undefined;
    target.exec('BEGIN IMMEDIATE');
    try {
      copyRows(source, target, 'thread_turns', threadId, current.ordinal, 'turn_id');
      const items = copyRows(source, target, 'thread_items', threadId, current.ordinal, 'item_id');
      rememberProjection(target, threadId, incoming.offset, incoming.ordinal);
      target.exec('COMMIT');
      preview = [...items].reverse().map(messageText).find(Boolean);
    } catch (error) {
      target.exec('ROLLBACK');
      throw error;
    }
    await rememberThread(personalHome, privateSqlite, threadId, preview);
    return 'copied';
  } finally { source.close(); target?.close(); }
}
