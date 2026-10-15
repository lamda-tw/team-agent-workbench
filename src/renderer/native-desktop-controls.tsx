import React, { useState } from 'react';
import type { AgentSession } from '../shared/types';
import { cursorSharedSessionUnavailable, isCursorFileSession } from '../shared/cursor-session-consistency';

export function NativeDesktopControls({ session, run }: { session: AgentSession; run: (work: () => Promise<unknown>) => unknown }) {
  const [busy, setBusy] = useState(false);
  if (!session.codexDesktop && !session.cursorNative || session.closedAt) return null;
  const call = (action: string) => { setBusy(true); void run(async () => { try { await window.workbench.call(action, { id: session.id }); } finally { setBusy(false); } }); };
  return <>
    {session.codexDesktop && <button className="secondary compact" disabled={busy} onClick={() => call('session.codexDesktop.open')}>在 Codex 中打开 <span className="badge">Beta</span></button>}
    <span className="muted small" role="status">{session.cursorNative && !isCursorFileSession(session) ? session.desktopSyncState === 'connected' ? '旧关联 · 仅查看' : session.desktopSyncState === 'connecting' ? '正在读取…' : '记录未连接' : session.desktopSyncState === 'connected' ? '同步中' : session.desktopSyncState === 'connecting' ? '正在连接…' : session.desktopSyncState === 'disconnected' ? '同步已断开' : '尚未同步'}</span>
    {session.nativeId && session.desktopSyncState !== 'connected' && <button className="secondary compact" disabled={busy || session.desktopSyncState === 'connecting' || session.status === 'starting'} onClick={() => call('session.desktopSync.restore')}>{busy ? '正在恢复…' : session.cursorNative ? '重新读取' : '恢复同步'}</button>}
    {session.cursorNative && !isCursorFileSession(session) && <span className="muted small" role="status">{cursorSharedSessionUnavailable}</span>}
    {session.desktopSyncPending && <span className="muted small" role="status">正在补齐对话…</span>}
    {session.desktopWaitingApproval && <span className="muted small" role="status">请到发起任务的窗口确认</span>}
  </>;
}
