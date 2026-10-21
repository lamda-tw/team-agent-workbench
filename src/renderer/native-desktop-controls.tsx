import React, { useState } from 'react';
import type { AgentSession } from '../shared/types';
import { cursorSharedSessionUnavailable, isCursorFileSession } from '../shared/cursor-session-consistency';

export function CodexDesktopOption({ checked, networkRoute, changed }: { checked: boolean; networkRoute: AgentSession['networkRoute']; changed: (enabled: boolean) => void }) {
  const unavailable = networkRoute === 'management';
  return <div className="codex-desktop-option"><div><strong>与 Codex 桌面版同步</strong><p>{unavailable ? '当前使用管理端访问，暂不支持桌面同步。' : '在工作台和 Codex 中继续同一条对话。'}</p></div>
    <button type="button" role="switch" className="project-ai-switch" aria-label="与 Codex 桌面版同步" aria-checked={checked && !unavailable} disabled={unavailable} onClick={() => changed(!checked)}><span/></button>
  </div>;
}

export function NativeDesktopStatus({ session }: { session: AgentSession }) {
  if (session.codexSyncRequest && !session.codexDesktop && !session.closedAt) return <span className="native-desktop-status"><span className="muted small" role="status" title={session.codexSyncRequest.error || '可继续工作。退出 Codex 后，工作台会自动完成同步并重新打开。'}>{session.codexSyncRequest.error ? '同步待处理' : '等待 Codex 退出后同步'}</span></span>;
  if (!session.codexDesktop && !session.cursorNative && !(session.provider === 'codex' && session.desktopSyncState === 'connecting') || session.closedAt) return null;
  return <span className="native-desktop-status">
    <span className="muted small" role="status">{session.cursorNative && !isCursorFileSession(session) ? session.desktopSyncState === 'connected' ? '旧关联 · 仅查看' : session.desktopSyncState === 'connecting' ? '正在读取…' : '记录未连接' : session.desktopSyncState === 'connected' ? '同步中' : session.desktopSyncState === 'connecting' ? '正在连接…' : session.desktopSyncState === 'disconnected' ? '同步已断开' : '尚未同步'}</span>
    {session.cursorNative && !isCursorFileSession(session) && <span className="muted small" role="status">{cursorSharedSessionUnavailable}</span>}
    {session.desktopSyncPending && <span className="muted small" role="status">正在补齐对话…</span>}
    {session.desktopWaitingApproval && <span className="muted small" role="status">请到发起任务的窗口确认</span>}
  </span>;
}

export function NativeDesktopControls({ session, run, showStatus = true }: { session: AgentSession; run: (work: () => Promise<unknown>) => unknown; showStatus?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (session.closedAt || session.purpose !== 'work' || session.provider !== 'codex' && !session.cursorNative) return null;
  const call = (action: string) => { setBusy(true); void run(async () => { try { await window.workbench.call(action, { id: session.id }); } finally { setBusy(false); } }); };
  return <>
    {!session.codexDesktop && session.provider === 'codex' && <>
      <button className="secondary compact" disabled={busy || session.networkRoute === 'management' || ['starting', 'running', 'approval'].includes(session.status)} onClick={() => call('session.codexDesktop.sync')}>{busy || session.desktopSyncState === 'connecting' ? '正在同步…' : session.codexSyncRequest ? session.codexSyncRequest.error ? '重试同步' : '完成同步并打开 Codex' : '同步到 Codex'}</button>
      {session.codexSyncRequest && <><span className="muted small" role="status">{session.codexSyncRequest.error || '已安排同步，可继续工作。方便时退出 Codex，工作台会自动完成同步并重新打开。'}</span><button className="secondary compact" disabled={busy || session.desktopSyncState === 'connecting'} onClick={() => call('session.codexDesktop.cancel')}>取消同步请求</button></>}
      {session.networkRoute === 'management' ? <span className="muted small">当前使用管理端访问，暂不支持桌面同步。</span> : ['starting', 'running', 'approval'].includes(session.status) && !busy && session.desktopSyncState !== 'connecting' ? <span className="muted small">当前回复结束后可同步。</span> : null}
    </>}
    {session.codexDesktop && <button className="secondary compact" disabled={busy} onClick={() => call('session.codexDesktop.open')}>在 Codex 中打开</button>}
    {showStatus && <NativeDesktopStatus session={session}/>}
    {(session.codexDesktop || session.cursorNative) && session.nativeId && session.desktopSyncState !== 'connected' && <button className="secondary compact" disabled={busy || session.desktopSyncState === 'connecting' || session.status === 'starting'} onClick={() => call('session.desktopSync.restore')}>{busy ? '正在恢复…' : session.cursorNative ? '重新读取' : '恢复同步'}</button>}
  </>;
}
