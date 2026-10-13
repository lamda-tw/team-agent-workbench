import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentSession, PreparationScope, SourceFile } from '../shared/types';
import { atomicJson } from './store';
import { freezeFile } from './artifacts';
import { mentionedFiles } from './session-files';
import { preparationDelta } from '../shared/preparation-progress';
import { localWithin } from './paths';
import { isPersonalHandoffSource } from '../shared/session-context';

// Normalize legacy and new frozen inputs in the application, before invoking
// the model. Every generated reading file is ASCII JSON: decoding it does not
// depend on the shell's locale. Original attachment bytes/hashes stay intact.
export async function prepareReadableInputs(inputDir: string, active = () => true, projectBriefPaths = new Set<string>()) {
  const index = JSON.parse(await fs.readFile(path.join(inputDir, 'source-index.json'), 'utf8'));
  const conversation = JSON.parse(await fs.readFile(path.join(inputDir, 'conversation.json'), 'utf8'));
  await atomicJson(path.join(inputDir, 'conversation.json'), conversation, true);
  // A single tool message can contain hundreds of thousands of characters.
  // Keep the model's reading units bounded without dropping any message text.
  index.conversationPages = [];
  let page: { id: string; role: string; part: number; parts: number; text: string }[] = [], pageSize = 0;
  const flush = async () => {
    if (!page.length) return;
    if (!active()) throw new Error('整理已停止');
    const relative = `readable/conversation-${index.conversationPages.length + 1}.json`;
    await atomicJson(path.join(inputDir, relative), page, true);
    index.conversationPages.push(relative); page = []; pageSize = 0;
  };
  for (const message of conversation) {
    const parts = Math.max(1, Math.ceil(message.text.length / 4000));
    for (let part = 0; part < parts; part++) {
      const item = { id: message.id, role: message.role, part: part + 1, parts, text: message.text.slice(part * 4000, (part + 1) * 4000) };
      const size = JSON.stringify(item).length;
      if (pageSize + size > 8000) await flush();
      page.push(item); pageSize += size;
    }
  }
  await flush();
  const root = await fs.realpath(inputDir);
  const sources = [index.handoff, ...(index.files || [])].filter(Boolean);
  for (const [position, source] of sources.entries()) {
    // Automatically attached project briefs are represented once in the bounded
    // reference context. Explicitly selected user documents remain full inputs.
    if (projectBriefPaths.has(source.sourcePath)) { source.contextOnly = 'project-brief'; source.readPaths = []; continue; }
    if (!/\.(?:md|txt|json|jsonl|csv|log|py|js|mjs|cjs|ts|tsx|jsx|html|css|yaml|yml|toml|ini|xml|sql|sh|ps1|c|h|cpp|hpp|rs|go|java)$/i.test(source.localPath)) continue;
    const filename = await fs.realpath(source.localPath);
    if (!localWithin(root, filename)) throw new Error('冻结资料不在本次整理目录内，请重新整理');
    source.readPaths = [];
    let decoder: TextDecoder | undefined, pending = '';
    const write = async (text: string) => {
      if (!active()) throw new Error('整理已停止');
      const part = source.readPaths.length + 1, relative = `readable/material-${position + 1}-${part}.json`;
      await atomicJson(path.join(inputDir, relative), { id: source === index.handoff ? 'handoff' : 'file:' + source.id, name: source.name, part, text }, true);
      source.readPaths.push(relative);
    };
    for await (const bytes of createReadStream(filename)) {
      if (!active()) throw new Error('整理已停止');
      decoder ||= new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true });
      pending += decoder.decode(bytes, { stream: true });
      while (pending.length >= 8000) { await write(pending.slice(0, 8000)); pending = pending.slice(8000); }
    }
    pending += decoder?.decode() || '';
    if (pending || !source.readPaths.length) await write(pending);
  }
  await atomicJson(path.join(inputDir, 'source-index.json'), index, true);
  return { index, conversation };
}

interface PreparationSnapshotOptions {
  scope?: PreparationScope;
  baseDraftId?: string;
  baseLastMessageId?: string;
  baseCapturedAt?: string;
  baseMessageCount?: number;
  baseLastMessageLength?: number;
}

// Capture messages before the first await: ongoing work must not change this input.
export async function preparationSnapshot(session: AgentSession, inputDir: string, extraFiles: string[] = [], options: PreparationSnapshotOptions = {}) {
  const allMessages = structuredClone(session.messages), capturedAt = new Date().toISOString(), scope = options.scope || 'full';
  let messages = allMessages;
  if (scope === 'incremental') {
    const delta = preparationDelta({ messages: allMessages }, { capturedAt: options.baseCapturedAt || '', conversationHash: '', messageCount: options.baseMessageCount ?? -1, lastMessageId: options.baseLastMessageId, lastMessageLength: options.baseLastMessageLength });
    if (!delta.count) throw new Error(delta.reason);
    messages = allMessages.slice(delta.start);
  }
  // Automatically supplied personal project logs are discovery context, not
  // evidence contributed by this session to team results.
  const conversation = messages.map(m => ({ id: m.id, role: m.role, text: m.role === 'user' && m.context?.projectJournal ? m.userText ?? m.text : m.text, createdAt: m.createdAt }));
  const conversationHash = createHash('sha256').update(JSON.stringify(conversation)).digest('hex');
  await fs.mkdir(inputDir, { recursive: true });
  // Windows PowerShell 5 defaults to the system code page for BOM-less files.
  // ASCII JSON escapes preserve Chinese text even when a reader omits UTF-8.
  await atomicJson(path.join(inputDir, 'conversation.json'), conversation, true);
  let handoff: SourceFile | undefined, noteWarning: string | undefined;
  try { handoff = await freezeFile(session.handoffPath, inputDir); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; noteWarning = '阶段摘要缺失；依据冻结对话整理。'; }
  const files: SourceFile[] = [], briefId = session.projectBrief?.sourceId;
  for (const source of session.sources.filter(source => !isPersonalHandoffSource(source))) {
    const copy = await freezeFile(source.localPath, inputDir);
    const userAttachment = !source.contentRef && source.id !== briefId;
    files.push({ ...copy, name: source.name, sourcePath: source.sourcePath, ...(userAttachment ? { userAttachment: true } : {}) });
  }
  for (const file of extraFiles) files.push(await freezeFile(file, inputDir));
  // Only known files inside this session's workspace become candidates. Never crawl a directory.
  const canonical = session.cwd ? await fs.realpath(session.cwd).catch(() => '') : '';
  for (const candidate of canonical ? mentionedFiles(session).slice(-100) : []) {
    const relative = path.relative(session.cwd, candidate);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.')) || /(?:^|[/\\])(?:node_modules|credentials|secrets)(?:[/\\]|$)/i.test(relative) || /\.(?:pem|key|pfx|p12)$/i.test(relative) || files.some(file => file.sourcePath === candidate)) continue;
    try {
      const actual = await fs.realpath(candidate), inside = path.relative(canonical, actual), stat = await fs.lstat(candidate);
      if (path.isAbsolute(inside) || inside.startsWith('..') || !stat.isFile() || stat.size > 10 * 1024 * 1024 || files.length >= 30) continue;
      files.push(await freezeFile(candidate, inputDir));
    } catch { /* Missing or changing outputs can be added manually after preparation. */ }
  }
  const snapshot = { capturedAt, messageCount: messages.length, totalMessageCount: allMessages.length, lastMessageId: allMessages.at(-1)?.id, lastMessageLength: allMessages.at(-1)?.text.length, conversationHash, scope, baseDraftId: options.baseDraftId, baseLastMessageId: options.baseLastMessageId, baseCapturedAt: options.baseCapturedAt };
  await atomicJson(path.join(inputDir, 'source-index.json'), { sourceSessionId: session.id, ...snapshot, conversation: 'conversation.json', handoff, noteWarning, files }, true);
  return { files, snapshot };
}
