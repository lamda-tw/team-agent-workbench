import React, { useEffect, useState } from 'react';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import { X } from 'lucide-react';
import { contributionCategoryInfo, titleSubject } from '../shared/content';
import { categoryStatuses, resultCategories, resultDefaultStatus, resultStateLabel, resultStatusLabels, type ResultCategory, type ResultStatus } from '../shared/result-model';

export function ResultCategoryDialog({ category, busy, error, close, save }: { category: ResultCategory; busy: boolean; error?: string; close: () => void; save: (category: ResultCategory) => void }) {
  const [value, setValue] = useState(category);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) close(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [busy, close]);
  return <div className="modal-backdrop"><section className="modal result-category-dialog" role="dialog" aria-modal="true" aria-labelledby="result-category-dialog-title">
    <header><h2 id="result-category-dialog-title">修改分类</h2><button className="icon" aria-label="关闭分类窗口" disabled={busy} onClick={close}><X size={18}/></button></header>
    <div className="modal-body"><div className="result-category-choices">{resultCategories.map(key => <label key={key} className={key === value ? 'selected' : ''}><input type="radio" name="result-category" checked={value === key} disabled={busy} onChange={() => setValue(key)}/><span><b>{contributionCategoryInfo[key].label}</b><small>{contributionCategoryInfo[key].description}</small></span></label>)}</div>
      <p className="muted small">正文和来源保留。{value !== category && resultDefaultStatus(value) ? `改类后为「${resultStateLabel({ title: '', category: value })}」。` : ''}</p>{error && <div className="inline-error" role="alert">{error}</div>}
    </div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || value === category} onClick={() => save(value)}>{busy ? '正在保存…' : '确认修改'}</button></footer>
  </section></div>;
}
export function ResultStatusSelect({ category, value, disabled, change }: { category: ResultCategory; value?: ResultStatus; disabled?: boolean; change: (status: ResultStatus) => void }) {
  if (!categoryStatuses[category].length) return null;
  const statuses = value && !categoryStatuses[category].includes(value) ? [value, ...categoryStatuses[category]] : categoryStatuses[category];
  return <label className="field">状态<select aria-label="成果状态" value={value || resultDefaultStatus(category)} disabled={disabled} onChange={event => change(event.target.value as ResultStatus)}>{statuses.map(status => <option key={status} value={status} disabled={!categoryStatuses[category].includes(status)}>{category === 'project_goal' && status === 'pending' ? '待确认' : resultStatusLabels[status]}</option>)}</select></label>;
}
export interface ResultHistoryEntry { version: number; title: string; content: string; updatedAt: string; category?: string; resultStatus?: ResultStatus }
export function ResultHistoryDrawer({ current, versions, close }: { current: ResultHistoryEntry; versions: ResultHistoryEntry[]; close: () => void }) {
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [close]);
  return <div className="result-drawer-backdrop" onClick={close}><aside className="result-history-drawer" role="dialog" aria-modal="true" aria-labelledby="result-history-heading" onClick={event => event.stopPropagation()}>
    <header><div><h2 id="result-history-heading">历史版本</h2><p>{titleSubject(current.title)}</p></div><button className="icon" aria-label="关闭历史版本" onClick={close}><X size={18}/></button></header>
    <div className="result-history-body">{[current, ...versions.filter(entry => entry.version < current.version).sort((a,b) => b.version - a.version)].map((entry, index) => <section key={entry.version} className={index ? '' : 'current'}><div className="row"><b>v{entry.version}</b><span className="content-category-badge">{index ? '历史版本' : '当前版本'}</span></div><small>{new Date(entry.updatedAt).toLocaleString()}</small>{entry.category && <p className="muted small">{contributionCategoryInfo[entry.category as keyof typeof contributionCategoryInfo]?.label} · {resultStateLabel(entry)}</p>}<details open={!index}><summary>查看当时内容</summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown></div></details></section>)}</div>
    <footer><button className="secondary" onClick={close}>关闭</button></footer>
  </aside></div>;
}
