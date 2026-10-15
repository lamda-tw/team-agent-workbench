import React from 'react';
import { ChevronRight, LoaderCircle, Terminal } from 'lucide-react';
import type { AgentSession, Message } from '../shared/types';
import { withoutQuestionFillTurns } from '../shared/session-context-text';
import { CursorNativeRecord } from './cursor-native-record';

type TranscriptRow = { kind: 'message'; id: string; message: Message } | { kind: 'tools'; id: string; messages: Message[] };

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
  const rows = sessionTranscriptRows(session.messages);
  return <>{rows.map((row, index) => row.kind === 'tools'
    ? <ToolExecutionGroup key={`${session.id}:tools:${row.id}`} messages={row.messages} activity={index === rows.length - 1 && !session.closedAt ? session.status === 'approval' ? '等待确认' : ['running', 'starting'].includes(session.status) ? '本轮进行中' : undefined : undefined}/>
    : <React.Fragment key={`${session.id}:message:${row.id}`}>{renderMessage(row.message)}</React.Fragment>)}</>;
}
