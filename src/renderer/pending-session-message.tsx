import React from 'react';
import type { AgentSession, Message } from '../shared/types';
import { sessionMessageText } from '../shared/session-context-text';

export interface PendingMessage { text: string; beforeMessageCount: number; phase: 'matching' | 'submitting' | 'question' }

export function PendingSessionMessage({ pending, messages, session }: { pending: PendingMessage; messages: Message[]; session?: AgentSession }) {
  if (messages.slice(pending.beforeMessageCount).some(message => message.role === 'user' && (session ? sessionMessageText(session, message) : message.userText ?? message.text) === pending.text)) return null;
  const question = pending.phase === 'question';
  return <article className={'message user message-pending' + (question ? ' is-question' : '')} role="status" aria-label={question ? '提问已放入对话' : '消息正在提交'}>
    <div className="message-author"><span className="provider-icon user">我</span><b>你</b><span className={'pending-message-state' + (question ? ' question' : '')}><span className="status-pulse"/>{question ? (session?.error || '已放入对话，正在连接本地 CLI…') : pending.phase === 'matching' ? '正在检查相关成果…' : session?.cursorNative ? '正在加入 Cursor 等待队列…' : '正在提交，等待 CLI 确认…'}</span></div>
    <div className={'pending-message-text' + (question ? ' question' : '')}>{pending.text}</div>
  </article>;
}
