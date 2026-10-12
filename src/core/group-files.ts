import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AdminState, ManagedGroup, ManagedUser } from '../admin/types';
import { groupSlug } from '../admin/group-name';
import { groupCommandSchema, type GroupCommand, type GroupRole, type TeamGroup } from '../shared/team-groups';
import { diskPath, writeRegistry, type LocalRegistry } from './local-space';

export const groupIdentity = (user: ManagedUser) => user.accountId || createHash('sha256').update(JSON.stringify([user.username, user.uid, user.marker])).digest('hex');
export function groupRole(state: AdminState, group: ManagedGroup, username: string): GroupRole | undefined {
  const user = state.users[username];
  if (!user?.enabled || user.missing || user.provisioning || group.deletedAt || group.provisioning || !user.groups?.includes(group.name)) return;
  if (group.creator?.username === username && group.creator.identity === groupIdentity(user)) return 'creator';
  return user.contentAdminGroups?.includes(group.name) ? 'manager' : 'member';
}
export function assertCreatorChange(state: AdminState, username: string, groups?: string[], admins?: string[]) {
  const user = state.users[username]; if (!user) return;
  for (const group of Object.values(state.groups)) if (!group.deletedAt && group.creator?.username === username && group.creator.identity === groupIdentity(user)) {
    if (groups && !groups.includes(group.name) || admins && !admins.includes(group.name)) throw new Error('请先在项目组管理中移交创建者权限：' + group.label);
  }
}
export async function groupCommand(root: string, registry: LocalRegistry, actor: string | undefined, raw: GroupCommand, system = false): Promise<TeamGroup | TeamGroup[] | { username: string; name: string }[]> {
  const command = groupCommandSchema.parse(raw), state = registry.state;
  const user = actor ? state.users[actor] : undefined;
  if (!system && (!user?.enabled || user.missing || user.provisioning)) throw new Error('账号已停用或身份已改变');
  if (!system && command.action === 'create' && command.creator !== undefined) throw new Error('创建者由当前登录身份确定');
  const record = 'group' in command ? state.groups[command.group] : undefined;
  if ('group' in command && (!record || record.purgedAt || record.provisioning)) throw new Error('项目组不存在或尚未准备好');
  const role = record && actor ? groupRole(state, record, actor) : undefined;
  if (record && !system && !role) throw new Error('没有此项目组的访问权限');
  const describe = async (group: ManagedGroup): Promise<TeamGroup> => {
    const members = Object.values(state.users).filter(user => user.groups?.includes(group.name)).map(user => ({ username: user.username, name: user.name, enabled: user.enabled && !user.missing && !user.provisioning, role: group.creator?.username === user.username && group.creator.identity === groupIdentity(user) ? 'creator' as const : user.contentAdminGroups?.includes(group.name) ? 'manager' as const : 'member' as const })).sort((a,b) => a.username.localeCompare(b.username));
    const projects: {id:string;name:string}[] = []; let bytes = 0, count = 0;
    const files = createHash('sha256');
    const target = await diskPath(root, group.deletedAt ? group.recyclePath! : group.workspace!, true);
    async function walk(dir: string) {
      for (const entry of (await fs.readdir(dir, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
        if (++count > 500000) throw new Error('项目组文件过多，请管理员分批核对');
        if (entry.isSymbolicLink()) throw new Error('项目组包含目录联接或符号链接，请管理员核对');
        const file = path.join(dir, entry.name);
        const stat = await fs.stat(file, {bigint:true});
        files.update(JSON.stringify([path.relative(target,file),String(stat.ino),String(stat.mtimeNs),String(stat.size)]));
        if (entry.isDirectory()) await walk(file); else if (entry.isFile()) bytes += Number(stat.size);
      }
    }
    try {
      for (const entry of await fs.readdir(target, {withFileTypes:true})) if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.isSymbolicLink()) {
        try { const marker = await diskPath(root, (group.deletedAt ? group.recyclePath! : group.workspace!) + '/' + entry.name + '/.workbench-project.json'); const data = JSON.parse(await fs.readFile(marker, 'utf8')); if (data.id) projects.push({id:data.id,name:data.name}); } catch (error:any) { if (error.code !== 'ENOENT') throw error; }
      }
      await walk(target);
    } catch (error:any) { if (error.code !== 'ENOENT' || !group.provisioning && !group.purgeStartedAt) throw error; }
    const revision = createHash('sha256').update(JSON.stringify([group, members, projects, bytes,files.digest('hex')])).digest('hex');
    return { id:group.name,label:group.label,revision,role:actor ? groupRole(state,group,actor) : undefined,creator:group.creator?.username,createdBy:group.createdBy,deletedAt:group.deletedAt,deletedBy:group.deletedBy,purgeStartedAt:group.purgeStartedAt,members,projects,bytes };
  };
  if (command.action === 'list') return Promise.all(Object.values(state.groups).filter(group => !group.purgedAt && !group.provisioning && group.workspace && (system || !!groupRole(state,group,actor!))).map(describe));
  if (command.action === 'details') return describe(record!);
  if (!system && role !== 'creator' && command.action !== 'create') throw new Error('只有本组创建者可以管理成员或删除项目组');
  if (command.action === 'directory') return Object.values(state.users).filter(user => user.enabled && !user.missing && !user.provisioning).map(({username,name}) => ({username,name}));
  if (record && 'revision' in command && (await describe(record)).revision !== command.revision) throw new Error('项目组成员或内容已变化，请刷新后重新确认');
  if (record?.deletedAt && !['restore','purge'].includes(command.action)) throw new Error('项目组已删除，请由管理端恢复');
  if (!system && ['restore','purge'].includes(command.action)) throw new Error('只有管理端可以恢复或彻底清理项目组');
  if (command.action === 'resume') throw new Error('本地项目组无需继续创建');
  if (command.action === 'create') {
    const creator = system ? command.creator : actor;
    const owner = creator ? state.users[creator] : undefined;
    if (!owner?.enabled || owner.missing || owner.provisioning) throw new Error('请选择已启用的创建者账号');
    if (Object.values(state.groups).some(group => !group.purgedAt && group.label.toLocaleLowerCase() === command.label.toLocaleLowerCase())) throw new Error('项目组名称已存在；删除的组需先恢复或彻底清理');
    const name = 'local_' + groupSlug(command.label) + '_' + randomUUID().slice(0,8), workspace = '/projects/' + command.label;
    if (state.groups[name]) throw new Error('项目组名称冲突');
    const directory = await diskPath(root, workspace, true); await fs.mkdir(directory);
    owner.accountId ||= randomUUID();
    state.groups[name] = {name,label:command.label,adminGroup:name+'_admins',workspace,creator:{username:creator!,identity:groupIdentity(owner)},createdBy:creator!,createdAt:new Date().toISOString()};
    owner.groups = [...new Set([...(owner.groups || []),name])]; owner.contentAdminGroups = [...new Set([...(owner.contentAdminGroups || []),name])];
    const operationId=randomUUID();state.operations||={};state.operations[operationId]={id:operationId,op:'group_control',request:{...command,actor:actor||'系统管理员'},status:'done',completed:['项目组已创建']};
    try { await writeRegistry(root,registry); } catch(error) { await fs.rmdir(directory).catch(()=>{}); throw error; }
    return describe(state.groups[name]);
  }
  if (command.action === 'member' || command.action === 'transfer') {
    const target = state.users[command.username];
    if (!target?.enabled || target.missing || target.provisioning) throw new Error('目标账号不存在或未启用；创建账号请使用管理端');
    if (command.action === 'member' && record!.creator?.username === target.username && record!.creator.identity === groupIdentity(target)) throw new Error('请先移交创建者权限，不能直接移除或降级创建者');
    if (command.action === 'transfer') {
      if (!system && !target.groups?.includes(record!.name)) throw new Error('接任创建者必须是本组已有成员');
      target.accountId ||= randomUUID(); record!.creator = {username:target.username,identity:groupIdentity(target)};
    }
    const removing = command.action === 'member' && command.role === 'remove', manager = command.action === 'transfer' || command.role === 'manager';
    target.groups = [...new Set([...(target.groups || []).filter(g=>g!==record!.name),...(!removing ? [record!.name] : [])])];
    target.contentAdminGroups = [...new Set([...(target.contentAdminGroups || []).filter(g=>g!==record!.name),...(manager ? [record!.name] : [])])];
  } else if (command.action === 'delete') {
    const from = await diskPath(root,record!.workspace!), recyclePath = '/.workbench-local/group-trash/' + record!.name;
    const to = await diskPath(root,recyclePath,true); await fs.mkdir(path.dirname(to),{recursive:true}); await fs.rename(from,to);
    record!.deletedAt = new Date().toISOString(); record!.deletedBy = actor || '系统管理员'; record!.recyclePath = recyclePath;
    try { await writeRegistry(root,registry); } catch(error) { await fs.rename(to,from); throw error; }
  } else if (command.action === 'restore') {
    if (!record!.deletedAt || record!.purgeStartedAt) throw new Error('项目组未删除或已经开始彻底清理');
    const from = await diskPath(root,record!.recyclePath!), to = await diskPath(root,record!.workspace!,true);
    await fs.rename(from,to); delete record!.deletedAt; delete record!.deletedBy; delete record!.recyclePath;
    try { await writeRegistry(root,registry); } catch(error) { await fs.rename(to,from); throw error; }
  } else if (command.action === 'purge') {
    if (!record!.deletedAt) throw new Error('只能彻底清理回收站内的项目组');
    const target = await diskPath(root,record!.recyclePath!,true);
    if (!target.startsWith(path.join(root,'.workbench-local','group-trash') + path.sep)) throw new Error('回收路径不合法');
    record!.purgeStartedAt ||= new Date().toISOString(); await writeRegistry(root,registry);
    await fs.rm(target,{recursive:true,force:true}); record!.purgedAt = new Date().toISOString();
    for (const member of Object.values(state.users)) { member.groups = member.groups?.filter(g=>g!==record!.name); member.contentAdminGroups = member.contentAdminGroups?.filter(g=>g!==record!.name); }
  }
  const id = randomUUID(); state.operations ||= {}; state.operations[id] = {id,op:'group_control',request:{...command,actor:actor || '系统管理员'},status:'done',completed:['项目组操作已完成']};
  await writeRegistry(root,registry);
  if (command.action === 'purge') return [];
  return describe(record!);
}
