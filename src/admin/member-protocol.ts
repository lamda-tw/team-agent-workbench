import { z } from 'zod';
import { accountNameSchema, accountPasswordSchema } from '../shared/accounts';
import type { AdminState, ManagedUser } from './types';

const group = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const version = z.string().min(1).max(128);
const handoffs = z.record(z.string(), accountNameSchema.nullable()).optional();
const handoffRevisions = z.record(z.string(), version).optional();
export const memberCreateSchema = z.object({ op: z.literal('user_create'), username: accountNameSchema, name: z.string().max(120), groups: z.array(group).max(100).default([]), contentAdminGroups: z.array(group).max(100).default([]) });
export const memberCommandSchema = z.discriminatedUnion('op', [
  memberCreateSchema,
  z.object({ op: z.literal('user_password'), username: accountNameSchema, password: accountPasswordSchema, expectedRevision: version }),
  z.object({ op: z.literal('user_enabled'), username: accountNameSchema, enabled: z.boolean(), expectedRevision: version, handoffs, handoffRevisions }),
  z.object({ op: z.literal('member_groups'), username: accountNameSchema, expectedRevision: version, changes: z.array(z.object({ group, role: z.enum(['member', 'admin', 'remove']) })).max(100), handoffs, handoffRevisions }),
  z.object({ op: z.literal('recover'), operationId: z.string().min(1).max(160), username: accountNameSchema, expectedRevision: version, password: accountPasswordSchema.optional() }),
]);
export type MemberCommand = z.infer<typeof memberCommandSchema>;
export type MemberCreate = z.infer<typeof memberCreateSchema>;
export const memberApplySchema = z.object({ op: z.literal('members_apply'), teamId: version, requestId: z.string().uuid(), command: memberCommandSchema });
export const memberSyncSchema = z.object({ op: z.literal('members_sync'), teamId: version.optional(), since: z.number().int().nonnegative().optional(), requestIds: z.array(z.string().uuid()).max(1000).optional() });
export type MemberApply = z.infer<typeof memberApplySchema>;
export type MemberDelta = { protocol: 1; teamId: string; sequence: number; full: boolean; users: AdminState['users']; groups: AdminState['groups']; deletedUsers: string[]; deletedGroups: string[]; receipts?: Record<string, 'running' | 'done' | 'failed'>; metadata?: Omit<AdminState, 'users' | 'groups'> };
export type PendingMember = { id: string; command: MemberCreate; status: 'pending' | 'blocked'; createdAt: string; error?: string };
export type MemberSyncView = { teamId?: string; lastSyncedAt?: string; error?: string; pending: PendingMember[] };

export function membershipChanges(base: ManagedUser, groups: string[], admins: string[]) {
  const role = (name: string, member: string[] = [], admin: string[] = []) => !member.includes(name) ? 'remove' as const : admin.includes(name) ? 'admin' as const : 'member' as const;
  return [...new Set([...(base.groups || []), ...groups])].filter(name => role(name, base.groups, base.contentAdminGroups) !== role(name, groups, admins)).map(group => ({ group, role: role(group, groups, admins) }));
}
export function rebaseMembership(base: ManagedUser, current: ManagedUser, groups: string[], admins: string[]) {
  const nextGroups = new Set(current.groups || []), nextAdmins = new Set(current.contentAdminGroups || []);
  for (const change of membershipChanges(base, groups, admins)) {
    if (change.role === 'remove') nextGroups.delete(change.group); else nextGroups.add(change.group);
    if (change.role === 'admin') nextAdmins.add(change.group); else nextAdmins.delete(change.group);
  }
  return { groups: [...nextGroups], admins: [...nextAdmins] };
}
export function applyMemberDelta(state: AdminState | undefined, delta: MemberDelta): AdminState {
  if (delta.protocol !== 1 || !delta.teamId || (!delta.full && state?.teamId !== delta.teamId)) throw new Error('成员同步响应与当前团队不一致');
  const next: AdminState = { initialized: true, ...(delta.full ? {} : state), ...delta.metadata, teamId: delta.teamId, users: { ...(delta.full ? {} : state?.users), ...delta.users }, groups: { ...(delta.full ? {} : state?.groups), ...delta.groups } };
  for (const name of delta.deletedUsers) delete next.users[name];
  for (const name of delta.deletedGroups) delete next.groups[name];
  return next;
}
