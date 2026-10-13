import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSharedThread } from '../src/core/codex-live-thread';
import type { Message } from '../src/shared/types';
const message = (id: string, text: string, role: Message['role'] = 'assistant'): Message => ({ id, text, role, createdAt: 'before' });
const thread = (...items: any[]) => ({ turns: [{ id: 'turn', items }] });
test('joining an active reply hydrates its prefix and keeps stable UI IDs and input receipts', () => {
  const existing = [{ ...message('local-user', 'task', 'user'), userText: 'raw task', context: { nativeId: 'thread', accepted: true, workRecord: true, sourceHashes: {} } }, message('native:reply', 'tail')];
  const result = mergeSharedThread(existing, thread({ id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'task' }] }, { id: 'reply', type: 'agentMessage', text: 'prefix and tail' }));
  assert.equal(result.length, 2); assert.equal(result[0].id, 'local-user'); assert.equal(result[0].userText, 'raw task'); assert.equal(result[0].context, existing[0].context);
  assert.equal(result[1].id, 'native:reply'); assert.equal(result[1].text, 'prefix and tail');
  assert.deepEqual(mergeSharedThread(result, thread({ id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'task' }] }, { id: 'reply', type: 'agentMessage', text: 'prefix and tail' })), result);
});
test('older partial snapshots cannot erase streamed text; completion is authoritative', () => {
  const existing = [message('reply', 'complete streamed text'), message('unsent-receipt', 'local notice', 'system')];
  assert.equal(mergeSharedThread(existing, thread({ id: 'reply', type: 'agentMessage', text: 'complete' }))[0].text, 'complete streamed text');
  assert.equal(mergeSharedThread(existing, thread({ id: 'reply', type: 'agentMessage', text: 'final', status: 'completed' }))[0].text, 'final');
  assert.equal(mergeSharedThread(existing, thread({ id: 'reply', type: 'agentMessage', text: 'complete' }))[1].id, 'unsent-receipt');
});
test('repeated user prompts retain separate receipts and native item identities', () => {
  const existing = [{ ...message('first', 'same', 'user'), nativeItemId: 'u1', userText: 'first raw' }, { ...message('second', 'same', 'user'), nativeItemId: 'u2', userText: 'second raw' }];
  const result = mergeSharedThread(existing, thread({ id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'same' }] }));
  assert.equal(result[0].userText, 'second raw'); assert.equal(result.length, 2); assert.equal(result[1].userText, 'first raw');
});
