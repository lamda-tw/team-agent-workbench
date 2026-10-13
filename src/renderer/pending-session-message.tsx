import React from 'react';
import type { AgentSession, Message } from '../shared/types';
import { sessionMessageText } from '../shared/session-context-text';

export interface PendingMessage { text: string; beforeMessageCount: number; phase: 'matching' | 'submitting' }

export function PendingSessionMessage({ pending, messages, session }: { pending: PendingMessage; messages: Message[]; session?: AgentSession }) {
  if (messages.slice(pending.beforeMessageCount).some(message => message.role === 'user' && (session ? sessionMessageText(session, message) : message.userText ?? message.text) === pending.text)) return null;
  return <article className="message user message-pending" role="status" aria-label="消息正在提交">
    <div className="message-author"><span className="provider-icon user">我</span><b>你</b><span className="pending-message-state"><span className="status-pulse"/>{pending.phase === 'matching' ? '正在检查相关成果…' : '正在提交，等待 CLI 确认…'}</span></div>
    <div className="pending-message-text">{pending.text}</div>
  </article>;
}
