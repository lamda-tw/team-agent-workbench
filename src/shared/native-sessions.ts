export interface NativeSessionGroup { id: string; name: string; position: number; kind?: 'project' | 'section' | 'workspace'; hostId?: string; hostName?: string; error?: string }
export interface NativeSessionEntry { nativeId: string; name: string; groupId?: string; cwd: string; updatedAt: number; linkedSessionId?: string; unavailable?: string; hostId?: string; hostName?: string }
export interface NativeSessionCatalog { provider: 'codex' | 'cursor'; groups: NativeSessionGroup[]; sessions: NativeSessionEntry[] }
export interface NativeSessionSelection { nativeId: string; hostId?: string }
export const nativeSelectionKey = (session: NativeSessionSelection) => session.hostId ? JSON.stringify([session.hostId, session.nativeId.toLowerCase()]) : session.nativeId.toLowerCase();

export const canImportNativeSession = (session: NativeSessionEntry) => !session.linkedSessionId && !session.unavailable;
