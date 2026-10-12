import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { AgentCapabilityCatalog, AgentSession } from '../shared/types';
import { McpPanel } from './mcp-panel';

export function AgentCustomization({ session, close }: { session: AgentSession; close: () => void }) {
  const [tab, setTab] = useState<'mcp' | 'skill' | 'plugin'>('mcp'), [catalog, setCatalog] = useState<AgentCapabilityCatalog>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), panel = useRef<HTMLElement>(null);
  const load = async (forceRefresh = false) => {
    const n = ++generation.current; setBusy(true); setError('');
    try { const value = await window.workbench.call<AgentCapabilityCatalog>('session.capabilities', { id: session.id, kind: tab, forceRefresh }); if (n === generation.current) setCatalog(value); }
    catch { if (n === generation.current) setError('列表读取失败，请重试。'); }
    finally { if (n === generation.current) setBusy(false); }
  };
  useEffect(() => { setCatalog(undefined); if (tab !== 'mcp') void load(); return () => { generation.current++; }; }, [tab, session.id]);
  useEffect(() => {
    const previous = document.activeElement; panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); else document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(); };
  }, []);
  const items = tab === 'skill' ? catalog?.skills || [] : catalog?.plugins || [];
  return <div className="modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') || [])].filter(value => value.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (first && (document.activeElement === panel.current || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    }
  }}>
    <section className="modal agent-customization" role="dialog" aria-modal="true" aria-label={session.provider === 'cursor' ? 'Cursor 自定义' : 'Codex 设置'} ref={panel} tabIndex={-1}>
      <header><h2>{session.provider === 'cursor' ? 'Cursor · 自定义' : 'Codex · 设置'}</h2><span className="spacer"/><button className="icon" aria-label="关闭工具设置" onClick={close}><X size={18}/></button></header>
      <div className="settings-tabs" role="tablist" aria-label="工具设置类别">{([['mcp', 'MCP 服务器'], ['skill', 'Skills'], ['plugin', '插件']] as const).map(([id, name]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{name}</button>)}</div>
      {tab === 'mcp' ? <McpPanel session={session} close={close} embedded manage/> : <><div className="modal-body"><div className="row"><strong>{tab === 'skill' ? '可用 Skills' : '已安装插件'}</strong><span className="spacer"/><button className="icon" aria-label="刷新工具列表" disabled={busy} onClick={() => void load(true)}><RefreshCw size={15}/></button></div>
        {(error || (tab === 'skill' ? catalog?.skillError : catalog?.pluginError)) && <p className="inline-error" role="alert">{error || (tab === 'skill' ? catalog?.skillError : catalog?.pluginError)}</p>}
        {busy && <p role="status">读取中…</p>}{!busy && catalog && !items.length && <p className="muted">{tab === 'skill' ? '没有可用的 Skill。' : session.provider === 'cursor' ? '未发现本地插件。市场安装的插件可在 Cursor 中管理。' : '没有已安装的插件。'}</p>}
        {items.map(item => <article className="mcp-server" key={item.id}><div className="row"><b>{item.name}</b><span className="badge">{item.enabled ? '已启用' : '已停用'}</span><span className="spacer"/>{tab === 'skill' && session.provider === 'codex' && item.source === '个人' && <button className="secondary compact" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await window.workbench.call('session.skills.configure', { id: session.id, skillId: item.id, enabled: !item.enabled }); await load(true); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{item.enabled ? '停用' : '启用'}</button>}</div><p>{item.description}</p><small className="muted">{item.source}</small></article>)}
      </div><footer><button className="secondary" onClick={() => void window.workbench.call('session.tools.configuration', { id: session.id, kind: tab }).catch(() => setError('无法打开目录。'))}>打开个人{tab === 'skill' ? ' Skills' : '插件'}目录</button><span className="spacer"/><button className="text-button" onClick={() => void window.workbench.call('open.link', session.provider === 'cursor' ? 'https://cursor.com/marketplace' : 'https://learn.chatgpt.com/docs/build-skills').catch(() => setError('无法打开浏览器。'))}>{session.provider === 'cursor' ? '插件市场' : '安装与创建说明'}</button></footer></>}
    </section>
  </div>;
}
