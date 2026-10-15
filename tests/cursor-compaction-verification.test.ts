import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCursorCompaction } from '../src/core/cursor-compaction-verification';

function frames() {
  const bubble = { bubbleId: 'message-1', type: 2, text: '', toolFormerData: { status: 'completed', toolCallId: 'read-1' } };
  const tool = { blobId: 'tool-blob', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read-1', result: 'full tool output' }] };
  const user = { blobId: 'user-blob', role: 'user', content: 'chosen method' };
  const summary = { blobId: 'summary-blob', role: 'user', content: 'native summary', providerOptions: { cursor: { isSummary: true } } };
  const before = { nativeId: 'native-1', cwd: process.cwd(), settled: true, bubbles: [bubble], promptMessages: [user, tool], archivedMessages: [], toolArtifacts: [], summaryArchiveCount: 0, checkpointSha256: 'before' };
  const compacted = { ...before, promptMessages: [summary], archivedMessages: [user, tool], summaryArchiveCount: 1, checkpointSha256: 'compacted' };
  const resumed = { ...compacted, promptMessages: [summary, user], checkpointSha256: 'resumed' };
  return { before, compacted, resumed };
}

test('a marker without actual native compaction remains unverified', () => {
  const f = frames();
  const compacted = { ...f.before, bubbles: [...f.before.bubbles, { bubbleId: 'ui-marker', type: 2, text: 'Chat context summarized' }] };
  assert.equal(verifyCursorCompaction(f.before, compacted, compacted).result, 'unverified');
});

test('successful replies cannot hide native state rollback after reopen', () => {
  const f = frames();
  const resumed = { ...f.before, promptMessages: [...f.before.promptMessages, { blobId: 'answer', role: 'assistant', content: 'chosen method recalled correctly' }], checkpointSha256: 'new-turn' };
  const result = verifyCursorCompaction(f.before, f.compacted, resumed);
  assert.equal(result.compressionObserved, true); assert.equal(result.compressedStateRetained, false); assert.equal(result.result, 'failed');
});

test('saved tool UI metadata is insufficient when its original result is not referenced', () => {
  const f = frames(), compacted = { ...f.compacted, archivedMessages: [] };
  const result = verifyCursorCompaction(f.before, compacted, { ...f.resumed, archivedMessages: [] });
  assert.equal(result.result, 'failed'); assert.equal(result.uncoveredTools.length, 2);
});

test('native compaction, retained state and full history/tool coverage must all hold', () => {
  const f = frames(); assert.equal(verifyCursorCompaction(f.before, f.compacted, f.resumed).result, 'passed');
  assert.equal(verifyCursorCompaction(f.before, f.compacted, { ...f.resumed, settled: false }).result, 'unverified');
  assert.throws(() => verifyCursorCompaction(f.before, f.compacted, { ...f.resumed, nativeId: 'another-agent' }), /不一致/);
});

test('archive consolidation is allowed when the same native summary and original results survive', () => {
  const f = frames();
  const compacted = { ...f.compacted, summaryArchiveCount: 3 };
  assert.equal(verifyCursorCompaction(f.before, compacted, f.resumed).result, 'passed');
});

test('a different summary cannot stand in for retention of the compacted native state', () => {
  const f = frames();
  const resumed = { ...f.resumed, promptMessages: f.resumed.promptMessages.map(message => message.blobId === 'summary-blob' ? { ...message, blobId: 'unrelated-summary', content: 'different state' } : message) };
  assert.equal(verifyCursorCompaction(f.before, f.compacted, resumed).compressedStateRetained, false);
});

test('an archived compacted summary cannot hide replacement of the current execution state', () => {
  const f = frames(), compactedSummary = f.compacted.promptMessages[0];
  const resumed = { ...f.resumed,
    promptMessages: [{ ...compactedSummary, blobId: 'old-summary-restored', content: 'older execution state' }],
    archivedMessages: [...f.resumed.archivedMessages, compactedSummary] };
  const result = verifyCursorCompaction(f.before, f.compacted, resumed);
  assert.equal(result.historyPreserved, true);
  assert.equal(result.toolResultsPreserved, true);
  assert.equal(result.compressedStateRetained, false);
  assert.equal(result.result, 'failed');
});

test('the same tool call ID cannot hide changed tool result content or a missing content blob', () => {
  const f = frames();
  const changed = { ...f.resumed, archivedMessages: f.resumed.archivedMessages.map(message => message.role === 'tool' ? { ...message, content: [{ type: 'tool-result', toolCallId: 'read-1', result: 'truncated' }] } : message) };
  assert.equal(verifyCursorCompaction(f.before, f.compacted, changed).toolResultsPreserved, false);
  const artifact = { blobId: 'read-content', kind: 'read-file-content' as const, content: 'full original file' };
  assert.equal(verifyCursorCompaction({ ...f.before, toolArtifacts: [artifact] }, { ...f.compacted, toolArtifacts: [artifact] }, f.resumed).toolArtifactsPreserved, false);
});

test('full message coverage must preserve the original order', () => {
  const f = frames(), second = { bubbleId: 'message-2', type: 1, text: 'next turn' };
  const before = { ...f.before, bubbles: [...f.before.bubbles, second] };
  const compacted = { ...f.compacted, bubbles: before.bubbles };
  const resumed = { ...f.resumed, bubbles: [...before.bubbles].reverse() };
  assert.equal(verifyCursorCompaction(before, compacted, resumed).historyPreserved, false);
});

test('a failed tool cannot disappear during compaction while its UI error bubble remains', () => {
  const f = frames();
  const bubbles = [{ ...f.before.bubbles[0], toolFormerData: { status: 'error', toolCallId: 'read-1' } }];
  const before = { ...f.before, bubbles }, compacted = { ...f.compacted, bubbles }, resumed = { ...f.resumed, bubbles };
  assert.equal(verifyCursorCompaction(before, compacted, resumed).result, 'passed');
  const missing = { ...resumed, archivedMessages: resumed.archivedMessages.filter(message => message.role !== 'tool') };
  const result = verifyCursorCompaction(before, compacted, missing);
  assert.equal(result.result, 'failed');
  assert.equal(result.toolResultsPreserved, false);
  assert.deepEqual(result.uncoveredTools, [{ stage: 'resumed', callId: 'read-1' }]);
});

test('retaining error text cannot hide loss of the native error result and isError flag', () => {
  const f = frames(), bubbles = [{ ...f.before.bubbles[0], toolFormerData: { status: 'error', toolCallId: 'read-1' } }];
  const tool = { ...f.before.promptMessages[1], content: [{ type: 'tool-result', toolCallId: 'read-1', result: 'Error: File not found' }],
    providerOptions: { cursor: { highLevelToolCallResult: { output: { error: { errorMessage: 'File not found' } }, isError: true } } } };
  const before = { ...f.before, bubbles, promptMessages: [f.before.promptMessages[0], tool] };
  const compacted = { ...f.compacted, bubbles, archivedMessages: [f.before.promptMessages[0], tool] };
  const resumed = { ...f.resumed, bubbles, archivedMessages: compacted.archivedMessages };
  assert.equal(verifyCursorCompaction(before, compacted, resumed).result, 'passed');
  const changed = { ...resumed, archivedMessages: [f.before.promptMessages[0], { ...tool, providerOptions: { cursor: { highLevelToolCallResult: { isError: false } } } }] };
  const result = verifyCursorCompaction(before, compacted, changed);
  assert.equal(result.result, 'failed'); assert.equal(result.toolResultsPreserved, false);
});

test('compaction cannot discard a failed turn or rewrite its recorded model and mode', () => {
  const f = frames();
  const bubble = { ...f.before.bubbles[0], unifiedMode: 2, agentMode: true,
    modelInfo: { modelName: 'synthetic-model' }, errorDetails: { title: 'Model not available', isRetryable: false } };
  const before = { ...f.before, bubbles: [bubble] }, compacted = { ...f.compacted, bubbles: [bubble] }, resumed = { ...f.resumed, bubbles: [bubble] };
  assert.equal(verifyCursorCompaction(before, compacted, resumed).result, 'passed');
  for (const key of ['errorDetails', 'unifiedMode', 'agentMode', 'modelInfo']) {
    const changed: Record<string, unknown> = { ...bubble }; delete changed[key];
    const result = verifyCursorCompaction(before, compacted, { ...resumed, bubbles: [changed] });
    assert.equal(result.historyPreserved, false, key); assert.equal(result.result, 'failed', key);
  }
});
