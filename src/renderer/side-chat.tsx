import React, { useEffect, useRef, useState } from 'react';
import type { SideChat, WorkbenchAPI } from '../shared/types';
import { ConversationMessage } from './conversation-message';
import { SessionTranscript } from './session-transcript';
import { RequestCard } from './request-card';

export function SideChatPanel({ chats, selectedId, select, api, changed, creating }: {
  chats: SideChat[]; selectedId: string; select: (id: string) => void; api: WorkbenchAPI; changed: () => Promise<void>; creating?: boolean;
}) {
  const chat = chats.find(value => value.id === selectedId) || chats.at(-1);
  return <section className="side-chat-panel" aria-label="侧边提问">
    {!!chats.length && <nav className="side-chat-tabs" aria-label="临时侧聊列表">{chats.map((value, index) => <button key={value.id} aria-pressed={value.id === chat?.id} title={value.parentTitle} onClick={() => select(value.id)}>{['running', 'starting', 'approval'].includes(value.session.status) && <span className="status-pulse"/>}侧聊 {index + 1}{value.expired ? ' · 已失效' : ''}</button>)}</nav>}
    {creating && <p className="side-chat-notice" role="status"><span className="status-pulse"/>正在创建侧聊…</p>}
    {chat ? <SideChatConversation key={chat.id} chat={chat} api={api} changed={changed}/> : !creating && <p className="subsession-empty">在 Codex 对话中选中文字，点击“侧边提问”。</p>}
  </section>;
}

function SideChatConversation({ chat, api, changed }: { chat: SideChat; api: WorkbenchAPI; changed: () => Promise<void> }) {
  const [text, setText] = useState(chat.draft), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  const lock = useRef(false), currentText = useRef(text), messages = useRef<HTMLDivElement>(null);
  currentText.current = text;
  const session = chat.session, running = ['starting', 'running', 'approval'].includes(session.status);
  const invoke = <T,>(action: string, data = {}) => api.call<T>(action, { id: chat.id, parentId: chat.parentId, ...data });
  const action = async (job: () => Promise<unknown>) => { try { setError(''); await job(); await changed(); } catch (reason: any) { setError(reason.message); } };
  useEffect(() => { if (messages.current) messages.current.scrollTop = messages.current.scrollHeight; }, [session.messages.at(-1)?.text]);
  const edit = (value: string) => { setText(value); void invoke('sidechat.draft', { text: value }).catch(reason => setError(reason.message)); };
  const send = async () => {
    if (lock.current || running || chat.expired || !text.trim()) return;
    const sent = text; lock.current = true; setBusy(true);
    try {
      setError(''); await invoke('sidechat.send', { text: sent });
      if (currentText.current === sent) setText('');
      await changed();
    } catch (reason: any) { setError(reason.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="subsession-chat side-chat-conversation">
    <header><div className="subsession-heading"><b>侧边提问</b><button className="text-button" onClick={() => setConfirmClose(true)}>关闭侧聊</button></div>
      <p className="side-chat-parent" title={chat.parentTitle}>来自：{chat.parentTitle}</p><p className="subsession-context-note">临时对话 · 关闭后不保留</p>
    </header>
    {confirmClose && <div className="side-chat-notice" role="alert">关闭后将清除此侧聊。<button className="text-button" onClick={() => setConfirmClose(false)}>保留</button><button className="text-button" onClick={() => void action(() => invoke('sidechat.close'))}>关闭并清除</button></div>}
    <div className="subsession-messages" ref={messages}>
      {!session.messages.length && <p className="muted small">已继承创建时的上下文，可以直接提问。</p>}
      <SessionTranscript session={session} renderMessage={message => <ConversationMessage key={message.id} message={message} provider={session.provider} text={message.text}/>}/>
      {running && <p className="muted small" role="status"><span className="status-pulse"/>{session.status === 'approval' ? '等待你的处理' : '正在回复…'}</p>}
      {!chat.expired && session.approvals.map(request => <RequestCard key={request.id} request={request} onAnswer={(option, answers) => void action(() => invoke('sidechat.answer', { requestId: request.id, option, answers }))}/>)}
      {(error || session.error || chat.expired) && <p className="inline-error" role="alert">{error || (chat.expired ? '原连接已关闭，此侧聊已失效。已有内容仍可查看，请从原会话重新创建侧聊。' : session.error)}</p>}
    </div>
    <div className="subsession-composer"><textarea aria-label="侧边提问输入" value={text} maxLength={128 * 1024} placeholder="针对当前上下文提问…" onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!event.repeat) void send(); } }}/><div className="row"><span className="muted small">Enter 发送 · Shift+Enter 换行</span><div className="spacer"/>{running && !chat.expired && <button className="secondary" onClick={() => void action(() => invoke('sidechat.stop'))}>停止</button>}<button className="primary" disabled={busy || running || chat.expired || !text.trim()} onClick={() => void send()}>{busy ? '正在发送…' : '发送'}</button></div></div>
  </div>;
}
