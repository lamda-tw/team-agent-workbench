import type { AdminOperation, AdminState } from './types';
export function continuityImpact(state: AdminState | undefined, operation: Partial<AdminOperation>): string[] {
  if (!state || !('username' in operation) || !operation.username) return [];
  const user = state.users[operation.username]; if (!user?.enabled) return [];
  return (user.contentAdminGroups || []).filter(group => {
    if (state.groups[group]?.deletedAt || state.groups[group]?.purgedAt) return false;
    const losing = operation.op === 'user_enabled' ? operation.enabled === false : operation.op === 'group_member' ? operation.group === group && operation.role !== 'admin' : operation.op === 'user_groups' ? !operation.groups?.includes(group) || !operation.contentAdminGroups?.includes(group) : false;
    return losing && !Object.values(state.users).some(u => u.username !== user.username && u.enabled && !u.missing && !u.provisioning && u.groups?.includes(group) && u.contentAdminGroups?.includes(group));
  });
}
export function continuitySuccessors(state: AdminState, operation: AdminOperation) {
  return continuityImpact(state, operation).flatMap(group => {
    if (!operation.handoffs || !Object.hasOwn(operation.handoffs, group)) throw new Error('此操作会使项目组失去组管理员：' + state.groups[group]?.label + '。请选择接任人，或明确保留空缺。');
    const username = operation.handoffs[group]; if (username === null) return [];
    const user = state.users[username];
    if (!user?.enabled || user.missing || user.provisioning || !user.groups?.includes(group) || ('username' in operation && username === operation.username)) throw new Error('接任人必须是本组其他已启用成员');
    return [{ group, user }];
  });
}
