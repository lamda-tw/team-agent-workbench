import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTree, SubsessionChat } from '../src/renderer/subsession-chat';
import { ComposerActions } from '../src/renderer/composer-actions';
import { quoteSessionText } from '../src/shared/subsessions';
import type { AgentSession, WorkbenchAPI } from '../src/shared/types';

const session = (id: string, parent?: string): AgentSession => ({
  id, title: id, provider: 'codex', purpose: 'work', cwd: '/test', status: 'running', createdAt: '2026-10-20T00:00:00Z',
  autoUpload: false, handoffPath: '/test/' + id, sources: [], messages: [], approvals: [], parentId: parent,
  ...(parent ? { fork: { parentId: parent, capturedAt: '2026-10-20T00:00:00Z', parentMessageCount: 1, snapshotHash: 'hash', sourceId: 'source', inheritedSourceIds: [], workspaceKind: 'shared-directory', workspaceRoot: '/test', parentWasRunning: true } } : {}),
});
test('deep child selection expands its full ancestor path and keeps running parents actionable', () => {
  const root = session('root'), child = session('child', root.id), grandchild = session('grandchild', child.id);
  const html = renderToStaticMarkup(React.createElement(SessionTree, { sessions: [grandchild, child, root], selectedId: root.id, childId: grandchild.id, open() {}, create() {}, promote() {} }));
  assert(html.indexOf('data-session-id="root"') < html.indexOf('data-session-id="child"'));
  assert(html.indexOf('data-session-id="child"') < html.indexOf('data-session-id="grandchild"'));
  assert.match(html, /创建子会话/); assert.match(html, /升级为独立会话/);
  assert.doesNotMatch(html, /disabled=/);
});
test('next-turn quotation keeps the stop control and does not become a current-turn steering message', () => {
  const quoted = quoteSessionText('第一行\n第二行');
  assert.equal(quoted, '> 第一行\n> 第二行\n\n');
  const props = { session: session('s'), text: quoted, activeTurnId: 'turn', busy: false, nextTurnOnly: true, send() {}, stop() {} };
  const running = renderToStaticMarkup(React.createElement(ComposerActions, props));
  assert.match(running, /等待本轮结束/); assert.match(running, /aria-label="停止当前任务"/);
  assert.doesNotMatch(running, /引导当前任务/);
  const finished = renderToStaticMarkup(React.createElement(ComposerActions, { ...props, session: { ...props.session, status: 'idle' } }));
  assert.match(finished, /aria-label="发送任务"/); assert.doesNotMatch(finished, /disabled=/);
});
test('child chat allows another fork while streaming, presents inherited context folded, and retains its draft', () => {
  const parent = session('root'), child = session('child', parent.id);
  const api = { call: async () => { throw new Error('no IPC during render'); } } as unknown as WorkbenchAPI;
  const html = renderToStaticMarkup(React.createElement(SubsessionChat, { session: child, sessions: [parent, child], input: { text: '> 引用\n\n继续问', sourceIds: [], answers: {} }, api, active: true, edit() {}, open() {}, create() {}, promote() {}, remove() {}, changed: async () => {} }));
  assert.match(html, /创建子会话/); assert.match(html, /包含当时未完成的回复/);
  assert.match(html, /共用工作目录/); assert.match(html, /继续问/);
  assert.match(html, /<details class="inherited-conversation">/);
  assert.match(html, /<button class="primary" disabled="">发送/);
});
