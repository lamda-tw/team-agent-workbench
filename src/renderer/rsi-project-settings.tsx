import React, { useEffect, useState } from 'react';
import type { RsiExecution, RsiShadowSettings } from '../shared/rsi';
import type { ProviderCatalog, Snapshot } from '../shared/types';
import { ModelPicker } from './model-picker';
import { ProviderConnectionSettings } from './provider-connection';
import { canUseProvider } from './provider-auth';
import type { ProviderConnectionCheck } from './provider-connection-check';

export function RsiProjectSettings({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<RsiShadowSettings>(), [snapshot, setSnapshot] = useState<Snapshot>();
  const [execution, setExecution] = useState<RsiExecution>({ provider: 'codex', model: '', networkRoute: 'direct' });
  const [check, setCheck] = useState<ProviderConnectionCheck>(), [catalog, setCatalog] = useState<ProviderCatalog>();
  const [busy, setBusy] = useState(false), [networkBusy, setNetworkBusy] = useState(false), [networkPending, setNetworkPending] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => void window.workbench.call<Snapshot>('snapshot').then(value => { if (alive) setSnapshot(value); }).catch(() => {});
    void window.workbench.call<RsiShadowSettings>('rsi.settings', { projectId }).then(value => { if (alive) { setSettings(value); if (value.config.execution) setExecution(value.config.execution); } }).catch(reason => { if (alive) setError(reason.message); });
    refresh(); const unsubscribe = window.workbench.subscribe(event => { if (event.type === 'state') refresh(); });
    return () => { alive = false; unsubscribe(); };
  }, [projectId]);
  const patch = (value: Partial<RsiExecution>) => { setExecution(previous => ({ ...previous, ...value })); setNotice(''); };
  const model = catalog?.models.find(item => item.id === (execution.model || catalog.defaultModel));
  return <section className="modal-body" aria-label="AI推荐模型设置">
    <p className="muted small">本项目的后台推荐使用此配置和你的个人账号额度。项目有新进展时自动分析，无需保持某条会话打开。</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!settings || !snapshot ? <p>正在读取设置…</p> : <>
      <label className="field">Agent<select aria-label="AI推荐 Agent" value={execution.provider} disabled={busy} onChange={event => { patch({ provider: event.target.value as RsiExecution['provider'], model: '', reasoningEffort: undefined }); setCheck(undefined); setCatalog(undefined); }}><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="claude">Claude Code</option></select></label>
      <div className="new-session-grid"><ProviderConnectionSettings key={execution.provider + execution.networkRoute} provider={execution.provider} cwd={settings.cwd!} auth={snapshot.auth[execution.provider]} egress={snapshot.egress} activeTaskCount={snapshot.sessions.filter(item => ['starting', 'running', 'approval'].includes(item.status)).length} scopeLabel="本项目的 AI推荐" sessionRoute={execution.networkRoute} showCatalog={false} checked={setCheck} busyChanged={setNetworkBusy} pendingChanged={setNetworkPending} routeChanged={networkRoute => { patch({ networkRoute }); setCheck(undefined); setCatalog(undefined); }}/>
      <ModelPicker provider={execution.provider} cwd={settings.cwd!} networkRoute={execution.networkRoute} ready={!networkBusy && !networkPending && !!canUseProvider(check?.auth)} model={execution.model} changed={model => patch({ model, reasoningEffort: undefined })} initialCatalog={check?.catalog} catalogChanged={setCatalog} label="AI推荐模型"/></div>
      {!!model?.reasoningEfforts?.length && <label className="field">思考强度<select aria-label="AI推荐思考强度" value={execution.reasoningEffort || ''} onChange={event => patch({ reasoningEffort: event.target.value || undefined })}><option value="">默认</option>{model.reasoningEfforts.map(option => <option key={option.id} value={option.id}>{option.id}</option>)}</select></label>}
      <div className="row"><button className="primary" disabled={busy || networkBusy || networkPending} onClick={async () => {
        setBusy(true); setError(''); setNotice('');
        try { const config = await window.workbench.call<RsiShadowSettings['config']>('rsi.shadow.configure', { projectId, config: { execution } }); setSettings({ ...settings, config }); setNotice('已保存，后续后台分析使用新配置。'); }
        catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
      }}>{busy ? '保存中…' : '保存推荐配置'}</button><span role="status">{notice}</span></div>
    </>}
  </section>;
}
