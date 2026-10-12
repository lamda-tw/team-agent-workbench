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

export function NativeSessionBrowser({ catalog, selectedId, onSelect }: { catalog: NativeSessionCatalog; selectedId: string; onSelect: (id: string) => void }) {
  const { groups, grouped, ungrouped, sortSessions } = orderedNativeSessions(catalog);
  const row = (session: NativeSessionEntry) => <button type="button" key={session.nativeId} disabled={!!session.unavailable} className={!session.unavailable && session.nativeId === selectedId ? 'selected' : ''} title={session.unavailable} onClick={() => { if (!session.unavailable) onSelect(session.nativeId); }}><b>{session.name}</b><small>{session.unavailable || (session.linkedSessionId ? '已在工作台' : '可关联')} · {session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN') : '时间未知'}</small></button>;
  return <div className="native-session-list" aria-label={providerLabel(catalog.provider) + ' 会话'}>{groups.map(group => <section key={group.id} className="native-session-group"><h3 title={group.name}>{group.name}</h3>{sortSessions(grouped.get(group.id) || []).map(row)}</section>)}{ungrouped.map(row)}</div>;
}

export function NativeSessionPicker({ provider, projectId, close, linked }: { provider: 'codex' | 'cursor'; projectId: string; close: () => void; linked: (session: AgentSession) => void }) {
  const [catalog, setCatalog] = useState<NativeSessionCatalog>();
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setLoading(true); setError('');
    try {
      const value = await window.workbench.call<NativeSessionCatalog>('session.native.list', { provider });
      if (value.provider !== provider) throw new Error(provider === 'codex' ? '读到的不是 Codex 会话' : '读到的不是 Cursor 会话');
      setCatalog(value);
      const first = firstSelectableNativeSession(value);
      setSelectedId(current => value.sessions.some(session => session.nativeId === current && !session.unavailable) ? current : first?.nativeId || '');
    } catch (loadError: any) { setCatalog(undefined); setError(loadError.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [provider]);
  const selected = catalog?.sessions.find(session => session.nativeId === selectedId && !session.unavailable);
  const title = provider === 'codex' ? '接入 Codex 会话' : '接入 Cursor 会话';
  const explanation = provider === 'codex' ? '这里只列出 Codex 自己的项目组和会话名。选中后，工作台和这条 Codex 会话是同一条。' : '这里只列出 Cursor 自己的工作目录和会话名。选中后，工作台和这条 Cursor 会话是同一条。';
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="native-session-title"><header><h2 id="native-session-title">{title}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header><div className="modal-body"><p className="agent-notes-explanation">{explanation}</p>{error && <div className="inline-error" role="alert">{error}</div>}{loading ? <p className="muted">正在读取会话。</p> : catalog && !catalog.sessions.length ? <p className="muted">没有读到{providerLabel(provider)}会话。</p> : catalog ? <NativeSessionBrowser catalog={catalog} selectedId={selectedId} onSelect={setSelectedId}/> : null}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="secondary" disabled={loading || busy} onClick={() => void load()}>刷新</button><button className="primary" disabled={!selected || busy || loading} onClick={() => void (async () => { if (!selected) return; setBusy(true); setError(''); try { linked(await window.workbench.call<AgentSession>('session.native.link', { provider, nativeId: selected.nativeId, projectId })); } catch (linkError: any) { setError(linkError.message); } finally { setBusy(false); } })()}>{busy ? '正在接入…' : selected?.linkedSessionId ? '打开' : '在工作台继续'}</button></footer></section></div>;
}
