import React, { useEffect, useState } from 'react';
import { Folder, FolderPlus, Ellipsis, Pencil, ArrowRight, X, Layers, FolderInput, Trash2 } from 'lucide-react';
import type { AgentSession, Project } from '../shared/types';
import type { PersonalGroup } from '../shared/personal-workspace';
import './personal-workspace.css';

type Call = <T = unknown>(action: string, payload?: unknown) => Promise<T>;
export type MoveSelection = { sessionId?: string; groupId?: string; title: string; count: number };

export function PersonalSection({ groups, sessions, active, selected, select, move, call, changed }: {
  groups: PersonalGroup[]; sessions: AgentSession[]; active: boolean; selected: string;
  select: (id: string) => void; move: (selection: MoveSelection) => void; call: Call; changed: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ id?: string; name: string }>(), [removing, setRemoving] = useState<PersonalGroup>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const dismiss = (event: Event) => document.querySelectorAll<HTMLDetailsElement>('.personal-menu[open]').forEach(menu => { if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return; if (event.type === 'keydown' || !menu.contains(event.target as Node)) menu.open = false; });
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', dismiss); };
  }, []);
  const count = (id: string) => sessions.filter(session => (session.personalGroupId || '') === id).length;
  const close = () => { if (!busy) { setEditing(undefined); setRemoving(undefined); setError(''); } };
  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (removing) { await call('local.group.delete', { id: removing.id }); if (selected === removing.id) select(''); }
      else if (editing) { const group = await call<PersonalGroup>('local.group.save', editing); select(group.id); }
      await changed(); setEditing(undefined); setRemoving(undefined);
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  return <section className={'personal-section ' + (active ? 'is-active' : '')} aria-label="未分项目">
    <header><button className="personal-heading" onClick={() => select('*')}><Layers size={16}/><b>未分项目</b><span className="personal-count">{sessions.length}</span></button><button className="icon" aria-label="新建个人分组" title="新建个人分组" onClick={() => { setError(''); setEditing({ name: '' }); }}><FolderPlus size={15}/></button></header>
    <div className="personal-group-row"><button className={'personal-group ' + (active && selected === '' ? 'selected' : '')} onClick={() => select('')}><Folder size={14}/><span>未分组</span><small>{count('')}</small></button></div>
    {groups.map(group => <div className="personal-group-row" key={group.id}><button className={'personal-group ' + (active && selected === group.id ? 'selected' : '')} onClick={() => select(group.id)}><Folder size={14}/><span>{group.name}</span><small>{count(group.id)}</small></button><details className="personal-menu" onToggle={event => { const menu = event.currentTarget; if (!menu.open) return; const rect = menu.getBoundingClientRect(), popup = menu.querySelector('div')!; popup.style.top = Math.min(rect.bottom + 4, window.innerHeight - 140) + 'px'; popup.style.left = Math.max(8, rect.right - 205) + 'px'; }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}><summary role="button" aria-haspopup="menu" aria-label={'管理个人分组 ' + group.name} title="分组操作"><Ellipsis size={15}/></summary><div role="menu"><button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; setError(''); setEditing(group); }}><Pencil size={14}/>重命名</button><button role="menuitem" disabled={!count(group.id)} onClick={event => { event.currentTarget.closest('details')!.open = false; move({ groupId: group.id, title: group.name, count: count(group.id) }); }}><FolderInput size={14}/>整组迁移到项目</button><button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; setError(''); setRemoving(group); }}><Trash2 size={14}/>解散分组</button></div></details></div>)}
    {!sessions.length && !groups.length && <p className="personal-hint">本机会话保存在这里，可用个人分组整理。</p>}
    {(editing || removing) && <div className="modal-backdrop"><section className="modal personal-dialog"><header><h2>{removing ? '解散个人分组' : editing?.id ? '重命名个人分组' : '新建个人分组'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={18}/></button></header><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="modal-body">{removing ? <p>解散“{removing.name}”后，里面的会话会回到“未分组”，会话内容保留。</p> : <label className="field">分组名称<input aria-label="个人分组名称" autoFocus maxLength={60} value={editing?.name || ''} onChange={event => setEditing({ ...editing, name: event.target.value })} placeholder="例如：日常开发、资料研究"/></label>}{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !removing && !editing?.name.trim()}>{busy ? '正在保存…' : removing ? '解散分组' : '保存分组'}</button></footer></form></section></div>}
  </section>;
}

export function SessionOrganization({ session, groups, close, move, call, changed }: { session: AgentSession; groups: PersonalGroup[]; close: () => void; move: (selection: MoveSelection) => void; call: Call; changed: () => Promise<void> }) {
  const [groupId, setGroupId] = useState(session.personalGroupId || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <div className="modal-backdrop"><section className="modal personal-dialog"><header><h2>管理会话归属</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={18}/></button></header><div className="modal-body"><p className="muted small">{session.title}</p><label className="field">个人分组<select aria-label="会话个人分组" value={groupId} onChange={event => setGroupId(event.target.value)}><option value="">未分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><button className="personal-move-link" disabled={busy} onClick={() => move({ sessionId: session.id, title: session.title, count: 1 })}><FolderInput size={17}/><span>迁移到项目<small>保留完整会话，迁移后从未分项目移除</small></span><ArrowRight size={15}/></button>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || groupId === (session.personalGroupId || '')} onClick={async () => { setBusy(true); try { await call('local.session.group', { id: session.id, groupId: groupId || undefined }); await changed(); close(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>保存分组</button></footer></section></div>;
}

export function PersonalMoveDialog({ selection, projects, connected, connect, call, close, moved }: {
  selection: MoveSelection; projects: Project[]; connected: boolean; connect: () => void; call: Call; close: () => void;
  moved: (result: { count: number; projectId: string; sessionId: string }) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const groups = [...new Set(projects.map(project => project.groupName || ''))];
  return <div className="modal-backdrop"><section className="modal personal-dialog"><header><h2>{selection.groupId ? '整组迁移到项目' : '迁移到项目'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={18}/></button></header><div className="modal-body"><div className="personal-move-summary"><FolderInput size={23}/><div><b>{selection.title}</b><small>{selection.count} 条工作会话{selection.sessionId && selection.count > 1 ? '（包含关联父子会话）' : ''} · 历史、摘要、整理草稿和成果引用一起保留</small></div></div><label className="field">目标项目<select aria-label="迁移目标项目" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">请选择目标项目</option>{groups.map(group => <optgroup key={group} label={projects.find(project => project.groupName === group)?.groupLabel || '本机项目'}>{projects.filter(project => (project.groupName || '') === group).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</optgroup>)}</select>{!projects.length && <small>暂无可迁入的项目，可先在本机创建项目。</small>}</label><p className="muted small">迁移完成后，原位置的会话{selection.groupId ? '和个人分组' : ''}会移除。工作目录、AI 和网络方式保持原样；聊天记录继续保存在本机。</p>{selection.groupId && <p className="muted small">会先检查整组会话；有任务或整理正在运行时，会提示你处理后再迁移。</p>}{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !projects.some(project => project.id === projectId)} onClick={async () => { setBusy(true); setError(''); try { const result = await call<{ count: number; projectId: string; sessionId: string }>('local.move', { sessionId: selection.sessionId, groupId: selection.groupId, projectId }); await moved(result); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>{busy ? '正在整体迁移…' : `迁移 ${selection.count} 条会话`}</button></footer></section></div>;
}
