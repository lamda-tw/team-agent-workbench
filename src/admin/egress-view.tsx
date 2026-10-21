import React, { useEffect, useId, useRef, useState } from 'react';
import { Activity, ArrowRight, CircleCheck, Clipboard, Network, Radio, RefreshCw, Settings2, ShieldCheck, Stethoscope, Users, WifiOff } from 'lucide-react';
import type { AdminEgressConfig, AdminEgressSnapshot } from '../shared/egress';
import { EgressMonitorPanel, traffic } from './egress-monitor';
import { EgressNetworkTests, egressServices, type EgressService, type EgressTestResult } from './egress-tests';
import { EgressJumpSettings } from './egress-jump';
import type { AdminSnapshot } from './types';

const tabs = [
  { id: 'monitor', label: '运行监控', icon: Activity },
  { id: 'access', label: '成员接入', icon: Users },
  { id: 'settings', label: '出口设置', icon: Settings2 },
  { id: 'diagnostics', label: '连接诊断', icon: Stethoscope },
] as const;
type Tab = typeof tabs[number]['id'];
const upstream = (config: AdminEgressConfig) => config.upstreamMode === 'direct' ? '本机直连' : config.upstreamMode === 'http' ? 'HTTP 代理' : 'SOCKS5 代理';
const stamp = (value: string) => new Date(value).toLocaleString();

export function EgressView({ snapshot, remote, refresh }: { snapshot: AdminEgressSnapshot; remote: AdminSnapshot; refresh: () => Promise<void> }) {
  const id = useId(), tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<Tab>(() => snapshot.running || snapshot.config.enabled ? 'monitor' : 'settings');
  const [route, setRoute] = useState<'direct' | 'shared'>(() => snapshot.reverse?.enabled ? 'shared' : 'direct');
  const [config, setConfig] = useState(snapshot.config), [password, setPassword] = useState(''), [clearPassword, setClearPassword] = useState(false);
  const [action, setAction] = useState<'save' | 'copy' | 'rotate' | 'test'>(), [jumpBusy, setJumpBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  const [testing, setTesting] = useState<EgressService>(), [testResults, setTestResults] = useState<Partial<Record<EgressService, EgressTestResult>>>({});
  useEffect(() => { setConfig(snapshot.config); setTestResults({}); }, [JSON.stringify(snapshot.config)]);
  const busy = !!action || jumpBusy || remote.busy;
  const dirty = JSON.stringify(config) !== JSON.stringify(snapshot.config) || !!password || clearPassword;
  const update = <K extends keyof AdminEgressConfig>(key: K, value: AdminEgressConfig[K]) => setConfig(current => ({ ...current, [key]: value }));
  const run = async (kind: 'save' | 'copy' | 'rotate', fn: () => Promise<void>) => {
    setAction(kind); setError(''); setMessage('');
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setAction(undefined); }
  };
  const save = () => run('save', async () => {
    await window.admin.call('egress.save', { config, upstreamPassword: password, clearUpstreamPassword: clearPassword });
    setPassword(''); setClearPassword(false); setTestResults({}); await refresh();
    setMessage(config.enabled ? '网络出口已保存并启动' : '网络出口已关闭，用户端可继续使用本机直连');
  });
  const probe = async (provider: EgressService) => {
    setAction('test'); setTesting(provider); setError(''); setMessage(''); setTestResults(current => ({ ...current, [provider]: undefined }));
    try { await window.admin.call('egress.test', { provider }); setTestResults(current => ({ ...current, [provider]: { ok: true, detail: '管理端网络连接通过' } })); }
    catch (error: any) { setTestResults(current => ({ ...current, [provider]: { ok: false, detail: error.message || '网络连接失败' } })); }
    finally { setAction(undefined); setTesting(undefined); }
  };
  const panel = (key: Tab) => ({ role: 'tabpanel', id: `${id}-panel-${key}`, 'aria-labelledby': `${id}-tab-${key}`, hidden: tab !== key, tabIndex: 0, className: 'egress-panel' });
  const savedServices = egressServices.filter(service => snapshot.config[service.id]).map(service => service.label).join('、');
  const reverseReady = snapshot.reverse?.state === 'connected' && snapshot.reverse.memberAccessConfigured;

  return <div className="egress-view">
    <div className="page-title egress-title">
      <div><span className="eyebrow">NETWORK EGRESS</span><h1>网络出口</h1><p>管理本机转发、成员接入与连接状态。</p></div>
      <span className={'egress-state ' + (snapshot.running ? 'online' : '')}>{snapshot.running ? <CircleCheck size={17}/> : <WifiOff size={17}/>} {snapshot.running ? '出口运行中' : snapshot.config.enabled ? '出口未运行' : '未启用'}</span>
    </div>
    <div className="egress-context"><span><Network size={14}/>{upstream(snapshot.config)}</span><span>{savedServices || '未允许成员转发'}</span><span><ShieldCheck size={14}/>加密传输</span></div>
    {snapshot.config.enabled && <p className="egress-footnote">{snapshot.background ? '关闭管理端窗口后，出口和已登录的反向隧道会继续在系统托盘运行。双击托盘图标可重新打开；选择“关闭此节点并停止其转发”才会结束。注销或关机会停止。' : '系统托盘当前不可用，关闭管理端窗口会停止转发。'}</p>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {message && <div className="admin-success" role="status"><CircleCheck size={17}/>{message}</div>}
    {snapshot.lastError && <div className="egress-start-error" role="alert"><span>出口启动失败：{snapshot.lastError}</span><button className="text-button" onClick={() => setTab('settings')}>检查出口设置<ArrowRight size={14}/></button></div>}
    <div className="egress-tabs" role="tablist" aria-label="网络出口功能">{tabs.map((item, index) => <button
      key={item.id} ref={element => { tabButtons.current[index] = element; }} type="button" role="tab"
      id={`${id}-tab-${item.id}`} aria-label={item.label} aria-controls={`${id}-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
      onClick={() => setTab(item.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); setTab(tabs[next].id); tabButtons.current[next]?.focus(); }
      }}><item.icon size={17}/>{item.label}{item.id === 'settings' && dirty && <span className="egress-unsaved-dot" aria-label="有未保存修改"/>}</button>)}</div>

    <div {...panel('monitor')}>
      {!snapshot.running && <div className="egress-hint"><span>启用出口后，在这里查看成员连接、流量和资源占用。</span><button className="text-button" onClick={() => setTab('settings')}>前往出口设置<ArrowRight size={14}/></button></div>}
      {snapshot.reverse?.enabled && <button className={'egress-route-status ' + (reverseReady ? 'online' : '')} onClick={() => { setRoute('shared'); setTab('access'); }}>
        <Radio size={18}/><span><strong>共享服务器中转</strong><small>{snapshot.reverse.detail}</small></span><span>{snapshot.reverse.activeConnections} 个连接</span><ArrowRight size={16}/>
      </button>}
      <EgressMonitorPanel snapshot={snapshot}/>
      <details className="egress-disclosure egress-history"><summary><span>最近连接 <small>{snapshot.events.length} 条</small></span><span className="egress-summary-note">查看连接记录与失败原因</span></summary>
        <div className="storage-table-scroll"><table><thead><tr><th>时间</th><th>账号标识</th><th>产品</th><th>目标</th><th>状态</th><th>流量</th></tr></thead><tbody>{snapshot.events.length ? snapshot.events.map(event => <tr key={event.id}>
          <td>{stamp(event.at)}</td><td>{event.username || '未标识'}</td><td>{event.provider === 'codex' ? 'Codex' : event.provider === 'cursor' ? 'Cursor' : event.provider === 'claude' ? 'Claude Code' : '连接检测'}</td><td><code>{event.target || '管理端'}</code></td><td>{event.status === 'connected' ? '连接中' : event.status === 'closed' ? '已结束' : event.status === 'rejected' ? '已拒绝' : '失败'}{event.detail && <small>{event.detail}</small>}</td><td>↑ {traffic(event.bytesUp)} · ↓ {traffic(event.bytesDown)}</td>
        </tr>) : <tr><td className="storage-no-rows" colSpan={6}>还没有连接记录</td></tr>}</tbody></table></div>
        <p className="egress-footnote">仅保留连接信息，不记录提问、回答或模型账号凭据。账号标识由用户端上报，不用于权限认证。</p>
      </details>
    </div>

    <div {...panel('access')}>
      <div className="egress-section-intro"><h2>成员怎么连接这台管理端？</h2><p>选择对应路线，再把接入码交给成员。</p></div>
      <div className="egress-route-picker" role="radiogroup" aria-label="成员接入路线">
        <label className={route === 'direct' ? 'selected' : ''}><input type="radio" name={`${id}-route`} checked={route === 'direct'} onChange={() => setRoute('direct')}/><Network size={21}/><span><strong>直连管理端</strong><small>成员能访问本机的地址和端口</small></span></label>
        <label className={route === 'shared' ? 'selected' : ''}><input type="radio" name={`${id}-route`} checked={route === 'shared'} onChange={() => setRoute('shared')}/><Radio size={21}/><span><strong>经共享服务器</strong><small>成员无法直接连接本机时使用</small></span>{snapshot.reverse?.enabled && <em>{reverseReady ? '已连接' : '已启用'}</em>}</label>
      </div>
      {!snapshot.running && <div className="egress-hint"><span>出口尚未运行，成员暂时无法接入。</span><button className="text-button" onClick={() => setTab('settings')}>配置出口<ArrowRight size={14}/></button></div>}
      <div hidden={route !== 'direct'} className="egress-route-panel">
        <section className="egress-card egress-direct-access"><header><div><h3>直连接入</h3><small>用户端 → 本机管理端 → 模型服务</small></div></header>
          <div className="egress-access-body"><div className="egress-address"><span>成员连接地址</span><code>{snapshot.config.publicHost}:{snapshot.config.listenPort}</code><button className="text-button" onClick={() => setTab('settings')}>修改</button></div>
            <div className="egress-copy-row"><p>在用户端开启“通过管理端访问模型服务”，粘贴接入码。</p><button className="primary" disabled={busy} onClick={() => void run('copy', async () => { await window.admin.call('egress.copy'); setMessage('接入码已复制'); })}><Clipboard size={16}/>复制接入码</button></div>
          </div>
        </section>
      </div>
      <div hidden={route !== 'shared'} className="egress-route-panel"><EgressJumpSettings remote={remote} config={snapshot.config} reverse={snapshot.reverse} refresh={refresh} disabled={!!action} busyChanged={setJumpBusy}/></div>
      <details className="egress-disclosure egress-credentials"><summary><span><ShieldCheck size={16}/>接入凭据与安全</span><span className="egress-summary-note">证书 · 更新接入码</span></summary><div className="egress-disclosure-body">
        <p>接入码只提供网络通路，成员仍使用自己的模型账号与额度。仅发给需要使用出口的成员。</p>
        <label>证书指纹<code>{snapshot.fingerprint.match(/.{1,4}/g)?.join(' ')}</code></label>
        <div className="egress-credential-reset"><p>更新后，直连和中转接入码都会失效。所有使用者需重新获取，当前连接会中断。</p><button className="text-button danger" disabled={busy} onClick={() => void run('rotate', async () => { await window.admin.call('egress.rotate'); await refresh(); setMessage('接入码已更新，已接入成员需要重新配置'); })}><RefreshCw size={14}/>更新接入码</button></div>
      </div></details>
    </div>

    <div {...panel('settings')}>
      <section className="egress-card egress-settings-card"><header><div><h3>出口设置</h3><small>更改后保存生效。</small></div><label className="switch-row"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={e => update('enabled', e.target.checked)}/>启用管理端出口</label></header>
        <fieldset className="egress-settings-fields" disabled={busy}>
          <section className="egress-setting-group"><div className="egress-setting-heading"><span>01</span><div><h4>本机如何访问模型服务</h4><p>使用本机网络，或指定已有代理。</p></div></div><div className="egress-setting-controls">
            <label className="field">管理端如何访问外网<select aria-label="上游代理类型" value={config.upstreamMode} onChange={e => update('upstreamMode', e.target.value as AdminEgressConfig['upstreamMode'])}><option value="direct">本机直接访问</option><option value="http">HTTP 代理</option><option value="socks5">SOCKS5 代理</option></select></label>
            {config.upstreamMode !== 'direct' && <><div className="form-grid"><label className="field">代理地址<input aria-label="上游代理地址" placeholder="例如 127.0.0.1" value={config.upstreamHost} onChange={e => update('upstreamHost', e.target.value)}/></label><label className="field">代理端口<input aria-label="上游代理端口" type="number" value={config.upstreamPort || ''} onChange={e => update('upstreamPort', Number(e.target.value))}/></label></div>
              <details className="egress-inline-details"><summary>代理认证（选填）{snapshot.hasUpstreamPassword ? ' · 密码已保存' : ''}</summary><div className="form-grid"><label className="field">代理账号<input value={config.upstreamUsername} onChange={e => update('upstreamUsername', e.target.value)}/></label><label className="field">代理密码<input type="password" autoComplete="new-password" placeholder={snapshot.hasUpstreamPassword ? '留空保持已保存的密码' : '没有则留空'} value={password} onChange={e => { setPassword(e.target.value); setClearPassword(false); }}/></label></div>{snapshot.hasUpstreamPassword && <label className="check-row"><input type="checkbox" checked={clearPassword} onChange={e => setClearPassword(e.target.checked)}/>清除已保存的代理密码</label>}</details></>}
          </div></section>
          <section className="egress-setting-group"><div className="egress-setting-heading"><span>02</span><div><h4>允许成员使用的服务</h4><p>管理端无需安装或登录这些 CLI。</p></div></div><div className="egress-setting-controls egress-service-permissions"><span>成员可通过出口访问</span><div>{egressServices.map(service => <label className={'check-row ' + (config[service.id] ? 'selected' : '')} key={service.id}><input type="checkbox" checked={config[service.id]} onChange={e => update(service.id, e.target.checked)}/>{service.label}</label>)}</div></div></section>
          <section className="egress-setting-group"><div className="egress-setting-heading"><span>03</span><div><h4>本机接入地址</h4><p>直连成员需能访问此地址。</p></div></div><div className="egress-setting-controls">
            <div className="form-grid"><label className="field">提供给成员的地址<input aria-label="提供给成员的地址" value={config.publicHost} onChange={e => update('publicHost', e.target.value)}/><small>本机名或固定内网 IP。</small></label><label className="field">监听端口<input aria-label="网络出口端口" type="number" value={config.listenPort} onChange={e => update('listenPort', Number(e.target.value))}/></label></div>
            <details className="egress-inline-details"><summary>高级监听设置</summary><label className="field">本机监听地址<input value={config.listenHost} onChange={e => update('listenHost', e.target.value)}/></label></details>
          </div></section>
        </fieldset>
        <footer className="egress-save-bar"><span>{dirty ? '有未保存的修改' : '设置已同步'}{dirty && snapshot.running && <small>应用设置会重新启动出口，当前连接将中断。</small>}</span><button className="secondary" disabled={busy || !dirty} onClick={() => { setConfig(snapshot.config); setPassword(''); setClearPassword(false); }}>放弃修改</button><button className="primary" disabled={busy} onClick={() => void save()}>{action === 'save' ? '正在应用…' : '保存并应用'}</button></footer>
      </section>
    </div>

    <div {...panel('diagnostics')}>
      <div className="egress-section-intro"><h2>分段检查连接</h2><p>先检查本机到模型服务；使用中转时，再检查共享服务器通路。</p></div>
      <EgressNetworkTests snapshot={snapshot} busy={busy} testing={testing} results={testResults} pendingChanges={dirty} onTest={provider => void probe(provider)}/>
      <div className="egress-diagnostic-link"><Radio size={21}/><div><strong>共享服务器 → 本机出口</strong><p>{snapshot.reverse?.enabled ? snapshot.reverse.detail : '使用共享服务器中转时，需额外检测完整隧道。'}</p></div><button className="secondary" onClick={() => { setRoute('shared'); setTab('access'); }}>检查中转<ArrowRight size={14}/></button></div>
    </div>
  </div>;
}
