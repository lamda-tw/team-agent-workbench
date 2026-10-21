import { ContinuityChoices } from './continuity-view';
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FolderTree, Plus, RefreshCw, ShieldCheck, UserRound, Users, X } from 'lucide-react';
import type { AdminSnapshot, AdminState, ManagedGroup, ManagedUser } from './types';
import type { Form } from './renderer';
import { memberReadiness } from './member-readiness';
import { firstMemberIsAdmin } from './member-defaults';
import { MemberConflict, useMemberRequestId } from './member-sync-view';

function memberRole(user: ManagedUser, group: ManagedGroup) {
  return group.creator?.username === user.username && group.creator.identity === (user.accountId || user.identity) ? '创建者' : user.contentAdminGroups?.includes(group.name) ? '管理者' : '成员';
}
type Open = (form: Form) => void;
export function PeopleManagement({ state, ready, canCreateMember, busy, local, open, refresh }: { state: AdminState; ready: boolean; canCreateMember: boolean; busy: boolean; local: boolean; open: Open; refresh: () => void }) {
  const [view, setView] = useState<'users' | 'groups'>('users');
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [collapsed, setCollapsed] = useState<string[]>([]);
  const users = Object.values(state.users).sort((a, b) => a.username.localeCompare(b.username));
  const groups = Object.values(state.groups).filter(group=>!group.deletedAt&&!group.purgedAt).sort((a, b) => a.label.localeCompare(b.label));
  const query = search.trim().toLocaleLowerCase();
  const memberships = (user: ManagedUser) => groups.filter(g => user.groups?.includes(g.name));
  const matches = (user: ManagedUser) => (user.username + ' ' + user.name + ' ' + memberships(user).map(g => g.label + ' ' + g.name).join(' ')).toLocaleLowerCase().includes(query);
  const eligible = (user: ManagedUser) => filter === 'all' || (filter === 'unassigned' ? !memberships(user).length : filter === 'admins' ? memberships(user).some(g => user.contentAdminGroups?.includes(g.name)) : filter === 'enabled' ? user.enabled : !user.enabled);
  const visible = users.filter(u => matches(u) && eligible(u));
  const toggle = (key: string) => setCollapsed(values => values.includes(key) ? values.filter(v => v !== key) : [...values, key]);
  const rows = (list: ManagedUser[], group?: ManagedGroup) => <div className="people-table-scroll"><table><thead><tr><th>成员 / {local ? '模拟账号' : 'Linux 账号'}</th><th>状态</th><th>{group ? '本组角色 / 所属用户组' : '所属用户组与角色'}</th><th>管理操作</th></tr></thead><tbody>{list.map(user => <tr key={user.username} data-user={user.username}>
    <td><button className="person-link" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'groups', user })}><span className="admin-avatar"><UserRound size={17}/></span><span><b>{user.name || user.username}</b><code>{user.username}</code></span></button></td>
    <td><span className={'badge ' + (user.enabled ? 'done' : 'error')}>{user.missing ? '账号已变更' : user.provisioning ? '开通未完成' : user.enabled ? '已启用' : '已停用'}</span></td>
    <td>{group && <div className={'member-role ' + (user.contentAdminGroups?.includes(group.name) ? 'subadmin' : '')}>{memberRole(user, group)}</div>}<div className="membership-chips">{memberships(user).map(g => <button className={'group-chip ' + (user.contentAdminGroups?.includes(g.name) ? 'subadmin' : '')} key={g.name} disabled={!ready || user.missing || user.provisioning || g.provisioning} title={'管理 ' + g.label + ' 成员身份'} onClick={() => open({ kind: 'membership', group: g, user, role: user.contentAdminGroups?.includes(g.name) ? 'admin' : 'member' })}>{g.label}<><ShieldCheck size={11}/>{memberRole(user,g)}</></button>)}</div>{!memberships(user).length && <span className="unassigned-label">未分组</span>}</td>
    <td><small className="muted">{memberReadiness(state, user).join(' · ') || '开通完成'}</small><div className="people-actions">
      {group ? <><button className="text-button" disabled={!ready || user.missing || user.provisioning || group.provisioning || memberRole(user,group)==='创建者'} onClick={() => open({ kind: 'membership', user, group, role: user.contentAdminGroups?.includes(group.name) ? 'member' : 'admin' })}>{user.contentAdminGroups?.includes(group.name) ? '取消管理者' : '设为管理者'}</button><button className="text-button danger" disabled={!ready || user.missing || user.provisioning || group.provisioning || memberRole(user,group)==='创建者'} onClick={() => open({ kind: 'membership', user, group, role: 'remove' })}>移出本组</button></> : <><button className="text-button" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'membership', user })}>加入用户组</button><button className="text-button" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'groups', user })}>组与角色</button></>}
      <button className="text-button" disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'password', user })}>重置密码</button><button className={'text-button ' + (user.enabled ? 'danger' : '')} disabled={!ready || user.missing || user.provisioning} onClick={() => open({ kind: 'enabled', user })}>{user.enabled ? '停用' : '启用'}</button>
    </div></td>
  </tr>)}</tbody></table>{!list.length && <div className="people-empty">{query || filter !== 'all' ? '没有符合筛选条件的成员' : group ? '此组暂无成员，可创建新用户或添加已有用户。' : '暂无成员，可独立创建用户，稍后再分配用户组。'}</div>}</div>;
  return <section className="people-management">
    <div className="people-toolbar"><div className="people-tabs" role="tablist" aria-label="用户管理视图"><button role="tab" aria-selected={view === 'users'} onClick={() => setView('users')}><Users size={16}/>全部用户</button><button role="tab" aria-selected={view === 'groups'} onClick={() => setView('groups')}><FolderTree size={16}/>按组查看</button></div><span className="spacer"/><button className="secondary compact" disabled={busy} onClick={refresh}><RefreshCw size={14}/>刷新</button></div>
    <div className="people-filters"><input aria-label="查找成员或用户组" placeholder="查找账号、姓名或用户组" value={search} onChange={e => setSearch(e.target.value)}/><select aria-label="成员筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">所有成员</option><option value="unassigned">未分组</option><option value="admins">项目组管理者</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><span className="muted small">{view === 'users' ? `${visible.length} / ${users.length} 位成员` : `${groups.length} 个用户组 · ${users.length} 位成员`}</span>{(query || filter !== 'all') && <button className="text-button" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button>}</div>
    {view === 'users' ? <section className="admin-table-card people-global" aria-label="全部用户列表">{rows(visible)}</section> : <div className="people-hierarchy">
      {groups.filter(g => !query || (g.label + ' ' + g.name).toLocaleLowerCase().includes(query) || users.some(u => u.groups?.includes(g.name) && matches(u))).map(g => {
        const members = users.filter(u => u.groups?.includes(g.name));
        const expanded = !collapsed.includes(g.name), available = ready && !!g.workspace && !g.provisioning;
        return <section className="admin-table-card group-section" key={g.name} data-group={g.name} aria-label={'用户组 ' + g.label}><header><button className="group-heading" aria-expanded={expanded} onClick={() => toggle(g.name)}>{expanded ? <ChevronDown size={18}/> : <ChevronRight size={18}/>}<FolderTree size={20}/><span><b>{g.label}</b><small>{g.workspace || '工作路径尚未准备'}</small></span></button><span className="group-count">{members.length} 位成员 · {members.filter(u => u.contentAdminGroups?.includes(g.name)).length} 位管理者</span>{!members.some(u => u.enabled && u.contentAdminGroups?.includes(g.name)) && <span className="badge error">待指定负责人</span>}<span className="spacer"/>{!g.workspace && <button className="secondary compact" disabled={!ready} onClick={() => open({ kind: 'workspace', group: g })}>准备工作目录</button>}<button className="secondary compact" disabled={!available || !canCreateMember} onClick={() => open({ kind: 'create', group: g })}><Plus size={14}/>组内创建用户</button><button className="primary compact" disabled={!available} onClick={() => open({ kind: 'membership', group: g })}>添加已有用户</button></header>{expanded && rows(members.filter(u => eligible(u) && (matches(u) || (g.label + ' ' + g.name).toLocaleLowerCase().includes(query))), g)}</section>;
      })}
      {!groups.length && <div className="people-empty">还没有项目组。可以先创建用户，也可以先创建项目组。</div>}
      <section className="admin-table-card unassigned-section" data-group="unassigned"><header><h3>未分组用户</h3><span className="muted small">{users.filter(u => !memberships(u).length).length} 位 · 创建账号后，可在这里分配用户组</span></header>{rows(visible.filter(u => !memberships(u).length))}</section>
    </div>}
  </section>;
}

export function MembershipDialog({ form, snapshot, close, done }: { form: Form; snapshot: AdminSnapshot; close: () => void; done: () => Promise<void> }) {
  const [baselines, setBaselines] = useState(snapshot.state?.users || {});
  const requestId = useMemberRequestId();
  const groups = Object.values(snapshot.state?.groups || {}).filter(g => g.workspace && !g.provisioning && !g.deletedAt && !g.purgedAt);
  const users = Object.values(snapshot.state?.users || {}).filter(u => !u.missing && !u.provisioning);
  const [usernames, setUsernames] = useState(form.user ? [form.user.username] : []), [groupName, setGroupName] = useState(form.group?.name || '');
  const defaultRole = (group: string) => firstMemberIsAdmin(snapshot.state, group) ? 'admin' as const : 'member' as const;
  const [role, setRole] = useState<'member' | 'admin' | 'remove'>(form.role || defaultRole(form.group?.name || ''));
  const [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const username = form.user?.username || usernames[0] || '', selectedGroup = groups.find(g => g.name === groupName);
  const candidateGroups = groups.filter(g => !form.user || !form.user.groups?.includes(g.name) || form.group?.name === g.name);
  const candidates = users.filter(u => !u.groups?.includes(groupName) && (u.username + ' ' + u.name).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const [handoffs, setHandoffs] = useState<Record<string, string | null>>({});
  const removing = role === 'remove';
  const title = form.user && form.group ? '管理组成员' : form.user ? '将用户加入已有组' : '向组添加已有用户';
  const submit = async () => {
    setBusy(true); setError('');
    const targets = form.user ? [form.user.username] : usernames, completed: string[] = [];
    try {
      for (const target of targets) {
        try {
          const expectedRevision = baselines[target]?.revision;
          if (!expectedRevision) throw new Error('成员尚未同步完成，请重新打开');
          const handoffRevisions = Object.fromEntries(Object.values(handoffs).filter((name): name is string => !!name).map(name => [name, baselines[name]?.revision]));
          const command = { op: 'member_groups', username: target, changes: [{ group: groupName, role }], expectedRevision, handoffs, handoffRevisions };
          await window.admin.call('members.apply', { command, requestId: requestId(command, target) }); completed.push(target);
        }
        catch (reason: any) {
          setUsernames(current => current.filter(value => !completed.includes(value)));
          const prefix = completed.length ? `已成功添加 ${completed.length} 位；` : '';
          throw new Error(`${prefix}${target} 添加失败：${reason.message}。未完成的选择已保留。`);
        }
      }
      await done();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="modal membership-dialog"><header><h2>{title}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={close}><X size={19}/></button></header><div className="modal-body">
    {error && <div className="inline-error" role="alert">{error}</div>}
    {[...new Set([...usernames, ...Object.values(handoffs).filter((name): name is string => !!name)])].map(name => <MemberConflict key={name} baseline={baselines[name]} current={snapshot.state?.users[name]} state={snapshot.state} busy={busy} confirm={() => { setBaselines(current => ({ ...current, [name]: snapshot.state!.users[name] })); setError(''); }}/>) }
    {form.user ? <div className="member-summary"><UserRound size={24}/><div><b>{form.user.name}</b><code>{form.user.username}</code><small>当前所属组：{groups.filter(g => form.user!.groups?.includes(g.name)).map(g => g.label).join('、') || '未分组'}</small></div></div> : <><label className="field">查找已有用户<input aria-label="查找已有用户" value={search} onChange={e => setSearch(e.target.value)} placeholder="账号或姓名"/></label><div className="candidate-actions"><span className="muted small">已选择 {usernames.length} 位</span><span className="spacer"/><button className="text-button" disabled={!candidates.some(user => !usernames.includes(user.username))} onClick={() => setUsernames(current => [...new Set([...current, ...candidates.map(user => user.username)])])}>全选当前结果</button><button className="text-button" disabled={!usernames.length} onClick={() => setUsernames([])}>清空选择</button></div><div className="member-candidates">{candidates.map(u => <label className="check-row" key={u.username}><input type="checkbox" aria-label={'选择用户 ' + u.username} checked={usernames.includes(u.username)} onChange={event => setUsernames(current => event.target.checked ? [...current, u.username] : current.filter(value => value !== u.username))}/><span><b>{u.name}</b> <code>{u.username}</code><small>{u.enabled ? '已启用' : '已停用'} · 已加入：{groups.filter(g => u.groups?.includes(g.name)).map(g => g.label).join('、') || '未分组'}</small></span></label>)}{!candidates.length && <p className="muted">{search ? '没有匹配的可添加用户' : '暂无可添加用户，已有用户均已加入本组。'}</p>}</div></>}
    {form.group ? <p>目标用户组：<b>{form.group.label}</b></p> : <label className="field">选择已有用户组<select aria-label="选择已有用户组" value={groupName} onChange={e => { setGroupName(e.target.value); setRole(defaultRole(e.target.value)); }}><option value="">请选择用户组</option>{candidateGroups.map(g => <option key={g.name} value={g.name}>{g.label}</option>)}</select>{!candidateGroups.length && <small>暂无可加入的用户组，请先创建用户组。</small>}</label>}
    <label className="field">成员身份{!form.user && usernames.length > 1 ? `（应用于已选 ${usernames.length} 位用户）` : ''}<select aria-label="成员身份" value={role} onChange={e => setRole(e.target.value as typeof role)}><option value="member">普通成员</option><option value="admin">项目组管理者（仅本组）</option>{form.user && form.group && <option value="remove">移出此组</option>}</select></label>
    <ContinuityChoices state={snapshot.state} operation={{ op: 'group_member', username, group: groupName, role }} choices={handoffs} change={value => { setHandoffs(value); setBaselines(current => ({ ...current, ...Object.fromEntries(Object.values(value).filter((name): name is string => !!name && !Object.values(handoffs).includes(name)).map(name => [name, snapshot.state!.users[name]])) })); }}/>
    {removing && <div className="callout membership-removal"><div>移出本组并撤销本组管理者权限。<small>账号、其他组身份及已上传内容保留。</small></div></div>}{snapshot.profile?.mode !== 'local' && <p className="muted small">执行后将断开该用户的远端旧连接。</p>}
  </div><footer>{!form.user && <span className="muted small">将添加 {usernames.length} 位用户</span>}<span className="spacer"/><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !usernames.length || !selectedGroup} onClick={() => void submit()}>{busy ? `正在处理 ${usernames.length} 位…` : '确认执行'}</button></footer></section></div>;
}
