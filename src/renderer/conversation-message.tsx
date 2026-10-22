import React from 'react';
import { Puzzle } from 'lucide-react';
import type { Message, Provider } from '../shared/types';
import { Markdown } from './markdown';
import { CursorNativeRecord } from './cursor-native-record';
import { CopyTextButton } from './copy-text-button';

export function ConversationMessage({ message, provider, text = message.text, sessionId, openFile, pendingLabel, children }: {
  message: Message; provider: Provider; text?: string; sessionId?: string;
  openFile?: (path: string) => void; pendingLabel?: string; children?: React.ReactNode;
}) {
  const user = message.role === 'user', assistant = message.role === 'assistant';
  const name = user ? '你' : assistant ? provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : 'Claude Code' : message.role === 'tool' ? '工具执行' : '运行信息';
  const member = user && !!message.context?.questionRunId;
  const showMetadata = !user && !assistant || member || message.steering || pendingLabel;
  const timestamp = new Date(message.createdAt);
  const validTime = Number.isFinite(timestamp.getTime());
  const time = validTime ? <time dateTime={message.createdAt} title={timestamp.toLocaleString('zh-CN')}>{timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time> : null;
  return <article className={'message conversation-message ' + message.role + (pendingLabel ? ' message-pending is-question' : '')} aria-label={name + '的消息'}>
    <div className="message-surface">
      {showMetadata && <div className="message-author"><b>{name}</b>{message.steering && <span className="badge">引导</span>}{member && <span className="badge">成员消息</span>}{pendingLabel && <span className="pending-message-state question" role="status"><span className="status-pulse"/>{pendingLabel}</span>}{time}</div>}
      {children ?? (message.role === 'tool' ? <details><summary>{text.split('\n')[0]?.slice(0, 130) || '查看工具事件'}</summary><pre>{text}</pre></details> : <Markdown text={text} sessionId={sessionId} openFile={openFile} conversation/>)}
      {user && !!message.context?.capabilities?.length && <div className="message-capabilities">{message.context.capabilities.map(item => <span key={item.id}><Puzzle size={11}/>{item.name}</span>)}</div>}
      <CursorNativeRecord message={message}/>
      {assistant && !!text.trim() && <footer className="conversation-message-footer"><CopyTextButton text={text} label="复制这条回复"/>{time}</footer>}
    </div>
  </article>;
}
