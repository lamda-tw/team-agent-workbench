import { z } from 'zod';
import type { ConnectionProfile } from './types';

export const accountRecordsSchema = z.record(z.string().regex(/^(material|draft|alias|update|seen|dismissed|result-rules):[^\x00-\x1f]{1,500}$/), z.unknown()).refine(data => new TextEncoder().encode(JSON.stringify(data)).length <= 2 * 1024 * 1024, '账号资料超过 2 MB，请清理不再需要的历史资料');
export type AccountRecords = Record<string, any>;
export interface AccountSnapshot { revision: number; records: AccountRecords }
export interface AccountSyncState { status: 'offline' | 'pending' | 'syncing' | 'synced' | 'error' | 'conflict'; detail?: string; syncedAt?: string; conflicts?: import('./sync-conflict').SyncConflict[]; history?: { id: string; key: string; at: string; method: string }[] }
export function accountIdentity(profile: Pick<ConnectionProfile, 'host' | 'port' | 'username' | 'fingerprint'>) { return JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username, profile.fingerprint]); }
