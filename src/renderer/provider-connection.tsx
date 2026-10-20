import React, { useEffect, useId, useRef, useState } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import type { Provider, ProviderAuth, SessionNetworkRoute } from '../shared/types';
import type { UserEgressStatus } from '../shared/egress';
import { ProviderAuthPanel } from './provider-auth';
import { EgressRouteChoice } from './egress-route';
import { checkProviderConnection, type ProviderConnectionCheck } from './provider-connection-check';

export function ProviderConnectionSettings({ provider, cwd, auth, egress, activeTaskCount, busyChanged, pendingChanged, checked, showCatalog = true, routeEditable = true, sessionRoute, savedRoute, sessionId, routeChanged, scopeLabel }: {
  scopeLabel?: string; provider: Provider; cwd: string; auth: ProviderAuth; egress?: UserEgressStatus; activeTaskCount: number; busyChanged?: (busy: boolean) => void;
  checked?: (result: ProviderConnectionCheck) => void; pendingChanged?: (pending: boolean) => void; showCatalog?: boolean; routeEditable?: boolean; sessionRoute?: SessionNetworkRoute; savedRoute?: SessionNetworkRoute; sessionId?: string; routeChanged?: (route: SessionNetworkRoute) => void;
}) {
  const [accountEnabled, setAccountEnabled] = useState(!!egress?.enabled), [invite, setInvite] = useState('');
  const enabled = sessionRoute ? sessionRoute === 'management' : accountEnabled;
  const setEnabled = (value: boolean) => { if (sessionRoute) routeChanged?.(value ? 'management' : 'direct'); else setAccountEnabled(value); };
  const [viaSharedServer, setViaSharedServer] = useState(!!egress?.viaSharedServer);
  const [changingCode, setChangingCode] = useState(false);
  const routeDescription = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<ProviderConnectionCheck>();
  const routeAuth = auth.networkRoute === sessionRoute && auth.cwd === cwd ? auth : undefined;
  const visibleAuth = routeAuth && (!result || ['checking', 'logging-in'].includes(routeAuth.status) || !!routeAuth.checkedAt && routeAuth.checkedAt >= (result.auth.checkedAt || '')) ? routeAuth : result?.auth || auth;
  const sequence = useRef(0), checking = useRef(false);
  const callbacks = useRef({ busyChanged, checked }); callbacks.current = { busyChanged, checked };
  const routePending = !!sessionId && !!sessionRoute && sessionRoute !== savedRoute;
  const dirty = routeEditable && (sessionRoute ? enabled && (!egress?.enabled || viaSharedServer !== !!egress?.viaSharedServer || !!invite.trim()) : enabled !== !!egress?.enabled || viaSharedServer !== !!egress?.viaSharedServer || !!invite.trim());
  const needsAccessCode = enabled && !invite.trim() && (!egress?.hasAccessCode || changingCode);
  useEffect(() => { pendingChanged?.(dirty); return () => pendingChanged?.(false); }, [dirty]);
  useEffect(() => setAccountEnabled(!!egress?.enabled), [egress?.enabled]);
  useEffect(() => setViaSharedServer(!!egress?.viaSharedServer), [egress?.viaSharedServer]);
  const check = async (apply: boolean) => {
    if (!cwd || checking.current) return;
    if (apply && dirty && activeTaskCount) { setError('当前窗口有任务正在运行，请结束或停止任务后再切换网络出口。'); return; }
    checking.current = true; const n = ++sequence.current; setBusy(true); setError(''); setResult(undefined); callbacks.current.busyChanged?.(true);
    try {
      const result = await checkProviderConnection(window.workbench.call, provider, cwd, apply && dirty ? { enabled, viaSharedServer, inviteCode: invite.trim() || undefined } : undefined, () => n === sequence.current, sessionRoute);
      if (n !== sequence.current) return;
      if (apply && sessionId && sessionRoute && !result.issues.some(issue => issue.startsWith('网络出口检测失败'))) await window.workbench.call('session.network', { id: sessionId, networkRoute: sessionRoute });
      if (n !== sequence.current) return;
      if (apply) { setInvite(''); setChangingCode(false); } setResult(result); setError(result.issues.join('；')); callbacks.current.checked?.(result);
    } catch (reason: any) { if (n === sequence.current) setError(reason.message); }
    finally { checking.current = false; if (n === sequence.current) { setBusy(false); callbacks.current.busyChanged?.(false); } }
  };
  useEffect(() => {
    const n = ++sequence.current;
    // Opening the panel should not lock network controls behind a slow model request.
    if (cwd) void window.workbench.call<ProviderAuth>('provider.auth', { provider, cwd, ...(sessionRoute ? { networkRoute: sessionRoute } : {}) })
      .then(auth => { if (n === sequence.current) { const value = { auth, issues: [] }; setResult(value); callbacks.current.checked?.(value); } })
      .catch((reason: Error) => { if (n === sequence.current) setError(reason.message); });
    return () => { sequence.current++; callbacks.current.busyChanged?.(false); };
  }, [provider, cwd, sessionRoute]);
  return <section className="provider-connection-settings" aria-label="网络与登录设置">
    <div className="row"><Network size={17}/><strong>网络连接</strong><span className="spacer"/><span className="muted small">{enabled ? '管理端出口' : '本机网络'}</span></div>
    {routeEditable && <p className="muted small">{sessionId ? '应用后，这个会话从下一轮开始使用所选出口。改成管理端时，没有接入码就先粘贴管理端提供的接入码。其他会话保持原来的连接。' : scopeLabel ? `连接方式用于${scopeLabel}，使用你的个人 AI 账号。` : '连接方式只应用于这次新建的会话；运行中的其他会话继续使用原出口。'}</p>}
    {routeEditable && <fieldset disabled={busy}>
      <label className={'provider-route-option' + (enabled ? ' selected' : '')}>
        <span className="provider-route-icon" aria-hidden="true"><Network size={22}/></span>
        <span className="provider-route-copy"><strong>通过管理端访问模型服务</strong><span id={routeDescription}>使用管理员提供的网络连接，仍使用你的个人 AI 账号。</span></span>
        <input type="checkbox" aria-label="通过管理端访问模型服务" aria-describedby={routeDescription} checked={enabled} onChange={event => { setEnabled(event.target.checked); setChangingCode(false); setInvite(''); setResult(undefined); setError(''); }}/>
      </label>
      {enabled && <><EgressRouteChoice value={viaSharedServer} onChange={value => { setViaSharedServer(value); setResult(undefined); setError(''); }}/>{egress?.hasAccessCode && !changingCode ? <div className="row"><span role="status">管理端接入码已保存，本次无需再次输入。</span><button className="text-button" type="button" onClick={() => setChangingCode(true)}>更换接入码</button></div> : <><label className="field">管理端接入码<textarea aria-label="管理端网络出口接入码" rows={3} value={invite} onChange={event => { setInvite(event.target.value); if (event.target.value.trim().startsWith('TAE2.')) setViaSharedServer(true); setResult(undefined); }} placeholder="粘贴管理端“网络出口”页面复制的接入码"/></label>{changingCode && <button className="text-button" type="button" onClick={() => { setChangingCode(false); setInvite(''); }}>取消更换</button>}</>}{!egress?.hasAccessCode && !invite.trim() && <p className="muted small" role="status">缺少管理端接入码，粘贴后才能应用此连接方式。</p>}</>}
    </fieldset>}
    {enabled && egress?.enabled && <p className="muted small" role="status">{egress.detail}</p>}
    {dirty && activeTaskCount > 0 && <p className="muted small">当前有 {activeTaskCount} 个任务使用管理端出口；更换接入信息需等这些任务结束或停止。</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button className="secondary" disabled={busy || !cwd || dirty && !!activeTaskCount || needsAccessCode && (dirty || routePending || changingCode)} onClick={() => void check(true)}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? '正在检测网络、登录和模型…' : dirty || routePending ? '应用并重新检测' : '重新检测连接与登录'}</button>
    <ProviderAuthPanel provider={provider} cwd={cwd} auth={visibleAuth} networkRoute={sessionRoute} autoCheck={false} stale={dirty || busy || !!sessionRoute && !result && !routeAuth} disabled={dirty || busy}/>
    {showCatalog && result?.catalog && <div className="provider-connection-catalog"><b>可用模型（{result.catalog.models.length}）</b><p>{result.catalog.models.map(model => model.name).join('、') || 'CLI 暂未返回可用模型。'}</p><p className="muted small">{result.catalog.quota.windows.length ? result.catalog.quota.windows.map(window => `${window.name}：剩余 ${Number((100 - window.usedPercent).toFixed(1))}%`).join('；') : result.catalog.quota.detail}</p></div>}
  </section>;
}
