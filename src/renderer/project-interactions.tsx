import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Sparkles, PanelRightClose } from 'lucide-react';
import type { RsiInbox, RsiReaction } from '../shared/rsi';
import type { WorkbenchAPI } from '../shared/types';

export function useRsiInbox(projectId: string | undefined, api: WorkbenchAPI) {
  const [value, setValue] = useState<{ projectId: string; inbox?: RsiInbox; error?: string }>();
  const sequence = useRef(0), current = useRef(projectId); current.current = projectId;
  const reload = async () => {
    if (!projectId) return;
    const request = ++sequence.current;
    try { const inbox = await api.call<RsiInbox>('rsi.inbox', { projectId }); if (current.current === projectId && request === sequence.current) setValue({ projectId, inbox }); }
    catch (error: any) { if (current.current === projectId && request === sequence.current) setValue(previous => ({ projectId, inbox: previous?.projectId === projectId ? previous.inbox : undefined, error: error.message })); }
  };
  useEffect(() => {
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void reload();
    const unsubscribe = api.subscribe(event => { if (event.type === 'state') { clearTimeout(timer); timer = setTimeout(() => void reload(), 100); } });
    return () => { ++sequence.current; clearTimeout(timer); unsubscribe(); };
  }, [projectId, api]);
  return { inbox: value && value.projectId === projectId ? value.inbox : undefined, error: value && value.projectId === projectId ? value.error : undefined, reload };
}

type Draft = { linkedSessionId: string; text: string };
const decisionLabels = { pending: '待处理', accepted: '已接受', rejected: '已拒绝' };
export const pendingRecommendations = (inbox?: RsiInbox) => inbox?.items.filter(item => item.review.decision === 'pending' && !item.review.closed).length || 0;

export function RsiRecommendations({ inbox, error, call, reload }: { inbox?: RsiInbox; error?: string; call: WorkbenchAPI['call']; reload: () => Promise<void> }) {
  const [selected, setSelected] = useState(''), [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
  const lock = useRef(false), retry = useRef<{ signature: string; requestId: string } | undefined>(undefined);
  const item = inbox?.items.find(value => value.id === selected) || inbox?.items.find(value => !value.review.closed) || inbox?.items[0];
  useEffect(() => { if (item && item.id !== selected) setSelected(item.id); }, [item?.id, selected]);
  const draft = item && (drafts[item.id] || { linkedSessionId: item.review.linkedSessionId || '', text: item.review.feedback });
  const update = (patch: Partial<Draft>) => item && draft && setDrafts(current => ({ ...current, [item.id]: { ...draft, ...patch } }));
  const act = async (kind: RsiReaction['kind']) => {
    if (!item || !inbox || lock.current) return;
    const reaction = { suggestionId: item.id, kind, ...(kind === 'supplement' ? { text: draft?.text || '', linkedSessionId: item.review.decision === 'accepted' ? draft?.linkedSessionId || null : null } : {}) };
    const signature = JSON.stringify(reaction);
    if (retry.current?.signature !== signature) retry.current = { signature, requestId: crypto.randomUUID() };
    lock.current = true; setBusy(true); setFailure(''); setNotice('');
    try {
      await call('rsi.feedback', { projectId: inbox.projectId, reaction: { ...reaction, requestId: retry.current.requestId } });
      await reload();
      retry.current = undefined;
      setNotice(kind === 'accepted' ? '已接受，关联会话和反馈均可留空。' : kind === 'rejected' ? '已拒绝，反馈可留空。' : kind === 'dismissed' ? '已关闭，原处理记录保留。' : kind === 'reopened' ? '已重新打开。' : '补充已保存。关联会话不会自动发送消息。');
    } catch (reason: any) { setFailure(reason.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="rsi-recommendations" aria-label="项目推荐">
    {(error || failure) && <div className="inline-error" role="alert">{failure || error}{error && <button className="text-button" onClick={() => void reload()}>重试</button>}</div>}
    {!inbox ? <p className="muted rsi-empty">{error ? '推荐暂时无法读取。' : '正在读取推荐…'}</p> : <>
      {(!inbox.enabled || inbox.busy || inbox.queued || inbox.lastError) && <div className="rsi-background-status" role="status">{!inbox.enabled ? 'AI推荐已关闭，已有记录保留。' : inbox.busy ? '正在分析项目进展…' : inbox.queued ? '等待当前工作完成后分析。' : '本次分析未完成：' + inbox.lastError}</div>}
      {!item ? <p className="muted rsi-empty">暂无推荐。项目对话或资料更新后，会在后台分析。</p> : <div className="rsi-layout">
        <nav className="rsi-list" aria-label="推荐列表">{inbox.items.map(value => <button key={value.id} type="button" className={'rsi-list-item' + (value.review.closed ? ' is-closed' : '')} aria-pressed={value.id === item.id} onClick={() => { setSelected(value.id); setFailure(''); setNotice(''); }}><span>{value.title}</span><small>{value.review.closed ? '已关闭' : decisionLabels[value.review.decision]} · {new Date(value.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></button>)}</nav>
        <article className="rsi-detail" aria-label="推荐详情">
          <span className={'rsi-decision ' + item.review.decision}>{item.review.closed ? '已关闭' + (item.review.decision !== 'pending' ? ' · ' + decisionLabels[item.review.decision] : '') : decisionLabels[item.review.decision]}</span>
          <h3>{item.title}</h3><p>{item.action}</p><p className="muted">{item.reason}</p>
          <details key={item.id}><summary>推荐依据</summary>{item.conditions.length > 0 && <p>适用条件：{item.conditions.join('；')}</p>}{item.uncertainty && <p>尚不确定：{item.uncertainty}</p>}<div className="rsi-evidence">{item.evidence.map(evidence => <blockquote key={evidence.id}>{evidence.text}</blockquote>)}</div></details>
          {item.review.closed ? <div className="rsi-actions"><span className="muted small">{item.review.decision === 'pending' ? '未记录为接受或拒绝。' : '原处理记录与补充仍保留。'}</span><button className="text-button" disabled={busy} onClick={() => void act('reopened')}>重新打开</button></div> : item.review.decision === 'pending' ? <div className="rsi-actions"><button className="primary" disabled={busy} onClick={() => void act('accepted')}>接受</button><button className="secondary" disabled={busy} onClick={() => void act('rejected')}>拒绝</button><button className="text-button rsi-close" disabled={busy} onClick={() => void act('dismissed')}>关闭</button></div> : <form className="rsi-supplement" onSubmit={event => { event.preventDefault(); void act('supplement'); }}>
            <fieldset disabled={busy}>{item.review.decision === 'accepted' && <label>关联会话 <small>选填</small><select aria-label="关联会话" value={draft!.linkedSessionId} onChange={event => update({ linkedSessionId: event.target.value })}><option value="">暂不关联</option>{draft!.linkedSessionId && !inbox.sessions.some(session => session.id === draft!.linkedSessionId) && <option value={draft!.linkedSessionId}>原关联会话（已关闭或不可用）</option>}{inbox.sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}
            <label>反馈意见 <small>选填</small><textarea aria-label="反馈意见" rows={3} maxLength={6000} value={draft!.text} onChange={event => update({ text: event.target.value })} placeholder="有需要补充的意见，可以写在这里。"/></label>
            <div className="rsi-actions"><button className="primary" type="submit">{busy ? '保存中…' : '保存补充'}</button><button className="text-button rsi-close" type="button" onClick={() => void act('dismissed')}>关闭</button></div></fieldset>
          </form>}
        </article>
      </div>}
    </>}
    {notice && <div className="rsi-notice" role="status">{notice}</div>}
  </section>;
}

export function ProjectInteractionPanel({ projectName, active, select, close, inbox, error, call, reload, questionCount, questions }: {
  projectName: string; active: 'recommendations' | 'questions' | ''; select: (tab: 'recommendations' | 'questions') => void; close: () => void;
  inbox?: RsiInbox; error?: string; call: WorkbenchAPI['call']; reload: () => Promise<void>; questionCount: number; questions: React.ReactNode;
}) {
  const [visitedQuestions, setVisitedQuestions] = useState(active === 'questions');
  useEffect(() => { if (active === 'questions') setVisitedQuestions(true); }, [active]);
  return <aside className="project-interaction-panel" aria-label="项目推荐与提问" hidden={!active}>
    <header><span>{projectName}</span><button className="icon" aria-label="收起项目工作区" title="收起" onClick={close}><PanelRightClose size={17}/></button></header>
    <div className="project-interaction-tabs" role="tablist" aria-label="项目工作区内容">
      <button id="project-ai-tab" role="tab" aria-selected={active === 'recommendations'} aria-controls="project-ai-panel" onClick={() => select('recommendations')}><Sparkles size={14}/>AI推荐{pendingRecommendations(inbox) > 0 && <span>{pendingRecommendations(inbox)}</span>}</button>
      <button id="project-questions-tab" role="tab" aria-selected={active === 'questions'} aria-controls="project-questions-panel" onClick={() => select('questions')}><MessageSquare size={14}/>提问{questionCount > 0 && <span>{questionCount}</span>}</button>
    </div>
    <div className="project-interaction-pane" id="project-ai-panel" role="tabpanel" aria-labelledby="project-ai-tab" hidden={active !== 'recommendations'}><RsiRecommendations inbox={inbox} error={error} call={call} reload={reload}/></div>
    <div className="project-interaction-pane" id="project-questions-panel" role="tabpanel" aria-labelledby="project-questions-tab" hidden={active !== 'questions'}>{(visitedQuestions || active === 'questions') && questions}</div>
  </aside>;
}
