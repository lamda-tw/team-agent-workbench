import React, { useState } from 'react';
import { Server } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';
import type { WorkspaceAccess } from '../shared/types';

export function LocalProjectConnection({ projectId, profile, groups, configure, linked }: { projectId: string; profile?: ConnectionProfile; groups: WorkspaceAccess[]; configure: () => void; linked: () => Promise<void> }) {
  const [groupName, setGroupName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="modal-body"><p>项目已保存在本机，可离线使用。关联中央节点和工作组后，项目资料与账号成果将在后台自动同步；会话全文保留在本机。</p>
    {profile && <><p>{profile.host}:{profile.port} · {profile.username}</p><label className="field">同步到工作组<select value={groupName} onChange={event => setGroupName(event.target.value)}><option value="">请选择</option>{groups.map(group => <option key={group.groupName} value={group.groupName}>{group.groupLabel || group.groupName}</option>)}</select></label><button className="primary" disabled={busy || !groupName} onClick={async () => { setBusy(true); setError(''); try { await window.workbench.call('project.link', { projectId, groupName }); await linked(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } }}>{busy ? '正在关联…' : '关联并自动同步'}</button></>}
    <button className="secondary" disabled={busy} onClick={configure}>{profile ? '连接其他中央节点' : '关联中央节点'}</button>{error && <p className="inline-error">{error}</p>}
  </section>;
}

export function ProjectCentralConnection({ profile, connected, configure }: { profile: ConnectionProfile; connected: boolean; configure: () => void }) {
  return <section className="modal-body" aria-label="项目中央节点"><div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><span className={connected ? 'green small' : 'muted small'}>{connected ? '已连接' : '未连接'}</span></div><p>成员账号：{profile.username}</p><button className="secondary" onClick={configure}>{connected ? '查看连接' : '连接中央节点'}</button></section>;
}
