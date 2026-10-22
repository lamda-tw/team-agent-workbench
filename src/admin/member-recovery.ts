import type { AdminSnapshot } from './types';

export function existingLinuxAccountCollision(error?: string) {
  return !!error && error.includes('Linux 账号已存在');
}

export function existingAccountRecoveries(snapshot?: AdminSnapshot) {
  const accounts = new Map<string, { username: string; name: string }>();
  for (const item of snapshot?.memberSync?.pending || []) {
    if (item.status !== 'blocked' || !existingLinuxAccountCollision(item.error)) continue;
    accounts.set(item.command.username.toLowerCase(), { username: item.command.username, name: item.command.name });
  }
  for (const job of Object.values(snapshot?.state?.operations || {})) {
    const username = job.request?.username;
    if (job.op !== 'user_create' || job.status === 'done' || typeof username !== 'string' || !existingLinuxAccountCollision(job.error)) continue;
    const key = username.toLowerCase();
    if (!accounts.has(key)) accounts.set(key, { username, name: username });
  }
  return [...accounts.values()].filter(account => !snapshot?.state?.users[account.username]);
}
