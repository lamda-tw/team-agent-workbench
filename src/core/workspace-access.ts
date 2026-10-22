import type { ConnectionProfile, RemoteBinding, WorkspaceAccess, WorkspaceSnapshot } from '../shared/types';
import { sameEndpoint } from './sftp';
export function makeWorkspaceSnapshot(profile: ConnectionProfile, workspaces: WorkspaceAccess[]): WorkspaceSnapshot {
  // Clone: the live profile is mutated in place by later manifest refreshes.
  return { profile: structuredClone(profile), workspaces: structuredClone(workspaces) };
}
// A disconnected workbench may only keep working on what the last sync actually granted.
export function assertKnownWorkspace(binding: RemoteBinding | undefined, snapshot?: WorkspaceSnapshot) {
  if (!binding || !snapshot || !sameEndpoint(binding, snapshot.profile) || !snapshot.workspaces.some(w => !w.accessError && w.groupName === binding.project.groupName) || !snapshot.profile.projects.some(p => p.id === binding.project.id && p.remoteRoot === binding.project.remoteRoot)) throw new Error('此项目不在最近一次同步的工作组清单中，请重新连接中央节点核验；已有记录仍可查看');
}
