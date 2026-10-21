import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSession, FilePreview, SessionFile } from '../shared/types';

export function sessionFilePath(session: Pick<AgentSession, 'cwd'>, value: string) {
  let target = value.trim().replace(/^<|>$/g, '');
  if (/^file:/i.test(target)) { const url = new URL(target); if (url.hostname && url.hostname !== 'localhost') throw new Error('不支持打开网络文件'); target = fileURLToPath(url); }
  else { try { target = decodeURIComponent(target); } catch { /* Plain paths may contain a literal %. */ } }
  target = target.replace(/#L?\d+(?:C\d+)?(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '');
  if (process.platform === 'win32' && /^\/[a-z]:[/\\]/i.test(target)) target = target.slice(1);
  if (!target || /[\x00-\x1f]/.test(target) || /^[\\/]{2}/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[/\\]/i.test(target)) throw new Error('不是可打开的本地文件路径');
  return path.resolve(session.cwd, target);
}

export function mentionedFiles(session: AgentSession) {
  const paths = new Set<string>();
  const add = (value: string) => { try { const target = sessionFilePath(session, value); if (path.extname(target)) paths.add(target); } catch { /* Ignore non-local URLs and prose. */ } };
  for (const value of session.outputFiles || []) add(value);
  for (const message of session.messages) {
    if (!['assistant', 'tool'].includes(message.role)) continue;
    for (const match of message.text.matchAll(/\[[^\]\n]*\]\(<?([^\n]*?)>?\)/g)) add(match[1]);
    for (const match of message.text.matchAll(/`([^`\n]+)`/g)) if (!/[\s]/.test(match[1]) || /[/\\]/.test(match[1])) add(match[1]);
    for (const match of message.text.matchAll(/(?:[A-Za-z]:[\\/]|file:\/\/\/)[^\s<>"`|]+/g)) add(match[0].replace(/[，。；、)）]+$/, ''));
    if (message.role === 'tool') { try { const item = JSON.parse(message.text); if (item.type === 'fileChange') for (const change of item.changes || []) if (typeof change.path === 'string') add(change.path); } catch { /* Most tool output is text. */ } }
  }
  return [...paths];
}

export async function listSessionFiles(session: AgentSession): Promise<SessionFile[]> {
  const files = await Promise.all(mentionedFiles(session).slice(-300).map(async target => {
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat?.isFile()) return undefined;
    return { path: target, name: path.basename(target), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }));
  return files.filter((item): item is SessionFile => !!item).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function checkedSessionFile(session: AgentSession, input: string) {
  const target = sessionFilePath(session, input), relative = path.relative(session.cwd, target);
  if ((relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) && !mentionedFiles(session).includes(target)) throw new Error('文件不属于此会话的工作目录，也未在会话中记录');
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat?.isFile()) throw new Error('文件不存在或已移动：' + target);
  return { target, stat };
}

export async function previewSessionFile(session: AgentSession, input: string): Promise<FilePreview> {
  const { target, stat } = await checkedSessionFile(session, input), name = path.basename(target), extension = path.extname(target).toLowerCase();
  const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  if (mime[extension] && stat.size <= 5 * 1024 * 1024) return { name, path: target, type: 'image', size: stat.size, truncated: false, content: `data:${mime[extension]};base64,` + (await fs.readFile(target)).toString('base64') };
  const textFile = /\.(md|txt|log|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|cfg|conf|py|js|mjs|cjs|ts|tsx|jsx|html|css|scss|sql|sh|ps1|bat|cmd|c|h|cpp|hpp|rs|go|java|r|vue|svelte|svg)$/i.test(extension);
  if (!textFile) return { name, path: target, type: 'binary', size: stat.size, truncated: false, content: '' };
  const limit = 512 * 1024, handle = await fs.open(target, 'r');
  try { const buffer = Buffer.alloc(Math.min(limit, stat.size)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return { name, path: target, type: 'text', size: stat.size, truncated: stat.size > limit, content: buffer.subarray(0, bytesRead).toString('utf8') }; }
  finally { await handle.close(); }
}
