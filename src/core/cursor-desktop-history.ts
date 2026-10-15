import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sameNativePath } from './native-transcript';

type RecordValue = Record<string, any>;
type ProtoValue = Uint8Array | bigint;
export interface CursorHistoryIssue { kind: string; id?: string; source?: string }
export interface CursorStoredMessage extends RecordValue { blobId: string; role: string; content?: unknown }
export interface CursorToolArtifact { blobId: string; toolCallId?: string; kind: 'read-file-content'; content: string }
export interface CursorDesktopHistory {
  title?: string;
  nativeId: string;
  cwd: string;
  status: string;
  settled: boolean;
  runtimeCheckpointAvailable: boolean;
  headersCount: number;
  bubbles: RecordValue[];
  promptMessages: CursorStoredMessage[];
  archivedMessages: CursorStoredMessage[];
  toolArtifacts: CursorToolArtifact[];
  toolCoverage: Array<{ callId: string; name: string; source: 'prompt' | 'archive' | 'missing' }>;
  checkpointSha256: string;
  stateFields: Array<{ number: number; count: number }>;
  summaryArchiveCount: number;
  issues: CursorHistoryIssue[];
}

// Cursor 3.24 stores a protobuf checkpoint whose byte fields refer to local blobs.
// This decoder skips unrelated fields; it does not rebuild an executable Agent state.
function protobufFields(bytes: Uint8Array) {
  const fields = new Map<number, ProtoValue[]>();
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= bytes.length) throw new Error('Cursor 状态记录不完整');
      const byte = bytes[offset++];
      if (index === 9 && byte > 1) throw new Error('Cursor 状态字段超出范围');
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('Cursor 状态字段无效');
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (tag > 0xffffffffn) throw new Error('Cursor 状态字段无效');
    const number = Number(tag) >>> 3, wire = Number(tag) & 7;
    if (!number) throw new Error('Cursor 状态字段无效');
    let value: ProtoValue;
    if (wire === 0) value = varint();
    else if (wire === 2 || wire === 1 || wire === 5) {
      const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error('Cursor 状态记录不完整');
      value = bytes.subarray(offset, offset + length); offset += length;
    } else throw new Error('当前 Cursor 状态格式尚未适配');
    const values = fields.get(number) || [];
    values.push(value); fields.set(number, values);
  }
  return fields;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function jsonRecord(raw: unknown): RecordValue {
  const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : '';
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cursor 记录格式无效');
  return value;
}
function checkpointBytes(encoded: unknown) {
  if (typeof encoded !== 'string' || !encoded) throw new Error('Cursor 尚未保存可读取的状态');
  if (encoded.startsWith('~')) {
    const base64 = encoded.slice(1);
    // A native prompt blocked before the first model call has a valid empty
    // protobuf checkpoint. Its UI history can exist without executable state.
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Cursor 状态编码无效');
    return Buffer.from(base64, 'base64');
  }
  if (!/^(?:[a-f0-9]{2})+$/i.test(encoded)) throw new Error('Cursor 状态编码无效');
  return Buffer.from(encoded, 'hex');
}

/** Scoped, read-only local history reader for the native IDE file transport.
 * Requires an exact native ID and local workspace. Does not read ItemTable/auth values,
 * write Cursor's database, generate summaries or promise CLI/desktop resumability.
 */
export function readCursorDesktopHistory(file: string, nativeId: string, cwd: string): CursorDesktopHistory {
  if (!uuid.test(nativeId)) throw new Error('Cursor 原生会话 ID 无效');
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1500 });
  try {
    db.exec('BEGIN');
    const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key=?');
    const row = get.get('composerData:' + nativeId);
    if (!row) throw new Error('未找到关联的 Cursor 原生会话');
    const root = jsonRecord(row.value);
    if (root.composerId !== nativeId) throw new Error('Cursor 原生会话身份不匹配');
    const uri = root.workspaceIdentifier?.uri;
    let actualCwd = '';
    try {
      const url = new URL(uri?.external);
      if (url.protocol === 'file:' && !url.host) actualCwd = fileURLToPath(url);
    } catch { /* Unknown and remote workspaces must not be inferred from titles. */ }
    if (!cwd.trim() || !actualCwd || !sameNativePath(actualCwd, cwd)) throw new Error('Cursor 原生会话工作目录不匹配');
    const headers = root.fullConversationHeadersOnly;
    if (!Array.isArray(headers)) throw new Error('当前 Cursor 历史格式尚未适配');
    const bubbles: RecordValue[] = [], issues: CursorHistoryIssue[] = [], ids = new Set<string>();
    for (const header of headers) {
      if (!header || typeof header.bubbleId !== 'string' || !uuid.test(header.bubbleId)) throw new Error('Cursor 消息索引无效');
      const id = header.bubbleId;
      if (ids.has(id)) { issues.push({ kind: 'duplicate-bubble', id }); continue; }
      ids.add(id);
      const record = get.get('bubbleId:' + nativeId + ':' + id);
      if (!record) { issues.push({ kind: 'missing-bubble', id }); continue; }
      const body = jsonRecord(record.value);
      if (body.bubbleId !== id) throw new Error('Cursor 消息身份不匹配');
      // Select history fields, not root authentication/encryption settings. Preserve full text.
      const bubble: RecordValue = { header };
      for (const key of ['bubbleId', 'type', 'text', 'createdAt', 'toolFormerData', 'toolResults', 'thinking', 'allThinkingBlocks', 'capabilityType', 'summarizationAborted', 'unifiedMode', 'agentMode', 'modelInfo', 'errorDetails']) {
        if (key in body) bubble[key] = body[key];
      }
      bubbles.push(bubble);
    }
    const bytes = checkpointBytes(root.conversationState), state = protobufFields(bytes), runtimeCheckpointAvailable = bytes.length > 0;
    if (!runtimeCheckpointAvailable) issues.push({ kind: 'empty-native-checkpoint' });
    const loadBlob = (reference: ProtoValue, source: string) => {
      if (!(reference instanceof Uint8Array) || reference.length !== 32) { issues.push({ kind: 'invalid-blob-ref', source }); return; }
      const id = Buffer.from(reference).toString('hex'), record = get.get('agentKv:blob:' + id);
      if (!record) { issues.push({ kind: 'missing-blob', id, source }); return; }
      const value = record.value;
      if (value instanceof Uint8Array) return { id, data: Buffer.from(value) };
      if (typeof value === 'string' && /^(?:[a-f0-9]{2})+$/i.test(value)) return { id, data: Buffer.from(value, 'hex') };
      issues.push({ kind: 'unsupported-blob', id, source });
    };
    const readMessages = (references: ProtoValue[], source: string, target: CursorStoredMessage[]) => {
      for (const reference of references) {
        const blob = loadBlob(reference, source);
        if (!blob) continue;
        try {
          const message = jsonRecord(blob.data);
          if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error();
          target.push({ ...message, blobId: blob.id, role: message.role });
        } catch { issues.push({ kind: 'unreadable-message', id: blob.id, source }); }
      }
    };
    const promptMessages: CursorStoredMessage[] = [], archivedMessages: CursorStoredMessage[] = [];
    const archives = state.get(13) || [];
    for (const reference of archives) {
      const blob = loadBlob(reference, 'summary-archive');
      if (!blob) continue;
      try { readMessages(protobufFields(blob.data).get(1) || [], 'archived-message', archivedMessages); }
      catch { issues.push({ kind: 'unreadable-archive', id: blob.id }); }
    }
    // A legacy field is reported rather than silently dropped or guessed.
    if (state.has(11)) issues.push({ kind: 'unsupported-legacy-summary-archive' });
    readMessages(state.get(1) || [], 'current-prompt-message', promptMessages);
    // A saved UI tool bubble does not imply its full result survived compaction.
    // Failed calls also have native model-visible results (for example Read's
    // "File not found"). Losing those is still incomplete history.
    const containsCall = (messages: CursorStoredMessage[], callId: string) => messages.some(message =>
      message.role === 'tool' && Array.isArray(message.content) && message.content.some(part => part?.type === 'tool-result' && part.toolCallId === callId));
    const toolCoverage: CursorDesktopHistory['toolCoverage'] = [];
    for (const bubble of bubbles) {
      const tool = bubble.toolFormerData;
      if (!['completed', 'error'].includes(tool?.status) || typeof tool?.toolCallId !== 'string') continue;
      const callId = tool.toolCallId, source = containsCall(promptMessages, callId) ? 'prompt' : containsCall(archivedMessages, callId) ? 'archive' : 'missing';
      toolCoverage.push({ callId, name: String(tool.name || ''), source });
      if (source === 'missing') issues.push({ kind: 'historical-tool-result-not-referenced', id: callId });
    }
    // Native Read moves larger original content into another referenced blob. The
    // model's formatted tool result and this original payload are different records.
    const toolArtifacts: CursorToolArtifact[] = [], artifactKeys = new Set<string>();
    for (const message of [...archivedMessages, ...promptMessages]) {
      if (message.role !== 'tool') continue;
      const reference = message.providerOptions?.cursor?.highLevelToolCallResult?.output?.success?.contentBlobId;
      if (reference === undefined) continue;
      if (typeof reference !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(reference)) { issues.push({ kind: 'invalid-blob-ref', source: 'tool-result-content' }); continue; }
      const blob = loadBlob(Buffer.from(reference, 'base64'), 'tool-result-content');
      if (!blob) continue;
      const part = Array.isArray(message.content) ? message.content.find(item => item?.type === 'tool-result') : undefined;
      const toolCallId = typeof part?.toolCallId === 'string' ? part.toolCallId : undefined;
      const key = blob.id + ':' + (toolCallId || message.blobId);
      if (artifactKeys.has(key)) continue;
      artifactKeys.add(key);
      try { toolArtifacts.push({ blobId: blob.id, toolCallId, kind: 'read-file-content', content: new TextDecoder('utf-8', { fatal: true }).decode(blob.data) }); }
      catch { issues.push({ kind: 'unreadable-artifact', id: blob.id, source: 'tool-result-content' }); }
    }
    return {
      nativeId, cwd: actualCwd, title: typeof root.name === 'string' ? root.name : undefined, status: String(root.status || 'unknown'),
      settled: runtimeCheckpointAvailable && root.status === 'completed' && Array.isArray(root.generatingBubbleIds) && root.generatingBubbleIds.length === 0,
      runtimeCheckpointAvailable,
      headersCount: headers.length, bubbles, promptMessages, archivedMessages, toolArtifacts, toolCoverage, issues,
      checkpointSha256: createHash('sha256').update(bytes).digest('hex'),
      stateFields: [...state].map(([number, values]) => ({ number, count: values.length })), summaryArchiveCount: archives.length,
    };
  } finally { db.close(); }
}
