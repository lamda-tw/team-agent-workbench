import React, { useState } from 'react';
import { briefFields } from '../shared/project-brief';
import type { AccountSyncState } from '../shared/account-data';
import type { SyncChoice, SyncConflict } from '../shared/sync-conflict';

export function SyncConflictCard({ conflict, busy, resolve }: { conflict: SyncConflict; busy: boolean; resolve: (choice: SyncChoice, fields?: { path: string[]; text: string }[]) => void }) {
  const [editing, setEditing] = useState(false), [changes, setChanges] = useState<Record<string, string>>({});
  const describe = (value: unknown) => value == null ? '已删除' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const title = (conflict.local as any)?.title || (conflict.remote as any)?.title || '资料';
  const editable = conflict.fields.every(field => typeof field.local === 'string' && typeof field.remote === 'string');
  const fields = conflict.fields.map(field => { const key = JSON.stringify(field.path); return { path: field.path, text: changes[key] ?? conflict.ai?.fields?.find(item => JSON.stringify(item.path) === key)?.text ?? String(field.local ?? '') }; });
  return <section className="sync-conflict" aria-label={'同步冲突：' + title}>
    <h3>{title}</h3><p className="muted small">此项等待处理，其他资料继续自动同步。</p>
    {conflict.fields.map(field => <div key={JSON.stringify(field.path)}><b>{field.path.map(part => briefFields.find(field => field.key === part)?.label || ({ content: '内容', title: '标题', body: '正文' } as Record<string, string>)[part] || part).join(' / ') || '整份资料'}</b><div className="form-grid"><div>本机<pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{describe(field.local)}</pre></div><div>中央<pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{describe(field.remote)}</pre></div></div>
      {editing && <label className="field">合并稿<textarea rows={6} value={fields.find(item => JSON.stringify(item.path) === JSON.stringify(field.path))!.text} onChange={event => setChanges({ ...changes, [JSON.stringify(field.path)]: event.target.value })}/></label>}
    </div>)}
    {['queued', 'running'].includes(conflict.ai?.status || '') && <p role="status">AI 正在分析双方修改…</p>}
    {conflict.ai?.status === 'error' && <p className="muted small">{conflict.ai.error}；可直接处理，后台会自动重试。</p>}
    {conflict.ai?.status === 'ready' && <div><b>AI 合并建议</b><p>{conflict.ai.summary}</p>{conflict.ai.fields?.map(field => <div key={JSON.stringify(field.path)}><small>{field.reason}</small><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{field.text}</pre></div>)}{conflict.ai.unresolved?.map((item, index) => <p className="inline-error" key={index}>{item}</p>)}</div>}
    <div className="row" style={{ flexWrap: 'wrap' }}>
      {editable && conflict.ai?.status === 'ready' && !conflict.ai.unresolved?.length && <button className="primary" disabled={busy} onClick={() => resolve('merged', conflict.ai!.fields)}>采用 AI 合并</button>}
      {editable && <button className="secondary" disabled={busy} onClick={() => editing ? resolve('merged', fields) : setEditing(true)}>{editing ? '保存合并稿' : '手动合并'}</button>}
      <button className="secondary" disabled={busy} onClick={() => resolve('local')}>采用本机</button><button className="secondary" disabled={busy} onClick={() => resolve('remote')}>采用中央</button>
      {conflict.key.startsWith('material:') && !!conflict.local && !!conflict.remote && <button className="secondary" disabled={busy} onClick={() => resolve('both')}>双方保留</button>}
    </div>
  </section>;
}

export function AccountSyncStatus({ state, connected }: { state?: AccountSyncState; connected: boolean }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const labels = { offline: '本机已保存', pending: '资料待同步', syncing: '资料同步中', synced: '资料已同步', error: '资料等待自动同步', conflict: (state?.conflicts?.length || 0) + ' 项待处理' };
  const run = async (action: string, input?: unknown) => { setBusy(true); setError(''); try { await window.workbench.call(action, input); } catch (error: any) { setError(error.message); } finally { setBusy(false); } };
  return <><button className="text-button" title={state?.detail || '自动同步状态'} onClick={() => setOpen(true)}>{labels[state?.conflicts?.length ? 'conflict' : connected ? state?.status || 'offline' : 'offline']}</button>{open && <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-label="账号资料同步"><header><h2>自动同步</h2><button className="icon" onClick={() => setOpen(false)} aria-label="关闭同步状态">×</button></header><div className="modal-body"><p>个人成果、整理结果、已选附件和动态处理记录自动同步到你的账号。完整对话、代码目录和登录凭据保留在本机。</p>{state?.detail && <p role="status">{state.detail}</p>}{state?.syncedAt && <p className="muted small">最近同步：{new Date(state.syncedAt).toLocaleString()}</p>}{error && <p className="inline-error">{error}</p>}
    {state?.conflicts?.map(conflict => <SyncConflictCard key={conflict.token} conflict={conflict} busy={busy} resolve={(choice, fields) => void run('account.sync.resolve', { key: conflict.key, token: conflict.token, choice, fields })}/>)}
    {!!state?.history?.length && <details><summary>合并记录与恢复</summary>{state.history.map(item => <div className="row" key={item.id}><span>{new Date(item.at).toLocaleString()} · {item.method === 'ai-auto' ? 'AI 自动合并' : item.method === 'undo' ? '已恢复旧版本' : '已处理冲突'}</span><button className="text-button" disabled={busy} onClick={() => void run('account.sync.undo', { id: item.id })}>恢复处理前版本</button></div>)}</details>}
    </div></section></div>}</>;
}
