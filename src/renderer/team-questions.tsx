import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import type { AgentSession, Project } from '../shared/types';
import type { QuestionInbox, QuestionMember, TeamQuestion } from '../shared/questions';

const empty: QuestionInbox = { items: [], jobs: [], read: {} };
export const questionUnread = (q: TeamQuestion, inbox: QuestionInbox) => (inbox.read[q.id] || 0) < q.activityRevision;
const time = (value: string) => new Date(value).toLocaleString('zh-CN');
export function QuestionCard({ question: q, unread, open }: { question: TeamQuestion; unread: boolean; open: () => void }) {
  return <button className={'team-question-card' + (unread ? ' unread' : '')} onClick={open}>
    <span className="row"><b>{q.title}</b><span className="spacer"/><span className={'badge' + (q.closedAt ? ' muted' : '')}>{q.closedAt ? '已关闭' : '开放'}</span></span>
    <small>{q.authorName} 提问 · {q.recipients.filter(r => r.answers.length).length}/{q.recipients.length === q.recipientCount ? q.recipientCount : 1} 人已回复{unread ? ' · 有新动态' : ''}</small>
  </button>;
}
export function QuestionFeed({ inbox = empty, projects, open }: { inbox?: QuestionInbox; projects: Project[]; open: (id: string) => void }) {
  const [scope, setScope] = useState('all'), [search, setSearch] = useState('');
  const items = inbox.items.filter(q => (scope === 'all' || (scope === 'closed' ? !!q.closedAt : !q.closedAt)) && (q.title + q.authorName).includes(search)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="team-question-feed" aria-label="提问动态"><div className="row"><MessageSquare size={18}/><h3>提问动态</h3><span className="spacer"/><select aria-label="筛选提问状态" value={scope} onChange={e => setScope(e.target.value)}><option value="open">开放的问题</option><option value="closed">已关闭</option><option value="all">全部</option></select><input aria-label="搜索提问" placeholder="搜索问题或发问人" value={search} onChange={e => setSearch(e.target.value)}/></div>
    {inbox.error && <p className="inline-error">提问动态暂未同步：{inbox.error}</p>}
    <div className="team-question-feed-list">{items.map(q => <div key={q.id}><small className="muted">{projects.find(p => p.id === q.projectId)?.name || '项目'}</small><QuestionCard question={q} unread={questionUnread(q, inbox)} open={() => open(q.id)}/></div>)}{!items.length && <p className="muted small">暂无{scope === 'closed' ? '已关闭' : scope === 'open' ? '开放的' : ''}问题</p>}</div>
  </section>;
}

function QuestionComposer({ session, sent }: { session: AgentSession; sent: (q: TeamQuestion) => void }) {
  const [members, setMembers] = useState<QuestionMember[]>([]), [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [context, setContext] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const submitted = useRef<{ payload: string; id: string } | undefined>(undefined), working = useRef(false);
  useEffect(() => { let active = true; void window.workbench.call<QuestionMember[]>('question.members', { projectId: session.binding!.project.id }).then(value => { if (active) setMembers(value); }, e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [session.id]);
  const send = async () => {
    if (working.current) return; working.current = true; setBusy(true); setError('');
    const value = { title: title.trim(), body: body.trim(), context, recipients: [...selected].sort() }, payload = JSON.stringify(value);
    if (submitted.current?.payload !== payload) submitted.current = { payload, id: crypto.randomUUID() };
    try { const q = await window.workbench.call<TeamQuestion>('question.create', { sessionId: session.id, question: { ...value, id: submitted.current.id } }); sent(q); }
    catch (e: any) { setError(e.message); } finally { working.current = false; setBusy(false); }
  };
  return <details className="team-question-compose" open><summary>向组内成员提问</summary><fieldset disabled={busy || !!session.closedAt}>
    <label>问题标题<input maxLength={200} value={title} onChange={e => setTitle(e.target.value)}/></label>
    <label>需要补充什么<textarea rows={4} maxLength={12000} value={body} onChange={e => setBody(e.target.value)}/></label>
    <label>补充资料（可选）<textarea rows={2} maxLength={24000} placeholder="填写可以分享的背景、资料或链接" value={context} onChange={e => setContext(e.target.value)}/></label>
    <span>接收成员（可多选）</span><div className="team-question-members">{members.map(m => <label key={m.username}><input type="checkbox" checked={selected.includes(m.username)} onChange={e => setSelected(current => e.target.checked ? [...current, m.username] : current.filter(name => name !== m.username))}/>{m.name} <small className="muted">{m.username}</small></label>)}{loading ? <small>正在读取成员…</small> : !members.length && <small>当前组没有可选择的其他成员</small>}</div>
    <p className="muted small">只发送这里填写的内容。对方回复后可以手动引入；第一次回答后，也可以和其中一个人开启自动对话。</p>
    <button className="primary" disabled={!title.trim() || !body.trim() || !selected.length || busy} onClick={() => void send()}>{busy ? '发送中…' : `发送提问${selected.length ? `（${selected.length} 人）` : ''}`}</button>
  </fieldset>{error && <p className="inline-error" role="alert">{error}</p>}</details>;
}

export function questionAutoLock(inbox: QuestionInbox | undefined, sessionId: string) {
  const dialogue = inbox?.dialogues?.find(item => item.sessionId === sessionId);
  if (!dialogue) return;
  const question = inbox?.items.find(item => item.id === dialogue.questionId);
  const peer = question?.recipients.find(item => item.username === dialogue.peer);
  return { name: peer?.name || dialogue.peer, title: question?.title || '提问', suggested: !!dialogue.suggested || !!peer?.endSuggestedAt };
}
export function QuestionDetail({ question: q, inbox, username, sessions, changed, openSession }: { question: TeamQuestion; inbox: QuestionInbox; username: string; sessions: AgentSession[]; changed: () => Promise<void>; openSession: (session: AgentSession) => void }) {
  const own = q.recipients.find(r => r.username === username), author = q.author === username;
  const [sessionId, setSessionId] = useState(own?.sessionId || ''), [laneText, setLaneText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const followDraft = useRef<Record<string, { payload: string; id: string }>>({});
  const working = useRef(false);
  const choices = sessions.filter(s => s.binding?.project.id === q.projectId && s.purpose === 'work' && !s.closedAt && !s.cursorNative);
  const selected = choices.find(s => s.id === sessionId), linked = sessions.find(s => s.id === (author ? q.sessionId : own?.sessionId));
  const job = [...inbox.jobs].reverse().find(j => j.questionId === q.id && j.mode !== 'import' && j.mode !== 'auto'), active = !!job && ['queued', 'running', 'ready'].includes(job.phase);
  const inDialogue = !!own && (!!own.sessionId || own.answers.length > 0 || own.state !== 'pending');
  useEffect(() => { if (questionUnread(q, inbox)) void window.workbench.call('question.read', { id: q.id, revision: q.activityRevision }).then(changed).catch(e => setError(e.message)); }, [q.id, q.activityRevision]);
  const run = async (action: string, payload: object) => { if (working.current) return false; working.current = true; setBusy(true); setError(''); try { await window.workbench.call(action, payload); await changed(); return true; } catch (e: any) { setError(e.message); return false; } finally { working.current = false; setBusy(false); } };
  return <section className="team-question-detail"><div className="row"><h3>{q.title}</h3><span className="spacer"/><span className="badge">{q.closedAt ? '已关闭' : '开放'}</span></div><p className="muted small">{q.authorName} · {time(q.createdAt)}</p><div className="team-question-text">{q.body}</div>{q.context && <details><summary>补充资料</summary><div className="team-question-text">{q.context}</div></details>}
    {q.closedAt && <p className="callout">提问已于 {time(q.closedAt)} 结束，不再接收答复。已关联的 Session 保留，需要结束时请在 Session 中手动关闭。</p>}
    {!author && <div className="row">{linked && <button className="secondary compact" onClick={() => openSession(linked)}>打开关联 Session{linked.closedAt ? '（已关闭）' : ''}</button>}{inDialogue && !q.closedAt && <button className="secondary compact" disabled={busy} onClick={() => void run('question.close', { projectId: q.projectId, id: q.id })}>结束提问</button>}</div>}
    {!author && own && !q.closedAt && <div className="team-question-answer"><label>选择回答问题的 Session<select aria-label="回答 Session" value={selected?.id || ''} disabled={busy || active || own.state === 'running'} onChange={e => setSessionId(e.target.value)}><option value="">请选择同项目的 Session</option>{choices.map(s => <option key={s.id} value={s.id}>{s.title}{['running', 'starting', 'approval'].includes(s.status) ? ' · 忙碌，排队回答' : ''}</option>)}</select></label>
      <p className="muted small">关联后，AI 会在该 Session 空闲时回答。你可以随时结束这条提问，包括问到一半。结束会轻量通知发问人，并刷新提问工作区。</p>
      <button className="primary" disabled={!selected || busy || active || own.state === 'running'} onClick={() => void run('question.link', { projectId: q.projectId, id: q.id, sessionId })}>{active ? ({ queued: '等待 Session 空闲', running: '回答中…', ready: '答复待送达' } as Record<string, string>)[job!.phase] : own.state === 'running' ? '回答中…' : own.answers.length ? '关联并补充回答' : '关联并回答'}</button>
      {!choices.length && <p className="muted small">请先在这个项目中新建或打开一个工作 Session。</p>}
      {job?.phase === 'error' && <p className="inline-error">{job.error}</p>}{job?.phase === 'ready' && job.error && <p className="muted small">答复已保留，连接恢复后自动送达。</p>}
    </div>}
    {author && <p className="muted small">{q.recipients.filter(r => r.answers.length).length}/{q.recipientCount} 人已回复 · 每人一条对话</p>}
    {q.recipients.map(r => {
      const dialogue = inbox.dialogues?.find(item => item.questionId === q.id && item.peer === r.username);
      const suggested = !!r.endSuggestedAt || !!dialogue?.suggested;
      const otherAuto = inbox.dialogues?.find(item => item.questionId === q.id && item.sessionId === linked?.id && item.peer !== r.username);
      const autoOn = !!dialogue && !suggested;
      const turns = [...(q.followUps || []).filter(item => !item.target || item.target === r.username).map(item => ({ id: item.id, at: item.createdAt, mine: author, who: author ? '我' : q.authorName, body: item.body })), ...r.answers.map(item => ({ id: item.id, at: item.createdAt, mine: !author, who: author ? r.name : '我', body: item.body, answerId: item.id }))].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const sendFollow = () => { const body = (laneText[r.username] || '').trim(); if (!body) return; const key = r.username + ':' + body; if (followDraft.current[key]?.payload !== body) followDraft.current[key] = { payload: body, id: crypto.randomUUID() }; const draft = followDraft.current[key]; void run('question.follow', { projectId: q.projectId, id: q.id, followId: draft.id, body, target: r.username }).then(ok => { if (ok) setLaneText(current => ({ ...current, [r.username]: '' })); }); };
      const status = dialogue ? (suggested ? '建议结束' : '自动对话中') : r.answers.length ? `${r.answers.length} 条答复` : q.closedAt ? '关闭前未回复' : ({ pending: '待关联', linked: '已关联', running: '回答中', replied: '已回复' })[r.state];
      return <section className="team-question-replies" key={r.username}>
        <div className="team-question-lane-head"><b>{r.name}</b><small className="muted">{status}</small>{author && !!q.closedAt && linked && <button className="secondary compact" onClick={() => openSession(linked)}>打开关联 Session{linked.closedAt ? '（已关闭）' : ''}</button>}</div>
        {suggested && !q.closedAt && <p className="callout">自动对话认为可以结束。上面的往来保留，确认后才会真正结束提问。</p>}
        <div className="team-question-thread">{turns.map(turn => <article key={turn.id} className={'team-question-turn' + (turn.mine ? ' mine' : '')}><span className="who">{turn.who} · {time(turn.at)}</span><div className="team-question-text">{turn.body}</div>{author && !q.closedAt && !dialogue && turn.answerId && linked && !linked.closedAt && <button className="secondary compact" disabled={busy} onClick={() => void run('question.import', { projectId: q.projectId, id: q.id, sessionId: linked.id, answerId: turn.answerId! })}>引入到 Session</button>}</article>)}{!turns.length && <p className="muted small">还没有往来。</p>}</div>
        {author && !q.closedAt && <div className="team-question-composer">
          {autoOn ? <p className="team-question-composer-status">正在与{r.name}自动对话。新的提问会出现在上面的对话里。</p> : <textarea rows={3} maxLength={12000} aria-label={`回复${r.name}`} value={laneText[r.username] || ''} placeholder="继续提问" onChange={e => setLaneText(current => ({ ...current, [r.username]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (!e.repeat) sendFollow(); } }}/>}
          <div className="team-question-composer-bar">
            {linked && <button type="button" className="secondary compact" onClick={() => openSession(linked)}>打开关联 Session{linked.closedAt ? '（已关闭）' : ''}</button>}
            {suggested ? <button type="button" className="secondary compact" disabled={busy} onClick={() => void run('question.close', { projectId: q.projectId, id: q.id })}>确认结束</button> : <button type="button" className="secondary compact" disabled={busy} onClick={() => void run('question.close', { projectId: q.projectId, id: q.id })}>结束提问</button>}
            {!!r.answers.length && !dialogue && <button type="button" className="secondary compact" disabled={!linked || !!linked.closedAt || !!otherAuto || busy} title={otherAuto ? '这条提问的 Session 正在与另一个人自动对话' : '使用这条提问已关联的 Session'} onClick={() => linked && void run('question.auto', { projectId: q.projectId, id: q.id, sessionId: linked.id, peer: r.username })}>自动对话</button>}
            {dialogue && <button type="button" className="secondary compact" disabled={busy} onClick={() => void run('question.auto.stop', { projectId: q.projectId, id: q.id, peer: r.username })}>停止自动</button>}
            {!autoOn && <button type="button" className="primary compact team-question-send" disabled={!laneText[r.username]?.trim() || busy} onClick={sendFollow}>{busy ? '发送中…' : '发送'}</button>}
          </div>
        </div>}
      </section>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

export function QuestionPanel({ inbox = empty, selectedId, session, username, sessions, connected, select, close, changed, openSession }: { inbox?: QuestionInbox; selectedId: string; session?: AgentSession; username: string; sessions: AgentSession[]; connected: boolean; select: (id: string) => void; close: () => void; changed: () => Promise<void>; openSession: (session: AgentSession) => void }) {
  const q = inbox.items.find(q => q.id === selectedId);
  const items = inbox.items.filter(q => session && q.projectId === session.binding?.project.id && (q.sessionId === session.id || q.recipients.some(r => r.username === username && (!r.sessionId || r.sessionId === session.id)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <aside className="team-question-panel" aria-label="成员提问"><header className="row"><MessageSquare size={18}/><h3>提问</h3><span className="spacer"/><button className="icon" aria-label="关闭提问窗口" onClick={close}><X size={18}/></button></header><div className="team-question-panel-body">
    {!connected && <p className="callout">连接团队账号后，可发送问题和答复。</p>}{inbox.error && <p className="inline-error">{inbox.error}</p>}
    {q ? <><button className="text-button" onClick={() => select('session')}>返回问题列表</button><QuestionDetail key={q.id} question={q} inbox={inbox} username={username} sessions={sessions} changed={changed} openSession={openSession}/></> : <>{session && !session.closedAt && connected && <QuestionComposer key={session.id} session={session} sent={q => { select(q.id); void changed(); }}/>}<h3>与当前 Session 有关的问题</h3>{items.map(q => <QuestionCard key={q.id} question={q} unread={questionUnread(q, inbox)} open={() => select(q.id)}/>)}{!items.length && <p className="muted small">暂无问题。收到的问题也会显示在动态中。</p>}</>}
  </div></aside>;
}
