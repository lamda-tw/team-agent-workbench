import React, { useEffect, useRef } from 'react';
import { CircleAlert, CircleHelp, LoaderCircle } from 'lucide-react';
import type { AgentSession } from '../shared/types';

export function hasUnreadCompletion(session: AgentSession) {
  return session.purpose === 'work' && !session.closedAt && !session.stoppedAt && session.status === 'idle' && !session.error && !!session.completion && !session.completion.readAt;
}

export function SessionStatusIndicator({ session, sending = false }: { session: AgentSession; sending?: boolean }) {
  if (session.closedAt) return null;
  if (session.status === 'approval') return <span className="session-state pending-approval" role="status" aria-label="等待确认，对话尚未结束" title="等待确认，对话尚未结束"><LoaderCircle size={16} className="spin"/><CircleHelp size={14}/></span>;
  if (sending || session.status === 'starting' || session.status === 'running') {
    const label = session.status === 'starting' ? '正在连接，对话尚未结束' : '正在回复，对话尚未结束';
    return <span className="session-state" role="status" aria-label={label} title={label}><LoaderCircle size={16} className="spin"/></span>;
  }
  if (session.status === 'error') return <span className="session-state failed" role="status" aria-label="对话未完成，需要处理" title={session.error || '对话未完成，需要处理'}><CircleAlert size={16}/></span>;
  if (hasUnreadCompletion(session)) return <span className="session-state" role="status" aria-label="回复已完成，尚未查看" title="回复已完成，尚未查看"><span className="session-unread-dot"/></span>;
  return null;
}

export function observeVisibleCompletion(read: () => Promise<unknown>, onError: (error: Error) => void,
  page: Pick<Document, 'visibilityState' | 'hasFocus' | 'addEventListener' | 'removeEventListener'> = document,
  host: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
  let active = true, pending = false, acknowledged = false;
  const markRead = () => {
    if (!active || pending || acknowledged || page.visibilityState !== 'visible' || !page.hasFocus()) return;
    pending = true;
    void read().then(() => { acknowledged = true; }, error => { if (active) onError(error); }).finally(() => { pending = false; });
  };
  markRead();
  host.addEventListener('focus', markRead);
  page.addEventListener('visibilitychange', markRead);
  return () => { active = false; host.removeEventListener('focus', markRead); page.removeEventListener('visibilitychange', markRead); };
}

// Only acknowledge the exact completion displayed in the foreground conversation.
// Keeping this in the session store preserves unread state across restarts/windows.
export function useSessionCompletionRead(session: AgentSession | undefined, read: (id: string, completionId: string) => Promise<unknown>, onError: (error: Error) => void) {
  const readRef = useRef(read), errorRef = useRef(onError);
  readRef.current = read; errorRef.current = onError;
  const id = session?.id, completionId = session?.completion?.id, unread = !!session && hasUnreadCompletion(session);
  useEffect(() => {
    if (!id || !completionId || !unread) return;
    return observeVisibleCompletion(() => readRef.current(id, completionId), error => errorRef.current(error));
  }, [id, completionId, unread]);
}
