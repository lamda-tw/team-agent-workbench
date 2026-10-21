import { createHash, randomUUID, scryptSync } from 'node:crypto';
import type { AdminState } from './types';
import type { MemberApply, MemberDelta } from './member-protocol';

type Index = { sequence: number; users: Record<string, { revision: string; at: number }>; groups: Record<string, { revision: string; at: number }>; metadata?: { revision: string; at: number } };
type Receipt = { signature: string; status: 'running' | 'done' | 'failed'; passwordSalt?: string; passwordHash?: string };
export type MemberRegistryState = AdminState & { memberIndex?: Index; memberRequests?: Record<string, Receipt> };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function memberPublicState(state: MemberRegistryState): AdminState {
  const { memberIndex: _index, memberRequests: _requests, ...value } = structuredClone(state);
  for (const user of Object.values(value.users)) {
    const { revision: _revision, ...fields } = user;
    user.revision = hash({ ...fields, groups: [...(user.groups || [])].sort(), contentAdminGroups: [...(user.contentAdminGroups || [])].sort() });
  }
  return value;
}
export function memberDelta(state: MemberRegistryState, teamId?: string, since?: number, requestIds: string[] = []): MemberDelta {
  if (teamId && teamId !== state.teamId) throw new Error('[MEMBER_TEAM] 团队身份已变化，已停止成员同步与开通');
  const value = memberPublicState(state), { users, groups, ...metadata } = value;
  metadata.operations = Object.fromEntries(Object.entries(metadata.operations || {}).filter(([, job]) => job.status !== 'done'));
  const index = state.memberIndex ||= { sequence: 0, users: {}, groups: {} };
  const at = index.sequence + 1;
  let changed = false;
  for (const kind of ['users', 'groups'] as const) {
    for (const key of new Set([...Object.keys(index[kind]), ...Object.keys(value[kind])])) {
      const revision = Object.hasOwn(value[kind], key) ? hash(value[kind][key]) : '';
      if (index[kind][key]?.revision !== revision) { index[kind][key] = { revision, at }; changed = true; }
    }
  }
  const revision = hash(metadata);
  if (index.metadata?.revision !== revision) { index.metadata = { revision, at }; changed = true; }
  if (changed) index.sequence = at;
  const full = since === undefined || since > index.sequence;
  const delta: MemberDelta = { protocol: 1, teamId: state.teamId!, sequence: index.sequence, full, users: {}, groups: {}, deletedUsers: [], deletedGroups: [] };
  for (const kind of ['users', 'groups'] as const) for (const [key, entry] of Object.entries(index[kind])) {
    if (!full && entry.at <= since!) continue;
    if (!entry.revision) delta[kind === 'users' ? 'deletedUsers' : 'deletedGroups'].push(key);
    else (delta[kind] as Record<string, unknown>)[key] = value[kind][key];
  }
  if (full || index.metadata!.at > since!) delta.metadata = metadata;
  delta.receipts = Object.fromEntries(requestIds.filter(id => Object.hasOwn(state.memberRequests || {}, id)).map(id => [id, state.memberRequests![id].status]));
  return delta;
}
export function prepareMemberOperation(state: MemberRegistryState, input: MemberApply): { duplicate: boolean; request?: any } {
  if (input.teamId !== state.teamId) throw new Error('[MEMBER_TEAM] 团队身份已变化，已停止成员操作');
  // Receipts retain only a salted verifier; plaintext passwords never reach disk.
  const { password, ...publicCommand } = input.command as any;
  const signature = hash(publicCommand), receipts = state.memberRequests ||= {};
  const previous = receipts[input.requestId];
  if (previous) {
    if (previous.signature !== signature) throw new Error('[MEMBER_REQUEST] 请求编号已用于其他操作');
    if ((password === undefined) !== (previous.passwordHash === undefined) || (password !== undefined && scryptSync(password, previous.passwordSalt!, 32).toString('hex') !== previous.passwordHash)) throw new Error('[MEMBER_REQUEST] 请求编号已用于其他密码操作');
    if (previous.status === 'done') return { duplicate: true };
    throw new Error('[MEMBER_RECOVERY] 此操作可能已部分完成，请通过待恢复操作核对后继续');
  }
  const command = input.command;
  if (command.op === 'user_create') {
    if (Object.keys(state.users).some(name => name.toLowerCase() === command.username.toLowerCase())) throw new Error('[MEMBER_EXISTS] 账号已存在，请查看已有成员或更换账号');
  } else {
    const current = memberPublicState(state).users[command.username];
    if ((!current && !(command.op === 'recover' && command.expectedRevision === 'absent')) || (current && current.revision !== command.expectedRevision)) throw new Error('[MEMBER_CONFLICT] 成员已被其他管理端修改，请查看最新状态后重新确认；本次输入已保留');
    if ('handoffs' in command) for (const successor of Object.values(command.handoffs || {})) {
      if (successor && memberPublicState(state).users[successor]?.revision !== command.handoffRevisions?.[successor]) throw new Error('[MEMBER_CONFLICT] 接任成员已变化，请重新确认');
    }
  }
  let request: any = { ...command, requestId: input.requestId };
  if (command.op === 'member_groups') {
    const user = state.users[command.username], groups = new Set(user.groups || []), admins = new Set(user.contentAdminGroups || []);
    for (const change of command.changes) {
      const group = state.groups[change.group];
      if (!group?.workspace || group.deletedAt || group.purgedAt || group.provisioning) throw new Error('[MEMBER_GROUP] 项目组已变化，请重新选择');
      if (change.role === 'remove') groups.delete(change.group); else groups.add(change.group);
      if (change.role === 'admin') admins.add(change.group); else admins.delete(change.group);
    }
    request = { ...request, op: 'user_groups', groups: [...groups], contentAdminGroups: [...admins] };
  }
  receipts[input.requestId] = { signature, status: 'running' };
  if (password !== undefined) { const salt = randomUUID(); Object.assign(receipts[input.requestId], { passwordSalt: salt, passwordHash: scryptSync(password, salt, 32).toString('hex') }); }
  return { duplicate: false, request };
}
export function bumpMemberAccess(state: AdminState, username: string) { state.users[username].accessVersion = randomUUID(); }
