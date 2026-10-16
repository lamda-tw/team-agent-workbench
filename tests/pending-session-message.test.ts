import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerActions } from '../src/renderer/composer-actions';
import { PendingSessionMessage } from '../src/renderer/pending-session-message';
import type { AgentSession, Message } from '../src/shared/types';

test('sending immediately shows the original message and a visible acknowledgement state', () => {
  const pending = { text: '第一行\n第二行', beforeMessageCount: 0, phase: 'submitting' as const };
  const html = renderToStaticMarkup(React.createElement(PendingSessionMessage, { pending, messages: [] }));
  assert.match(html, /aria-label="消息正在提交"/);
  assert.match(html, /第一行\n第二行/);
  assert.match(html, /等待 CLI 确认/);
  const button = renderToStaticMarkup(React.createElement(ComposerActions, { session: { provider: 'codex', status: 'idle' } as AgentSession, text: pending.text, busy: true, send: () => {}, stop: () => {} }));
  assert.match(button, /aria-label="正在提交消息"/);
  assert.match(button, /disabled=""/);
});

test('the temporary bubble disappears when the accepted user message arrives', () => {
  const pending = { text: '继续分析', beforeMessageCount: 1, phase: 'submitting' as const };
  const previous = { id: 'old', role: 'user', text: '继续分析', createdAt: '2026-09-28' } as Message;
  const accepted = { id: 'new', role: 'user', text: '含上下文的原文', userText: '继续分析', createdAt: '2026-09-28' } as Message;
  assert.match(renderToStaticMarkup(React.createElement(PendingSessionMessage, { pending, messages: [previous] })), /消息正在提交/);
  assert.equal(renderToStaticMarkup(React.createElement(PendingSessionMessage, { pending, messages: [previous, accepted] })), '');
  assert.match(renderToStaticMarkup(React.createElement(PendingSessionMessage, { pending: { ...pending, phase: 'matching' }, messages: [previous] })), /正在检查相关成果/);
  const placed = renderToStaticMarkup(React.createElement(PendingSessionMessage, { pending: { text: '问题：验收\n回复人：周祺智\n先用 v2', beforeMessageCount: 0, phase: 'question' }, messages: [] }));
  assert.match(placed, /提问已放入对话/);
  assert.match(placed, /问题：验收/);
  assert.match(placed, /已放入对话，正在连接本地 CLI/);
});
