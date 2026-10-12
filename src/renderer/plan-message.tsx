import React, { useState } from 'react';
import type { AgentSession, Message } from '../shared/types';

export function PlanMessage({ session, message, render }: { session: AgentSession; message: Message; render: (text: string) => React.ReactNode }) {
  const [editing, setEditing] = useState(false), [text, setText] = useState(message.text), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (message.kind === 'planSteps') return <div className="plan-steps" aria-label="计划进度">{message.steps?.map((step, index) => <div className={'plan-step ' + step.status} key={index}><span>{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '◉' : step.status === 'cancelled' ? '—' : '○'}</span><span>{step.text}</span></div>)}</div>;
  const current = session.proposedPlan?.messageId === message.id, ready = current && session.proposedPlan?.ready && !session.proposedPlan.accepted && session.status === 'idle' && !session.closedAt;
  const execute = async () => {
    setBusy(true); setError('');
    try { const sent = await window.workbench.call('session.plan.execute', { id: session.id, messageId: message.id }); if (!sent) setError('计划未开始执行，请检查会话状态后重试。'); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <section className="proposed-plan" aria-label="实施计划"><strong>实施计划</strong>{editing ? <textarea aria-label="修改实施计划" className="plan-editor" value={text} onChange={event => setText(event.target.value)}/> : render(message.text)}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {current && <div className="row">{editing ? <><button className="secondary compact" disabled={busy} onClick={() => setEditing(false)}>取消修改</button><button className="primary compact" disabled={!ready || busy || !text.trim()} onClick={async () => { setBusy(true); setError(''); try { const sent = await window.workbench.call('session.plan.revise', { id: session.id, messageId: message.id, text }); if (sent) setEditing(false); else setError('修改未发送，请重试。'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>提交修改</button></> : <><button className="secondary compact" disabled={!ready || busy} onClick={() => { setText(message.text); setEditing(true); }}>修改计划</button><button className="primary compact" disabled={!ready || busy} onClick={() => void execute()}>{session.proposedPlan?.accepted ? '已开始执行' : busy ? '正在提交…' : '执行计划'}</button></>}</div>}
  </section>;
}
