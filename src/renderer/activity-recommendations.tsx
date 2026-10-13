import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AgentSession, ContentUpdate } from '../shared/types';
import { activityPending, type ActivityJob, type ActivityChoice, type ActivityActionResult } from '../shared/activity-assistant';

export function ActivityRecommendationCard({ job, attach, save, busy, choose, view, ignore }: {
  job: ActivityJob; attach: boolean; save: boolean; busy: boolean;
  choose: (key: 'attach' | 'save', value: boolean) => void; view: () => void; ignore: () => void;
}) {
  return <article className="activity-recommendation">
    <strong>{job.event.title}</strong><small>{job.event.updatedBy || job.event.author || '团队成员'} · {new Date(job.event.occurredAt).toLocaleString()} · v{job.event.revision}</small>
    <p>关联理由：{job.reason}</p><blockquote>{job.excerpt}</blockquote>
    <div className="activity-recommendation-actions">
      <label><input type="checkbox" checked={!!job.attachedSourceId || attach} disabled={busy || !!job.attachedSourceId} onChange={e => choose('attach', e.target.checked)}/>{job.attachedSourceId ? '已加入本会话' : '加入当前会话'}</label>
      <label><input type="checkbox" checked={!!job.availableConclusionId || save} disabled={busy || !!job.availableConclusionId} onChange={e => choose('save', e.target.checked)}/>{job.availableConclusionId ? '已存入个人成果库' : '存入个人成果库'}</label>
      <button className="text-button" disabled={busy} onClick={view}>查看全文</button>
      <button className="text-button" disabled={busy} onClick={ignore}>本会话忽略</button>
    </div>
  </article>;
}

export interface ActivityPanelHandle { beforeSend: () => boolean }
export const ActivityRecommendations = forwardRef<ActivityPanelHandle, {
  session: AgentSession; jobs: ActivityJob[]; changed: () => Promise<void>; view: (event: ContentUpdate) => void;
  sourcesAdded: (ids: string[]) => void; send: () => Promise<unknown>;
}>(({ session, jobs, changed, view, sourcesAdded, send }, ref) => {
  const [expanded, setExpanded] = useState(false), [limit, setLimit] = useState(3), [busy, setBusy] = useState(false);
  const [sendAfter, setSendAfter] = useState(false), [error, setError] = useState('');
  const [choices, setChoices] = useState<Record<string, { attach: boolean; save: boolean }>>({});
  const [displayed, setDisplayed] = useState<string[]>([]);
  const mounted = useRef(true), latest = useRef({ send, sourcesAdded }); latest.current = { send, sourcesAdded };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const own = jobs.filter(j => j.sessionId === session.id && j.status === 'matched' && !j.ignoredAt).sort((a, b) => b.event.occurredAt.localeCompare(a.event.occurredAt));
  const pending = own.filter(activityPending), fresh = pending.filter(j => !j.presentedAt);
  const rows = own.filter(j => activityPending(j) || displayed.includes(j.id));
  const visible = rows.slice(0, limit);
  const running = ['starting', 'running', 'approval'].includes(session.status);
  const failedJobs = jobs.filter(j => j.sessionId === session.id && j.status === 'pending' && j.error && !j.ignoredAt);
  const failed = failedJobs.length > 0;
  const present = async (ids: string[]) => { if (ids.length) { await window.workbench.call('activity.presented', { id: session.id, jobIds: ids }); await changed(); } };
  const open = () => {
    setDisplayed(pending.map(j => j.id)); setExpanded(true); setError('');
    void present(pending.map(j => j.id)).catch(e => { if (mounted.current) setError(e.message); });
  };
  useImperativeHandle(ref, () => ({ beforeSend: () => {
    if (running) return false;
    if (busy) return true;
    if (!expanded && (!pending.length || !fresh.length)) return false;
    setSendAfter(true); open(); return true;
  } }));
  const setChoice = (job: ActivityJob, key: 'attach' | 'save', value: boolean) => setChoices(current => ({ ...current, [job.id]: { ...(current[job.id] || { attach: false, save: false }), [key]: value } }));
  const chosen: ActivityChoice[] = rows.map(job => ({ jobId: job.id, attach: !!choices[job.id]?.attach && !job.attachedSourceId, save: !!choices[job.id]?.save && !job.availableConclusionId })).filter(c => c.attach || c.save);
  const execute = async () => {
    if (busy || running) return; setBusy(true); setError('');
    try {
      const results = await window.workbench.call<ActivityActionResult[]>('activity.apply', { id: session.id, choices: chosen });
      if (!mounted.current) return;
      latest.current.sourcesAdded(results.flatMap(r => r.sourceId ? [r.sourceId] : []));
      setChoices(current => Object.fromEntries(Object.entries(current).map(([id, choice]) => {
        const result = results.find(r => r.jobId === id);
        return [id, { attach: choice.attach && !result?.sourceId, save: choice.save && !result?.conclusionId }];
      })));
      await changed(); if (!mounted.current) return;
      const errors = results.filter(r => r.error).map(r => r.error).join('\n');
      if (errors) { setError(errors); return; }
      setExpanded(false);
      if (sendAfter) { setSendAfter(false); await latest.current.send(); }
    } catch (e: any) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const skip = async () => {
    if (busy) return; setBusy(true);
    try { await present(pending.map(j => j.id)); if (!mounted.current) return; setExpanded(false); if (sendAfter) { setSendAfter(false); await latest.current.send(); } }
    catch (e: any) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  if (session.closedAt || running || !pending.length && !expanded && !failed) return null;
  return <section className="activity-recommendations" aria-label="本会话相关新动态">
    <div className="activity-recommendations-heading"><span>{fresh.length ? `新增 ${fresh.length} 条可能相关的动态` : pending.length ? `${pending.length} 条相关动态待处理` : failed ? '新动态判断暂未完成' : '相关动态'}{fresh.length > 0 && pending.length > fresh.length && `，另有 ${pending.length - fresh.length} 条待处理`}</span>{(rows.length > 0 || expanded) && <button className="text-button" disabled={busy} onClick={() => expanded ? setExpanded(false) : open()}>{expanded ? '收起' : '查看'}</button>}</div>
    {failed && <div className="activity-background-error" role="status">有 {failedJobs.length} 条新动态暂未完成判断，将在新动态到达、资料或连接恢复后自动继续。你可以继续对话。</div>}
    {expanded && <>
      <div className="activity-bulk"><span>批量选择当前展开条目：</span>{(['attach', 'save'] as const).map(key => {
        const candidates = visible.filter(j => key === 'attach' ? !j.attachedSourceId : !j.availableConclusionId);
        return <label key={key}><input type="checkbox" disabled={busy || !candidates.length} checked={!!candidates.length && candidates.every(j => choices[j.id]?.[key])} onChange={e => candidates.forEach(j => setChoice(j, key, e.target.checked))}/>{key === 'attach' ? '加入当前会话' : '存入个人成果库'}</label>;
      })}</div>
      <div className="activity-recommendation-list">{visible.map(job => <ActivityRecommendationCard key={job.id} job={job} attach={!!choices[job.id]?.attach} save={!!choices[job.id]?.save} busy={busy}
        choose={(key, value) => setChoice(job, key, value)} view={() => view(job.event)} ignore={() => { setBusy(true); void window.workbench.call('activity.ignore', { id: session.id, jobIds: [job.id] }).then(changed).catch(e => setError(e.message)).finally(() => setBusy(false)); }}/>)}</div>
      {rows.length > limit && <button className="text-button" disabled={busy} onClick={() => setLimit(value => value + 20)}>展开其余 {rows.length - limit} 条</button>}
      <div className="activity-recommendations-footer"><span>已选择：加入会话 {chosen.filter(c => c.attach).length} 条，存库 {chosen.filter(c => c.save).length} 条</span><button className="primary" disabled={busy || !chosen.length} onClick={() => void execute()}>{busy ? '正在处理…' : sendAfter ? '执行所选并发送' : '执行所选'}</button><button className="secondary" disabled={busy} onClick={() => void skip()}>{sendAfter ? '本轮跳过，直接发送' : '稍后处理'}</button></div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
});
