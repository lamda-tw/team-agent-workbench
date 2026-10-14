import React from 'react';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import type { AgentSession } from '../shared/types';
import { cursorSharedSessionUnavailable } from '../shared/cursor-session-consistency';

export function composerMode(session: Pick<AgentSession, 'provider' | 'status' | 'closedAt' | 'cursorNative'>, activeTurnId?: string): 'send' | 'steer' | 'wait' {
  if (session.closedAt || session.cursorNative || session.status === 'starting') return 'wait';
  if (['running', 'approval'].includes(session.status)) return session.provider === 'codex' && activeTurnId ? 'steer' : 'wait';
  return 'send';
}

export function ComposerActions({ session, activeTurnId, text, busy, send, stop }: {
  session: AgentSession; activeTurnId?: string; text: string; busy: boolean; send: () => void; stop: () => void;
}) {
  const mode = composerMode(session, activeTurnId), active = ['starting', 'running', 'approval'].includes(session.status);
  if (session.closedAt) return null;
  if (session.cursorNative) return <button className="send" aria-label="发送任务" disabled title={cursorSharedSessionUnavailable}><ArrowUp size={20}/></button>;
  return <>
    {mode === 'send' && <button className="send" aria-label={busy ? '正在提交消息' : '发送任务'} title={busy ? '正在提交消息' : '发送任务'} disabled={!text.trim() || busy} onClick={send}>{busy ? <LoaderCircle size={18} className="spin"/> : <ArrowUp size={20}/>}</button>}
    {active && session.provider === 'codex' && <button className="primary compact" aria-label="引导当前任务" title={mode === 'steer' ? '补充要求，继续当前任务' : '等待当前任务就绪后可引导'} disabled={mode !== 'steer' || !text.trim() || busy} onClick={send}>{busy && mode === 'steer' ? '发送中…' : '引导'}</button>}
    {active && <button className="send stop" aria-label="停止当前任务" title="停止当前任务" onClick={stop}><Square size={15}/></button>}
  </>;
}
