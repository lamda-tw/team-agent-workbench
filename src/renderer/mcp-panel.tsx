import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import type { AgentSession } from '../shared/types';
import type { McpCatalog, McpServerInput } from '../shared/mcp';

const labels = { notStarted: '尚未连接', starting: '连接中', connected: '已连接', authenticationRequired: '需要登录', failed: '连接失败', cancelled: '连接已取消', disabled: '已停用', unknown: '状态待确认' };
export function McpPanel({ session, close, manage = false, embedded = false, openSettings }: { session: AgentSession; close: () => void; manage?: boolean; embedded?: boolean; openSettings?: () => void }) {
  const [catalog, setCatalog] = useState<McpCatalog>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [adding, setAdding] = useState(false);
  const alive = useRef(true), sequence = useRef(0), panel = useRef<HTMLElement>(null), polling = useRef(false);
  const [editing, setEditing] = useState<McpServerInput>(), [removing, setRemoving] = useState('');
  const load = async (refresh = false, quiet = false) => {
    if (quiet && polling.current) return;
    const n = ++sequence.current; polling.current = true;
    if (!quiet) { setBusy(true); setError(''); }
    try { const result = await window.workbench.call<McpCatalog>('session.mcp', { id: session.id, refresh }); if (alive.current && n === sequence.current) { setCatalog(result); setError(''); } }
    catch { if (alive.current && n === sequence.current) setError('MCP 状态读取失败，可刷新重试。'); }
    finally { polling.current = false; if (alive.current && n === sequence.current && !quiet) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; void load(); panel.current?.focus();
    return () => { alive.current = false; sequence.current++; };
  }, [session.id]);
  const pending = catalog?.servers.some(server => server.loginPending || server.state === 'starting');
  useEffect(() => { if (!pending || busy) return; const timer = setInterval(() => void load(false, true), 2000); return () => clearInterval(timer); }, [pending, busy, session.id]);
  const mutate = async (action: string, payload: object) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.workbench.call<{ pendingReload?: number }>(action, { id: session.id, ...payload });
      if (!alive.current) return;
      if (action !== 'session.mcp.login') setNotice(result?.pendingReload ? '已保存；部分会话尚未刷新，可在对应会话打开 MCP 重试。' : '已保存，后续任务使用新设置。');
      else setNotice('请在浏览器完成登录。');
      await load(); setAdding(false); setEditing(undefined); setRemoving('');
    } catch (e: any) { if (alive.current) setError(e.message || '操作未完成，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className={embedded ? 'mcp-embedded' : 'modal-backdrop'} onPointerDown={event => { if (!embedded && event.target === event.currentTarget) close(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab' && !embedded) {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') || [])].filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (first && (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    }
  }}>
    <section className={embedded ? 'mcp-panel' : 'modal mcp-panel'} ref={panel} tabIndex={-1} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="MCP 服务器">
      <header><h2>{manage ? 'MCP 服务器' : 'MCP 状态'}</h2><span className="spacer"/><button className="icon" title="刷新 MCP" disabled={busy} onClick={() => void load(true)}><RefreshCw size={15} className={busy ? 'spin' : ''}/></button>{!embedded && <button className="icon" aria-label="关闭 MCP" onClick={close}><X size={17}/></button>}</header>
      <div className="modal-body">
        {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="muted small" role="status">{notice}</p>}
        {busy && !catalog && <p role="status"><LoaderCircle size={14} className="spin"/>读取 MCP 中…</p>}
        {!busy && catalog && !catalog.servers.length && <p className="muted">还没有配置 MCP。</p>}
        {catalog?.servers.map(server => <article className="mcp-server" key={server.name}>
          <div className="row"><b>{server.title}</b><span className={'mcp-state ' + server.state}>{server.loginPending ? '等待浏览器登录' : session.provider === 'cursor' && server.state === 'unknown' ? '已配置 · 由 Cursor 连接' : labels[server.state]}</span><span className="spacer"/>
            {manage && server.enabled && (server.canLogin || ['notLoggedIn', 'oAuth'].includes(server.authStatus)) && <button className="secondary compact" disabled={busy || server.loginPending} onClick={() => void mutate('session.mcp.login', { name: server.name })}>{server.authStatus === 'oAuth' ? '重新登录' : '登录'}</button>}
            {manage && server.canToggle && <><button className="text-button" disabled={busy} onClick={() => void mutate('session.mcp.toggle', { name: server.name, enabled: !server.enabled })}>{server.enabled ? '停用' : '启用'}</button><button className="text-button" disabled={busy} onClick={async () => { setError(''); try { setEditing(await window.workbench.call<McpServerInput>('session.mcp.editable', { id: session.id, name: server.name })); setAdding(false); } catch { setError('MCP 配置读取失败，请重试。'); } }}>编辑</button><button className="text-button" disabled={busy} onClick={() => setRemoving(server.name)}>删除</button></>}
          </div><small className="muted">{server.source} · {server.tools.length} 个工具</small>
          {server.loginError && <p className="inline-error" role="alert">{server.loginError}</p>}
          {manage && removing === server.name && <div className="row"><span>删除个人配置中的“{server.title}”？</span><button className="secondary compact" onClick={() => setRemoving('')}>取消</button><button className="secondary compact" disabled={busy} onClick={() => void mutate('session.mcp.remove', { name: server.name })}>确认删除</button></div>}
          {server.tools.length > 0 && <details><summary>查看工具</summary><ul>{server.tools.map(tool => <li key={tool.name}><b>{tool.name}</b>{tool.description && <p>{tool.description}</p>}</li>)}</ul></details>}
        </article>)}
        {manage && (adding || editing) && <McpForm key={editing?.name || 'new'} provider={session.provider} initial={editing} busy={busy} cancel={() => { setAdding(false); setEditing(undefined); }} save={server => mutate(editing ? 'session.mcp.update' : 'session.mcp.add', { server })}/>}
      </div><footer><span className="muted small">工具由 Agent 按需调用。</span><span className="spacer"/>{manage ? <><button className="text-button" onClick={() => void window.workbench.call('session.tools.configuration', { id: session.id, kind: 'mcp' }).catch(() => setError('无法打开配置文件。'))}>打开配置文件</button>{!adding && !editing && <button className="secondary" disabled={busy} onClick={() => { setError(''); setAdding(true); }}><Plus size={14}/>添加 MCP</button>}</> : openSettings && <button className="secondary" onClick={openSettings}>打开设置</button>}{!embedded && <button className="secondary" onClick={close}>关闭</button>}</footer>
    </section>
  </div>;
}

function McpForm({ busy, save, cancel, initial, provider }: { busy: boolean; save: (value: McpServerInput) => Promise<void>; cancel: () => void; initial?: McpServerInput; provider: AgentSession['provider'] }) {
  const [name, setName] = useState(initial?.name || ''), [transport, setTransport] = useState<'http' | 'stdio'>(initial?.transport || 'http'), [address, setAddress] = useState(initial?.command || initial?.url || ''), [args, setArgs] = useState(initial?.args?.join('\n') || ''), [tokenVar, setTokenVar] = useState(initial?.bearerTokenEnvVar || '');
  return <form className="mcp-form" onSubmit={event => { event.preventDefault(); void save({ name: name.trim(), transport, ...(transport === 'http' ? { url: address.trim(), ...(tokenVar.trim() ? { bearerTokenEnvVar: tokenVar.trim() } : {}) } : { command: address.trim(), args: args.split(/\r?\n/).filter(Boolean) }) }); }}>
    <h3>{initial ? '编辑个人 MCP' : '添加个人 MCP'}</h3><label>名称<input required readOnly={!!initial} pattern="[a-zA-Z0-9_-]+" maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如 docs"/></label>
    <label>连接方式<select value={transport} onChange={event => { setTransport(event.target.value as 'http' | 'stdio'); setAddress(''); }}><option value="http">远端服务（HTTP）</option><option value="stdio">本地进程（STDIO）</option></select></label>
    <label>{transport === 'http' ? '服务地址' : '启动命令'}<input required type={transport === 'http' ? 'url' : 'text'} value={address} onChange={event => setAddress(event.target.value)} placeholder={transport === 'http' ? 'https://example.com/mcp' : '例如 npx 或程序的完整路径'}/></label>
    {transport === 'stdio' ? <label>启动参数<textarea aria-label="MCP 启动参数" value={args} onChange={event => setArgs(event.target.value)} placeholder="每行一个参数"/></label> : provider === 'codex' && <details><summary>Token 认证（可选）</summary><label>保存 Token 的环境变量名<input pattern="[A-Za-z_][A-Za-z0-9_]*" value={tokenVar} onChange={event => setTokenVar(event.target.value)} placeholder="例如 DOCS_TOKEN"/></label></details>}
    <div className="row"><span className="muted small">保存到个人 {provider === 'codex' ? 'Codex' : 'Cursor'} 配置。</span><span className="spacer"/><button type="button" className="secondary compact" onClick={cancel}>取消</button><button className="primary compact" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
  </form>;
}
