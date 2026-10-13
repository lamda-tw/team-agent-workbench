import React from 'react';
import type { AgentSession } from '../shared/types';

export function SummaryUpdateStatus({ session }: { session: AgentSession }) {
  const reason = session.handoffState?.error;
  if (!reason) return null;
  return <div className="summary-update-status" aria-label="摘要与日志更新状态">
    <p>阶段摘要和会话日志暂未更新。{session.closedAt ? '重新打开会话后自动补齐。' : '下一轮结束或服务恢复后自动补齐，不影响继续对话。'}</p>
    <details><summary>查看失败原因</summary><p>{reason}</p></details>
  </div>;
}
