import React, { useEffect, useState } from 'react';
import { Server, X } from 'lucide-react';
import type { AdminSnapshot } from './types';
import { useMemberRequestId } from './member-sync-view';

type ExistingMember = { username: string; login: string; uid: number; marker: string; groups: string[]; contentAdminGroups: string[]; historicalGroups: string[]; unknownGroups: string[]; needsLoginGroup: boolean; identity: string };

export function ExistingMemberDialog({ snapshot, initialUsername, initialName, close, done }: { snapshot: AdminSnapshot; initialUsername?: string; initialName?: string; close: () => void; done: () => Promise<void> }) {
  const [username, setUsername] = useState(initialUsername || ''), [name, setName] = useState(initialName || ''), [password, setPassword] = useState('');
  const [found, setFound] = useState<ExistingMember>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestId = useMemberRequestId();
  const detect = async (candidate = username) => {
    setBusy(true); setError(''); setFound(undefined); setPassword('');
    try {
      const result = await window.admin.call<{ value: ExistingMember }>('operation', { op: 'user_import_probe', username: candidate.trim() });
      setFound(result.value);
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  useEffect(() => { if (initialUsername) void detect(initialUsername); }, []);
  const submit = async () => {
    if (!found || !password) return;
    setBusy(true); setError('');
    try {
      const command = { op: 'user_import', username: found.username, name: name.trim() || found.username, password, expectedIdentity: found.identity };
      await window.admin.call('members.apply', { command, requestId: requestId(command) });
      setPassword(''); await done();
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal"><header><h2>{initialUsername ? '恢复已有 Linux 账号' : '接入已有 Linux 账号'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={19}/></button></header><div className="modal-body">
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="admin-target"><Server size={16}/><span>{snapshot.profile?.username}@{snapshot.profile?.host} · {snapshot.profile?.root}</span></div>
    <p className="muted small">账号归属当前 Linux 系统，不受团队空间 ID 限制。仅接入本机 Workbench 专用账号：通过原密码验证并核对已有权限，不会重设密码；若属于旧空间，会添加当前空间的登录组，并核对实际 SFTP 目录。</p>
    <label className="field">Linux 登录账号<input aria-label="已有 Linux 登录账号" value={username} disabled={busy} onChange={event => { setUsername(event.target.value); setFound(undefined); setPassword(''); }} placeholder="例如 taowen"/></label>
    <button className="secondary" disabled={busy || !username.trim()} onClick={() => void detect()}>{busy && !found ? '正在检测…' : '检测已有账号及权限'}</button>
    {found && <><div className="callout"><div><b>{found.login} · UID {found.uid}</b><small>本机账号标识：{found.marker}</small><small>当前空间项目组：{found.groups.map(group => (snapshot.state?.groups[group]?.label || group) + (found.contentAdminGroups.includes(group) ? '（管理者）' : '（成员）')).join('、') || '无，接入后可另行分配'}</small>{found.historicalGroups.length > 0 && <small>其他空间已有 Linux 组（保留，不自动映射为当前空间权限）：{found.historicalGroups.join('、')}</small>}{found.needsLoginGroup && <small>验证后将加入当前空间登录组，并检查 SFTP 目录是否正确。</small>}{found.unknownGroups.length > 0 && <small>检测到未登记或已停用的 Linux 组：{found.unknownGroups.join('、')}。请先核对其权限，当前不能接入。</small>}</div></div>
      <label className="field">成员姓名<input aria-label="接入成员姓名" value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder={found.username}/></label>
      <label className="field">原账号密码<input aria-label="已有账号原密码" type="password" autoComplete="off" value={password} disabled={busy || found.unknownGroups.length > 0} onChange={event => setPassword(event.target.value)}/><small>仅本次验证使用，不写入成员缓存或审计记录。</small></label>
    </>}
  </div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !found || !!found.unknownGroups.length || !password} onClick={() => void submit()}>{busy ? '验证并接入中…' : '验证密码并接入'}</button></footer></section></div>;
}
