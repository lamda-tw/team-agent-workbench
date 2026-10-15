import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentSession, Message } from '../src/shared/types';
import { SessionTranscript, sessionTranscriptRows, toolExecutionTitle } from '../src/renderer/session-transcript';

const message = (id: string, role: Message['role'], text = id, extra: Partial<Message> = {}): Message => ({ id, role, text, createdAt: '2026-10-15T02:00:00.000Z', ...extra });
const render = (messages: Message[], status: AgentSession['status'] = 'idle', closedAt?: string) => renderToStaticMarkup(React.createElement(SessionTranscript, {
  session: { id: 'session-a', messages, status, closedAt } as AgentSession,
  renderMessage: m => React.createElement('article', { 'data-message-id': m.id }, m.text),
}));

test('only adjacent tools fold together; user turns, prose, errors and plans retain their order', () => {
  const messages = [message('u1', 'user'), message('a1', 'assistant'), message('t1', 'tool'), message('t2', 'tool'), message('a2', 'assistant'), message('t3', 'tool'), message('error', 'system'), message('t4', 'tool'), message('plan', 'assistant', '计划', { kind: 'planSteps', steps: [] }), message('u2', 'user'), message('t5', 'tool')];
  const original = JSON.stringify(messages), rows = sessionTranscriptRows(messages);
  assert.deepEqual(rows.map(row => row.kind === 'tools' ? row.messages.map(m => m.id) : row.id), ['u1', 'a1', ['t1', 't2'], 'a2', ['t3'], 'error', ['t4'], 'plan', 'u2', ['t5']]);
  assert.equal(JSON.stringify(messages), original, 'display grouping never mutates stored history');
  assert.equal(rows[0].kind === 'message' && rows[0].message, messages[0]);
});

test('a growing tool group keeps its identity and updates existing output without duplicating records', () => {
  const first = message('t1', 'tool', '$ echo hello\n'), second = message('t2', 'tool');
  const before = sessionTranscriptRows([first]);
  const after = sessionTranscriptRows([{ ...first, text: '$ echo hello\nhello\n退出码：0' }, second]);
  assert.equal(before[0].id, after[0].id);
  assert.equal(after.length, 1);
  assert.equal(after[0].kind === 'tools' && after[0].messages.length, 2);
  assert.equal(after[0].kind === 'tools' && after[0].messages[0].text, '$ echo hello\nhello\n退出码：0');
  assert.deepEqual(sessionTranscriptRows([]), []);
});

test('hidden question draft turns do not leak through tool groups', () => {
  const messages = [message('u', 'user', 'visible question'), message('t', 'tool', 'visible tool'), message('fill', 'user', 'hidden prompt', { context: { questionFill: true, nativeId: '', accepted: true, workRecord: false, sourceHashes: {} } }), message('hidden-tool', 'tool', 'hidden command'), message('draft', 'assistant', 'hidden draft'), message('next', 'user', 'visible next turn'), message('next-tool', 'tool', 'visible next tool')];
  const markup = render(messages);
  assert.doesNotMatch(markup, /hidden prompt|hidden command|hidden draft/);
  assert.match(markup, /visible question/);
  assert.match(markup, /visible next turn/);
  assert.equal((markup.match(/class="tool-execution-group"/g) || []).length, 2);
});

test('one collapsed summary contains the tools, full outputs and original Cursor records', () => {
  const text = '$ run\n<script>literal output</script>\n' + 'large output\n'.repeat(1000) + '退出码：1';
  const markup = render([message('t1', 'tool', text), message('t2', 'tool', 'Read file', { nativeDetails: { toolCall: { name: 'read_file' }, toolResults: { content: 'original native result' } } })]);
  assert.equal((markup.match(/class="tool-execution-group"/g) || []).length, 1);
  assert.match(markup, /工具执行 · 2 项/);
  assert.doesNotMatch(markup, /<details[^>]*\sopen(?:[ =>])/);
  assert.equal((markup.match(/class="tool-execution-output"/g) || []).length, 2);
  assert.match(markup, /&lt;script&gt;literal output&lt;\/script&gt;/);
  assert.match(markup, /退出码：1/);
  assert.match(markup, /original native result/);
  assert.equal((markup.match(/large output/g) || []).length, 1000);
});

test('activity belongs only to the trailing tools of an active session, never implying tool success', () => {
  const tools = [message('t1', 'tool'), message('a1', 'assistant'), message('t2', 'tool')];
  assert.equal((render(tools, 'running').match(/本轮进行中/g) || []).length, 1);
  assert.match(render(tools, 'approval'), /等待确认/);
  for (const markup of [render(tools), render(tools, 'error'), render(tools, 'running', '2026-10-15'), render([...tools, message('done', 'assistant')], 'running')]) assert.doesNotMatch(markup, /本轮进行中|等待确认|执行成功/);
});

test('structured tool events get readable summaries without truncating the stored details', () => {
  assert.equal(toolExecutionTitle(message('a', 'tool', JSON.stringify({ type: 'fileChange', changes: [] }, null, 2))), '修改文件');
  assert.equal(toolExecutionTitle(message('b', 'tool', JSON.stringify({ type: 'mcpToolCall', tool: 'search' }))), 'search');
  assert.equal(toolExecutionTitle(message('c', 'tool', '\n$ npm test\nfull output')), '$ npm test');
  assert.equal(toolExecutionTitle(message('d', 'tool', '')), '查看工具记录');
  assert.doesNotThrow(() => toolExecutionTitle(message('e', 'tool', '{"incomplete":')));
});
