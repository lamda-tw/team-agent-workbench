import React, { useRef, useState } from 'react';
import type { AdminSnapshot, AdminState, ManagedUser } from './types';
import { existingLinuxAccountCollision } from './member-recovery';

export function useMemberRequestId() {
  const requests = useRef(new Map<string, { body: string; id: string }>());
  return (command: unknown, target = '') => {
    const body = JSON.stringify(command), previous = requests.current.get(target);
    if (previous?.body === body) return previous.id;
    const id = crypto.randomUUID(); requests.current.set(target, { body, id }); return id;
  };
}
export function MemberSyncStatus({ snapshot, refresh }: { snapshot: AdminSnapshot; refresh: () => Promise<void> }) {
  const [error, setError] = useState('');
  const sync = snapshot.memberSync;
  if (!sync?.teamId) return null;
  const pending = sync.pending.filter(item => !existingLinuxAccountCollision(item.error));
  return <section aria-label="成员同步状态">
    <p className="muted small">{snapshot.connected ? '成员自动同步' : '离线查看 · 新成员联网后开通'} · 团队 {sync.teamId.slice(0, 8)}{sync.lastSyncedAt && ` · 上次同步 ${new Date(sync.lastSyncedAt).toLocaleTimeString()}`}</p>
    {sync.error && <p className="inline-error" role="status">成员同步暂未完成：{sync.error}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!!pending.length && <div className="admin-table-card"><header><h3>待开通成员 · {pending.length}</h3></header>{pending.map(item => <div className="callout" key={item.id}><div><b>{item.command.name}（{item.command.username}）</b><small>{item.status === 'blocked' ? '需要处理' : '待开通 · 连接中央节点后自动提交'}</small>{item.error && <small>{item.error}</small>}</div><button className="secondary compact" disabled={snapshot.busy} onClick={() => { setError(''); void window.admin.call('members.removePending', item.id).then(refresh).catch(reason => setError(reason.message)); }}>移除待办</button></div>)}<p className="muted small">移除待办会停止本机后续提交；若服务器已完成开通，已有账号会保留。</p></div>}
  </section>;
}
export function MemberConflict({ baseline, current, state, confirm, busy }: { baseline?: ManagedUser; current?: ManagedUser; state?: AdminState; confirm: () => void; busy: boolean }) {
  if (baseline?.revision === 'absent' && !current) return null;
  if (!baseline?.revision || baseline.revision === current?.revision) return null;
  const describe = (user: ManagedUser) => `${user.enabled ? '已启用' : '已停用'}；所属组：${(user.groups || []).filter(name => state?.groups[name]).map(name => (state?.groups[name].label || name) + (user.contentAdminGroups?.includes(name) ? '（管理者）' : '')).join('、') || '无'}`;
  return <div className="callout" role="alert"><div><b>成员状态已更新</b><small>打开时：{describe(baseline)}</small><small>现在：{current ? describe(current) : '成员已不存在'}</small><small>密码或账号身份的变化也会触发此提示。你的输入已保留，确认后将以最新状态检查本次操作。</small><button className="secondary compact" disabled={busy || !current} onClick={confirm}>已查看变化，保留输入继续</button></div></div>;
}
