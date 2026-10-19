import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { groupRoleLabels, type GroupCommand, type TeamGroup } from '../shared/team-groups';

type Directory = {username:string;name:string}[];
type Props = { groupId?: string; system?: boolean; embedded?: boolean; accounts?: Directory; call: (command:GroupCommand)=>Promise<any>; close:()=>void; changed:()=>Promise<void> };
const sizeLabel = (bytes:number) => bytes < 1024 ? bytes+' B' : bytes < 1024**2 ? (bytes/1024).toFixed(1)+' KB' : bytes < 1024**3 ? (bytes/1024**2).toFixed(1)+' MB' : (bytes/1024**3).toFixed(1)+' GB';

export function TeamGroupDialog({ groupId, system=false, embedded=false, accounts=[], call, close, changed }: Props) {
  const [group,setGroup] = useState<TeamGroup>(), [directory,setDirectory] = useState<Directory>(accounts);
  const [label,setLabel] = useState(''), [selected,setSelected] = useState(''), [newRole,setNewRole] = useState<'manager'|'member'>('member'), [successor,setSuccessor] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [pending,setPending] = useState<GroupCommand>();
  const canManage = system || group?.role==='creator';
  const canEdit = canManage && !group?.deletedAt && !group?.provisioning;
  const load = async () => {
    if (!groupId) return;
    const value:TeamGroup = await call({action:'details',group:groupId}); setGroup(value);
    if ((system || value.role==='creator') && !value.deletedAt && !value.provisioning) setDirectory(await call({action:'directory',group:groupId}));
  };
  useEffect(()=>{ let active=true; setBusy(true); void load().catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);}); return()=>{active=false;}; },[groupId]);
  const execute = async (command:GroupCommand) => {
    setBusy(true); setError('');
    try {
      await call(command); setPending(undefined);
      if (['create','delete','restore','purge','resume'].includes(command.action)) { close(); await changed(); return; }
      setSelected(''); setSuccessor(''); await changed(); await load();
    } catch(e:any) { setError(e.message); } finally { setBusy(false); }
  };
  const available = directory.filter(user=>!group?.members.some(member=>member.username===user.username));
  const refresh = async()=>{setBusy(true);setError('');setPending(undefined);try{await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  const transferOptions = system ? directory : group?.members.filter(user=>user.enabled).map(user=>({username:user.username,name:user.name})) || [];
  const panel = <section className={embedded ? 'project-members-panel team-group-dialog' : 'modal wide team-group-dialog'} role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : true} aria-label={groupId?(system?'项目组管理':'成员与权限'):'创建项目组'}>
    <header><h2>{groupId ? `${embedded ? '所属项目组' : system ? '项目组管理' : '成员与权限'}${group ? ' · ' + group.label : ''}` : '创建项目组'}{group?.deletedAt && <span className="badge">已删除</span>}</h2><span className="spacer"/>{groupId && <button className="secondary compact" disabled={busy} onClick={()=>void refresh()}>刷新组信息</button>}{!embedded && <button className="icon" aria-label="关闭项目组窗口" disabled={busy} onClick={close}><X size={19}/></button>}</header>
    <div className="modal-body">
      {error && <div className="inline-error" role="alert">{error}</div>}
      {!groupId ? <>
        <label className="field">项目组名称<input autoFocus aria-label="项目组名称" value={label} maxLength={24} disabled={busy} onChange={event=>setLabel(event.target.value)}/></label>
        {system ? <label className="field">创建者<select aria-label="项目组创建者" value={selected} disabled={busy} onChange={event=>setSelected(event.target.value)}><option value="">选择已有账号</option>{accounts.map(user=><option key={user.username} value={user.username}>{user.name} · {user.username}</option>)}</select></label> : <p className="muted small">创建后，你将成为这个项目组的创建者。</p>}
      </> : group ? <>
        <p className="group-permissions-note">{canManage ? '管理本组成员与角色；也可移交创建者权限或删除项目组。' : '查看本组成员与角色。创建者负责人员与权限，管理者负责组内项目及共享内容。'}</p>
        {group.provisioning && <div className="callout">创建尚未完成，成员暂时无法访问。管理端可核对后继续创建。</div>}<div className="group-overview"><span>创建者：{group.creator || '待指定'}</span><span>{group.members.length} 位成员</span><span>{group.projects.length} 个项目</span><span>{sizeLabel(group.bytes)}</span>{group.role && <span className="badge">{groupRoleLabels[group.role]}</span>}</div>
        <table className="group-members-table"><thead><tr><th>成员</th><th>角色</th>{canEdit && <th>操作</th>}</tr></thead><tbody>{group.members.map(user=><tr key={user.username}><td><b>{user.name}</b><small>{user.username}{!user.enabled && ' · 已停用'}</small></td><td>{groupRoleLabels[user.role]}</td>{canEdit && <td>{user.role!=='creator' && user.enabled && <div className="row"><button className="text-button" disabled={busy} aria-label={`设为${user.role==='manager'?'成员':'管理者'}：${user.username}`} onClick={()=>void execute({action:'member',group:group.id,revision:group.revision,username:user.username,role:user.role==='manager'?'member':'manager'})}>{user.role==='manager'?'设为成员':'设为管理者'}</button><button className="text-button danger" disabled={busy} aria-label={`移除成员：${user.username}`} onClick={()=>setPending({action:'member',group:group.id,revision:group.revision,username:user.username,role:'remove'})}>移出组</button></div>}</td>}</tr>)}</tbody></table>
        {canManage && !group.deletedAt && !group.provisioning && <>
          <div className="group-member-add"><label className="field">添加已有成员<select aria-label="选择已有成员" value={selected} disabled={busy} onChange={event=>setSelected(event.target.value)}><option value="">选择账号</option>{available.map(user=><option key={user.username} value={user.username}>{user.name} · {user.username}</option>)}</select></label><label className="field">组内角色<select aria-label="添加成员角色" value={newRole} disabled={busy} onChange={event=>setNewRole(event.target.value as 'manager'|'member')}><option value="member">成员</option><option value="manager">管理者</option></select></label><button className="secondary" disabled={busy || !selected} onClick={()=>void execute({action:'member',group:group.id,revision:group.revision,username:selected,role:newRole})}>添加到项目组</button></div>
          <div className="group-member-add"><label className="field">移交创建者权限<select aria-label="接任创建者" value={successor} disabled={busy} onChange={event=>setSuccessor(event.target.value)}><option value="">选择接任者</option>{transferOptions.filter(user=>user.username!==group.creator).map(user=><option key={user.username} value={user.username}>{user.name} · {user.username}</option>)}</select></label><button className="secondary" disabled={busy || !successor} onClick={()=>setPending({action:'transfer',group:group.id,revision:group.revision,username:successor})}>确认移交</button></div>
        </>}
        {!!group.projects.length && <details className="group-projects"><summary>组内项目（{group.projects.length}）</summary>{group.projects.map(project=><p key={project.id}>{project.name}</p>)}</details>}
        {pending && <section className="group-operation-confirm" aria-label="项目组操作确认"><b>{pending.action==='delete'?'删除项目组':pending.action==='purge'?'彻底清理项目组':pending.action==='transfer'?'移交创建者权限':'移出项目组'}</b>
          {['delete','purge'].includes(pending.action) ? <p>“{group.label}”：{group.projects.length} 个项目、{group.members.length} 位成员、{sizeLabel(group.bytes)}。{pending.action==='delete'?'删除后成员无法继续访问共享内容，管理端可恢复；本地副本保留。':'组内共享内容将永久删除，不能恢复。'}</p> : <p>{'username' in pending && pending.username}：{pending.action==='transfer'?(system?'接任后可以调整成员和删除整个项目组，原创建者保留管理者权限。':'接任后可以调整成员和删除整个项目组，你将保留管理者权限。'):'移出后无法再访问本组共享内容，本地副本保留。'}</p>}
          <div className="row"><button className="secondary" disabled={busy} onClick={()=>setPending(undefined)}>取消操作</button><button className="primary danger" disabled={busy} onClick={()=>void execute(pending)}>{busy?'正在处理…':pending.action==='delete'?'确认删除项目组':pending.action==='purge'?'确认彻底清理':pending.action==='transfer'?'确认移交创建者权限':'确认移出成员'}</button></div>
        </section>}
      </> : <p className="muted">{busy?'正在读取项目组…':'暂无法读取，请重试。'}</p>}
    </div>
    <footer>{group && canManage && !pending && <>{group.provisioning ? system && <button className="primary" disabled={busy} onClick={()=>void execute({action:'resume',group:group.id,revision:group.revision})}>继续创建项目组</button> : group.deletedAt ? system && <><button className="secondary" disabled={busy || !!group.purgeStartedAt} onClick={()=>void execute({action:'restore',group:group.id,revision:group.revision})}>恢复项目组</button><button className="secondary danger" disabled={busy} onClick={()=>setPending({action:'purge',group:group.id,revision:group.revision})}>彻底清理</button></> : <button className="secondary danger" disabled={busy} onClick={()=>setPending({action:'delete',group:group.id,revision:group.revision})}>删除项目组</button>}</>}<span className="spacer"/><button className="secondary" disabled={busy} onClick={close}>关闭</button>{!groupId && <button className="primary" disabled={busy || !label.trim() || system && !selected} onClick={()=>void execute({action:'create',label,...(system?{creator:selected}:{})})}>{busy?'正在创建…':'创建项目组'}</button>}</footer>
  </section>;
  return embedded ? panel : <div className="modal-backdrop">{panel}</div>;
}

export function AdminGroupOverview({ accounts, enabled, changed }: {accounts:Directory;enabled:boolean;changed:()=>Promise<void>}) {
  const loaded = useRef(false);
  const [groups,setGroups] = useState<TeamGroup[]>([]), [selected,setSelected] = useState<string>(), [creating,setCreating] = useState(false), [trash,setTrash] = useState(false), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const call = (command:GroupCommand) => window.admin.call('group.control',command);
  const refresh = async()=>{if(!enabled)return;setBusy(true);try{setGroups(await call({action:'list'}));setError('');}catch(e:any){setError(e.message);}finally{setBusy(false);}};
  useEffect(()=>{if(enabled && !loaded.current){loaded.current=true;void refresh();}},[enabled]);
  return <section className="admin-group-overview"><div className="row"><h2>项目组管理</h2><span className="spacer"/><button className="secondary" disabled={!enabled||busy} onClick={()=>void refresh()}>刷新项目组</button><button className="primary" disabled={!enabled||!accounts.length||busy} onClick={()=>setCreating(true)}>创建项目组</button></div>
    <p className="group-permissions-note">查看各组成员与角色，调整创建者，删除或恢复项目组。</p>
    <div className="row group-view-tabs"><button className={!trash?'secondary':'text-button'} onClick={()=>setTrash(false)}>当前项目组</button><button className={trash?'secondary':'text-button'} onClick={()=>setTrash(true)}>项目组回收站</button></div>{error && <div className="inline-error" role="alert">{error}</div>}
    <table className="group-members-table"><thead><tr><th>项目组</th><th>创建者</th><th>成员</th><th>项目</th><th>占用空间</th><th>操作</th></tr></thead><tbody>{groups.filter(group=>!!group.deletedAt===trash).map(group=><tr key={group.id}><td>{group.label}{group.provisioning && <small>创建未完成</small>}</td><td>{group.creator||'待指定'}</td><td>{group.members.length}</td><td>{group.projects.length}</td><td>{sizeLabel(group.bytes)}</td><td><button className="secondary compact" aria-label={`管理项目组：${group.label}`} disabled={busy} onClick={()=>setSelected(group.id)}>管理</button></td></tr>)}</tbody></table>
    {!groups.filter(group=>!!group.deletedAt===trash).length && <p className="muted">{busy?'正在读取…':trash?'回收站为空':'暂无项目组'}</p>}
    {(creating||selected) && <TeamGroupDialog key={selected||'create'} system groupId={selected} accounts={accounts} call={call} close={()=>{setCreating(false);setSelected(undefined);}} changed={async()=>{await changed();await refresh();}}/>}
  </section>;
}
