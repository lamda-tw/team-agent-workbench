import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyNativeTranscript, nativeTranscriptChanged, readCodexTranscript } from '../src/core/native-transcript';

test('imported Codex history preserves phases and refreshes records when only the phase changed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-phase-'));
  try {
    const file = path.join(root, 'rollout.jsonl');
    const items = [{ id: 'u', type: 'UserMessage', content: 'question' }, { id: 'p', type: 'AgentMessage', content: 'progress', phase: 'commentary' }, { id: 'f', type: 'AgentMessage', content: 'result', phase: 'final_answer' }, { id: 'old', type: 'AgentMessage', content: 'legacy', phase: 'unknown' }];
    await fs.writeFile(file, items.map(item => JSON.stringify({ payload: { type: 'item_completed', item, completed_at_ms: 1 } })).join('\n'));
    const parsed = await readCodexTranscript(file);
    assert.deepEqual(parsed.map(m => m.phase), [undefined, 'commentary', 'final_answer', undefined]);
    const old = parsed.map(({ phase, ...message }) => message);
    assert.equal(nativeTranscriptChanged(old, parsed), true);
    assert.deepEqual(applyNativeTranscript(old, parsed).slice(1), parsed.slice(1));
    assert.equal(nativeTranscriptChanged(applyNativeTranscript(old, parsed), parsed), false);
    assert.equal(nativeTranscriptChanged(parsed, parsed), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
