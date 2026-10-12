import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSession, Message } from '../shared/types';
import { findCodexRollout } from './codex-storage';
import { codexHome, cursorChatsRoot, nativeRecordAllowed } from './native-sessions';
import { nativeCwd } from './native-transcript';

const nativeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (value: string, max: number) => value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function stamp(value: string) {
  const date = new Date(value);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const part = (digit: number) => String(digit).padStart(2, '0');
  return { date: valid, folder: [String(valid.getFullYear()), part(valid.getMonth() + 1), part(valid.getDate())], clock: `${part(valid.getHours())}-${part(valid.getMinutes())}-${part(valid.getSeconds())}` };
}

function rolloutText(session: AgentSession, id: string) {
  const lines = [JSON.stringify({ timestamp: session.createdAt, type: 'session_meta', payload: { id, cwd: session.cwd, source: 'cli', timestamp: session.createdAt } })];
  for (const message of session.messages) {
    const item = rolloutItem(message);
    if (!item) continue;
    const at = Date.parse(message.createdAt);
    lines.push(JSON.stringify({ timestamp: message.createdAt, type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: Number.isNaN(at) ? Date.now() : at, item } }));
  }
  return lines.join('\n') + '\n';
}

function rolloutItem(message: Message) {
  const text = message.userText || message.text;
  if (!text.trim()) return;
  if (message.role === 'user') return { type: 'UserMessage', id: message.id, content: [{ type: 'text', text }] };
  if (message.role === 'assistant') return { type: 'AgentMessage', id: message.id, content: [{ type: 'text', text: message.text }] };
  if (message.role === 'tool') return { type: 'CommandExecution', id: message.id, command: [message.text], aggregated_output: '' };
}

async function codexStateFile(home: string) {
  const names = (await fs.readdir(home).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^state_\d+\.sqlite$/.test(name));
  names.sort((left, right) => Number(left.match(/\d+/)![0]) - Number(right.match(/\d+/)![0]));
  if (!names.length) throw new Error('没有找到桌面 Codex 的会话列表');
  return path.join(home, names[names.length - 1]);
}

async function publishCodex(session: AgentSession, privateHome: string) {
  const home = codexHome();
  const sessions = path.join(home, 'sessions');
  const info = await fs.lstat(sessions).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new Error('桌面 Codex 的会话目录不能是链接');
  await fs.mkdir(sessions, { recursive: true });
  const source = session.nativePath && (await fs.stat(session.nativePath).catch(() => undefined))?.isFile() ? session.nativePath : session.nativeId && nativeIdPattern.test(session.nativeId) ? await findCodexRollout(privateHome, session.nativeId) : undefined;
  const copied = source ? await fs.readFile(source, 'utf8') : '';
  const id = nativeIdPattern.test(session.nativeId || '') && !copied ? session.nativeId! : copiedId(copied) || (nativeIdPattern.test(session.nativeId || '') ? session.nativeId! : randomUUID());
  if (await findCodexRollout(home, id)) throw new Error('桌面 Codex 里已经有这条会话，没有覆盖');
  const when = stamp(session.createdAt);
  const destination = path.join(sessions, ...when.folder, `rollout-${when.folder.join('-')}T${when.clock}-${id}.jsonl`);
  if (!nativeRecordAllowed('codex', destination)) throw new Error('桌面 Codex 的会话路径无效');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, copied || rolloutText(session, id), { flag: 'wx' });
  const state = await codexStateFile(home);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(state, { timeout: 2000 });
    const existing = db.prepare('SELECT id FROM threads WHERE id = ?').get(id) as { id?: string } | undefined;
    if (existing?.id) throw new Error('桌面 Codex 里已经有这条会话，没有覆盖');
    const now = Date.now();
    const first = clip(session.messages.find(message => message.role === 'user')?.text || session.title, 2000);
    db.prepare(`INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode,
      tokens_used, has_user_event, archived, cli_version, first_user_message, memory_mode, preview, recency_at, recency_at_ms,
      history_mode, name, is_pinned, thread_source, originator, model
    ) VALUES (?, ?, ?, ?, 'cli', 'openai', ?, ?, '{"type":"workspace-write"}', 'on-request', 0, ?, 0, '', ?, 'enabled', ?, ?, ?, 'paginated', ?, 0, 'user', 'codex-tui', ?)`).run(
      id, destination, Math.floor(when.date.getTime() / 1000), Math.floor(now / 1000), session.cwd, first || session.title,
      first ? 1 : 0, first, clip(first || session.title, 240), Math.floor(now / 1000), now, clip(session.title, 120), session.model || null,
    );
  } catch (error: any) {
    await fs.rm(destination, { force: true });
    if (error?.message === '桌面 Codex 里已经有这条会话，没有覆盖') throw error;
    throw new Error('无法写入桌面 Codex 的会话列表，请先关闭桌面 Codex 后再试');
  } finally { db?.close(); }
  try {
    const index = path.join(home, 'session_index.jsonl');
    const current = await fs.readFile(index, 'utf8').catch((error: any) => { if (error.code === 'ENOENT') return ''; throw error; });
    if (!current.includes('"id":"' + id + '"')) await fs.appendFile(index, JSON.stringify({ id, thread_name: clip(session.title, 120), updated_at: Math.floor(Date.now() / 1000) }) + '\n');
  } catch { /* The desktop list is the threads row. A missing index line can be rewritten later. */ }
  return { nativeId: id, nativePath: destination };
}

function copiedId(text: string) {
  const line = text.split(/\n/).find(item => item.trim());
  if (!line) return;
  try {
    const value = JSON.parse(line);
    const id = value?.payload?.id;
    if (typeof id === 'string' && nativeIdPattern.test(id)) return id;
  } catch { /* A rollout without a readable header keeps the workbench id. */ }
}

async function publishCursor(session: AgentSession) {
  const cwd = nativeCwd(session.cwd);
  if (!cwd || !(await fs.stat(cwd).catch(() => undefined))?.isDirectory()) throw new Error('这条会话的工作目录已经不在，无法登记到 Cursor');
  const id = nativeIdPattern.test(session.nativeId || '') ? session.nativeId! : randomUUID();
  const root = cursorChatsRoot();
  const hashes = await fs.readdir(root, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const hash of hashes) {
    if (!hash.isDirectory() || hash.isSymbolicLink()) continue;
    const directory = path.join(root, hash.name, id);
    if ((await fs.stat(path.join(directory, 'meta.json')).catch(() => undefined))?.isFile()) {
      if (!nativeRecordAllowed('cursor', directory)) throw new Error('Cursor 的会话路径无效');
      return { nativeId: id, nativePath: directory, replaceTranscript: false };
    }
  }
  const directory = path.join(root, crypto.createHash('md5').update(cwd).digest('hex'), id);
  if (!nativeRecordAllowed('cursor', directory)) throw new Error('Cursor 的会话路径无效');
  await fs.mkdir(directory, { recursive: true });
  const now = Date.now();
  let wrote = false;
  try {
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify({ schemaVersion: 1, createdAtMs: Date.parse(session.createdAt) || now, updatedAtMs: now, hasConversation: session.messages.some(message => message.role === 'user' || message.role === 'assistant'), cwd, title: clip(session.title, 120) }, null, 2), { flag: 'wx' });
    wrote = true;
    const db = new DatabaseSync(path.join(directory, 'store.db'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT, value TEXT);');
      const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
      for (const message of session.messages) {
        if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
        const text = message.role === 'user' ? message.userText || message.text : message.text;
        if (!text.trim()) continue;
        const content = message.role === 'tool' ? [{ type: 'text', text, toolName: '工具', result: text }] : text;
        insert.run(message.id || randomUUID(), Buffer.from(JSON.stringify({ role: message.role, content })));
      }
    } finally { db.close(); }
  } catch (error) {
    if (wrote) await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { nativeId: id, nativePath: directory, replaceTranscript: true };
}

export async function publishToNativeList(session: AgentSession, privateCodexHome: string) {
  if (session.provider === 'codex') return { ...await publishCodex(session, privateCodexHome), replaceTranscript: true };
  if (session.provider === 'cursor') return publishCursor(session);
  throw new Error('只有 Codex 和 Cursor 会话可以登记到桌面端');
}
