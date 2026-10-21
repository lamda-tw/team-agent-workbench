import { z } from 'zod';
import { groupCommandSchema } from '../shared/team-groups';
import { accountNameSchema, accountPasswordSchema } from '../shared/accounts';
import { groupLabelMessage, groupLabelPattern } from '../shared/groups';
import type { AdminEgressSnapshot } from '../shared/egress';
import { memberApplySchema, memberSyncSchema, type MemberSyncView } from './member-protocol';

const egressTargetFields = {
  host: z.string().trim().min(1).max(253).refine(value => !value.includes('%') && (z.ipv6().safeParse(value).success || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) && !value.includes('..')), '请输入主机名或 IP，不含协议、路径、通配符和方括号'),
  port: z.number().int().min(1).max(65535),
};
export const adminProfileSchema = z.object({
  teamId: z.string().min(1).max(128).optional(),
  mode: z.enum(['sftp', 'local']).optional(), localRoot: z.string().optional(),
  host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535),
  username: z.string().max(64).default(''), fingerprint: z.string().default(''),
  root: z.string().regex(/^\/(?:[^\x00\r\n\\/]+\/)+[^\x00\r\n\\/]+$/).default('/srv/teamspace'),
}).refine(profile => profile.mode === 'local' || !!profile.username.trim(), { path: ['username'], message: '请输入服务器管理账号' });
export const adminConnectSchema = z.object({
  profile: adminProfileSchema, password: z.string().max(4096).default(''), sudoPassword: z.string().max(4096).default(''),
}).refine(input => input.profile.mode === 'local' || !!input.password, { path: ['password'], message: '请输入服务器登录密码' });
export type AdminProfile = z.infer<typeof adminProfileSchema>;
export type ManagedUser = { username: string; revision?: string; accessVersion?: string; systemUsername?: string; name: string; enabled: boolean; mustChangePassword?: boolean; accountId?: string; identity?: string; marker?: string; uid?: number; groups?: string[]; contentAdminGroups?: string[]; missing?: boolean; provisioning?: boolean };
export type ManagedGroup = AdminState['groups'][string];
export type AdminJob = { id: string; op: string; request: Record<string, any>; status: 'running' | 'failed' | 'done'; completed: string[]; error?: string };
export type AdminState = { initialized: boolean; egressJumpTargets?: { host: string; port: number }[]; bootstrapPending?: boolean; operations?: Record<string, AdminJob>; storageVersion?: number; teamId?: string; loginGroup?: string; sftpConfigured?: boolean; users: Record<string, ManagedUser>; groups: Record<string, { name: string; label: string; adminGroup: string; workspace?: string; provisioning?: boolean; creator?: { username: string; identity: string }; createdBy?: string; createdAt?: string; deletedAt?: string; deletedBy?: string; recyclePath?: string; purgeStartedAt?: string; purgedAt?: string }> };
export type AdminSnapshot = { memberSync?: MemberSyncView; profile?: AdminProfile; connectionError?: string; connected: boolean; verified: boolean; busy: boolean; actor?: string; role?: 'administrator'; state?: AdminState; missingCommands?: string[]; setupIssues?: string[]; setupNotes?: string[]; aclBackend?: 'setfacl' | 'libacl' | null; serviceManager?: 'systemd' | 'supervisor' | null; egress?: AdminEgressSnapshot };
export type StorageMetrics = { bytes: number; files: number; directories: number; directBytes: number; modifiedAt?: string };
export type StorageCategoryKey = 'submissions' | 'trajectories' | 'curated' | 'project' | 'system' | 'unassigned';
export type StorageCategoryUsage = StorageMetrics & { key: StorageCategoryKey; label: string };
export type StorageGroupUsage = StorageMetrics & {
  id: string; label: string; path: string; projects: number; members: number;
  submissionsBytes: number; trajectoriesBytes: number; curatedBytes: number; projectBytes: number; unassignedBytes: number;
};
export type StorageUserUsage = StorageMetrics & { username: string; name: string; groups: string[]; submissionsBytes: number; trajectoriesBytes: number };
export type StorageFolderUsage = StorageMetrics & { name: string; path: string };
export type StorageUsageReport = {
  scannedAt: string; path: string; name: string; total: StorageMetrics;
  volume: { totalBytes: number; freeBytes: number };
  categories: StorageCategoryUsage[]; groups: StorageGroupUsage[]; users: StorageUserUsage[];
  children: StorageFolderUsage[]; childCount: number; offset: number; limit: number;
  warningCount: number; warnings: { path: string; message: string }[];
};
export const storageScanSchema = z.object({
  path: z.string().max(2048).default('').refine(value => !value || (!value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value === value.split('/').filter(Boolean).join('/') && !value.split('/').some(part => part === '.' || part === '..')), '目录必须位于共享空间内'),
  offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(200).default(100),
});
export type StorageScanRequest = z.infer<typeof storageScanSchema>;
export const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, '系统组名需以小写字母开头，最多 32 位，可包含数字、下划线和短横线');
// Normalize before checking so the value that travels to the server is the one that was validated.
export const groupLabelSchema = z.string().max(48).transform(value => value.normalize('NFC')).refine(value => groupLabelPattern.test(value), groupLabelMessage);
const password = accountPasswordSchema;
export const adminOperationSchema = z.discriminatedUnion('op', [
  memberApplySchema, memberSyncSchema,
  z.object({ op: z.literal('egress_jump'), ...egressTargetFields, enabled: z.boolean() }),
  z.object({ op: z.literal('egress_jump_probe'), ...egressTargetFields }),
  z.object({ op: z.literal('environment_prepare'), source: z.enum(['online', 'offline']), packageDirectory: z.string().max(2048).optional() }).refine(value => value.source !== 'offline' || !!value.packageDirectory?.startsWith('/'), '请填写服务器上的离线软件包绝对目录'),
  z.object({ op: z.literal('group_control'), command: groupCommandSchema }),
  z.object({ op: z.literal('status') }), z.object({ op: z.literal('initialize') }), z.object({ op: z.literal('storage_upgrade') }),
  z.object({ op: z.literal('user_create'), username: accountNameSchema, name: z.string().max(120), password: password.default('123456'), groups: z.array(nameSchema).optional(), contentAdminGroups: z.array(nameSchema).optional() }),
  z.object({ op: z.literal('recover'), operationId: z.string().min(1).max(160), password: password.optional() }),
  z.object({ op: z.literal('user_password'), username: accountNameSchema, password }),
  z.object({ op: z.literal('user_enabled'), username: accountNameSchema, enabled: z.boolean() }),
  z.object({ op: z.literal('workspace_prepare'), group: nameSchema }),
  z.object({ op: z.literal('group_create'), label: groupLabelSchema }),
  z.object({ op: z.literal('user_groups'), username: accountNameSchema, groups: z.array(nameSchema).max(100), contentAdminGroups: z.array(nameSchema).max(100).default([]) }),
  z.object({ op: z.literal('group_member'), username: accountNameSchema, group: nameSchema, role: z.enum(['member', 'admin', 'remove']) }),
]).and(z.object({ handoffs: z.record(z.string(), accountNameSchema.nullable()).optional() }));
export type AdminOperation = z.infer<typeof adminOperationSchema>;
