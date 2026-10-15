import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readCursorDesktopHistory } from '../src/core/cursor-desktop-history';

function varint(value: number) {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const field = (number: number, value: Uint8Array) => Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);

function fixture() {
  const testRoot = path.resolve('.test-data'); fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'cursor-history-test-')), cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd);
  const file = path.join(root, 'state.vscdb'), nativeId = randomUUID(), db = new DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO ItemTable VALUES (?,?)').run('private-auth', 'AUTH_SENTINEL_DO_NOT_EXPORT');
  const set = (key: string, value: string | Uint8Array) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?,?)').run(key, value);
  const blob = (value: object | Buffer, hex = false) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const id = createHash('sha256').update(bytes).digest(); set('agentKv:blob:' + id.toString('hex'), hex ? bytes.toString('hex') : bytes); return id;
  };
  const composer: any = { composerId: nativeId, status: 'completed', generatingBubbleIds: [],
    workspaceIdentifier: { uri: { external: pathToFileURL(cwd).href } }, fullConversationHeadersOnly: [],
    conversationState: '~' + field(1, blob({ role: 'user', content: 'test' })).toString('base64'),
    blobEncryptionKey: 'KEY_SENTINEL_DO_NOT_EXPORT', speculativeSummarizationEncryptionKey: 'SUMMARY_KEY_SENTINEL' };
  const save = () => set('composerData:' + nativeId, JSON.stringify(composer));
  const bubble = (text: string, extra: object = {}) => {
    const id = randomUUID(); composer.fullConversationHeadersOnly.push({ bubbleId: id, type: 2 });
    set('bubbleId:' + nativeId + ':' + id, JSON.stringify({ bubbleId: id, type: 2, text, ...extra })); return id;
  };
  const read = () => { save(); return readCursorDesktopHistory(file, nativeId, cwd); };
  const close = () => { db.close(); assert.equal(path.dirname(root), testRoot); fs.rmSync(root, { recursive: true }); };
  return { root, cwd, file, nativeId, db, composer, set, save, blob, bubble, read, close };
}

test('native headers, not SQLite row order or loaded DOM, determine history order', () => {
  const f = fixture();
  try {
    const first = f.bubble('第一条'), second = f.bubble('第二条');
    f.composer.fullConversationHeadersOnly.reverse();
    const result = f.read();
    assert.deepEqual(result.bubbles.map(bubble => bubble.bubbleId), [second, first]);
    assert.equal(result.settled, true); assert.deepEqual(result.issues, []);
  } finally { f.close(); }
});

test('complete tool arguments/results preserve Unicode and long native output', () => {
  const f = fixture();
  try {
    const text = '中文\n' + '完整结果'.repeat(6000) + '\nTAIL_MARKER', callId = 'native-call-1';
    f.bubble('', { toolFormerData: { toolCallId: callId, name: 'read_file_v2', result: '{"totalLinesInFile":3}' } });
    const call = f.blob({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: 'Read', args: { path: 'file.txt' } }] });
    const response = f.blob({ role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Read', result: text }] });
    f.composer.conversationState = '~' + Buffer.concat([field(1, call), field(1, response)]).toString('base64');
    const result = f.read();
    assert.equal((result.promptMessages[1].content as any[])[0].result, text);
    assert.equal((result.promptMessages[0].content as any[])[0].toolCallId, (result.promptMessages[1].content as any[])[0].toolCallId);
    assert.equal(result.bubbles[0].toolFormerData.result, '{"totalLinesInFile":3}');
    assert.deepEqual(result.issues, []);
  } finally { f.close(); }
});

test('summary archives and current prompt are read separately without reconstructing context', () => {
  const f = fixture();
  try {
    const old = f.blob({ role: 'tool', content: [{ type: 'tool-result', result: 'older tool output' }] });
    const archive = f.blob(field(1, old));
    const summary = f.blob({ role: 'user', content: 'native summary', providerOptions: { cursor: { isSummary: true } } });
    f.composer.conversationState = '~' + Buffer.concat([field(13, archive), field(1, summary)]).toString('base64');
    const result = f.read();
    assert.equal(result.summaryArchiveCount, 1); assert.equal(result.archivedMessages[0].role, 'tool');
    assert.equal(result.promptMessages[0].content, 'native summary'); assert.equal(result.promptMessages.length, 1);
    assert.deepEqual(result.issues, []);
  } finally { f.close(); }
});

test('large native Read content is resolved from its blob without changing the formatted model result', () => {
  const f = fixture();
  try {
    const content = '原始文件内容'.repeat(4000), artifact = f.blob(Buffer.from(content));
    const message = f.blob({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'Read', result: '    1|' + content }],
      providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { contentBlobId: artifact.toString('base64') } } } } } });
    f.composer.conversationState = '~' + field(1, message).toString('base64');
    const result = f.read();
    assert.equal(result.toolArtifacts[0].content, content); assert.equal(result.toolArtifacts[0].toolCallId, 'read-1');
    assert.equal((result.promptMessages[0].content as any[])[0].result, '    1|' + content);
    assert.deepEqual(result.issues, []);
    f.db.prepare('DELETE FROM cursorDiskKV WHERE key=?').run('agentKv:blob:' + artifact.toString('hex'));
    assert.deepEqual(f.read().issues.map(issue => issue.source), ['tool-result-content']);
  } finally { f.close(); }
});

test('exact native identity and workspace reject cross-conversation reads', () => {
  const f = fixture();
  try {
    f.save();
    assert.throws(() => readCursorDesktopHistory(f.file, 'not-an-id', f.cwd), /ID 无效/);
    assert.throws(() => readCursorDesktopHistory(f.file, randomUUID(), f.cwd), /未找到/);
    assert.throws(() => readCursorDesktopHistory(f.file, f.nativeId, path.join(f.root, 'other')), /工作目录不匹配/);
    f.composer.workspaceIdentifier.uri.external = 'file://remote-server/share/workspace';
    assert.throws(() => f.read(), /工作目录不匹配/);
    f.composer.composerId = randomUUID(); f.save();
    assert.throws(() => readCursorDesktopHistory(f.file, f.nativeId, f.cwd), /身份不匹配/);
  } finally { f.close(); }
});

test('missing/duplicate bubbles and missing blobs are reported instead of silently complete', () => {
  const f = fixture();
  try {
    const id = f.bubble('stored'); f.composer.fullConversationHeadersOnly.push({ bubbleId: id }, { bubbleId: randomUUID() });
    f.composer.conversationState = '~' + field(1, Buffer.alloc(32, 123)).toString('base64');
    const result = f.read();
    assert.deepEqual(result.issues.map(issue => issue.kind), ['duplicate-bubble', 'missing-bubble', 'missing-blob']);
    assert.equal(result.bubbles.length, 1); assert.equal(result.headersCount, 3);
  } finally { f.close(); }
});

test('legacy hex checkpoint and blob representations remain readable', () => {
  const f = fixture();
  try {
    const reference = f.blob({ role: 'assistant', content: '旧格式' }, true);
    f.composer.conversationState = field(1, reference).toString('hex');
    assert.equal(f.read().promptMessages[0].content, '旧格式');
  } finally { f.close(); }
});

test('invalid checkpoint encoding and truncated protobuf fail explicitly', () => {
  const f = fixture();
  try {
    for (const state of ['~bad=', 'invalid hex', '~' + Buffer.from([10, 32, 1]).toString('base64'), '~' + Buffer.from([0]).toString('base64')]) {
      f.composer.conversationState = state; assert.throws(() => f.read(), /状态/);
    }
  } finally { f.close(); }
});

test('unsupported legacy archives, invalid pointers and unreadable blobs remain visible', () => {
  const f = fixture();
  try {
    const unknown = f.blob({ role: 'future-role', content: 'unknown' });
    f.composer.conversationState = '~' + Buffer.concat([field(11, Buffer.alloc(32)), field(1, Buffer.from([1])), field(1, unknown)]).toString('base64');
    assert.deepEqual(f.read().issues.map(issue => issue.kind), ['unsupported-legacy-summary-archive', 'invalid-blob-ref', 'unreadable-message']);
  } finally { f.close(); }
});

test('read-only snapshot excludes root keys/auth records and does not modify the database', () => {
  const f = fixture();
  try {
    f.bubble('stored'); f.save();
    const before = createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
    const result = readCursorDesktopHistory(f.file, f.nativeId, f.cwd), encoded = JSON.stringify(result);
    assert.equal(createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'), before);
    assert.equal(encoded.includes('SENTINEL'), false);
    assert.equal(encoded.includes('blobEncryptionKey'), false);
  } finally { f.close(); }
});

test('a running turn is reported as unsettled even when saved records can be read', () => {
  const f = fixture();
  try { f.composer.status = 'generating'; f.composer.generatingBubbleIds = [randomUUID()]; assert.equal(f.read().settled, false); }
  finally { f.close(); }
});

test('failed model turns retain native errors and per-turn model/mode metadata across later changes', () => {
  const f = fixture();
  try {
    const modelInfo = { modelName: 'synthetic-model' }, errorDetails = {
      requestId: 'synthetic-request', error: 'MODEL_NOT_AVAILABLE', title: 'Model not available',
      message: 'This model provider is not supported in your region.', stackTrace: 'native stack',
      connectCode: 9, isRetryable: false, extraButtons: []
    };
    const user = f.bubble('question', { type: 1, unifiedMode: 2, agentMode: true, modelInfo });
    const failed = f.bubble('', { unifiedMode: 2, errorDetails, unrelatedSecret: 'BUBBLE_SECRET_SENTINEL' });
    f.composer.status = 'aborted';
    const before = f.read();
    assert.equal(before.settled, false);
    assert.deepEqual(before.bubbles.find(b => b.bubbleId === failed)?.errorDetails, errorDetails);
    assert.deepEqual(before.bubbles.find(b => b.bubbleId === user)?.modelInfo, modelInfo);
    assert.equal(before.bubbles[0].unifiedMode, 2); assert.equal(before.bubbles[0].agentMode, true);
    f.composer.unifiedMode = 1; f.composer.modelConfig = { modelName: 'another-model' };
    f.composer.status = 'completed'; f.bubble('recovered', { unifiedMode: 1 });
    const after = f.read();
    assert.deepEqual(after.bubbles.slice(0, 2), before.bubbles);
    assert.equal(after.bubbles.length, 3); assert.equal(after.settled, true);
    assert.equal(JSON.stringify(after).includes('SENTINEL'), false);
    assert.equal(after.toolCoverage.length, 0);
  } finally { f.close(); }
});

test('a prompt blocked before the first model call has UI history but no executable checkpoint', () => {
  const f = fixture();
  try {
    f.bubble('Submission blocked by hook'); f.composer.conversationState = '~';
    const result = f.read();
    assert.equal(result.bubbles.length, 1); assert.equal(result.promptMessages.length, 0);
    assert.equal(result.runtimeCheckpointAvailable, false); assert.equal(result.settled, false);
    assert.deepEqual(result.issues, [{ kind: 'empty-native-checkpoint' }]);
  } finally { f.close(); }
});

test('a compacted UI history with missing completed tool results cannot report complete history', () => {
  const f = fixture();
  try {
    f.bubble('', { toolFormerData: { toolCallId: 'completed-read', name: 'read_file_v2', status: 'completed', result: '{"totalLinesInFile":10}' } });
    const summary = f.blob({ role: 'user', content: 'summary of older work', providerOptions: { cursor: { isSummary: true } } });
    f.composer.conversationState = '~' + field(1, summary).toString('base64');
    const result = f.read();
    assert.deepEqual(result.toolCoverage, [{ callId: 'completed-read', name: 'read_file_v2', source: 'missing' }]);
    assert.deepEqual(result.issues, [{ kind: 'historical-tool-result-not-referenced', id: 'completed-read' }]);
  } finally { f.close(); }
});

test('failed native tools retain their original error result and missing archived failures are reported', () => {
  const f = fixture();
  try {
    const callId = 'native-failed-read\nrequest-1';
    f.bubble('', { toolFormerData: { toolCallId: callId, name: 'read_file_v2', status: 'error', rawArgs: '{"path":"missing.txt"}' } });
    const error = { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Read', result: 'Error: File not found' }],
      providerOptions: { cursor: { highLevelToolCallResult: { output: { error: { errorMessage: 'File not found' } }, isError: true, rawErrorMessages: ['File not found'] } } } };
    const response = f.blob(error), archive = f.blob(field(1, response));
    const summary = f.blob({ role: 'user', content: 'native summary', providerOptions: { cursor: { isSummary: true } } });
    f.composer.conversationState = '~' + Buffer.concat([field(13, archive), field(1, summary)]).toString('base64');
    const read = f.read();
    assert.deepEqual(read.toolCoverage, [{ callId, name: 'read_file_v2', source: 'archive' }]);
    assert.deepEqual(read.archivedMessages[0], { ...error, blobId: response.toString('hex') });
    assert.deepEqual(read.issues, []);
    f.composer.conversationState = '~' + field(1, summary).toString('base64');
    const missing = f.read();
    assert.deepEqual(missing.toolCoverage, [{ callId, name: 'read_file_v2', source: 'missing' }]);
    assert.deepEqual(missing.issues, [{ kind: 'historical-tool-result-not-referenced', id: callId }]);
  } finally { f.close(); }
});
