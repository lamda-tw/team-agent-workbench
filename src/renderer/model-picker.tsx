import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { Provider, ProviderCatalog, SessionNetworkRoute } from '../shared/types';
import { defaultModelLabel } from '../shared/model-selection';

export function ModelPicker({ provider, cwd, ready, model, changed, initialCatalog, networkRoute }: { provider: Provider; cwd: string; ready: boolean; model: string; changed: (model: string) => void; initialCatalog?: ProviderCatalog; networkRoute?: SessionNetworkRoute }) {
  const [catalog, setCatalog] = useState<ProviderCatalog>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0);
  const refresh = async (forceRefresh = false) => {
    const n = ++sequence.current; setBusy(true); setError('');
    try { const value = await window.workbench.call<ProviderCatalog>('provider.catalog', { provider, cwd, forceRefresh, ...(networkRoute ? { networkRoute } : {}) }); if (n === sequence.current) setCatalog(value); }
    catch { if (n === sequence.current) setError('模型与额度读取失败，请检查 CLI 和网络后重试。'); }
    finally { if (n === sequence.current) setBusy(false); }
  };
  useEffect(() => { setCatalog(ready ? initialCatalog : undefined); setError(''); if (ready && !initialCatalog) void refresh(); else setBusy(false); return () => { sequence.current++; }; }, [provider, cwd, networkRoute, ready, initialCatalog]);
  const url = provider === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : provider === 'claude' ? 'https://claude.ai/settings/usage' : 'https://cursor.com/dashboard/spending';
  return <section className="model-picker" aria-label="模型与额度">
    <div className="row"><b>模型与额度</b><span className="spacer"/><button className="text-button" disabled={!ready || busy} onClick={() => void refresh(true)}><RefreshCw size={13} className={busy ? 'spin' : ''}/>{busy ? '读取中…' : '刷新模型与额度'}</button></div>
    <label className="field">会话模型<select aria-label="会话模型" value={model} disabled={!ready || busy && !catalog?.models.length} onChange={e => changed(e.target.value)}><option value="">{defaultModelLabel(catalog)}</option>{model && !catalog?.models.some(m => m.id === model) && <option value={model}>{model}（上次选择）</option>}{catalog?.models.map(m => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? ' · CLI 推荐' : ''}</option>)}</select></label>
    {!model && catalog?.defaultModelWarning && <p className="muted small">{catalog.defaultModelWarning}</p>}
    {!ready && <p className="muted small">暂时无法读取模型列表；仍可创建会话并沿用 CLI 默认模型。</p>}
    {(error || catalog?.modelError) && <p role="alert" className="inline-error">{error || catalog?.modelError}</p>}
    <div className="quota-panel">
      <div className="row"><strong>账号额度</strong><span className="spacer"/><button className="text-button" onClick={() => void window.workbench.call('open.link', url).catch(() => setError('无法打开浏览器，请稍后重试。'))}><ExternalLink size={13}/>查看官方额度页</button></div>
      {!catalog?.quota.windows.length && <p className="muted small">{catalog?.quota.detail || (provider === 'cursor' ? '请在官方额度页查看' : '额度未读取')}</p>}
      {catalog?.quota.windows.map((w, i) => <div className="quota-window" key={i}><div className="row"><span>{w.name}{w.windowMinutes ? `（${w.windowMinutes >= 1440 ? w.windowMinutes / 1440 + ' 天' : w.windowMinutes / 60 + ' 小时'}）` : ''}</span><b>剩余 {Number((100 - w.usedPercent).toFixed(1))}%</b></div><progress max={100} value={100 - w.usedPercent}/><small>{w.resetsAt ? '重置：' + new Date(w.resetsAt * 1000).toLocaleString('zh-CN') : '重置时间暂未提供'}</small></div>)}
      {catalog && <small className="muted">读取时间：{new Date(catalog.checkedAt).toLocaleTimeString('zh-CN')}</small>}
    </div>
  </section>;
}
