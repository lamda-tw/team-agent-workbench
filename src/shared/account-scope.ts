import { accountIdentity } from './account-data';
import { projectDirectoryKey } from './project-directory';
import type { ConnectionProfile, Project, RemoteBinding, Snapshot } from './types';

export function ownsBinding(profile: ConnectionProfile | undefined, binding: RemoteBinding | undefined): boolean {
  return !!profile && !!binding && accountIdentity(profile) === accountIdentity(binding);
}

// Local conversation ownership survives a changed central project directory.
// Never infer ownership from a project name, username alone or an unbound record.
export function ownedLocalProjects(profile: ConnectionProfile | undefined, records: readonly { binding?: RemoteBinding }[]): Project[] {
  const projects = new Map<string, Project>();
  for (const { binding } of records) if (binding?.project?.id && ownsBinding(profile, binding) && !projects.has(binding.project.id)) projects.set(binding.project.id, { ...binding.project });
  return [...projects.values()];
}

export function snapshotAccountKey(snapshot: Snapshot): string {
  const profile = snapshot.connection?.connected ? snapshot.connection.profile : snapshot.settings.workspaceSnapshot?.profile;
  return profile ? accountIdentity(profile) : '';
}

// Keep every account on disk, but send only the active account's records to the renderer.
export function scopeAccountSnapshot(snapshot: Snapshot): Snapshot {
  const profile = snapshot.connection?.connected ? snapshot.connection.profile : snapshot.settings.workspaceSnapshot?.profile;
  const owns = (binding?: RemoteBinding) => !snapshot.accountChanging && ownsBinding(profile, binding);
  const sessions = snapshot.sessions.filter(session => owns(session.binding));
  const ids = new Set(sessions.map(session => session.id));
  const owner = profile ? accountIdentity(profile) : '';
  const directoryKeys = new Set(profile?.projects.map(project => projectDirectoryKey(profile, project.id)));
  const settings = { ...snapshot.settings,
    betaFeatures: Object.fromEntries(Object.entries(snapshot.settings.betaFeatures || {}).filter(([key]) => !snapshot.accountChanging && key === owner)),
    projectDirectories: Object.fromEntries(Object.entries(snapshot.settings.projectDirectories || {}).filter(([key]) => !snapshot.accountChanging && directoryKeys.has(key))),
    ...(snapshot.accountChanging ? { contentAliases: {}, contentSeen: {}, contentUpdates: [], dismissedContentUpdateIds: [] } : {}),
  };
  return { ...snapshot, settings, sessions, sideChats: (snapshot.sideChats || []).filter(chat => ids.has(chat.parentId)), activity: { jobs: (snapshot.activity?.jobs || []).filter(j => ids.has(j.sessionId) && j.owner === owner), busy: !snapshot.accountChanging && !!snapshot.activity?.busy, error: snapshot.accountChanging ? undefined : snapshot.activity?.error },
    inputs: Object.fromEntries(Object.entries(snapshot.inputs).filter(([id]) => ids.has(id))),
    activeTurns: Object.fromEntries(Object.entries(snapshot.activeTurns || {}).filter(([id]) => ids.has(id))),
    drafts: snapshot.drafts.filter(draft => draft.binding ? owns(draft.binding) : ids.has(draft.sessionId)),
    transfers: snapshot.transfers.filter(transfer => owns(transfer.binding)),
    ...(snapshot.accountChanging ? { projectSync: {}, questions: { items: [], read: {}, jobs: [] }, accountSync: { status: 'pending' as const } } : {}),
  };
}
