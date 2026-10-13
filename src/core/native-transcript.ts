import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../shared/types';

const transcriptLimit = 300;
const textLimit = 8000;
const toolLimit = 2000;
const clip = (value: string, max: number) => { const text = value.replace(/\u0000/g, '').trim(); return text.length > max ? text.slice(0, max) + '…' : text; };
const textOf = (value: unknown) => typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '';

export function sameNativePath(left: string, right: string) {
  const clean = (value: string) => {
    let file = value.trim();
    if (file.startsWith('file:')) { try { file = fileURLToPath(file); } catch { /* Keep the original when it is not a file URL. */ } }
    file = file.replace(/^\\\\\?\\/, '');
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return !!left.trim() && clean(left) === clean(right);
}

export function nativeCwd(value: string) {
  let cwd = value.trim();
  if (!cwd) return '';
  if (cwd.startsWith('file:')) { try { cwd = fileURLToPath(cwd); } catch { return ''; } }
  return path.resolve(cwd.replace(/^\\\\\?\\/, ''));
}

function partsText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function codexItem(payload: any): { id: string; role: Message['role']; text: string; at?: number } | undefined {
  if (payload?.type !== 'item_completed' || !payload.item || typeof payload.item !== 'object') return;
  const item = payload.item, id = String(item.id || ''), at = typeof payload.completed_at_ms === 'number' ? payload.completed_at_ms : undefined;
  if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
    const text = clip(partsText(item.content), textLimit);
    if (!text) return;
    return { id, role: item.type === 'UserMessage' ? 'user' : 'assistant', text, at };
  }
  if (item.type === 'Reasoning') return;
  if (item.type === 'ContextCompaction') return { id, role: 'system', text: '上下文已压缩', at };
  if (item.type === 'CommandExecution') {
    const command = Array.isArray(item.command) ? item.command.map((part: unknown) => typeof part === 'string' ? part : '').filter(Boolean).join(' ') : String(item.command || '');
    const output = String(item.aggregated_output || item.stdout || '');
    return { id, role: 'tool', text: clip([command, item.exit_code === undefined ? '' : '退出 ' + item.exit_code, output].filter(Boolean).join('\n'), toolLimit), at };
  }
  if (item.type === 'FileChange') {
    const paths = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [];
    return { id, role: 'tool', text: clip('修改文件 ' + (paths.join('、') || '（未列出路径）') + (item.status ? ' · ' + item.status : ''), toolLimit), at };
  }
  if (item.type === 'McpToolCall') return { id, role: 'tool', text: clip([item.server, item.tool].filter(Boolean).join(' / ') || '工具调用', toolLimit), at };
  if (item.type === 'Extension') return { id, role: 'tool', text: clip([item.kind, item.query].filter(Boolean).join(' '), toolLimit) || '扩展操作', at };
  if (item.type === 'ImageView') return { id, role: 'tool', text: clip('查看图片 ' + String(item.path || ''), toolLimit), at };
}

function finish(messages: Message[], seen: number) {
  const visible = messages.slice(-transcriptLimit);
  if (seen > visible.length) visible.unshift({ id: 'native:earlier', role: 'system', text: '更早的对话仍在原来的会话里，这里显示最近 ' + transcriptLimit + ' 条。', createdAt: visible[0]?.createdAt || new Date(0).toISOString() });
  return visible;
}

export async function readCodexTranscript(file: string): Promise<Message[]> {
  const messages: Message[] = [], seenIds = new Set<string>();
  let seen = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let payload: any;
    try { payload = JSON.parse(line).payload; } catch { continue; }
    const item = codexItem(payload);
    if (!item) continue;
    const id = 'native:' + (item.id || String(seen));
    if (seenIds.has(id)) continue;
    seenIds.add(id); seen++;
    messages.push({ id, role: item.role, text: item.text, createdAt: new Date(item.at || 0).toISOString() });
  }
  return finish(messages, seen);
}

function cursorMessage(value: any, index: number, createdAt: string): Message | undefined {
  const role = value?.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return;
  if (role === 'tool') {
    const part = Array.isArray(value.content) ? value.content.find((item: any) => item && (item.toolName || item.result !== undefined)) : undefined;
    const name = String(part?.toolName || '工具');
    const result = typeof part?.result === 'string' ? part.result : part?.result === undefined ? '' : JSON.stringify(part.result);
    return { id: 'native:cursor-' + index, role: 'tool', text: clip(name + (result ? '\n' + result : ''), toolLimit), createdAt };
  }
  const text = clip(partsText(value.content), textLimit);
  if (!text) return;
  return { id: 'native:cursor-' + index, role, text, createdAt };
}

export function readCursorTranscript(directory: string): Message[] {
  const file = path.join(directory, 'store.db');
  if (!fs.existsSync(file)) return [];
  const createdAt = fs.statSync(file).mtime.toISOString();
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1500 });
  try {
    const messages: Message[] = [];
    let index = 0;
    for (const row of db.prepare('SELECT data FROM blobs ORDER BY rowid').all() as { data?: Uint8Array | string }[]) {
      const raw = textOf(row.data).trim();
      if (!raw.startsWith('{')) continue;
      let value: any;
      try { value = JSON.parse(raw); } catch { continue; }
      const message = cursorMessage(value, index++, createdAt);
      if (message) messages.push(message);
    }
    return finish(messages, messages.length);
  } finally { db.close(); }
}

export function nativeTranscriptChanged(existing: Message[], next: Message[]) {
  if (existing.length !== next.length) return true;
  return existing.some((message, index) => {
    const other = next[index];
    return message.id !== other.id || message.role !== other.role || message.text !== other.text || message.userText !== other.userText;
  });
}

export function applyNativeTranscript(existing: Message[], parsed: Message[]) {
  if (!parsed.length) return existing;
  const nativeCount = existing.filter(message => message.id.startsWith('native:')).length;
  if (parsed.length < nativeCount) return existing;
  const users = existing.filter(message => message.role === 'user');
  const nativeId = (id: string) => id.replace(/^native:/, '');
  const byId = new Map(users.map(message => [nativeId(message.id), message]));
  // Reserve ID matches before falling back to text, so repeated prompts cannot
  // steal one another's raw input or context receipts when history is refreshed.
  const reserved = new Set(parsed.filter(message => message.role === 'user').map(message => byId.get(nativeId(message.id))).filter(Boolean));
  const used = new Set<Message>();
  return parsed.map(message => {
    if (message.role !== 'user') return message;
    const matches = (text: string) => text === message.text || clip(text, textLimit) === message.text;
    const available = users.filter(previous => !reserved.has(previous) && !used.has(previous));
    const previous = byId.get(nativeId(message.id))
      || available.find(previous => matches(previous.text) || previous.userText !== undefined && matches(previous.userText));
    if (!previous || used.has(previous)) return message;
    used.add(previous);
    return { ...message, context: previous.context, userText: previous.userText, steering: previous.steering };
  });
}
