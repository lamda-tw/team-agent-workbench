import type { QuestionCommand, QuestionMember, TeamQuestion } from '../shared/questions';
import type { GroupCommand } from '../shared/team-groups';
import type { ContentEdit, ContentMerge, ContentMetadata } from '../shared/content';
import type { SharedServerRoute } from '../shared/egress';
import type { AccountSnapshot } from '../shared/account-data';
import { SftpConnection } from './sftp';
import { LocalFileConnection } from './local-files';
import type { ConnectionProfile, RemoteBinding, TransferPhase } from '../shared/types';
import type { ProjectBrief } from '../shared/project-brief';
import type { AssignmentCreate, AssignmentStatusChange, AssignmentUpload } from '../shared/assignments';

export class SharedFiles {
  private backend: SftpConnection | LocalFileConnection;
  constructor(private changed: () => void) { this.backend = new SftpConnection(() => this.changed()); }
  get profile() { return this.backend.profile; }
  get workspaces() { return this.backend.workspaces; }
  get workspace() { return this.backend.workspace; }
  get connected() { return this.backend.connected; }
  async connect(profile: ConnectionProfile, password: string, trust: (s: string) => Promise<boolean>) {
    this.disconnect(); this.backend = profile.mode === 'local' ? new LocalFileConnection(() => this.changed()) : new SftpConnection(() => this.changed());
    return this.backend.connect(profile, password, trust);
  }
  adoptConnection(source: SharedFiles) {
    if (source === this || !source.connected || !source.profile) throw new Error('已验证的账号连接不可用，请重新登录');
    const profile = source.profile;
    this.disconnect(); this.backend = source.backend;
    source.changed = () => this.changed();
    source.backend = new SftpConnection(() => source.changed());
    return profile;
  }
  disconnect() { this.backend.disconnect(); }
  openEgressTunnel(host: string, port: number, signal: AbortSignal, expectedServer?: SharedServerRoute) {
    if (!(this.backend instanceof SftpConnection)) throw new Error('本地共享目录不支持中转，请登录共享服务器');
    if (expectedServer && this.profile && (this.profile.host.toLowerCase() !== expectedServer.host.toLowerCase() || this.profile.port !== expectedServer.port || this.profile.fingerprint !== expectedServer.fingerprint)) throw new Error('当前共享服务器与中转接入码不匹配，请登录接入码对应的服务器');
    return this.backend.openEgressTunnel(host, port, signal);
  }
  accountData(write?: AccountSnapshot) { return this.backend.accountData(write); }
  memberDirections(directions?: unknown) { return this.backend.memberDirections(directions); }
  accountFile(hash: string, local: string, upload: boolean) { return this.backend.accountFile(hash, local, upload); }
  channel(binding?: RemoteBinding) { return this.backend.channel(binding); }
  binding(id: string) { return this.backend.binding(id); }
  verifyWorkspace(target: string) { return this.backend.verifyWorkspace(target); }
  loadManifest() { return this.backend.loadManifest(); }
  groupCommand(command: GroupCommand) { return this.backend.groupCommand(command); }
  createProject(name: string, groupName?: string, brief?: ProjectBrief) { return this.backend.createProject(name, groupName, brief); }
  contentList(binding: RemoteBinding) { return this.backend.contentList(binding); }
  contentHistory(binding: RemoteBinding, id?: string, revision?: number, summary = false) { return this.backend.contentHistory(binding, id, revision, summary); }
  contentMerge(binding: RemoteBinding, change: ContentMerge) { return this.backend.contentMerge(binding, change); }
  questionRequest(binding: RemoteBinding, command?: QuestionCommand | 'members'): Promise<TeamQuestion[] | TeamQuestion | QuestionMember[]> { return this.backend.questionRequest(binding, command); }
  assignmentMembers(binding: RemoteBinding) { return this.backend.assignmentMembers(binding); }
  assignmentList(binding: RemoteBinding) { return this.backend.assignmentList(binding); }
  assignmentCreate(binding: RemoteBinding, input: AssignmentCreate) { return this.backend.assignmentCreate(binding, input); }
  assignmentUpload(binding: RemoteBinding, taskId: string, file: AssignmentUpload, local: string) { return this.backend.assignmentUpload(binding, taskId, file, local); }
  assignmentDownload(binding: RemoteBinding, taskId: string, fileId: string, local: string) { return this.backend.assignmentDownload(binding, taskId, fileId, local); }
  assignmentStatus(binding: RemoteBinding, input: AssignmentStatusChange) { return this.backend.assignmentStatus(binding, input); }
  contentAdopt(binding: RemoteBinding, target: string) { return this.backend.contentAdopt(binding, target); }
  contentEdit(binding: RemoteBinding, change: ContentEdit) { return this.backend.contentEdit(binding, change); }
  contentReap(binding: RemoteBinding) { return this.backend.contentReap(binding); }
  contentReplace(binding: RemoteBinding, change: ContentEdit, file: string) { return this.backend.contentReplace(binding, change, file); }
  projectBrief(binding: RemoteBinding) { return this.backend.projectBrief(binding); }
  saveProjectBrief(binding: RemoteBinding, brief: ProjectBrief, revision: number) { return this.backend.saveProjectBrief(binding, brief, revision); }
  ensurePersonalFolder(binding: RemoteBinding, target: string) { return this.backend.ensurePersonalFolder(binding, target); }
  list(binding: RemoteBinding, target: string) { return this.backend.list(binding, target); }
  preview(binding: RemoteBinding, target: string, displayName?: string) { return this.backend.preview(binding, target, displayName); }
  uploadAttachment(binding: RemoteBinding, local: string, hash: string, progress: (bytes: number, total: number) => void, requestId?: string, phase?: (value: TransferPhase) => Promise<void> | void) { return this.backend.uploadAttachment(binding, local, hash, progress, requestId, phase); }
  downloadInfo(binding: RemoteBinding, target: string) { return this.backend.downloadInfo(binding, target); }
  download(binding: RemoteBinding, target: string, local: string, progress?: (bytes: number, total: number) => void, expected?: { sha256: string; size: number }) { return this.backend.download(binding, target, local, progress, expected); }
  upload(binding: RemoteBinding, local: string, target: string, progress: (bytes: number, total: number) => void, metadata?: ContentMetadata, hash?: string, requestId?: string, phase?: (value: TransferPhase) => Promise<void> | void) { return this.backend.upload(binding, local, target, progress, metadata, hash, requestId, phase); }
}
