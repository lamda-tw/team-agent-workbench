export interface NativeSessionGroup { id: string; name: string; position: number }
export interface NativeSessionEntry { nativeId: string; name: string; groupId?: string; cwd: string; updatedAt: number; linkedSessionId?: string; unavailable?: string }
export interface NativeSessionCatalog { provider: 'codex' | 'cursor'; groups: NativeSessionGroup[]; sessions: NativeSessionEntry[] }
