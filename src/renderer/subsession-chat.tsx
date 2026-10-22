import React, { useEffect, useRef, useState } from 'react';
import { ConversationMessage } from './conversation-message';
import type { AgentSession, Message, SessionInput, WorkbenchAPI } from '../shared/types';
import { quoteSessionText, subsessionParentId } from '../shared/subsessions';
import { sessionMessageText } from '../shared/session-context-text';
import { submitComposerInput } from './composer-input';
import { SessionTranscript } from './session-transcript';
import { SelectionActions } from './selection-actions';
import { RequestCard } from './request-card';
import { SessionStatusIndicator, useSessionCompletionRead } from './session-status';
import { SessionMoreMenu } from './session-more-menu';
import { SessionName } from './session-name';

export function SessionTree({ sessions, selectedId, childId, open, create, promote, organize, rename }: {
  sessions: AgentSession[]; selectedId: string; childId?: string;
  open: (session: AgentSession) => void; create: (session: AgentSession) => void;
  promote: (session: AgentSession) => void; organize?: (session: AgentSession) => React.ReactNode;
  rename: (id: string, title: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const selectedAncestors = new Set<string>();
  let selected = sessions.find(value => value.id === childId);
  while (selected && subsessionParentId(selected) && !selectedAncestors.has(subsessionParentId(selected)!)) {
    selectedAncestors.add(subsessionParentId(selected)!);
    selected = sessions.find(value => value.id === subsessionParentId(selected!));
  }
  useEffect(() => {
    setExpanded(value => ({ ...value, ...Object.fromEntries([...selectedAncestors].map(id => [id, true])) }));
  }, [childId]);
  const row = (session: AgentSession, ancestors: Set<string>): React.ReactNode => {
    if (ancestors.has(session.id)) return null;
    const path = new Set([...ancestors, session.id]);
    const children = sessions.filter(value => subsessionParentId(value) === session.id);
    const isExpanded = expanded[session.id] ?? selectedAncestors.has(session.id);
    return <div className="session-tree-node" key={session.id}>
      <div className="personal-session-row">
        <button className="icon" aria-label={`展开会话菜单：${session.title}`} aria-expanded={isExpanded} onClick={() => setExpanded(value => ({ ...value, [session.id]: !isExpanded }))}>{isExpanded ? '▾' : '▸'}</button>
        <SessionName title={session.title} variant="sidebar" save={title => rename(session.id, title)}>{begin => <button className={'session-row ' + ([selectedId, childId].includes(session.id) ? 'selected' : '')} data-session-id={session.id} title={session.title + ' · 双击修改名称'} onClick={() => open(session)} onDoubleClick={begin}><span className={'provider-icon ' + session.provider}>{session.provider === 'codex' ? 'G' : session.provider === 'cursor' ? 'C' : 'A'}</span><span><b>{session.title}</b><small>{session.closedAt ? '已关闭' : subsessionParentId(session) ? '子会话' : session.provider}</small></span><SessionStatusIndicator session={session}/></button>}</SessionName>
        {organize?.(session)}
      </div>
      {isExpanded && <div className="session-tree-children">
        {!session.closedAt && session.provider === 'codex' && <button className="text-button" onClick={() => create(session)}>＋ 创建子会话</button>}
        {subsessionParentId(session) && <button className="text-button" onClick={() => promote(session)}>升级为独立会话</button>}
        {children.map(value => row(value, path))}
      </div>}
    </div>;
  };
  return <>{sessions.filter(value => !subsessionParentId(value) || !sessions.some(parent => parent.id === subsessionParentId(value))).map(value => row(value, new Set()))}</>;
}

export function SubsessionChat({ session, sessions, input, edit, api, active, open, sideChat, promote, remove, closed, locked, changed }: {
  session?: AgentSession; sessions: AgentSession[]; input?: SessionInput; edit: (id: string, patch: Partial<SessionInput>) => void;
  api: WorkbenchAPI; active: boolean; open: (session: AgentSession) => void; sideChat?: (session: AgentSession, text?: string) => void;
  promote: (session: AgentSession) => void; remove: (session: AgentSession) => void; closed: (id: string) => void; locked?: boolean; changed: () => Promise<void>;
}) {
  const [error, setError] = useState(''), [sending, setSending] = useState(false), [history, setHistory] = useState<Message[]>();
  const lock = useRef(false), availabilityLock = useRef(false), messages = useRef<HTMLDivElement>(null);
  const [changingAvailability, setChangingAvailability] = useState(false);
  const latestInput = useRef(input); latestInput.current = input;
  useEffect(() => { setError(''); setHistory(undefined); }, [session?.id]);
  useSessionCompletionRead(active ? session : undefined, (id, completionId) => api.call('session.completion.read', { id, completionId }), reason => setError(reason.message));
  useEffect(() => { if (messages.current) messages.current.scrollTop = messages.current.scrollHeight; }, [session?.id, session?.messages.at(-1)?.text]);
  if (!session) return <div className="subsession-empty">在左侧会话菜单中创建或打开子会话。</div>;
  const current = input || { text: '', sourceIds: [], answers: {} };
  const running = ['starting', 'running', 'approval'].includes(session.status);
  const parent = sessions.find(value => value.id === subsessionParentId(session));
  const children = sessions.filter(value => subsessionParentId(value) === session.id && !value.closedAt);
  const action = async (job: () => Promise<unknown>) => { try { setError(''); await job(); await changed(); } catch (reason: any) { setError(reason.message); } };
  const changeAvailability = async () => {
    if (availabilityLock.current) return;
    availabilityLock.current = true; setChangingAvailability(true); setError('');
    const wasClosed = !!session.closedAt;
    try {
      await api.call(wasClosed ? 'session.reopen' : 'session.close', { id: session.id });
      await changed();
      if (!wasClosed) closed(session.id);
    } catch (reason: any) { setError(reason.message); }
    finally { availabilityLock.current = false; setChangingAvailability(false); }
  };
  const send = async () => {
    if (lock.current || availabilityLock.current || session.closedAt || locked || running || !current.text.trim()) return;
    lock.current = true; setSending(true);
    try { setError(''); await submitComposerInput(api, session.id, current, undefined, () => latestInput.current || current, id => edit(id, { text: '', sourceIds: [], capabilities: [] })); await changed(); }
    catch (reason: any) { setError(reason.message); }
    finally { lock.current = false; setSending(false); }
  };
  const render = (message: Message) => <ConversationMessage key={message.id} message={message} provider={session.provider} text={sessionMessageText(session, message)} sessionId={session.id}/>;
  return <section className="subsession-chat" aria-label={'子会话：' + session.title}>
    <header>
      <div className="subsession-heading"><SessionName key={session.id} title={session.title} variant="subsession" save={async title => { await api.call('session.rename', { id: session.id, title }); await changed(); }}/>{session.closedAt ? <span className="muted small" role="status">已关闭</span> : <SessionStatusIndicator session={session}/>}
        <SessionMoreMenu label="更多子会话操作">
          {parent && <div className="session-menu-group"><button type="button" onClick={() => promote(session)}>升级为独立会话</button></div>}
          <div className="session-menu-group">
            <button type="button" disabled={changingAvailability} onClick={() => void changeAvailability()}>{changingAvailability ? (session.closedAt ? '正在打开…' : '正在关闭…') : session.closedAt ? '重新打开' : '关闭会话'}</button>
            {session.closedAt && <button type="button" className="danger" onClick={() => remove(session)}>删除会话</button>}
          </div>
        </SessionMoreMenu>
      </div>
      {parent && <button className="subsession-parent text-button" title={'返回 ' + parent.title} onClick={() => open(parent)}>← {parent.title}</button>}
      <p className="subsession-context-note" title="上下文独立；与父会话共用工作目录，文件修改会相互可见。">上下文独立 · 共用工作目录</p>
    </header>
    {children.length > 0 && <details className="subsession-child-list"><summary>下级子会话 · {children.length}</summary><nav className="subsession-child-links" aria-label="下级子会话">{children.map(child => <button key={child.id} title={child.title} onClick={() => open(child)}><span>{child.title}</span><SessionStatusIndicator session={child}/></button>)}</nav></details>}
    <div className="subsession-messages" ref={messages}>
      <SelectionActions sessionId={session.id} add={!session.closedAt ? text => edit(session.id, { text: current.text + (current.text ? '\n\n' : '') + quoteSessionText(text) }) : undefined} sideChat={!session.closedAt && sideChat ? text => sideChat(session, text) : undefined}>
        {session.fork && <details className="inherited-conversation" onToggle={event => { if (event.currentTarget.open && !history) void api.call<Message[]>('subsession.history', { id: session.id }).then(setHistory, reason => setError(reason.message)); }}><summary>创建时的上下文 · {new Date(session.fork.capturedAt).toLocaleTimeString('zh-CN')}{session.fork.parentWasRunning ? ' · 包含当时未完成的回复' : ''}</summary>{history ? <SessionTranscript session={{ ...session, messages: history, status: 'idle' }} renderMessage={render}/> : <p>正在读取固定快照…</p>}</details>}
        <SessionTranscript session={session} renderMessage={render}/>
      </SelectionActions>
      {running && <p className="muted small">本轮尚未结束。</p>}
      {session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void action(() => api.call('session.answer', { id: session.id, requestId: request.id, option, answers }))}/>)}
      {(error || session.error) && <p role="alert" className="inline-error">{error || session.error}</p>}
    </div>
    {!session.closedAt && <div className="subsession-composer"><textarea aria-label="子会话输入" value={current.text} placeholder="在这个分支继续提问…" onChange={event => edit(session.id, { text: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!event.repeat) void send(); } }}/><div className="row"><span className="muted small">{locked ? '关联提问正在自动对话' : 'Enter 发送 · Shift+Enter 换行'}</span><div className="spacer"/>{running && <button className="secondary" onClick={() => void action(() => api.call('session.stop', { id: session.id }))}>停止</button>}<button className="primary" disabled={locked || running || sending || changingAvailability || !current.text.trim()} onClick={() => void send()}>{sending ? '正在发送…' : '发送'}</button></div></div>}
  </section>;
}
