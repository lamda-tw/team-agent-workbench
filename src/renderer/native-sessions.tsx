import React, { useEffect, useState } from 'react';
import type { AgentSession } from '../shared/types';
import type { NativeSessionCatalog, NativeSessionEntry } from '../shared/native-sessions';

const providerLabel = (provider: 'codex' | 'cursor') => provider === 'codex' ? 'Codex' : 'Cursor';

export function orderedNativeSessions(catalog: NativeSessionCatalog) {
  const groups = [...catalog.groups].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, 'zh-CN'));
  const byGroup = new Map<string, NativeSessionEntry[]>();
  const ungrouped: NativeSessionEntry[] = [];
  for (const session of catalog.sessions) {
    if (!session.groupId || !groups.some(group => group.id === session.groupId)) { ungrouped.push(session); continue; }
    const list = byGroup.get(session.groupId) || []; list.push(session); byGroup.set(session.groupId, list);
  }
  const sortSessions = (items: NativeSessionEntry[]) => [...items].sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name, 'zh-CN'));
  return { groups: groups.filter(group => byGroup.has(group.id)), grouped: byGroup, ungrouped: sortSessions(ungrouped), sortSessions };
}

export function firstSelectableNativeSession(catalog: NativeSessionCatalog) {
  const ordered = orderedNativeSessions(catalog);
  const visible = [...ordered.groups.flatMap(group => ordered.sortSessions(ordered.grouped.get(group.id) || [])), ...ordered.ungrouped];
  return visible.find(session => !session.unavailable);
}

export function nextNativeSelection(selected: string[], nativeId: string, available: boolean) {
  if (!available) return selected;
  return selected.includes(nativeId) ? selected.filter(id => id !== nativeId) : [...selected, nativeId];
}

export function nextNativeGroupSelection(selected: string[], nativeIds: string[]) {
  const available = [...new Set(nativeIds)];
  if (!available.length) return selected;
  const all = available.every(id => selected.includes(id));
  return all ? selected.filter(id => !available.includes(id)) : [...new Set([...selected, ...available])];
}

export function NativeSessionBrowser({ catalog, selectedIds, onChange }: { catalog: NativeSessionCatalog; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const { groups, grouped, ungrouped, sortSessions } = orderedNativeSessions(catalog);
  const chosen = (id: string) => selectedIds.includes(id);
  const row = (session: NativeSessionEntry) => {
    const when = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN') : '时间未知';
    const detail = session.unavailable || (session.linkedSessionId ? '已在工作台' : '可导入');
    const selected = !session.unavailable && chosen(session.nativeId);
    return <button type="button" key={session.nativeId} className={'native-session-row' + (selected ? ' selected' : '')} role="checkbox" aria-checked={selected} disabled={!!session.unavailable} title={session.unavailable} onClick={() => onChange(nextNativeSelection(selectedIds, session.nativeId, !session.unavailable))}><span className="native-session-check" aria-hidden="true">{selected ? '✓' : ''}</span><span className="native-session-copy"><b>{session.name}</b><small>{detail} · {when}</small></span></button>;
  };
  const heading = (name: string, items: NativeSessionEntry[]) => {
    const ids = items.filter(session => !session.unavailable).map(session => session.nativeId);
    const all = ids.length > 0 && ids.every(chosen);
    return <h3><button type="button" className="native-session-group-toggle" disabled={!ids.length} aria-pressed={all} onClick={() => onChange(nextNativeGroupSelection(selectedIds, ids))}>{all ? '取消本组' : '全选本组'}</button><span title={name}>{name}</span></h3>;
  };
  return <div className="native-session-list" aria-label={providerLabel(catalog.provider) + ' 会话'}>{groups.map(group => { const items = sortSessions(grouped.get(group.id) || []); return <section key={group.id} className="native-session-group">{heading(group.name, items)}{items.map(row)}</section>; })}{ungrouped.map(row)}</div>;
}

export function NativeSessionPicker({ provider, projectId, close, linked }: { provider: 'codex' | 'cursor'; projectId: string; close: () => void; linked: (sessions: AgentSession[]) => void }) {
  const [catalog, setCatalog] = useState<NativeSessionCatalog>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setLoading(true); setError('');
    try {
      const value = await window.workbench.call<NativeSessionCatalog>('session.native.list', { provider });
      if (value.provider !== provider) throw new Error(provider === 'codex' ? '读到的不是 Codex 会话' : '读到的不是 Cursor 会话');
      setCatalog(value);
      setSelectedIds(current => current.filter(id => value.sessions.some(session => session.nativeId === id && !session.unavailable)));
    } catch (loadError: any) { setCatalog(undefined); setError(loadError.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [provider]);
  const selectable = catalog?.sessions.filter(session => !session.unavailable) || [];
  const chosen = selectable.filter(session => selectedIds.includes(session.nativeId)).sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name, 'zh-CN'));
  const allSelected = selectable.length > 0 && selectable.every(session => selectedIds.includes(session.nativeId));
  const title = provider === 'codex' ? '接入 Codex 会话' : '接入 Cursor 会话';
  const explanation = provider === 'codex' ? '这里只列出 Codex 自己的项目组和会话名。可以勾选多条，一次导入。导入后，工作台和这些 Codex 会话是同一条。' : '这里只列出 Cursor 自己的工作目录和会话名。可以勾选多条，一次导入。导入后，工作台和这些 Cursor 会话是同一条。';
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="native-session-title"><header><h2 id="native-session-title">{title}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header><div className="modal-body"><p className="agent-notes-explanation">{explanation}</p>{error && <div className="inline-error" role="alert">{error}</div>}{loading ? <p className="muted">正在读取会话。</p> : catalog && !catalog.sessions.length ? <p className="muted">没有读到{providerLabel(provider)}会话。</p> : catalog ? <><div className="native-session-toolbar"><button type="button" className="text-button" disabled={busy || !selectable.length} onClick={() => setSelectedIds(allSelected ? [] : selectable.map(session => session.nativeId))}>{allSelected ? '取消全选' : '全选可导入'}</button><span className="muted small">已选 {chosen.length} 条</span></div><NativeSessionBrowser catalog={catalog} selectedIds={selectedIds} onChange={setSelectedIds}/></> : null}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="secondary" disabled={loading || busy} onClick={() => void load()}>刷新</button><button className="primary" disabled={!chosen.length || busy || loading} onClick={() => void (async () => { if (!chosen.length) return; setBusy(true); setError(''); try { linked(await window.workbench.call<AgentSession[]>('session.native.linkMany', { provider, nativeIds: chosen.map(session => session.nativeId), projectId })); } catch (linkError: any) { setError(linkError.message); } finally { setBusy(false); } })()}>{busy ? '正在导入…' : chosen.length ? `导入 ${chosen.length} 条` : '导入所选'}</button></footer></section></div>;
}
