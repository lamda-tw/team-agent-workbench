import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentSession, Message } from '../src/shared/types';
import { SessionTranscript, sessionDisplayRows, sessionTranscriptRows, toolExecutionTitle } from '../src/renderer/session-transcript';

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

const display = (messages: Message[], extra: Partial<AgentSession> = {}) => sessionDisplayRows({ messages, status: 'idle', ...extra });
const layout = (rows: ReturnType<typeof sessionDisplayRows>) => rows.map(row => row.kind === 'message' ? row.id : { kind: row.kind, ids: row.messages.map(m => m.id) });
const completedTurn = () => [message('u', 'user'), message('progress', 'assistant', '正在检查', { phase: 'commentary' }), message('steps', 'assistant', '执行计划', { kind: 'planSteps', steps: [] }), message('t', 'tool', '$ test\npassed'), message('more', 'assistant', '已完成检查', { phase: 'commentary' }), message('final', 'assistant', '最终结果', { phase: 'final_answer' })];

test('completion folds commentary, plans and tools together, leaving the user and final answer visible', () => {
  const messages = completedTurn(), original = JSON.stringify(messages);
  const rows = display(messages);
  assert.deepEqual(layout(rows), ['u', { kind: 'activity', ids: ['progress', 'steps', 't', 'more'] }, 'final']);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(rows[2].kind === 'message' && rows[2].message, messages[5]);
  const html = render(messages);
  assert.equal((html.match(/class="turn-activity-group"/g) || []).length, 1);
  assert.match(html, /工作过程 · 4 项/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:[ =>])/);
  assert.match(html, /<div class="turn-activity-content">[\s\S]*正在检查[\s\S]*执行计划[\s\S]*passed[\s\S]*已完成检查[\s\S]*<\/details><article data-message-id="final">最终结果<\/article>$/);
});

test('streaming and pending confirmations stay visible until the turn actually finishes', () => {
  for (const status of ['starting', 'running', 'approval', 'error'] as const) {
    assert(!display(completedTurn(), { status }).some(row => row.kind === 'activity'));
    assert.doesNotMatch(render(completedTurn(), status), /turn-activity-group/);
  }
  for (const extra of [{ error: 'connection lost' }, { stoppedAt: 'now' }]) assert(!display(completedTurn(), extra).some(row => row.kind === 'activity'));
  assert(display(completedTurn()).some(row => row.kind === 'activity'));
});

test('earlier completed rounds stay collapsed while the next round or a hidden draft is running', () => {
  const messages = [...completedTurn(), message('next', 'user'), message('next-progress', 'assistant')];
  assert.deepEqual(layout(display(messages, { status: 'running' })), ['u', { kind: 'activity', ids: ['progress', 'steps', 't', 'more'] }, 'final', 'next', 'next-progress']);
  const fill = message('fill', 'user', 'private prompt', { context: { questionFill: true, nativeId: '', accepted: true, workRecord: false, sourceHashes: {} } });
  assert.deepEqual(display([...completedTurn(), fill, message('draft', 'assistant', 'private draft')], { status: 'running' }), display(completedTurn()));
  const second = completedTurn().map(m => ({ ...m, id: 'next-' + m.id }));
  assert.equal(display([...completedTurn(), ...second]).filter(row => row.kind === 'activity').length, 2);
});

test('legacy records use the final reply, with no folding when only commentary or unfinished tools remain', () => {
  const legacy = completedTurn().map(({ phase, ...m }) => m);
  assert.deepEqual(layout(display(legacy)), layout(display(completedTurn())));
  for (const messages of [completedTurn().slice(0, -1), [message('progress', 'assistant'), message('t', 'tool')], [message('commentary', 'assistant', 'working', { phase: 'commentary' })], [message('steps', 'assistant', 'plan', { kind: 'planSteps' })], []]) {
    assert(!display(messages).some(row => row.kind === 'activity'));
  }
  assert.deepEqual(layout(display([message('u', 'user'), message('a', 'assistant')])), ['u', 'a']);
  assert.deepEqual(layout(display([message('u', 'user'), message('a', 'assistant'), message('plan', 'assistant', '最终方案', { kind: 'plan' })])), ['u', { kind: 'activity', ids: ['a'] }, 'plan']);
});

test('all final-answer blocks and interleaved user/system messages remain outside the disclosure', () => {
  const messages = [message('u', 'user'), message('p', 'assistant', 'progress', { phase: 'commentary' }), message('steering', 'user', 'extra requirement', { steering: true }), message('t', 'tool'), message('notice', 'system', 'retry notice'), message('p2', 'assistant'), message('f1', 'assistant', 'part one', { phase: 'final_answer' }), message('f2', 'assistant', 'part two', { phase: 'final_answer' }), message('empty', 'assistant', '', { phase: 'final_answer' })];
  assert.deepEqual(layout(display(messages)), ['u', { kind: 'activity', ids: ['p'] }, 'steering', { kind: 'activity', ids: ['t'] }, 'notice', { kind: 'activity', ids: ['p2'] }, 'f1', 'f2']);
  assert(!display(messages, { status: 'running' }).some(row => row.kind === 'activity'), 'steering does not complete the preceding messages');
  assert.equal(display(completedTurn())[1].id, display([...completedTurn(), message('next', 'user')], { status: 'running' })[1].id, 'stable disclosure identity preserves the user choice on later updates');
});
