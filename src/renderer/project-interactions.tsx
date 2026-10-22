import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Sparkles, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { RsiInbox, RsiReaction } from '../shared/rsi';
import type { WorkbenchAPI } from '../shared/types';
import { useInteractionPanelResize } from './interaction-panel-resize';

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

type Draft = { linkedSessionId: string; text: string; decisionEventId: string | null };
const decisionLabels = { pending: '待处理', accepted: '已接受', rejected: '已拒绝' };
export const pendingRecommendations = (inbox?: RsiInbox) => inbox?.items.filter(item => item.review.decision === 'pending' && !item.review.closed).length || 0;

export function RsiRecommendations({ inbox, error, call, reload }: { inbox?: RsiInbox; error?: string; call: WorkbenchAPI['call']; reload: () => Promise<void> }) {
  const [selected, setSelected] = useState(''), [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState<{ id: string; kind: RsiReaction['kind'] }>(), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
  const [completed, setCompleted] = useState<string[]>([]);
  const busy = !!pending;
  const lock = useRef(false), retry = useRef<{ signature: string; requestId: string } | undefined>(undefined);
  const items = inbox?.items.filter(value => !value.review.closed && !completed.includes(value.id)) || [];
  const item = items.find(value => value.id === selected) || items[0];
  // Keep acknowledged removals hidden while a refresh is delayed or fails.
  // Release that local guard once the server snapshot confirms removal.
  useEffect(() => { if (inbox) setCompleted(current => current.filter(id => inbox.items.some(value => value.id === id && !value.review.closed))); }, [inbox]);
  useEffect(() => { if (item && item.id !== selected) setSelected(item.id); }, [item?.id, selected]);
  const draft = item && (drafts[item.id] || { linkedSessionId: item.review.linkedSessionId || '', text: item.review.feedback, decisionEventId: item.review.decisionEventId || null });
  const staleDraft = !!item && !!draft && draft.decisionEventId !== (item.review.decisionEventId || null);
  const update = (patch: Partial<Draft>) => item && draft && setDrafts(current => ({ ...current, [item.id]: { ...draft, ...patch } }));
  const act = async (kind: RsiReaction['kind']) => {
    if (!item || !inbox || lock.current) return;
    const target = draft?.text.trim() && (draft.text.trim() !== item.review.feedback.trim() || item.review.feedbackTarget) ? 'recommendation' as const : undefined;
    const reaction = { suggestionId: item.id, kind, ...(['accepted', 'rejected', 'supplement'].includes(kind) ? { expectedDecisionId: kind === 'supplement' ? draft!.decisionEventId : item.review.decisionEventId || null } : {}), ...(kind === 'supplement' ? { text: draft?.text || '', ...(target ? { feedbackTarget: target } : {}), linkedSessionId: item.review.decision === 'accepted' ? draft?.linkedSessionId || null : null } : {}) };
    const signature = JSON.stringify(reaction);
    if (retry.current?.signature !== signature) retry.current = { signature, requestId: crypto.randomUUID() };
    lock.current = true; setPending({ id: item.id, kind }); setFailure('');
    setNotice(kind === 'supplement' ? '正在保存补充…' : kind === 'dismissed' ? '正在关闭推荐…' : '正在保存处理结果…');
    try {
      await call('rsi.feedback', { projectId: inbox.projectId, reaction: { ...reaction, requestId: retry.current.requestId } });
      retry.current = undefined;
      if (['accepted', 'rejected', 'supplement', 'dismissed'].includes(kind)) setDrafts(current => { const next = { ...current }; delete next[item.id]; return next; });
      if (kind === 'supplement' || kind === 'dismissed') setCompleted(current => [...current, item.id]);
      setNotice(kind === 'accepted' ? '已接受。可选填关联会话和反馈，再保存补充。' : kind === 'rejected' ? '已拒绝。可选填反馈，再保存补充。' : kind === 'dismissed' ? `已关闭“${item.title}”，处理记录已保留。` : `“${item.title}”的补充已保存，推荐已移出列表。`);
      try { await reload(); } catch { setFailure('处理结果已保存，列表暂未刷新，请重试刷新。'); }
    } catch (reason: any) { setNotice(''); setFailure(reason.message); if (reason.message.includes('处理已更新')) await reload().catch(() => {}); }
    finally { lock.current = false; setPending(undefined); }
  };
  return <section className="rsi-recommendations" aria-label="项目推荐">
    {notice && <div className="rsi-notice" role="status" aria-live="polite">{notice}</div>}
    {(error || failure) && <div className="inline-error" role="alert">{failure || error}{error && <button className="text-button" onClick={() => void reload()}>重试</button>}</div>}
    {!inbox ? <p className="muted rsi-empty">{error ? '推荐暂时无法读取。' : '正在读取推荐…'}</p> : <>
      {(!inbox.enabled || inbox.busy || inbox.queued || inbox.lastError) && <div className="rsi-background-status" role="status">{!inbox.enabled ? 'AI推荐已关闭，已有记录保留。' : inbox.busy ? '正在分析项目进展…' : inbox.queued ? '已记录项目变化，稍后在后台分析。' : '本次分析未完成：' + inbox.lastError}</div>}
      {!item ? <p className="muted rsi-empty">暂无待处理的推荐。</p> : <div className="rsi-layout">
        <nav className="rsi-list" aria-label="推荐列表">{items.map(value => <button key={value.id} type="button" className="rsi-list-item" aria-pressed={value.id === item.id} onClick={() => { setSelected(value.id); setFailure(''); setNotice(''); }}><span>{value.title}</span><small>{decisionLabels[value.review.decision]} · {new Date(value.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></button>)}</nav>
        <article className="rsi-detail" aria-label="推荐详情">
          <span className={'rsi-decision ' + item.review.decision}>{decisionLabels[item.review.decision]}</span>
          <h3>{item.title}</h3><p>{item.action}</p>
          <details key={item.id}><summary>推荐依据</summary><p>{item.reason}</p>{item.conditions.length > 0 && <p>适用条件：{item.conditions.join('；')}</p>}{item.uncertainty && <p>尚不确定：{item.uncertainty}</p>}<div className="rsi-evidence">{item.evidence.map(evidence => <blockquote key={evidence.id}>{evidence.text}</blockquote>)}</div></details>
          {item.review.decision === 'pending' ? <div className="rsi-actions"><button className="primary" disabled={busy} onClick={() => void act('accepted')}>接受</button><button className="secondary" disabled={busy} onClick={() => void act('rejected')}>拒绝</button><button className="text-button rsi-close" disabled={busy} onClick={() => void act('dismissed')}>{pending?.id === item.id && pending.kind === 'dismissed' ? '正在关闭…' : '关闭'}</button></div> : <form className="rsi-supplement" onSubmit={event => { event.preventDefault(); void act('supplement'); }}>
            <fieldset disabled={busy}>{item.review.decision === 'accepted' && <label>关联会话 <small>选填</small><select aria-label="关联会话" value={draft!.linkedSessionId} onChange={event => update({ linkedSessionId: event.target.value })}><option value="">暂不关联</option>{draft!.linkedSessionId && !inbox.sessions.some(session => session.id === draft!.linkedSessionId) && <option value={draft!.linkedSessionId}>原关联会话（已关闭或不可用）</option>}{inbox.sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>}
            <label>推荐反馈 <small>选填</small><textarea aria-label="推荐反馈" rows={3} maxLength={6000} value={draft!.text} onChange={event => update({ text: event.target.value })} placeholder="评价这条推荐：描述是否具体、背景是否充分，或希望它关注哪一层的问题。"/></label>
            <div className="rsi-actions"><button className="primary" type="submit" disabled={staleDraft}>{pending?.id === item.id && pending.kind === 'supplement' ? '保存中…' : '保存补充'}</button><button className="text-button" type="button" onClick={() => void act(item.review.decision === 'accepted' ? 'rejected' : 'accepted')}>{item.review.decision === 'accepted' ? '改为拒绝' : '改为接受'}</button><button className="text-button rsi-close" type="button" onClick={() => void act('dismissed')}>{pending?.id === item.id && pending.kind === 'dismissed' ? '正在关闭…' : '关闭'}</button></div></fieldset>
          </form>}
          {staleDraft && <div className="inline-error" role="alert">这份草稿对应先前的处理状态。<button className="text-button" onClick={() => setDrafts(current => { const next = { ...current }; delete next[item.id]; return next; })}>重新填写</button></div>}
        </article>
      </div>}
    </>}
  </section>;
}

export type InteractionTab = 'recommendations' | 'questions' | 'subsessions' | 'sidechats';
export function ProjectInteractionPanel({ projectName, active, select, close, inbox, error, call, reload, questionCount, questions, subsessions, sideChats, team = true }: {
  projectName: string; active: InteractionTab | ''; select: (tab: InteractionTab) => void; close: () => void;
  inbox?: RsiInbox; error?: string; call: WorkbenchAPI['call']; reload: () => Promise<void>; questionCount: number; questions: React.ReactNode;
  subsessions?: React.ReactNode; sideChats?: React.ReactNode; team?: boolean;
}) {
  const [visitedQuestions, setVisitedQuestions] = useState(active === 'questions');
  const resize = useInteractionPanelResize(!!active);
  const lastTab = useRef<InteractionTab>(active || (team ? 'recommendations' : 'subsessions'));
  useEffect(() => { if (active) lastTab.current = active; }, [active]);
  useEffect(() => { if (active === 'questions') setVisitedQuestions(true); }, [active]);
  const toggleLabel = active ? '收起侧栏' : '展开侧栏';
  const reopenTab = lastTab.current === 'sidechats' && sideChats ? 'sidechats' : lastTab.current === 'subsessions' ? (subsessions ? 'subsessions' : 'recommendations') : (team ? lastTab.current : 'subsessions');
  return <div ref={resize.shell} className={'project-interaction-shell' + (!active ? ' is-collapsed' : '') + (resize.dragging ? ' is-resizing' : '')} style={{ width: active ? resize.width : 60 }}>
    <button type="button" className="icon interaction-toggle" aria-label={toggleLabel} title={toggleLabel} aria-expanded={!!active} aria-controls="project-interaction-panel" onClick={() => active ? close() : select(reopenTab)}>{active ? <PanelRightClose size={17}/> : <PanelRightOpen size={17}/>}</button>
    {active && <button type="button" className="interaction-resize" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="project-interaction-panel" aria-valuemin={resize.limits.min} aria-valuemax={resize.limits.max} aria-valuenow={resize.width} aria-valuetext={`${resize.width} 像素`}
      onPointerDown={resize.begin} onPointerMove={resize.move} onPointerUp={resize.end} onPointerCancel={resize.end} onLostPointerCapture={resize.end} onKeyDown={resize.keyDown}/>}
    {!active && <nav className="interaction-reopen" aria-label="侧栏内容">
    {team && <><button aria-label="展开 AI推荐" onClick={() => select('recommendations')}><Sparkles size={16}/><span>AI推荐</span></button><button aria-label="展开提问" onClick={() => select('questions')}><MessageSquare size={16}/><span>提问</span></button></>}
    {subsessions && <button aria-label="展开子会话" onClick={() => select('subsessions')}><MessageSquare size={16}/><span>子会话</span></button>}
    {sideChats && <button aria-label="展开侧边提问" onClick={() => select('sidechats')}><MessageSquare size={16}/><span>侧边提问</span></button>}
  </nav>}<aside id="project-interaction-panel" className="project-interaction-panel" aria-label="项目工作区" hidden={!active}>
    <header><span>{projectName}</span></header>
    <div className="project-interaction-tabs" role="tablist" aria-label="项目工作区内容">
      {team && <><button id="project-ai-tab" role="tab" aria-selected={active === 'recommendations'} aria-controls="project-ai-panel" onClick={() => select('recommendations')}><Sparkles size={14}/>AI推荐{pendingRecommendations(inbox) > 0 && <span>{pendingRecommendations(inbox)}</span>}</button>
      <button id="project-questions-tab" role="tab" aria-selected={active === 'questions'} aria-controls="project-questions-panel" onClick={() => select('questions')}><MessageSquare size={14}/>提问{questionCount > 0 && <span>{questionCount}</span>}</button></>}
      {subsessions && <button id="project-subsessions-tab" role="tab" aria-selected={active === 'subsessions'} aria-controls="project-subsessions-panel" onClick={() => select('subsessions')}><MessageSquare size={14}/>子会话</button>}
      {sideChats && <button id="project-sidechats-tab" role="tab" aria-selected={active === 'sidechats'} aria-controls="project-sidechats-panel" onClick={() => select('sidechats')}><MessageSquare size={14}/>侧边提问</button>}
    </div>
    <div className="project-interaction-pane" id="project-ai-panel" role="tabpanel" aria-labelledby="project-ai-tab" hidden={active !== 'recommendations'}><RsiRecommendations inbox={inbox} error={error} call={call} reload={reload}/></div>
    <div className="project-interaction-pane" id="project-questions-panel" role="tabpanel" aria-labelledby="project-questions-tab" hidden={active !== 'questions'}>{(visitedQuestions || active === 'questions') && questions}</div>
    {subsessions && <div className="project-interaction-pane" id="project-subsessions-panel" role="tabpanel" aria-labelledby="project-subsessions-tab" hidden={active !== 'subsessions'}>{subsessions}</div>}
    {sideChats && <div className="project-interaction-pane" id="project-sidechats-panel" role="tabpanel" aria-labelledby="project-sidechats-tab" hidden={active !== 'sidechats'}>{sideChats}</div>}
  </aside></div>;
}
