import { cursorSharedSessionUnavailable } from '../shared/cursor-session-consistency';
import React, { useEffect, useState } from 'react';
import type { AgentSession } from '../shared/types';
import { canImportNativeSession, type NativeSessionCatalog, type NativeSessionEntry } from '../shared/native-sessions';

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
  return visible.find(canImportNativeSession);
}

export function nativeSessionsInGroup(catalog: NativeSessionCatalog, groupId = '') {
  const known = new Set(catalog.groups.map(group => group.id));
  return catalog.sessions.filter(session => !groupId || (groupId === '__ungrouped__' ? !session.groupId || !known.has(session.groupId) : session.groupId === groupId));
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

export function NativeSessionBrowser({ catalog, selectedIds, onChange, groupId = '', busy = false }: { catalog: NativeSessionCatalog; selectedIds: string[]; onChange: (ids: string[]) => void; groupId?: string; busy?: boolean }) {
  const { groups, grouped, ungrouped, sortSessions } = orderedNativeSessions({ ...catalog, sessions: nativeSessionsInGroup(catalog, groupId) });
  const chosen = (id: string) => selectedIds.includes(id);
  const row = (session: NativeSessionEntry) => {
    const when = session.updatedAt ? new Date(session.updatedAt).toLocaleString('zh-CN') : '时间未知';
    const detail = session.linkedSessionId ? '已在工作台' : session.unavailable || '可导入';
    const available = canImportNativeSession(session), selected = available && chosen(session.nativeId);
    return <button type="button" key={session.nativeId} className={'native-session-row' + (selected ? ' selected' : '') + (session.linkedSessionId ? ' linked' : '')} role="checkbox" aria-checked={selected} disabled={busy || !available} title={available ? session.cwd : detail} onClick={() => onChange(nextNativeSelection(selectedIds, session.nativeId, available))}><span className="native-session-check" aria-hidden="true">{selected ? '✓' : ''}</span><span className="native-session-copy"><b>{session.name}</b><small>{detail} · {when}</small></span></button>;
  };
  const heading = (name: string, items: NativeSessionEntry[]) => {
    const ids = items.filter(canImportNativeSession).map(session => session.nativeId);
    const all = ids.length > 0 && ids.every(chosen);
    return <h3><button type="button" className="native-session-group-toggle" disabled={busy || !ids.length} aria-pressed={all} onClick={() => onChange(nextNativeGroupSelection(selectedIds, ids))}>{all ? '取消本组' : '全选本组'}</button><span title={name}>{name}</span><small>{items.length} 条</small></h3>;
  };
  return <div className="native-session-list" aria-label={providerLabel(catalog.provider) + ' 会话'}>{groups.map(group => { const items = sortSessions(grouped.get(group.id) || []); return <section key={group.id} className="native-session-group">{heading(group.name, items)}{items.map(row)}</section>; })}{ungrouped.map(row)}</div>;
}

export function NativeSessionPicker({ provider, projectId, cursorDesktopBeta = false, directory = '', close, linked }: { cursorDesktopBeta?: boolean; directory?: string; provider: 'codex' | 'cursor'; projectId: string; close: () => void; linked: (sessions: AgentSession[]) => void }) {
  const [catalog, setCatalog] = useState<NativeSessionCatalog>();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [nativeDesktop,setNativeDesktop] = useState(provider==='cursor'&&cursorDesktopBeta);
  const load = async () => {
    setLoading(true); setError('');
    try {
      const value = await window.workbench.call<NativeSessionCatalog>(nativeDesktop?'session.cursorDesktop.list':'session.native.list', nativeDesktop?{cwd:directory,launch:false}:{ provider });
      if (value.provider !== provider) throw new Error(provider === 'codex' ? '读到的不是 Codex 会话' : '读到的不是 Cursor 会话');
      setCatalog(value);
      setSelectedIds(current => current.filter(id => value.sessions.some(session => session.nativeId === id && canImportNativeSession(session))));
      setGroupId(current => current === '__ungrouped__' || value.groups.some(group => group.id === current) ? current : '');
    } catch (loadError: any) { setCatalog(undefined); setError(nativeDesktop ? loadError.message.replace('点击“在 Cursor 中打开”重新连接', '点击上方“打开 Cursor 并读取会话”建立连接') : loadError.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { setSelectedIds([]);void load(); }, [provider,nativeDesktop,directory,projectId]);
  const selectable = catalog ? nativeSessionsInGroup(catalog, groupId).filter(canImportNativeSession) : [];
  const chosen = (catalog?.sessions || []).filter(session => canImportNativeSession(session) && selectedIds.includes(session.nativeId)).sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name, 'zh-CN'));
  const allSelected = selectable.length > 0 && selectable.every(session => selectedIds.includes(session.nativeId));
  const title = provider === 'codex' ? '接入 Codex 会话' : '接入 Cursor 会话';
  const explanation = provider === 'codex' ? '按 Codex 项目查看，可以勾选多条，一次导入。已在工作台的会话不能重复导入。' : nativeDesktop ? '关联普通 IDE 当前显示的 Cursor 会话，两端共用原生上下文。切换后，可用“在 Cursor 中打开”回到已打开的标签页。模型、模式和权限双向同步；工具及授权在 Cursor 中处理。' : '导入已有 Cursor CLI 会话。CLI 会话与原生窗口中的聊天独立。';
  const groups = catalog ? orderedNativeSessions(catalog).groups : [];
  const groupButton = (id: string, name: string, count: number) => <button type="button" key={id} aria-pressed={groupId === id} className={groupId === id ? 'selected' : ''} disabled={busy} onClick={() => setGroupId(id)}><span title={name}>{name}</span><small>{count}</small></button>;
  return <div className="modal-backdrop"><section className="modal wide native-session-modal" role="dialog" aria-modal="true" aria-labelledby="native-session-title"><header><h2 id="native-session-title">{title}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}>×</button></header>
    <div className="modal-body">{provider === 'cursor' && cursorDesktopBeta && <div className="row"><button className={nativeDesktop?'primary':'secondary'} disabled={busy||loading} onClick={()=>setNativeDesktop(true)}>原生会话 · Beta</button><button className={!nativeDesktop?'primary':'secondary'} disabled={busy || loading} onClick={()=>setNativeDesktop(false)}>CLI 会话</button></div>}<p className="agent-notes-explanation">{explanation}</p>{nativeDesktop&&<button className="secondary" disabled={busy||loading||!directory} onClick={()=>void(async()=>{setLoading(true);setError('');try{await window.workbench.call('session.cursorDesktop.list',{cwd:directory,launch:true});await load();}catch(e:any){setError(e.message);}finally{setLoading(false);}})()}>打开 Cursor 并读取会话</button>}{error && <div className="inline-error" role="alert">{error}</div>}
      {loading ? <p className="muted">正在读取会话…</p> : catalog && !catalog.sessions.length ? <p className="muted">{nativeDesktop ? '请在 Cursor 普通 IDE 中打开要关联的聊天，再点击“刷新”。' : `没有读到${providerLabel(provider)}会话。`}</p> : catalog && <div className="native-session-layout">
        <nav className="native-project-nav" aria-label={provider === 'codex' ? 'Codex 项目' : 'Cursor 工作目录'}>
          {groupButton('', '全部会话', catalog.sessions.length)}
          {groups.map(group => groupButton(group.id, group.name, nativeSessionsInGroup(catalog, group.id).length))}
          {nativeSessionsInGroup(catalog, '__ungrouped__').length > 0 && groupButton('__ungrouped__', '其他会话', nativeSessionsInGroup(catalog, '__ungrouped__').length)}
        </nav><div className="native-session-main"><div className="native-session-toolbar"><button type="button" className="text-button" disabled={busy || !selectable.length} onClick={() => setSelectedIds(nextNativeGroupSelection(selectedIds, selectable.map(session => session.nativeId)))}>{allSelected ? '取消当前列表选择' : '全选当前列表'}</button><span className="muted small">已选 {chosen.length} 条</span></div>
          <NativeSessionBrowser catalog={catalog} selectedIds={selectedIds} onChange={setSelectedIds} groupId={groupId} busy={busy}/>
        </div>
      </div>}
    </div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="secondary" disabled={loading || busy} onClick={() => void load()}>刷新</button><button className="primary" disabled={!chosen.length || busy || loading} onClick={() => void (async () => {
      if (!chosen.length) return; setBusy(true); setError('');
      try { linked(await window.workbench.call<AgentSession[]>(nativeDesktop?'session.cursorDesktop.linkMany':'session.native.linkMany', { provider, nativeIds: chosen.map(session => session.nativeId), projectId })); }
      catch (linkError: any) { await load(); setError(linkError.message); }
      finally { setBusy(false); }
    })()}>{busy ? '正在导入…' : chosen.length ? `导入 ${chosen.length} 条` : '导入所选'}</button></footer>
  </section></div>;
}
