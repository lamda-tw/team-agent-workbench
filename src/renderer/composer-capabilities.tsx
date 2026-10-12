import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Puzzle, RefreshCw, Search, X } from 'lucide-react';
import type { AgentCapabilityCatalog, AgentCapabilityKind, AgentCapabilityOption, AgentCapabilitySelection, AgentSession } from '../shared/types';
import { CodexComposerTools, type ComposerToolProps } from './composer-codex-tools';

export function ComposerCapabilities(props: ComposerToolProps) {
  return props.session.provider === 'claude' ? <LegacyComposerCapabilities {...props}/> : <CodexComposerTools {...props}/>;
}
function LegacyComposerCapabilities({ session, selected, change }: { session: AgentSession; selected: AgentCapabilitySelection[]; change: (items: AgentCapabilitySelection[]) => void }) {
  const [open, setOpen] = useState(false), [catalog, setCatalog] = useState<AgentCapabilityCatalog>(), [loadingKinds, setLoadingKinds] = useState<AgentCapabilityKind[]>([]), [query, setQuery] = useState('');
  const loading = loadingKinds.length > 0;
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), sequence = useRef(0);
  const close = () => { setOpen(false); setQuery(''); };
  const refresh = async (forceRefresh = false) => {
    const n = ++sequence.current; setLoadingKinds(['skill', 'plugin']);
    await Promise.all((['skill', 'plugin'] as const).map(async kind => {
      try {
        const result = await window.workbench.call<AgentCapabilityCatalog>('session.capabilities', { id: session.id, forceRefresh, kind });
        if (n === sequence.current) setCatalog(previous => ({ provider: session.provider, skills: [], plugins: [], checkedAt: result.checkedAt, ...previous,
          ...(kind === 'skill' ? { skills: result.skills, skillError: result.skillError } : { plugins: result.plugins, pluginError: result.pluginError }) }));
      } catch {
        if (n === sequence.current) setCatalog(previous => ({ provider: session.provider, skills: [], plugins: [], checkedAt: '', ...previous,
          ...(kind === 'skill' ? { skillError: 'Skill 列表读取失败，可刷新重试。' } : { pluginError: '插件列表读取失败，可刷新重试。' }) }));
      } finally { if (n === sequence.current) setLoadingKinds(values => values.filter(value => value !== kind)); }
    }));
  };
  useEffect(() => { setCatalog(undefined); }, [session.id, session.cwd, session.networkRoute, session.provider]);
  useEffect(() => { if (open) void refresh(); return () => { sequence.current++; }; }, [open, session.id, session.cwd, session.networkRoute, session.provider]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); button.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const toggle = (item: AgentCapabilityOption) => {
    if (!item.enabled) return;
    if (selected.some(value => value.id === item.id)) { change(selected.filter(value => value.id !== item.id)); return; }
    const next = { id: item.id, kind: item.kind, name: item.name };
    // Cursor's native slash-command surface invokes one Skill per message.
    change(session.provider === 'cursor' && item.kind === 'skill' ? [...selected.filter(value => value.kind !== 'skill'), next] : [...selected, next]);
  };
  const matches = (item: AgentCapabilityOption) => !query.trim() || `${item.name} ${item.description} ${item.source || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const skills = (catalog?.skills || []).filter(matches), plugins = (catalog?.plugins || []).filter(matches);
  return <div className="composer-capabilities" ref={root}>
    <button ref={button} className="composer-setting" aria-label="选择 Skill 和插件" aria-expanded={open} aria-haspopup="dialog" title="为下一条消息选择 Skill 或插件" onClick={() => { setOpen(!open); setQuery(''); }}><Puzzle size={13}/><span>{selected.length ? `能力 ${selected.length}` : 'Skill / 插件'}</span><ChevronDown size={12}/></button>
    {open && <section className="composer-popover capability-popover" role="dialog" aria-label="Skill 与插件">
      <header><strong>Skill 与插件</strong><span className="spacer"/><button className="icon" title="刷新选项" disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={13} className={loading ? 'spin' : ''}/></button><button className="icon" title="关闭选项" onClick={close}><X size={14}/></button></header>
      <div className="composer-options">
        <p className="capability-help">选择项只用于下一条消息。{session.provider === 'codex' ? 'Codex 按原生 $Skill / @插件提及调用。' : session.provider === 'claude' ? 'Claude Code Skill 按原生 / 命令调用；已安装插件由 CLI 加载。' : 'Cursor Skill 按原生 / 命令调用；插件工具由 CLI 配置加载。'}</p>
        <label className="capability-search"><Search size={13}/><input aria-label="搜索 Skill 和插件" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)}/></label>
        {catalog?.skillError && <p className="inline-error" role="alert">{catalog.skillError}</p>}
        <CapabilitySection title={session.provider === 'cursor' ? 'Skills / 命令' : 'Skills'} label="可用 Skills" items={skills} selected={selected} loading={loadingKinds.includes('skill')} empty="没有匹配的 Skill。" toggle={toggle}/>
        {catalog?.pluginError && <p className="inline-error" role="alert">{catalog.pluginError}</p>}
        <CapabilitySection title={session.provider === 'cursor' ? '插件工具（MCP）' : '已安装插件'} label="可用插件" items={plugins} selected={selected} loading={loadingKinds.includes('plugin')} empty="没有可选择的插件工具。" toggle={toggle}/>
      </div>
    </section>}
  </div>;
}

function CapabilitySection({ title, label, items, selected, loading, empty, toggle }: { title: string; label: string; items: AgentCapabilityOption[]; selected: AgentCapabilitySelection[]; loading: boolean; empty: string; toggle: (item: AgentCapabilityOption) => void }) {
  return <div className="capability-section"><b>{title}</b>{loading && <p className="muted small" role="status">读取{title}中…</p>}{!loading && !items.length && <p className="muted small">{empty}</p>}<div role="group" aria-label={label}>{items.map(item => <button key={item.id} className="setting-option" aria-pressed={selected.some(value => value.id === item.id)} disabled={!item.enabled} title={item.unavailableReason} onClick={() => toggle(item)}><span>{item.name}<small>{[item.description, item.source].filter(Boolean).join(' · ')}</small></span>{selected.some(value => value.id === item.id) && <Check size={14}/>}</button>)}</div></div>;
}
