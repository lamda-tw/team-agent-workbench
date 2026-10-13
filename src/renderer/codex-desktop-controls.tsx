import React, { useState } from 'react';
import type { AgentSession } from '../shared/types';

export function CodexDesktopControls({ session, run }: { session: AgentSession; run: (work: () => Promise<unknown>) => unknown }) {
  const [busy, setBusy] = useState(false);
  if (!session.codexDesktop || session.closedAt) return null;
  const call = (action: string) => { setBusy(true); void run(async () => { try { await window.workbench.call(action, { id: session.id }); } finally { setBusy(false); } }); };
  return <>
    <button className="secondary compact" disabled={busy} onClick={() => call('session.codexDesktop.open')}>在 Codex 中打开 <span className="badge">Beta</span></button>
    {(session.status === 'error' || session.cliConnection?.state === 'failed') && <button className="secondary compact" disabled={busy} onClick={() => call('session.codexDesktop.reconnect')}>{busy ? '正在重新连接…' : '重新连接'}</button>}
    {session.desktopSyncPending && <span className="muted small" role="status">正在补齐对话…</span>}
    {session.desktopWaitingApproval && <span className="muted small" role="status">请到发起任务的窗口确认</span>}
  </>;
}
