import React from 'react';
import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react';
import type { AgentSession, Message } from '../shared/types';
import { withoutQuestionFillTurns } from '../shared/session-context-text';
import { CursorNativeRecord } from './cursor-native-record';

type TranscriptRow = { kind: 'message'; id: string; message: Message } | { kind: 'tools'; id: string; messages: Message[] };
type DisplayRow = TranscriptRow | { kind: 'activity'; id: string; messages: Message[] };

/** Group only adjacent tools; prose, plans and user turns retain their positions. */
export function sessionTranscriptRows(messages: Message[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const message of withoutQuestionFillTurns(messages)) {
    if (message.role !== 'tool' || message.kind) {
      rows.push({ kind: 'message', id: message.id, message });
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === 'tools') last.messages.push(message);
    else rows.push({ kind: 'tools', id: message.id, messages: [message] });
  }
  return rows;
}

/** Fold completed turns without changing stored history or hiding user input. */
export function sessionDisplayRows(session: Pick<AgentSession, 'messages' | 'status' | 'error' | 'stoppedAt'>): DisplayRow[] {
  const turns: Message[][] = [];
  for (const message of session.messages) {
    if (!turns.length || message.role === 'user' && !message.steering) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns.flatMap((turn, index): DisplayRow[] => {
    const messages = withoutQuestionFillTurns(turn);
    // Partition before filtering so a hidden draft task does not reopen the
    // preceding completed turn. Stopped/failed turns keep their partial output.
    if (index === turns.length - 1 && (session.status !== 'idle' || session.error || session.stoppedAt)) return sessionTranscriptRows(messages);
    const finals = new Set(messages.filter(message => message.role === 'assistant' && message.phase === 'final_answer' && message.text.trim()));
    if (!finals.size) {
      // Older records and other providers may not expose a final-answer phase.
      // Require an answer at the end; tools or steering alone are not a result.
      const last = [...messages].reverse().find(message => message.role !== 'system' && message.kind !== 'planSteps' && message.text.trim());
      if (last?.role === 'assistant' && last.phase !== 'commentary') finals.add(last);
    }
    if (!finals.size) return sessionTranscriptRows(messages);
    const rows: DisplayRow[] = [];
    for (const message of messages) {
      if (message.role === 'assistant' && !message.text.trim() && !message.kind && !message.nativeDetails) continue;
      if (finals.has(message) || message.role === 'user' || message.role === 'system') {
        rows.push({ kind: 'message', id: message.id, message });
      } else {
        const last = rows.at(-1);
        if (last?.kind === 'activity') last.messages.push(message);
        else rows.push({ kind: 'activity', id: message.id, messages: [message] });
      }
    }
    return rows;
  });
}

export function toolExecutionTitle(message: Message): string {
  // Some providers store structured events; avoid a bare "{" as the label.
  let event: Record<string, unknown> | undefined;
  if (message.text.trimStart().startsWith('{')) {
    try { event = JSON.parse(message.text); } catch { /* Streaming/incomplete JSON keeps its original text. */ }
  }
  const title = event && [event.title, event.command, event.tool, event.name].find(value => typeof value === 'string' && value.trim());
  const types: Record<string, string> = { fileChange: '修改文件', mcpToolCall: '调用 MCP 工具', webSearch: '搜索网页' };
  const text = typeof title === 'string' ? title : event && typeof event.type === 'string' ? types[event.type] || event.type : message.text;
  return text.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 160) || '查看工具记录';
}

function ToolExecutionGroup({ messages, activity }: { messages: Message[]; activity?: string }) {
  const latest = toolExecutionTitle(messages[messages.length - 1]);
  // Native details owns its open state. A key based on the first tool preserves
  // the user's choice as output streams and more tools join this group.
  return <details className="tool-execution-group">
    <summary className="tool-execution-summary">
      <ChevronRight className="tool-execution-chevron" size={14} aria-hidden="true"/>
      {activity ? <LoaderCircle className="spin" size={14} aria-hidden="true"/> : <Terminal size={14} aria-hidden="true"/>}
      <span className="tool-execution-label">工具执行 · {messages.length} 项</span>
      {activity && <span className="tool-execution-activity">{activity}</span>}
      <span className="tool-execution-preview" title={latest}>{latest}</span>
    </summary>
    <div className="tool-execution-list">
      {messages.map(message => <div className="tool-execution-item" key={message.id}>
        <details className="tool-execution-output">
          <summary><ChevronRight size={12} aria-hidden="true"/><span>{toolExecutionTitle(message)}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></summary>
          <pre>{message.text}</pre>
        </details>
        <CursorNativeRecord message={message}/>
      </div>)}
    </div>
  </details>;
}

export function SessionTranscript({ session, renderMessage }: { session: AgentSession; renderMessage: (message: Message) => React.ReactNode }) {
  const rows = sessionDisplayRows(session);
  const renderRow = (row: TranscriptRow, activity?: string) => row.kind === 'tools'
    ? <ToolExecutionGroup key={`${session.id}:tools:${row.id}`} messages={row.messages} activity={activity}/>
    : <React.Fragment key={`${session.id}:message:${row.id}`}>{renderMessage(row.message)}</React.Fragment>;
  return <>{rows.map((row, index) => row.kind === 'activity'
    ? <details className="turn-activity-group" key={`${session.id}:activity:${row.id}`}>
        <summary className="tool-execution-summary"><ChevronRight className="tool-execution-chevron" size={14} aria-hidden="true"/><span>工作过程 · {row.messages.length} 项</span></summary>
        <div className="turn-activity-content">{sessionTranscriptRows(row.messages).map(item => renderRow(item))}</div>
      </details>
    : renderRow(row, index === rows.length - 1 && !session.closedAt ? session.status === 'approval' ? '等待确认' : ['running', 'starting'].includes(session.status) ? '本轮进行中' : undefined : undefined))}</>;
}
