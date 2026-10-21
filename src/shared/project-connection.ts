import { accountIdentity } from './account-data';
import { z } from 'zod';
import { errorMessage } from './errors';
import type { ConnectionProfile } from './types';

// A window-local continuation, never a saved project or an SSH credential.
export const projectCreationInputSchema = z.object({ name: z.string().trim().min(1, '请填写项目名称').max(180) });
export interface ProjectCreationIntent { id: string; name: string }

export function projectConnectionError(error: unknown) {
  const message = errorMessage(error);
  if (/All configured authentication methods failed|Authentication failed/i.test(message)) return '服务器未接受此账号或密码，请检查后重试。';
  if (/ECONNREFUSED/i.test(message)) return '服务器拒绝了连接，请检查地址、端口和 SSH 服务。';
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(message)) return '连接服务器超时，请检查网络和服务器地址后重试。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '无法找到这个服务器地址，请检查地址和网络。';
  return message;
}

export interface ReusableProjectConnection { key: string; profile: ConnectionProfile }
export function reusableProjectConnections(profiles: ConnectionProfile[]) {
  return [...new Map(profiles.map(profile => [accountIdentity(profile), { key: accountIdentity(profile), profile }])).values()];
}
export function connectionProject(profile: ConnectionProfile, projectId?: string) {
  if (projectId && !profile.projects.some(project => project.id === projectId)) throw new Error('此账号没有该项目的访问权限，请刷新项目列表');
  return projectId || profile.projects[0]?.id;
}
export function separateProjectWindow(current: ConnectionProfile | undefined, next: ConnectionProfile) {
  return !!current && accountIdentity(current) !== accountIdentity(next);
}
