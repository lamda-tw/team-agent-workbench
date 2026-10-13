import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sessionContext, migrateSessionContext } from '../src/core/session-context';
import { applyNativeTranscript } from '../src/core/native-transcript';
import { sessionMessageText } from '../src/shared/session-context-text';
import { projectJournalPrefix, type JournalContext } from '../src/shared/project-journal';
import { PendingSessionMessage } from '../src/renderer/pending-session-message';
import type { AgentSession, Message } from '../src/shared/types';

const base = (cwd = 'D:\\project'): AgentSession => ({
  id: randomUUID(), provider: 'codex', title: 'test', nativeId: 'native', cwd, purpose: 'work',
  createdAt: '', status: 'idle', messages: [], approvals: [], autoUpload: false, handoffPath: cwd + '/handoff.md',
  sources: [{ id: 'source', name: '项目参考', localPath: cwd + '/reference.md', sourcePath: '/team/reference.md', sha256: 'a'.repeat(64), size: 1, fetchedAt: '' }],
});
const user = (id: string, text: string, fields: Partial<Message> = {}): Message => ({ id, role: 'user', text, createdAt: '', ...fields });
function journal(s: AgentSession, mode: '首次全量' | '增量更新'): JournalContext {
  return {
    receipt: { projectKey: 'project', sessions: {} },
    text: projectJournalPrefix(mode) + s.cwd + '/.workbench/sessions/' + s.id + '/project-journal/index.md\n\n'
      + `### 同项目会话 | cursor | ${randomUUID()}\n摘要只读副本：${s.cwd}/summary.md\n摘要更新：2026-10-13T00:00:00Z\n- 2026-10-13T00:00:00Z [turn-1] 完成了方案验证`,
  };
}

test('old user bubbles recover input from summaries, references and full or incremental journals on Windows and Unix', () => {
  for (const cwd of ['D:\\project', '/work/project']) for (const mode of ['首次全量', '增量更新'] as const) {
    const s = base(cwd), input = '  请继续验证\n保留这行  ';
    const prompt = sessionContext(s, input, ['source'], journal(s, mode));
    const message = user('old', prompt.text, { context: { ...prompt.context, nativeId: s.nativeId!, accepted: true } });
    s.messages = [message];
    assert.equal(sessionMessageText(s, message), input);
    const receipt = message.context;
    migrateSessionContext(s);
    assert.equal(message.userText, input, 'existing receipts must not prevent display repair');
    assert.equal(message.context, receipt);
    assert.equal(message.text, prompt.text, 'the model prompt and exported trajectory retain all context');
    assert.equal(sessionContext(s, '下一轮', ['source']).text, '下一轮', 'repair preserves accepted reference state');
  }
});

test('journal-only turns and missing metadata recover immediately without inventing a journal receipt', () => {
  const s = base(), text = '继续' + journal(s, '增量更新').text;
  const message = user('native:u', text);
  assert.equal(sessionMessageText(s, message), '继续');
  s.messages = [message]; migrateSessionContext(s);
  assert.equal(message.userText, '继续');
  assert.equal(message.context, undefined);
  assert.equal(renderToStaticMarkup(React.createElement(PendingSessionMessage, {
    session: s, messages: [user('native:u', text)], pending: { text: '继续', beforeMessageCount: 0, phase: 'submitting' },
  })), '', 'refreshed messages also dismiss the temporary bubble');
});

test('saved user text, quoted markers, other session paths and assistant/tool replies are never hidden', () => {
  const s = base(), text = '这是用户引用的内容' + journal(s, '首次全量').text;
  assert.equal(sessionMessageText(s, user('saved', text, { userText: text })), text);
  assert.equal(sessionMessageText(s, user('empty', text, { userText: '' })), '');
  const other = '请解释' + journal(base(), '首次全量').text;
  assert.equal(sessionMessageText(s, user('other', other)), other);
  for (const prose of ['请解释\n\n[项目会话日志 · 首次全量]\n这是我自己的内容', text + '\n请回答上面的问题。']) {
    assert.equal(sessionMessageText(s, user('quote', prose)), prose);
  }
  for (const role of ['assistant', 'tool', 'system'] as const) assert.equal(sessionMessageText(s, { ...user(role, text), role }), text);
});

test('legacy repair strips only the last journal, preserving an earlier journal quoted by the user', () => {
  const s = base(), input = '请看这段历史日志' + journal(s, '首次全量').text;
  assert.equal(sessionMessageText(s, user('quote', input + journal(s, '增量更新').text)), input);
});

test('native refresh retains raw input and receipts when CLI IDs change or augmented prompts are clipped', () => {
  const s = base(), prompt = sessionContext(s, '请验证', ['source'], journal(s, '首次全量'));
  const context = { ...prompt.context, nativeId: s.nativeId!, accepted: true };
  const original = user('local', prompt.text, { userText: '请验证', context, steering: true });
  const merged = applyNativeTranscript([original], [user('native:cli', prompt.text)]);
  assert.equal(merged[0].userText, '请验证'); assert.equal(merged[0].context, context); assert.equal(merged[0].steering, true);
  assert.equal(original.id, 'local');
  const long = user('local-long', prompt.text + '很多背景资料'.repeat(2000), { userText: '请验证', context });
  const clipped = applyNativeTranscript([long], [user('native:long', long.text.slice(0, 8000) + '…')]);
  assert.equal(clipped[0].userText, '请验证'); assert.equal(clipped[0].context, context);
  const noReceipt = applyNativeTranscript([user('known', prompt.text, { userText: '原始输入' })], [user('native:known', 'CLI 改写后的记录')]);
  assert.equal(noReceipt[0].userText, '原始输入', 'raw input must survive even without reference metadata');
});

test('repeated native user messages keep separate receipts and stable IDs take precedence over text matches', () => {
  const s = base(), first = sessionContext(s, '继续', ['source']);
  const context = { ...first.context, nativeId: s.nativeId!, accepted: true };
  const one = user('local-1', first.text, { userText: '继续', context });
  const two = user('local-2', '继续', { userText: '继续', context: { ...context, sourceHashes: {} }, steering: true });
  const merged = applyNativeTranscript([one, two], [user('native:u1', '继续'), user('native:u2', '继续')]);
  assert.equal(merged[0].context, one.context); assert.equal(merged[1].context, two.context);
  assert.equal(merged[1].steering, true);
  const stable = user('native:stable', '相同内容', { userText: '已匹配', context });
  const local = user('local', '相同内容', { userText: '新消息', context: { ...context } });
  const reserved = applyNativeTranscript([stable, local], [user('native:new', '相同内容'), user('native:stable', '相同内容')]);
  assert.deepEqual(reserved.map(m => m.userText), ['新消息', '已匹配']);
  const extra = applyNativeTranscript([one], [user('native:u1', first.text), user('native:u2', first.text)]);
  assert.equal(extra[0].context, context); assert.equal(extra[1].context, undefined, 'one receipt cannot attach to two prompts');
});
