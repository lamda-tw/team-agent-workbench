import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { AgentCapabilityCatalog, AgentCapabilityOption, AgentCapabilitySelection, AgentSession } from '../shared/types';
import { composerTrigger, removeComposerTrigger, type ComposerTrigger } from './composer-command';
import { McpPanel } from './mcp-panel';
import { SessionMaterials } from './session-materials';
import './composer-tools.css';

export interface ComposerToolProps {
  session: AgentSession; selected: AgentCapabilitySelection[]; change: (items: AgentCapabilitySelection[]) => void;
  text?: string; changeText?: (text: string) => void; attach?: () => void; handoff?: () => void; changed?: () => Promise<void>;
  openSettings?: () => void;
}
type Menu = 'command' | 'skill' | 'plugin';
export function CodexComposerTools({ session, selected, change, text = '', changeText, attach, handoff, changed, openSettings }: ComposerToolProps) {
  const [menu, setMenu] = useState<Menu>(), [trigger, setTrigger] = useState<ComposerTrigger>(), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<AgentCapabilityCatalog>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [mcp, setMcp] = useState(false), [materials, setMaterials] = useState(false);
  const root = useRef<HTMLDivElement>(null), plus = useRef<HTMLButtonElement>(null), sequence = useRef(0), dismissed = useRef<string | undefined>(undefined);
  const input = () => root.current?.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务输入"]');
  const close = () => { setMenu(undefined); setTrigger(undefined); setQuery(''); dismissed.current = input()?.value; };
  const refresh = async (kind: 'skill' | 'plugin', forceRefresh = false) => {
    const n = ++sequence.current; setLoading(true); setError('');
    try { const result = await window.workbench.call<AgentCapabilityCatalog>('session.capabilities', { id: session.id, kind, forceRefresh }); if (n === sequence.current) setCatalog(result); }
    catch { if (n === sequence.current) setError(`${kind === 'skill' ? 'Skill' : '插件'}列表读取失败，可刷新重试。`); }
    finally { if (n === sequence.current) setLoading(false); }
  };
  useEffect(() => { if (menu) void refresh(menu === 'command' ? 'skill' : menu); return () => { sequence.current++; }; }, [menu, session.id]);
  useEffect(() => { setActive(0); }, [query, menu]);
  const syncTrigger = () => {
    const textarea = input(); if (!textarea || document.activeElement !== textarea || dismissed.current === textarea.value) return;
    dismissed.current = undefined;
    const next = composerTrigger(textarea.value, textarea.selectionStart, session.provider === 'cursor' ? 'cursor' : 'codex');
    if (next) { setTrigger(next); setQuery(next.query); setMenu(next.kind); }
    else if (trigger) { setTrigger(undefined); setMenu(undefined); setQuery(''); }
  };
  useEffect(syncTrigger, [text]);
  const consume = (focus = true) => {
    const textarea = input();
    const current = textarea && composerTrigger(textarea.value, textarea.selectionStart, session.provider === 'cursor' ? 'cursor' : 'codex');
    if (current && changeText) {
      const next = removeComposerTrigger(textarea!.value, current); changeText(next);
      if (focus) requestAnimationFrame(() => { if (textarea?.value === next) { textarea.focus(); textarea.setSelectionRange(current.start, current.start); } });
    } else if (focus) textarea?.focus();
  };
  const command = (kind: 'skill' | 'plugin' | 'mcp') => {
    consume(kind !== 'mcp'); dismissed.current = undefined; setQuery(''); setTrigger(undefined);
    if (kind === 'mcp') { setMenu(undefined); setMcp(true); } else setMenu(kind);
  };
  const pick = (item: AgentCapabilityOption) => {
    if (!item.enabled) return;
    if (!selected.some(value => value.id === item.id)) change([...(session.provider === 'cursor' ? selected.filter(value => value.kind !== 'skill') : selected), { id: item.id, kind: item.kind, name: item.name }]);
    consume(); close();
  };
  const options = (menu === 'skill' ? catalog?.skills || [] : catalog?.plugins || []).filter(item => `${item.name} ${item.invocation} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const commands: { id: string; label: string; help: string; kind?: 'skill' | 'mcp' | 'plugin'; mode?: 'default' | 'plan' | 'ask'; item?: AgentCapabilityOption }[] = [
    { id: 'skills', label: 'Skills', help: '选择工作方法', kind: 'skill' as const }, { id: 'mcp', label: 'MCP', help: '查看连接与工具', kind: 'mcp' as const },
    ...(session.provider === 'codex' ? [{ id: 'plugins', label: '插件', help: '引用已安装插件', kind: 'plugin' as const }] : []),
    ...(trigger ? [{ id: 'plan', label: 'Plan', help: '切换规划模式', mode: 'plan' as const }, { id: 'agent', label: 'Agent', help: '切换执行模式', mode: 'default' as const }, ...(session.provider === 'cursor' ? [{ id: 'ask', label: 'Ask', help: '回答问题', mode: 'ask' as const }] : [])] : []),
    ...(trigger ? (catalog?.skills || []).filter(item => item.enabled).map(item => ({ id: item.invocation, label: item.name, help: item.description, item })) : []),
  ].filter(item => item.id.toLowerCase().includes(query.toLowerCase()));
  const count = menu === 'command' ? commands.length : options.length;
  const chooseCommand = async (item: typeof commands[number]) => {
    if (item.item) { pick(item.item); return; }
    if (item.mode) {
      try { await window.workbench.call('session.mode', { id: session.id, mode: item.mode === 'plan' && session.provider === 'codex' && session.mode === 'plan' ? 'default' : item.mode }); consume(); close(); }
      catch (e: any) { setError(e.message || '模式切换失败，请重试。'); }
    } else if (item.kind) command(item.kind);
  };
  const chooseActive = () => { if (menu === 'command') { const item = commands[active]; if (item) void chooseCommand(item); } else { const item = options[active]; if (item) pick(item); } };
  useLayoutEffect(() => {
    const textarea = input(); if (!textarea) return;
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && mcp) { event.preventDefault(); event.stopImmediatePropagation(); setMcp(false); close(); return; }
      // Recognized slash commands are handled locally, never sent as a model task.
      const exact = /^\s*\/(skills|mcp|plugins|plan|agent|ask)\s*$/i.exec(textarea.value);
      if (event.key === 'Enter' && !event.shiftKey && exact && ['plan', 'agent', 'ask'].includes(exact[1].toLowerCase())) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) void chooseCommand({ id: exact[1], label: '', help: '', mode: exact[1].toLowerCase() === 'plan' ? 'plan' : exact[1].toLowerCase() === 'ask' ? 'ask' : 'default' }); return; }
      if (event.key === 'Enter' && !event.shiftKey && exact) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) command(exact[1].toLowerCase() === 'skills' ? 'skill' : exact[1].toLowerCase() === 'plugins' ? 'plugin' : 'mcp'); return; }
      if (event.key === 'Escape' && (menu || composerTrigger(textarea.value, textarea.selectionStart, session.provider === 'cursor' ? 'cursor' : 'codex'))) { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
      if (!menu || dismissed.current === textarea.value) return;
      if (!loading && !count && catalog && !error && !(menu === 'plugin' ? catalog.pluginError : catalog.skillError)) {
        if (event.key === 'Enter' || event.key === 'Tab') close();
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') close();
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setActive(index => count ? (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count : 0);
        else if (!event.repeat) chooseActive();
      }
    };
    textarea.addEventListener('keydown', key, true); textarea.addEventListener('select', syncTrigger); textarea.addEventListener('click', syncTrigger);
    return () => { textarea.removeEventListener('keydown', key, true); textarea.removeEventListener('select', syncTrigger); textarea.removeEventListener('click', syncTrigger); };
  });
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && (event.target !== input() || !trigger)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); plus.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu, trigger]);
  useEffect(() => { if (active >= count) setActive(0); }, [count, active]);
  useEffect(() => { root.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active, count, menu]);
  return <div className="composer-capabilities composer-codex-tools" ref={root}>
    <button className="icon composer-plus" ref={plus} aria-label="添加内容或工具" title={session.provider === 'cursor' ? '添加内容（/ Skill，@ 引用）' : '添加内容（/ 命令，$ Skill）'} aria-expanded={!!menu} aria-haspopup="dialog" onClick={() => { if (menu) close(); else { dismissed.current = undefined; setTrigger(undefined); setQuery(''); setMenu('command'); } }}><Plus size={19}/></button>
    {menu && <section className="composer-popover codex-tools-popover" role="dialog" aria-label={menu === 'command' ? '添加内容或工具' : menu === 'skill' ? '选择 Skill' : '选择插件'}>
      <header><strong>{menu === 'command' ? '添加内容或工具' : menu === 'skill' ? 'Skills' : '插件'}</strong><span className="spacer"/>{menu !== 'command' && <button className="icon" title="刷新选项" disabled={loading} onClick={() => void refresh(menu, true)}><RefreshCw size={13} className={loading ? 'spin' : ''}/></button>}<button className="icon" aria-label="关闭选项" onClick={() => { close(); input()?.focus(); }}><X size={14}/></button></header>
      {!trigger && menu !== 'command' && <label className="capability-search"><Search size={13}/><input aria-label={menu === 'skill' ? '搜索 Skill' : '搜索插件'} autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.key === 'Enter') chooseActive(); else setActive(index => count ? (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count : 0); } }} placeholder="搜索"/></label>}
      <div className="composer-options">
        {menu === 'command' ? <>
          {!trigger && <div className="composer-extra-actions">{attach && <button className="setting-option" onClick={() => { close(); attach(); }}>添加本地参考文件</button>}<button className="setting-option" disabled={!session.binding} onClick={() => { close(); setMaterials(true); }}>引用项目成果</button>{handoff && <button className="setting-option" onClick={() => { close(); handoff(); }}>引用会话摘要 <small>Beta</small></button>}</div>}
          {error && <p role="alert" className="inline-error">{error}</p>}{trigger && loading && <p role="status" className="muted small">读取命令…</p>}
          <div role="listbox" aria-label="输入框命令">{commands.map((item, index) => <button className={'setting-option ' + (active === index ? 'keyboard-active' : '')} role="option" aria-selected={active === index} key={item.id + (item.item ? '-skill' : '')} onClick={() => void chooseCommand(item)}><span>{item.label}<small>{item.help}</small></span><code>/{item.id}</code></button>)}</div>
        </> : <>
          {loading && <p className="muted small" role="status">读取中…</p>}{(error || (menu === 'skill' ? catalog?.skillError : catalog?.pluginError)) && <p className="inline-error" role="alert">{error || (menu === 'skill' ? catalog?.skillError : catalog?.pluginError)}</p>}
          {!loading && !options.length && <p className="muted small">{menu === 'skill' ? '没有匹配的 Skill。' : '没有匹配的插件。'}</p>}
          <div role="listbox" aria-label={menu === 'skill' ? '可用 Skills' : '可用插件'}>{options.map((item, index) => <button className={'setting-option ' + (active === index ? 'keyboard-active' : '')} key={item.id} role="option" aria-selected={active === index} disabled={!item.enabled} title={item.unavailableReason} onClick={() => pick(item)}><span>{item.name}<small>{[item.description, item.source].filter(Boolean).join(' · ')}</small></span>{selected.some(value => value.id === item.id) && <Check size={14}/>}</button>)}</div>
        </>}
      </div>
    </section>}
    {mcp && <McpPanel session={session} close={() => { setMcp(false); input()?.focus(); }} openSettings={openSettings ? () => { setMcp(false); openSettings(); } : undefined}/>}
    {materials && <SessionMaterials session={session} changed={changed || (async () => {})} opened close={() => setMaterials(false)}/>}
  </div>;
}
