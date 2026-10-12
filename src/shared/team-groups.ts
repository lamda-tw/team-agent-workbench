import { z } from 'zod';
import { accountNameSchema } from './accounts';
import { groupLabelPattern, groupLabelMessage } from './groups';

export type GroupRole = 'creator' | 'manager' | 'member';
export const groupRoleLabels: Record<GroupRole, string> = { creator: '创建者', manager: '管理者', member: '成员' };
const group = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const groupCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), label: z.string().trim().transform(value => value.normalize('NFC')).refine(value => groupLabelPattern.test(value), groupLabelMessage), creator: accountNameSchema.optional() }),
  z.object({ action: z.literal('details'), group }),
  z.object({ action: z.literal('directory'), group }),
  z.object({ action: z.literal('member'), group, revision, username: accountNameSchema, role: z.enum(['manager', 'member', 'remove']) }),
  z.object({ action: z.literal('transfer'), group, revision, username: accountNameSchema }),
  z.object({ action: z.literal('delete'), group, revision }),
  z.object({ action: z.literal('restore'), group, revision }),
  z.object({ action: z.literal('purge'), group, revision }),
  z.object({ action: z.literal('resume'), group, revision })
]);
export type GroupCommand = z.infer<typeof groupCommandSchema>;
export interface GroupMember { username: string; name: string; enabled: boolean; role: GroupRole }
export interface TeamGroup {
  id: string; label: string; revision: string; role?: GroupRole; creator?: string; createdBy?: string;
  deletedAt?: string; deletedBy?: string; purgeStartedAt?: string; provisioning?: boolean; members: GroupMember[];
  projects: { id: string; name: string }[]; bytes: number;
}
