import type { ConnectionProfile, RemoteBinding, WorkspaceSnapshot } from './types';

export const PERSONAL_PROJECT_ID = '__personal__';
export interface PersonalGroup { id: string; name: string }
export const personalProfile: ConnectionProfile = {
  id: PERSONAL_PROJECT_ID, name: '未分项目', host: 'personal', port: 22, username: 'local', fingerprint: 'PERSONAL', manifestPath: '',
  projects: [{ id: PERSONAL_PROJECT_ID, name: '未分项目', remoteRoot: '/personal', uploadPath: '/personal/results', historyPath: '/personal/history' }],
};
// A local namespace for existing preparation/result records; never an SSH connection or a team account.
export function personalWorkspace(): WorkspaceSnapshot { return { profile: structuredClone(personalProfile), workspaces: [] }; }
export function personalBinding(): RemoteBinding { return { connectionId: personalProfile.id, host: personalProfile.host, port: 22, username: 'local', fingerprint: 'PERSONAL', project: structuredClone(personalProfile.projects[0]) }; }
export function isPersonalBinding(binding?: RemoteBinding) { return binding?.connectionId === PERSONAL_PROJECT_ID && binding.host === 'personal' && binding.fingerprint === 'PERSONAL'; }
