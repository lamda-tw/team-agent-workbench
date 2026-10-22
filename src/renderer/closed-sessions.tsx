import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, History, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { AgentSession, Message, WorkbenchAPI } from '../shared/types';
import { sessionMessageText } from '../shared/session-context-text';
import { subsessionParentId } from '../shared/subsessions';
import { ConversationMessage } from './conversation-message';
import { SessionTranscript } from './session-transcript';
import './closed-sessions.css';

const providerNames = { codex: 'Codex', cursor: 'Cursor', claude: 'Claude Code' };

export function ClosedSessionsDialog({ sessions, initialId, api, close, reopen, remove }: {
  sessions: AgentSession[]; initialId?: string; api: WorkbenchAPI;
  close: () => void; reopen: (session: AgentSession) => Promise<void>; remove: (session: AgentSession) => void;
}) {
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState(initialId || '');
  const [busyId, setBusyId] = useState(''), [error, setError] = useState('');
  const opening = useRef(false), dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef(document.activeElement);
  const closed = sessions.filter(session => session.closedAt).sort((a, b) => b.closedAt!.localeCompare(a.closedAt!));
  const selected = closed.find(session => session.id === selectedId);
  const matches = closed.filter(session => `${session.title} ${session.binding?.project.name || ''} ${providerNames[session.provider]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    const previous = previousFocus.current;
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const target = dialog.current?.querySelector<HTMLElement>(selected ? '[aria-label="返回已关闭会话列表"]' : 'input');
    target?.focus();
  }, [selected?.id]);
  const open = async (session: AgentSession) => {
    if (opening.current) return;
    opening.current = true; setBusyId(session.id); setError('');
    try { await reopen(session); }
    catch (reason: any) { setError(reason.message); }
    finally { opening.current = false; setBusyId(''); }
  };
  const actions = (session: AgentSession) => <div className="closed-session-actions">
    <button className="secondary compact" disabled={!!busyId} onClick={() => void open(session)}><RotateCcw size={13}/>{busyId === session.id ? '正在打开…' : '重新打开'}</button>
    <button className="icon danger" aria-label={'删除会话：' + session.title} title="删除会话" disabled={!!busyId} onClick={() => remove(session)}><Trash2 size={15}/></button>
  </div>;
  return <div className="modal-backdrop" onKeyDown={event => {
    if (event.key === 'Escape' && !busyId) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href], summary, [tabindex="0"]') || [])].filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <section ref={dialog} className="modal closed-sessions-dialog" role="dialog" aria-modal="true" aria-labelledby="closed-sessions-title">
      <header><h2 id="closed-sessions-title"><History size={18}/>已关闭会话 <span className="muted small">{closed.length}</span></h2><button className="icon" aria-label="关闭历史会话窗口" onClick={close}><X size={18}/></button></header>
      {error && <p className="inline-error closed-sessions-error" role="alert">{error}</p>}
      {selected ? <>
        <div className="closed-session-heading"><button className="icon" aria-label="返回已关闭会话列表" onClick={() => { setSelectedId(''); setError(''); }}><ArrowLeft size={18}/></button><div><h3>{selected.title}</h3><p className="muted small">{providerNames[selected.provider]} · {selected.binding?.project.name || '本地会话'}</p></div>{actions(selected)}</div>
        <ClosedSessionRecord key={selected.id} session={selected} api={api}/>
      </> : <>
        <label className="closed-sessions-search"><Search size={15}/><input autoFocus aria-label="搜索已关闭会话" placeholder="搜索会话或项目" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="closed-sessions-list">
          {matches.map(session => <div className="closed-session-row" key={session.id}>
            <button className="closed-session-entry" aria-label={'查看记录：' + session.title} onClick={() => { setSelectedId(session.id); setError(''); }}>
              <b>{session.title}</b><span>{providerNames[session.provider]} · {session.binding?.project.name || '本地会话'}{subsessionParentId(session) ? ' · 子会话' : ''}</span>
              <time dateTime={session.closedAt}>关闭于 {new Date(session.closedAt!).toLocaleString('zh-CN')}</time>
            </button>{actions(session)}
          </div>)}
          {!matches.length && <p className="closed-sessions-empty muted">{query.trim() ? '没有匹配的已关闭会话。' : '暂无已关闭会话。'}</p>}
        </div>
      </>}
    </section>
  </div>;
}

function ClosedSessionRecord({ session, api }: { session: AgentSession; api: WorkbenchAPI }) {
  const [inherited, setInherited] = useState<Message[]>(), [error, setError] = useState('');
  const render = (message: Message) => <ConversationMessage key={message.id} message={message} provider={session.provider} text={sessionMessageText(session, message)} sessionId={session.id}/>;
  return <div className="closed-session-record">
    {session.fork && <details className="inherited-conversation" onToggle={event => {
      if (event.currentTarget.open && !inherited) void api.call<Message[]>('subsession.history', { id: session.id }).then(setInherited, reason => setError(reason.message));
    }}><summary>创建时的上下文</summary>{error ? <p className="inline-error" role="alert">{error}</p> : inherited ? <SessionTranscript session={{ ...session, messages: inherited, status: 'idle' }} renderMessage={render}/> : <p className="muted small">正在读取固定快照…</p>}</details>}
    <SessionTranscript session={session} renderMessage={render}/>
    {!session.messages.length && <p className="muted small">此会话暂无对话记录。</p>}
  </div>;
}
