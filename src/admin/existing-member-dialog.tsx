import React, { useEffect, useState } from 'react';
import { Server, X } from 'lucide-react';
import type { AdminSnapshot } from './types';
import { useMemberRequestId } from './member-sync-view';

type ExistingMember = { username: string; login: string; uid: number; marker: string; groups: string[]; contentAdminGroups: string[]; unknownGroups: string[]; identity: string };

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
    <p className="muted small">只接入由当前团队工作台创建、尚未登记的专用账号。先检测 Linux 身份与现有项目组权限，再用原密码验证；不会重设密码或修改 Linux 用户组。</p>
    <label className="field">Linux 登录账号<input aria-label="已有 Linux 登录账号" value={username} disabled={busy} onChange={event => { setUsername(event.target.value); setFound(undefined); setPassword(''); }} placeholder="例如 taowen"/></label>
    <button className="secondary" disabled={busy || !username.trim()} onClick={() => void detect()}>{busy && !found ? '正在检测…' : '检测已有账号及权限'}</button>
    {found && <><div className="callout"><div><b>{found.login} · UID {found.uid}</b><small>当前团队身份：{found.marker}</small><small>所属项目组：{found.groups.map(group => (snapshot.state?.groups[group]?.label || group) + (found.contentAdminGroups.includes(group) ? '（管理者）' : '（成员）')).join('、') || '无'}</small>{found.unknownGroups.length > 0 && <small>检测到未登记或已停用的 Linux 组：{found.unknownGroups.join('、')}。请先核对其权限，当前不能接入。</small>}</div></div>
      <label className="field">成员姓名<input aria-label="接入成员姓名" value={name} disabled={busy} onChange={event => setName(event.target.value)} placeholder={found.username}/></label>
      <label className="field">原账号密码<input aria-label="已有账号原密码" type="password" autoComplete="off" value={password} disabled={busy || found.unknownGroups.length > 0} onChange={event => setPassword(event.target.value)}/><small>仅本次验证使用，不写入成员缓存或审计记录。</small></label>
    </>}
  </div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !found || !!found.unknownGroups.length || !password} onClick={() => void submit()}>{busy ? '验证并接入中…' : '验证密码并接入'}</button></footer></section></div>;
}
