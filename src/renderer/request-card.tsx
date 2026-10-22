import React, { useState } from 'react';
import { MessageSquare, ShieldCheck } from 'lucide-react';
import type { Approval } from '../shared/types';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';

export type RequestAnswers = Record<string, string | string[]>;
export const isQuestionRequest = (request: Approval) => request.method === 'item/tool/requestUserInput' || request.method === 'cursor/ask_question' || (request.method === 'claude/can_use_tool' && !!request.questions?.length);
export const isPlanRequest = (request: Approval) => request.method === 'cursor/create_plan';

export function RequestCard({ request, onAnswer }: { request: Approval; onAnswer: (option: string, answers: RequestAnswers) => void }) {
  const [answers, setAnswers] = useState<RequestAnswers>({});
  const [editing, setEditing] = useState(false), [plan, setPlan] = useState(request.details);
  if (request.method === 'cursor/create_plan') return <section className="approval proposed-plan" aria-label="Cursor 实施计划"><strong>{request.title}</strong>{editing ? <textarea className="plan-editor" aria-label="修改 Cursor 计划" value={plan} onChange={event => setPlan(event.target.value)}/> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{request.details}</ReactMarkdown></div>}<div className="row">{editing ? <><button className="secondary" onClick={() => setEditing(false)}>取消修改</button><button className="primary" disabled={!plan.trim()} onClick={() => onAnswer('decline', { reason: '请按以下修订重新制定计划，等待确认：\n\n' + plan })}>提交修改</button></> : <><button className="secondary" onClick={() => setEditing(true)}>修改计划</button><button className="primary" onClick={() => onAnswer('accept', {})}>执行计划</button><button className="secondary" onClick={() => onAnswer('cancel', {})}>取消</button></>}</div></section>;
  const question = isQuestionRequest(request);
  const complete = request.questions?.length && request.questions.every(q => {
    const value = answers[q.id];
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && !!value.trim();
  });
  return <div className={'approval' + (question ? ' question-request' : '')}>
    <strong>{question ? <MessageSquare size={17}/> : <ShieldCheck size={17}/>} {request.title}</strong>
    {request.summary && <pre className="approval-summary">{request.summary}</pre>}
    {!question && <details><summary>查看请求详情</summary><pre>{request.details}</pre></details>}
    {request.questions?.map(q => q.allowMultiple ?
      <fieldset className="question-field" key={q.id}><legend>{q.text}（可多选）</legend>{q.options.map(o => {
        const selected = Array.isArray(answers[q.id]) ? answers[q.id] as string[] : [];
        return <label className="question-choice" key={o.id}><input type="checkbox" checked={selected.includes(o.id)} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.checked ? [...selected, o.id] : selected.filter(id => id !== o.id) }))}/>{o.label}</label>;
      })}</fieldset> :
      <label className="field" key={q.id}>{q.text}{request.method === 'cursor/ask_question' ?
        <select value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.value }))}><option value="">选择答案</option>{q.options.map(o => <option value={o.id} key={o.id}>{o.label}</option>)}</select> :
        <><input list={'q-' + request.id + '-' + q.id} value={typeof answers[q.id] === 'string' ? answers[q.id] as string : ''} onChange={event => setAnswers(current => ({ ...current, [q.id]: event.target.value }))}/><datalist id={'q-' + request.id + '-' + q.id}>{q.options.map(o => <option value={o.label} key={o.id}/>)}</datalist></>}
      </label>)}
    <div className="row">{request.options.map(o => <button key={o.id} className={o.kind === 'deny' ? 'secondary' : 'primary'} disabled={o.id === 'answer' && !complete} onClick={() => onAnswer(o.id, answers)}>{o.label}</button>)}</div>
  </div>;
}
