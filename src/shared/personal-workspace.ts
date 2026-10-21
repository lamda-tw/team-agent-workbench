import type { AgentSession, ConnectionProfile, RemoteBinding, WorkspaceSnapshot } from './types';

export const PERSONAL_PROJECT_ID = '__personal__';
export function personalFamilyIds(sessions: AgentSession[], seeds: string[]) {
  const selected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) if (session.parentId && isPersonalBinding(session.binding) && (selected.has(session.id) || selected.has(session.parentId))) {
      for (const id of [session.id, session.parentId]) if (!selected.has(id)) { selected.add(id); changed = true; }
    }
  }
  return selected;
}
export interface PersonalGroup { id: string; name: string }
export const personalProfile: ConnectionProfile = {
  id: PERSONAL_PROJECT_ID, name: '未分项目', host: 'personal', port: 22, username: 'local', fingerprint: 'PERSONAL', manifestPath: '',
  projects: [{ id: PERSONAL_PROJECT_ID, name: '未分项目', remoteRoot: '/personal', uploadPath: '/personal/results', historyPath: '/personal/history' }],
};
// A local namespace for existing preparation/result records; never an SSH connection or a team account.
export function personalWorkspace(): WorkspaceSnapshot { return { profile: structuredClone(personalProfile), workspaces: [] }; }
export function personalBinding(project = personalProfile.projects[0]): RemoteBinding { return { connectionId: personalProfile.id, host: personalProfile.host, port: 22, username: 'local', fingerprint: 'PERSONAL', project: structuredClone(project) }; }
export function isPersonalBinding(binding?: RemoteBinding) { return binding?.connectionId === PERSONAL_PROJECT_ID && binding.host === 'personal' && binding.fingerprint === 'PERSONAL'; }
