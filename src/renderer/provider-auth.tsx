import React, { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { Provider, ProviderAuth, SessionNetworkRoute } from '../shared/types';

export const authLabels: Record<ProviderAuth['status'], string> = {
  unknown: '尚未检测', checking: '检测中', authenticated: '已登录', configured: '凭据已配置',
  unauthenticated: '未登录', error: '检测失败', 'not-required': '无需 OpenAI 登录', 'logging-in': '等待登录',
};
export const canUseProvider = (auth?: ProviderAuth) => auth && ['authenticated', 'configured', 'not-required'].includes(auth.status);
export function ProviderAuthPanel({ provider, auth, cwd, autoCheck = true, stale = false, beforeAction, disabled = false, networkRoute }: {
  provider: Provider; auth: ProviderAuth; cwd?: string; autoCheck?: boolean; stale?: boolean; beforeAction?: () => Promise<unknown>; disabled?: boolean; networkRoute?: SessionNetworkRoute;
}) {
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const name = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Cursor';
  const current: ProviderAuth = stale || (auth.status !== 'logging-in' && cwd && auth.cwd !== cwd) ? { status: 'unknown', detail: '请检测当前 CLI 和工作目录的登录状态。' } : auth;
  const busy = disabled || pending || ['checking', 'logging-in'].includes(current.status);
  const action = async (kind: 'provider.auth' | 'provider.login' | 'provider.login.cancel') => {
    setError(''); setPending(true);
    try { await beforeAction?.(); await window.workbench.call(kind, { provider, cwd, ...(networkRoute ? { networkRoute } : {}) }); }
    catch (e: any) { setError(e.message); }
    finally { setPending(false); }
  };
  useEffect(() => {
    if (!autoCheck || stale) return;
    const timer = setTimeout(() => { void action('provider.auth'); }, 300);
    return () => clearTimeout(timer);
  }, [provider, cwd, networkRoute, autoCheck, stale]);
  return <section className={'provider-auth auth-' + current.status} aria-label={name + ' 登录状态'}>
    <div className="row"><strong>{name} 账号</strong><span className={'badge ' + (canUseProvider(current) ? 'done' : current.status === 'error' || current.status === 'unauthenticated' ? 'error' : 'running')}>{current.verifiedLocally && current.status === 'authenticated' ? '已保存登录' : authLabels[current.status]}</span></div>
    {(current.verifiedLocally || !['authenticated', 'unknown', 'checking'].includes(current.status)) && <p>{current.detail}</p>}
    {current.connectionIssue && <p className="inline-error" role="status">服务连接暂不可用：{current.connectionIssue}</p>}
    {canUseProvider(current) && (current.identity || !current.verifiedLocally) && <p className="account-identity"><strong>{current.identity || 'CLI 未提供账号名称'}</strong>{current.plan && <span className="badge">{current.plan}</span>}</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="row auth-actions">
      {current.status !== 'logging-in' && <button className="secondary compact" disabled={busy || !!canUseProvider(current)} title={canUseProvider(current) ? '已沿用当前账号，无需重复登录' : undefined} onClick={() => void action('provider.login')}><ExternalLink size={14}/>登录个人账号</button>}
      <button className="secondary compact" disabled={busy} onClick={() => void action('provider.auth')}><RefreshCw size={14} className={current.status === 'checking' ? 'spin' : ''}/>重新检测</button>
      {current.status === 'logging-in' && <>
        {current.loginUrl && <button className="secondary compact" onClick={() => void window.workbench.call('open.link', current.loginUrl).catch(e => setError(e.message))}>打开登录网页</button>}
        <button className="text-button" onClick={() => void action('provider.login.cancel')}>取消登录</button>
      </>}
    </div>
  </section>;
}
