import { newAccountPasswordSchema } from '../shared/accounts';
import { QuestionFiles } from './question-files';
import type { QuestionCommand } from '../shared/questions';
import { groupCommand, groupRole } from './group-files';
import type { GroupCommand } from '../shared/team-groups';
import { atomicJson } from './store';
import { ContentFiles } from './content-files';
import { AssignmentFiles } from './assignment-files';
import type { AssignmentCreate, AssignmentStatusChange, AssignmentUpload } from '../shared/assignments';
import type { ContentEdit, ContentMerge, ContentMetadata } from '../shared/content';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ConnectionProfile, FilePreview, Project, RemoteBinding, RemoteEntry, WorkspaceAccess } from '../shared/types';
import { passwordHash, writeRegistry, authorizeUser, diskPath, localRoot, passwordMatches, readRegistry, registryLock } from './local-space';
import { assertRemote, childRemote, remotePath, withinRemote } from './paths';
import { newProjectLayout, projectName } from './project-layout';
import { sameEndpoint } from './sftp';
import { accountRecordsSchema, type AccountSnapshot } from '../shared/account-data';
import { directionDirectorySchema, mergeDirectionUpdates, prepareDirectionSave, savedDirectionsSchema, type DirectionDirectory, type DirectionRecord } from '../shared/directions';
import { hashFile } from './artifacts';
import { PROJECT_BRIEF_FILE, projectBriefSchema, projectBriefMarkdown, type ProjectBrief } from '../shared/project-brief';

export class LocalFileConnection {
  profile?: ConnectionProfile; workspace?: WorkspaceAccess; workspaces: WorkspaceAccess[] = [];
  private root = ''; private proof = ''; private ready = false;
  constructor(private changed: () => void = () => {}) {}
  get connected() { return this.ready; }
  disconnect() { this.ready = false; this.proof = ''; this.workspace = undefined; this.workspaces = []; this.changed(); }
  async connect(profile: ConnectionProfile, password: string, _trust: (s: string) => Promise<boolean>) {
    this.disconnect(); this.root = await localRoot(profile.localRoot);
    const data = await readRegistry(this.root);
    if (!passwordMatches(password, data.credentials[profile.username])) throw new Error('模拟账号或密码错误');
    const proof = data.credentials[profile.username]; authorizeUser(data, profile.username, proof);
    const fingerprint = 'LOCAL:' + data.state.teamId;
    if (profile.fingerprint && profile.fingerprint !== fingerprint) throw new Error('本地测试共享区身份已改变，请重新打开对应的联调启动器');
    this.profile = { ...profile, mode: 'local', localRoot: this.root, host: 'local', port: 22, fingerprint, projects: [], workPath: '', manifestPath: '' };
    this.proof = proof; this.ready = true; this.changed(); return this.profile;
  }
  async passwordStatus() {
    const data = await readRegistry(this.root);
    return { required: !!authorizeUser(data, this.profile!.username, this.proof).mustChangePassword };
  }
  async changePassword(oldPassword: string, newPassword: string) {
    newAccountPasswordSchema.parse(newPassword);
    return registryLock(this.root, async () => {
      const data = await readRegistry(this.root), username = this.profile!.username;
      const user = authorizeUser(data, username, this.proof);
      if (!passwordMatches(oldPassword, data.credentials[username])) throw new Error('原密码错误');
      data.credentials[username] = passwordHash(newPassword); user.mustChangePassword = false; user.accessVersion = randomUUID();
      await writeRegistry(this.root, data); this.proof = data.credentials[username]; return true;
    });
  }
  channel(binding?: RemoteBinding) {
    if (!this.ready || !this.profile) throw new Error('请先连接本地共享区');
    if (binding) {
      if (!sameEndpoint(binding, this.profile)) throw new Error('当前共享区或账号与任务绑定的身份不一致');
      const p = this.profile.projects.find(p => p.id === binding.project.id);
      if (!p || ['remoteRoot', 'uploadPath', 'historyPath'].some(k => p[k as keyof Project] !== binding.project[k as keyof Project])) throw new Error('项目入口配置已改变');
    }
    return this;
  }
  async accountData(write?: AccountSnapshot): Promise<AccountSnapshot & { conflict?: boolean }> {
    const profile = this.channel().profile!, proof = this.proof;
    return registryLock(this.root, async () => {
      const registry = await readRegistry(this.root); authorizeUser(registry, profile.username, proof);
      if (this.profile !== profile || this.proof !== proof) throw new Error('账号已改变');
      // Local mode is an authorization test stub, not an OS-level privacy boundary.
      const file = await diskPath(this.root, `/.workbench-local/accounts/${profile.username}.json`, true);
      let current: AccountSnapshot = { revision: 0, records: {} };
      try { current = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (!write) return current;
      const records = accountRecordsSchema.parse(write.records);
      if (write.revision !== current.revision) return { ...current, conflict: true };
      const next = { revision: current.revision + 1, records }; await atomicJson(file, next); return next;
    });
  }
  private directionFile(username: string) { return `/.workbench-local/directions/${createHash('sha256').update(username).digest('hex')}.json`; }
  async memberDirections(directions?: unknown): Promise<DirectionDirectory> {
    const profile = this.channel().profile!, proof = this.proof;
    return registryLock(this.root, async () => {
      const registry = await readRegistry(this.root); authorizeUser(registry, profile.username, proof);
      if (this.profile !== profile || this.proof !== proof) throw new Error('账号已改变');
      const readOne = async (username: string) => {
        const file = await diskPath(this.root, this.directionFile(username), true);
        try { return savedDirectionsSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
        catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
      };
      if (directions) {
        const current = await readOne(profile.username);
        const next = { version: 1 as const, username: profile.username, updatedAt: new Date().toISOString(), directions: mergeDirectionUpdates(current?.directions || [], prepareDirectionSave(directions), new Date().toISOString()) };
        const file = await diskPath(this.root, this.directionFile(profile.username), true);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await atomicJson(file, next);
      }
      const members = [];
      for (const [username, user] of Object.entries(registry.state.users).sort(([a], [b]) => a.localeCompare(b, 'zh'))) {
        if (!user.enabled || user.missing || user.provisioning) continue;
        const stored = await readOne(username);
        members.push({ username, updatedAt: stored?.username === username ? stored.updatedAt : '', directions: stored?.username === username ? stored.directions : [] as DirectionRecord[] });
      }
      return directionDirectorySchema.parse({ version: 1, members });
    });
  }
  async accountFile(hash: string, local: string, upload: boolean) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('附件身份无效');
    const profile = this.channel().profile!, proof = this.proof;
    return registryLock(this.root, async () => {
      authorizeUser(await readRegistry(this.root), profile.username, proof);
      if (this.profile !== profile || this.proof !== proof) throw new Error('账号已改变');
      const file = await diskPath(this.root, `/.workbench-local/account-files/${profile.username}/${hash}`, true);
      if (upload) {
        const stat = await fs.lstat(local);
        if (!stat.isFile() || stat.size > 2 * 1024 ** 3 || await hashFile(local) !== hash) throw new Error('账号附件快照校验失败');
        await fs.mkdir(path.dirname(file), { recursive: true });
        try { await fs.copyFile(local, file, fs.constants.COPYFILE_EXCL); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
      } else { await fs.mkdir(path.dirname(local), { recursive: true }); await fs.copyFile(file, local, fs.constants.COPYFILE_EXCL); }
      if (await hashFile(upload ? file : local) !== hash) throw new Error('账号附件校验失败');
      return true;
    });
  }
  private async access(target: string, create = false) {
    const connection = this.channel(), proof = this.proof, profile = this.profile!;
    const data = await readRegistry(this.root);
    if (connection !== this.channel() || proof !== this.proof || profile !== this.profile) throw new Error('连接已改变');
    const user = authorizeUser(data, profile.username, proof);
    const group = Object.values(data.state.groups).find(g => !g.deletedAt && !g.purgedAt && g.workspace && withinRemote(g.workspace, target));
    if (!group || group.deletedAt || group.purgedAt || !user.groups?.includes(group.name)) throw new Error('模拟权限拒绝：不属于此项目组');
    if (create && !user.contentAdminGroups?.includes(group.name)) throw new Error('当前账号不是此工作路径的项目组管理员');
    return { user, group };
  }
  binding(id: string): RemoteBinding {
    const p = this.channel().profile!, project = p.projects.find(x => x.id === id);
    if (!project) throw new Error('项目入口不存在');
    return { connectionId: p.id, host: p.host, port: p.port, username: p.username, fingerprint: p.fingerprint, project: structuredClone(project) };
  }
  async verifyDirectory(target: string) {
    target = remotePath(target); await this.access(target);
    if (!(await fs.stat(await diskPath(this.root, target))).isDirectory()) throw new Error('工作路径必须是目录');
    return { path: target, canonicalPath: target };
  }
  async verifyWorkspace(target: string): Promise<WorkspaceAccess> {
    const checked = await this.verifyDirectory(target), { user, group } = await this.access(target);
    if (checked.path !== group.workspace) throw new Error('共享工作路径由所属工作组分配');
    this.workspace = { ...checked, canCreateProject: !!user.contentAdminGroups?.includes(group.name), groupName: group.name, groupLabel: group.label };
    this.changed(); return this.workspace;
  }
  private personal(p: Project): Project { return { ...p, managed: true, uploadPath: childRemote(p.remoteRoot, 'submissions') + '/' + this.profile!.username, historyPath: p.remoteRoot + '/trajectories/' + this.profile!.username }; }
  private async readProject(root: string, workspace?: WorkspaceAccess): Promise<Project | undefined> {
    const filename = root + '/.workbench-project.json';
    try {
      const file = await diskPath(this.root, filename), stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 256 * 1024) return;
      const meta = JSON.parse(await fs.readFile(file, 'utf8'));
      if (meta.version !== 1 || !/^project_[a-f0-9]{32}$/.test(meta.id)) return;
      return this.personal({ id: meta.id, name: projectName(meta.name), briefRevision: meta.briefRevision || 0, remoteRoot: root, uploadPath: root, historyPath: root, groupName: workspace?.groupName, groupLabel: workspace?.groupLabel });
    } catch (e: any) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
  }
  async discoverProjects() {
    const profile = this.channel().profile!, proof = this.proof;
    let data: Awaited<ReturnType<typeof readRegistry>>, user: ReturnType<typeof authorizeUser>;
    try { data = await readRegistry(this.root); user = authorizeUser(data, profile.username, proof); }
    catch (e) { if (this.profile === profile && this.proof === proof) { this.workspaces = []; this.workspace = undefined; profile.projects = []; this.changed(); } throw e; }
    const workspaces: WorkspaceAccess[] = [], projects: Project[] = [];
    for (const name of user.groups || []) {
      const group = data.state.groups[name]; if (!group || group.deletedAt || group.purgedAt) continue;
      const workspace: WorkspaceAccess = { path: group.workspace || '', canonicalPath: group.workspace || '', groupName: group.name, groupLabel: group.label, canCreateProject: false };
      workspaces.push(workspace);
      try {
        if (!group.workspace || group.provisioning) throw new Error('管理员尚未完成工作组目录配置');
        await this.verifyDirectory(group.workspace);
        workspace.role = groupRole(data.state, group, user.username); workspace.creator = group.creator?.username;
        workspace.canCreateProject = ['creator','manager'].includes(workspace.role || '');
        const entries = await fs.readdir(await diskPath(this.root, group.workspace), { withFileTypes: true });
        workspace.isEmpty = false;
        if (entries.length > 500) throw new Error('工作组目录超过 500 项，请联系管理员整理');
        const found: Project[] = [];
        for (const e of entries) if (!e.name.startsWith('.') && e.isDirectory() && !e.isSymbolicLink()) { const p = await this.readProject(childRemote(group.workspace, e.name), workspace); if (p) found.push(p); }
        workspace.isEmpty = found.length === 0;
        projects.push(...found);
      } catch (e: any) { workspace.accessError = e.message; workspace.canCreateProject = false; }
    }
    if (this.profile !== profile || this.proof !== proof || !this.connected) throw new Error('刷新期间连接已改变');
    this.workspaces = workspaces; this.workspace = workspaces[0]; profile.projects = projects; profile.workPath = ''; profile.manifestPath = '';
    this.changed(); return projects;
  }
  loadManifest() { return this.discoverProjects(); }
  async groupCommand(command: GroupCommand) {
    const profile = this.channel().profile!, proof = this.proof;
    const result = await registryLock(this.root, async () => {
      const data = await readRegistry(this.root); authorizeUser(data, profile.username, proof);
      if (this.profile !== profile || this.proof !== proof) throw new Error('账号已改变');
      return groupCommand(this.root, data, profile.username, command);
    });
    if (!['list','details','directory'].includes(command.action)) await this.loadManifest();
    this.changed(); return result;
  }

  async createProject(name: string, groupName?: string, rawBrief?: ProjectBrief, identifier?: string) {
    const brief = rawBrief === undefined ? undefined : projectBriefSchema.parse(rawBrief);
    await this.loadManifest();
    const workspace = groupName ? this.workspaces.find(w => w.groupName === groupName) : this.workspaces.length === 1 ? this.workspaces[0] : undefined;
    if (!workspace) throw new Error(this.workspaces.length ? '请选择要创建项目的工作组' : '还没有加入工作组，请联系管理员');
    if (workspace.accessError) throw new Error(workspace.accessError);
    const base = workspace.canonicalPath, { group } = await this.access(base, true);
    if (identifier && !/^project_[a-f0-9]{32}$/.test(identifier)) throw new Error('项目标识无效');
    const prior = identifier && this.profile!.projects.find(item => item.id === identifier);
    if (prior) { if (prior.groupName !== group.name) throw new Error('项目已关联到其他工作组'); return prior; }
    if (base !== group.workspace) throw new Error('只能在项目组工作路径中创建项目');
    const project = newProjectLayout(base, name), root = await diskPath(this.root, project.remoteRoot, true);
    if (identifier) project.id = identifier;
    const directories: string[] = [], files: string[] = [], createdAt = new Date().toISOString();
    const write = async (file: string, text: string) => { const handle = await fs.open(file, 'wx'); files.push(file); try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); } };
    try {
      await fs.mkdir(root); directories.push(root);
      for (const name of ['trajectories', 'submissions']) { const dir = path.join(root, name); await fs.mkdir(dir); directories.push(dir); }
      await write(path.join(root, '.workbench-content.json'), '[]');
      if (brief) await write(path.join(root, PROJECT_BRIEF_FILE), projectBriefMarkdown(project.name, brief, this.profile!.username, createdAt));
      await this.access(base, true);
      const marker = path.join(root, '.workbench-project.json');
      await write(marker, JSON.stringify({ version: 1, id: project.id, name: project.name, createdBy: this.profile!.username, createdAt, brief, briefRevision: brief ? 1 : 0 }));
    } catch (error) {
      for (const file of files.reverse()) await fs.unlink(file).catch(() => {});
      // Only directories reserved by this attempt, and only while still empty.
      for (const dir of directories.reverse()) await fs.rmdir(dir).catch(() => {});
      throw error;
    }
    workspace.isEmpty = false;
    const p = this.personal({ ...project, briefRevision: brief ? 1 : 0, groupName: group.name, groupLabel: group.label }); this.profile!.projects.push(p); this.changed(); return p;
  }
  private async checked(binding: RemoteBinding, target: string, write = false, missing = false) {
    this.channel(binding); target = assertRemote(binding.project.remoteRoot, target); await this.access(target);
    const p = binding.project, suffix = target.slice(p.remoteRoot.length).split('/').filter(Boolean), user = this.profile!.username;
    const attachmentBlob = !write && suffix[0] === '.workbench-attachments' && suffix.length === 3 && /^[a-f0-9]{64}$/.test(suffix[2]);
    if (suffix.some(s => s.startsWith('.')) && !attachmentBlob) throw new Error('模拟权限拒绝：管理记录不可操作');
    if (write && ['trajectories', 'submissions'].includes(suffix[0]) && suffix[1] !== user) { const { user: member, group } = await this.access(target); if (!member.contentAdminGroups?.includes(group.name)) throw new Error('模拟权限拒绝：不能修改他人的公共提交'); }
    const marker = await this.readProject(p.remoteRoot);
    if (!marker || marker.id !== p.id) throw new Error('项目身份已改变');
    const file = await diskPath(this.root, target, missing); this.channel(binding); return file;
  }
  async ensurePersonalFolder(binding: RemoteBinding, target: string) {
    const base = [binding.project.uploadPath, binding.project.historyPath].find(folder => target === folder || target.startsWith(folder + '/'));
    if (!base) { await this.checked(binding, target, true); return; }
    const personal = await this.checked(binding, base, true, true); await fs.mkdir(personal, { recursive: true });
    if (target !== base) { const nested = await this.checked(binding, target, true, true); await fs.mkdir(nested, { recursive: true }); }
  }
  async list(binding: RemoteBinding, target: string): Promise<RemoteEntry[]> {
    const dir = await this.checked(binding, target), entries = await fs.readdir(dir, { withFileTypes: true }), result: RemoteEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const stat = await fs.lstat(path.join(dir, e.name));
      result.push({ name: e.name, path: childRemote(target, e.name), kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtimeMs });
    }
    return result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
  }
  async preview(binding: RemoteBinding, target: string, displayName?: string): Promise<FilePreview> {
    const file = await this.checked(binding, target), stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('只能预览普通文件');
    const name = displayName || path.posix.basename(target), ext = path.extname(name).toLowerCase();
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const limit = mime[ext] && stat.size <= 5 * 1024 * 1024 ? 5 * 1024 * 1024 : 512 * 1024;
    const handle = await fs.open(file, 'r'); let data: Buffer;
    try { const buffer = Buffer.alloc(Math.min(stat.size, limit)); const { bytesRead } = await handle.read(buffer); data = buffer.subarray(0, bytesRead); } finally { await handle.close(); }
    await this.checked(binding, target);
    const type = mime[ext] && stat.size <= limit ? 'image' : data.includes(0) || ['.zip', '.pdf', '.exe', '.docx', '.xlsx'].includes(ext) ? 'binary' : 'text';
    return { name, path: target, type, content: type === 'image' ? `data:${mime[ext]};base64,${data.toString('base64')}` : type === 'text' ? data.toString('utf8') : '', size: stat.size, truncated: stat.size > limit };
  }
  async downloadInfo(binding: RemoteBinding, target: string) {
    const file = await this.checked(binding, target), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('只能下载普通文件');
    const sha256 = await hashFile(file);
    await this.checked(binding, target);
    return { sha256, size: stat.size };
  }
  async download(binding: RemoteBinding, target: string, local: string, progress = (_bytes: number, _total: number) => {}, expected?: { sha256: string; size: number }) {
    expected ||= await this.downloadInfo(binding, target);
    const file = await this.checked(binding, target), stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('只能下载普通文件');
    await fs.mkdir(path.dirname(local), { recursive: true }); const temp = local + '.' + randomUUID() + '.partial';
    try {
      await fs.copyFile(file, temp, fs.constants.COPYFILE_EXCL);
      if ((await fs.stat(temp)).size !== expected.size || await hashFile(temp) !== expected.sha256) throw new Error('远端文件内容已改变或下载不完整，请重新选择该文件');
      await this.checked(binding, target); await fs.rename(temp, local); progress(expected.size, expected.size);
    }
    finally { await fs.rm(temp, { force: true }); }
  }
  async projectBrief(binding: RemoteBinding) {
    this.channel(binding); await this.access(binding.project.remoteRoot);
    const meta = JSON.parse(await fs.readFile(await diskPath(this.root, binding.project.remoteRoot + '/.workbench-project.json'), 'utf8'));
    if (meta.id !== binding.project.id) throw new Error('项目身份已改变');
    return { brief: meta.brief, revision: meta.briefRevision || 0, updatedAt: meta.briefUpdatedAt || meta.createdAt };
  }
  async saveProjectBrief(binding: RemoteBinding, input: ProjectBrief, revision: number) {
    const brief = projectBriefSchema.parse(input);
    return registryLock(this.root, async () => {
      this.channel(binding); await this.access(binding.project.remoteRoot, true);
      const filename = await diskPath(this.root, binding.project.remoteRoot + '/.workbench-project.json');
      const meta = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (meta.id !== binding.project.id || (meta.briefRevision || 0) !== revision) throw new Error('项目资料已更新，请刷新后再保存');
      const updatedAt = new Date().toISOString(), markdown = projectBriefMarkdown(binding.project.name, brief, binding.username, updatedAt);
      const history = await diskPath(this.root, binding.project.remoteRoot + '/.brief-versions', true); await fs.mkdir(history, { recursive: true });
      await fs.writeFile(path.join(history, (revision + 1) + '.md'), markdown);
      await fs.writeFile(await diskPath(this.root, binding.project.remoteRoot + '/' + PROJECT_BRIEF_FILE, true), markdown);
      await atomicJson(filename, { ...meta, brief, briefRevision: revision + 1, briefUpdatedAt: updatedAt });
      return { brief, revision: revision + 1, updatedAt };
    });
  }
  private assignments() {
    return new AssignmentFiles(this.root, async binding => {
      this.channel(binding); const { user, group } = await this.access(binding.project.remoteRoot);
      if ((await this.readProject(binding.project.remoteRoot))?.id !== binding.project.id) throw new Error('项目身份已改变');
      const data = await readRegistry(this.root);
      const members = Object.values(data.state.users).filter(item => item.enabled && !item.missing && !item.provisioning && item.groups?.includes(group.name)).map(item => ({ username: item.username, name: item.name || item.username }));
      return { username: user.username, admin: !!user.contentAdminGroups?.includes(group.name), members };
    });
  }
  questionRequest(binding: RemoteBinding, command?: QuestionCommand | 'members') {
    return new QuestionFiles(this.root, async binding => {
      this.channel(binding); const { user, group } = await this.access(binding.project.remoteRoot);
      if ((await this.readProject(binding.project.remoteRoot))?.id !== binding.project.id) throw new Error('项目身份已改变');
      const data = await readRegistry(this.root);
      const members = Object.values(data.state.users).filter(item => item.enabled && !item.missing && !item.provisioning && item.groups?.includes(group.name)).map(item => ({ username: item.username, name: item.name || item.username }));
      return { username: user.username, members };
    }).request(binding, command);
  }
  assignmentMembers(binding: RemoteBinding) { return this.assignments().members(binding); }
  assignmentList(binding: RemoteBinding) { return this.assignments().list(binding); }
  assignmentCreate(binding: RemoteBinding, input: AssignmentCreate) { return this.assignments().create(binding, input); }
  assignmentUpload(binding: RemoteBinding, taskId: string, file: AssignmentUpload, local: string) { return this.assignments().upload(binding, taskId, file, local); }
  assignmentDownload(binding: RemoteBinding, taskId: string, fileId: string, local: string) { return this.assignments().download(binding, taskId, fileId, local); }
  assignmentStatus(binding: RemoteBinding, input: AssignmentStatusChange) { return this.assignments().status(binding, input); }
  private content() { return new ContentFiles(this.root, async binding => { this.channel(binding); const { user, group } = await this.access(binding.project.remoteRoot); const project = await this.readProject(binding.project.remoteRoot); if (project?.id !== binding.project.id) throw new Error('项目身份已改变'); return { username: user.username, admin: !!user.contentAdminGroups?.includes(group.name), destination: { projectId: project.id, projectName: project.name, groupName: group.name, groupLabel: group.label || group.name } }; }); }
  contentList(binding: RemoteBinding) { return this.content().list(binding); }
  contentHistory(binding: RemoteBinding, id?: string, revision?: number, summary = false) { return this.content().history(binding, id, revision, summary); }
  contentMerge(binding: RemoteBinding, change: ContentMerge) { return this.content().merge(binding, change); }
  contentAdopt(binding: RemoteBinding, target: string) { return this.content().adopt(binding, target); }
  contentEdit(binding: RemoteBinding, change: ContentEdit) { return this.content().edit(binding, change); }
  contentReap(binding: RemoteBinding) { return this.content().reap(binding); }
  contentReplace(binding: RemoteBinding, change: ContentEdit, file: string) { return this.content().edit(binding, change, file); }
  async uploadAttachment(binding: RemoteBinding, local: string, hash: string, progress: (bytes: number, total: number) => void, _requestId?: string, phase?: (value: import('../shared/types').TransferPhase) => Promise<void> | void) {
    this.channel(binding); await phase?.('streaming'); const item = await this.content().publishAttachment(binding, local, hash); progress(item.size, item.size); await phase?.('verifying'); return item;
  }
  async upload(binding: RemoteBinding, local: string, target: string, progress: (bytes: number, total: number) => void, metadata?: ContentMetadata, hash?: string, _requestId?: string, phase?: (value: import('../shared/types').TransferPhase) => Promise<void> | void) {
    await this.checked(binding, target, true, true); await phase?.('streaming');
    const item = await this.content().publish(binding, local, target, metadata, hash); progress(item.size, item.size); await phase?.('verifying'); return item;
  }
}
