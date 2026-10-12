import { groupCommand, assertCreatorChange } from '../core/group-files';
import { continuitySuccessors } from './continuity';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { groupSlug } from './group-name';
import type { AdminOperation, AdminProfile, AdminSnapshot, StorageScanRequest } from './types';
import { adminOperationSchema, storageScanSchema } from './types';
import { diskPath, localRoot, passwordHash, readRegistry, registryLock, writeRegistry, type LocalRegistry } from '../core/local-space';
import { scanLocalStorage } from './storage-usage';
import { catalogProjects, purgeProject, type ProjectPurgeMode } from './project-purge';

export class LocalAdminConnection {
  snapshot: AdminSnapshot = { connected: false, verified: false, busy: false };
  private root = ''; private teamId?: string; private generation = 0;
  constructor(private changed: () => void) {}
  disconnect() { this.generation++; this.teamId = undefined; this.snapshot = { profile: this.snapshot.profile, connected: false, verified: false, busy: false }; this.changed(); }
  async connect(profile: AdminProfile, _password: string, _sudo: string, _trust: (s: string) => Promise<boolean>) {
    this.disconnect();
    try { this.root = await localRoot(profile.localRoot); }
    catch (error: any) { if (error.code === 'ENOENT') throw new Error('本地共享目录不存在，请重新选择'); throw error; }
    let data: LocalRegistry | undefined;
    try { data = await readRegistry(this.root); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (data) {
      if (profile.fingerprint && profile.fingerprint !== 'LOCAL:' + data.state.teamId) throw new Error('本地共享区身份已改变，请重新选择共享目录');
      this.teamId = data.state.teamId;
    } else {
      if ((await fs.readdir(this.root)).length) throw new Error('首次初始化必须使用专用空目录');
      if (profile.fingerprint) throw new Error('原本地共享区的登记文件不存在，请检查共享目录');
    }
    // Local mode is a permission test stub. The admin application opens the
    // selected folder directly; the legacy administrator label is metadata only.
    const saved = { ...profile, username: data?.administrator || 'admin', host: 'local', localRoot: this.root, fingerprint: data ? 'LOCAL:' + data.state.teamId : '', mode: 'local' as const };
    this.snapshot = { profile: saved, connected: true, verified: true, busy: false, actor: '本地管理员', role: 'administrator', state: data?.state || { initialized: false, users: {}, groups: {} } };
    this.changed(); return saved;
  }
  async operation(raw: AdminOperation) {
    if (raw.op === 'egress_jump' || raw.op === 'egress_jump_probe') throw new Error('本地共享目录不支持中转，请连接 Linux 共享服务器');
    if (raw.op === "environment_prepare") throw new Error("本地模拟共享区无需安装服务器组件");
    const request = adminOperationSchema.parse(raw);
    if (!this.snapshot.connected) throw new Error('请先连接本地共享区');
    if (this.snapshot.busy) throw new Error('请等待当前管理操作完成');
    const generation = this.generation;
    this.snapshot.busy = true; this.changed();
    try {
      return await registryLock(this.root, async () => {
        let data: LocalRegistry; let created = false;
        try { data = await readRegistry(this.root); }
        catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
          if (this.teamId) throw new Error('本地共享区登记文件不存在，请重新连接并检查目录');
          if (request.op === 'status') return this.snapshot.state;
          if (request.op !== 'initialize') throw new Error('请先初始化团队空间');
          if ((await fs.readdir(this.root)).some(s => s !== '.workbench-local.lock')) throw new Error('共享区不是空目录，不能初始化');
          data = { version: 1, administrator: this.snapshot.profile!.username, credentials: {}, state: { initialized: true, teamId: randomUUID(), loginGroup: 'local_members', sftpConfigured: true, storageVersion: 1, users: {}, groups: {}, operations: {} } }; created = true;
          await fs.mkdir(await diskPath(this.root, '/.workbench-local', true));
          await fs.mkdir(await diskPath(this.root, '/projects', true));
        }
        if ((!created && data.state.teamId !== this.teamId) || generation !== this.generation) throw new Error('本地共享区已改变，请重新连接');
        const state = data.state;
        if (request.op === 'group_control') { const result = await groupCommand(this.root,data,undefined,request.command,true); this.snapshot.state = state; return result; }
        if (request.op === 'group_member' && request.role !== 'admin') assertCreatorChange(state, request.username, request.role === 'remove' ? state.users[request.username]?.groups?.filter(g=>g!==request.group) : undefined, state.users[request.username]?.contentAdminGroups?.filter(g=>g!==request.group));
        if (request.op === 'user_groups') assertCreatorChange(state, request.username, request.groups, request.contentAdminGroups);
        if (request.op === 'group_member' && (state.groups[request.group]?.deletedAt || state.groups[request.group]?.purgedAt)) throw new Error('项目组已删除，请先在项目组管理中恢复');
        const user = 'username' in request && Object.hasOwn(state.users, request.username) ? state.users[request.username] : undefined;
        if (['user_password', 'user_enabled', 'user_groups', 'group_member'].includes(request.op) && !user) throw new Error('成员不存在');
        if (request.op === 'user_create' || request.op === 'user_groups') {
          const groups = request.groups || [], admins = request.contentAdminGroups || [];
          if (groups.some(g => !state.groups[g]?.workspace || state.groups[g]?.purgedAt || state.groups[g]?.deletedAt && !user?.groups?.includes(g)) || admins.some(g => !groups.includes(g))) throw new Error('项目组不存在或管理者未加入该组');
        }
        for (const { group, user: successor } of continuitySuccessors(state, request)) successor.contentAdminGroups = [...new Set([...(successor.contentAdminGroups || []), group])];
        switch (request.op) {
          case 'status': break;
          case 'storage_upgrade': throw new Error('本地共享区无需升级服务器文件操作器');
          case 'initialize': break;
          case 'group_create': {
            const label = request.label, name = 'local_' + groupSlug(label), record = state.groups[name];
            if (!record) {
              const collision = Object.values(state.groups).find(g => g.label.toLowerCase() === label.toLowerCase());
              if (collision) throw new Error('已存在同名或仅大小写不同的项目组：' + collision.label);
              const workspace = '/projects/' + label;
              await fs.mkdir(await diskPath(this.root, workspace, true));
              state.groups[name] = { name, label, adminGroup: name + '_admins', workspace };
            }
            else if (record.label !== label) throw new Error('项目组名称与已有项目组冲突，请换一个名称：' + record.label);
            else throw new Error('项目组已存在'); break;
          }
          case 'workspace_prepare': if (!state.groups[request.group]?.workspace) throw new Error('项目组不存在'); break;
          case 'user_create':
            if ([data.administrator, ...Object.keys(state.users)].some(name => name.toLowerCase() === request.username.toLowerCase())) throw new Error('账号已存在（不允许创建仅大小写不同的重名账号）');
            state.users[request.username] = { username: request.username, name: request.name, enabled: true, accountId: randomUUID(), groups: request.groups || [], contentAdminGroups: request.contentAdminGroups || [] };
            data.credentials[request.username] = passwordHash(request.password); break;
          case 'user_password': data.credentials[request.username] = passwordHash(request.password); break;
          case 'user_enabled': user!.enabled = request.enabled; break;
          case 'user_groups': {
            const archived=(user!.groups||[]).filter(g=>state.groups[g]?.deletedAt&&!state.groups[g]?.purgedAt);
            const admins=(user!.contentAdminGroups||[]).filter(g=>archived.includes(g));
            user!.groups=[...new Set([...request.groups,...archived])];user!.contentAdminGroups=[...new Set([...(request.contentAdminGroups||[]).filter(g=>!archived.includes(g)),...admins])];break;
          }
          case 'group_member': {
            const group = state.groups[request.group];
            if (!group?.workspace || group.provisioning) throw new Error('项目组不存在或工作目录尚未准备好');
            if (user!.provisioning || user!.missing) throw new Error('请先完成用户开通或核对账号身份');
            const groups = new Set(user!.groups || []), admins = new Set(user!.contentAdminGroups || []);
            if (request.role === 'remove') groups.delete(request.group); else groups.add(request.group);
            if (request.role === 'admin') admins.add(request.group); else admins.delete(request.group);
            user!.groups = [...groups]; user!.contentAdminGroups = [...admins]; break;
          }
          case 'recover': throw new Error('本地权限桩没有 Linux 命令恢复任务');
        }
        if (request.op !== 'status') {
          const id = randomUUID(); const { password: _secret, ...sanitized } = request as any;
          state.operations ||= {}; state.operations[id] = { id, op: request.op, request: sanitized, status: 'done', completed: ['本地权限桩已保存'] };
          await writeRegistry(this.root, data);
        }
        this.teamId = state.teamId; this.snapshot.state = state; this.snapshot.profile!.fingerprint = 'LOCAL:' + state.teamId; return state;
      });
    } finally { this.snapshot.busy = false; this.changed(); }
  }
  async storageUsage(raw: StorageScanRequest, signal?: AbortSignal) {
    const request = storageScanSchema.parse(raw);
    if (!this.snapshot.connected || !this.snapshot.verified || this.snapshot.role !== 'administrator') throw new Error('只有总管理员可以查看共享空间统计');
    if (!this.snapshot.state?.initialized || !this.teamId) throw new Error('请先初始化团队空间');
    const generation = this.generation, data = await readRegistry(this.root);
    if (data.state.teamId !== this.teamId || generation !== this.generation) throw new Error('本地共享区已改变，请重新连接');
    return scanLocalStorage(this.root, data.state, request, signal);
  }
  async projectCatalog() {
    if (!this.snapshot.connected || !this.snapshot.verified || this.snapshot.role !== 'administrator') throw new Error('只有总管理员可以清理项目');
    if (!this.snapshot.state?.initialized || !this.teamId) throw new Error('请先初始化团队空间');
    const data = await readRegistry(this.root);
    if (data.state.teamId !== this.teamId) throw new Error('本地共享区已改变，请重新连接');
    return { projects: await catalogProjects(this.root, data.state) };
  }
  async projectPurge(projectId: string, mode: ProjectPurgeMode) {
    if (!this.snapshot.connected || !this.snapshot.verified || this.snapshot.role !== 'administrator') throw new Error('只有总管理员可以清理项目');
    if (!this.snapshot.state?.initialized || !this.teamId) throw new Error('请先初始化团队空间');
    return registryLock(this.root, async () => {
      const data = await readRegistry(this.root);
      if (data.state.teamId !== this.teamId) throw new Error('本地共享区已改变，请重新连接');
      return purgeProject(this.root, data.state, projectId, mode);
    });
  }
}
