import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';

export async function dismissStartupLogin(page) {
  const dialog = page.getByRole('heading', { name: '登录团队工作台', exact: true });
  await expect(dialog).toBeVisible();
  await page.locator('.modal').getByRole('button', { name: /^(取消|跳过，暂不登录)$/ }).click();
}

export async function setConnectionProfile({ page }, profile) {
  await page.evaluate(async profile => {
    await window.workbench.call('workspace.select', { personal: false });
    const snapshot = await window.workbench.call('snapshot');
    await window.workbench.call('settings.save', { ...snapshot.settings, connections: [...snapshot.settings.connections.filter(item => item.id !== profile.id), profile] });
  }, profile);
  await page.locator('.modal').getByRole('button', { name: /^(取消|跳过，暂不登录)$/ }).click();
  await page.waitForTimeout(250);
  await page.locator('.topbar').getByRole('button', { name: /^(连接团队账号|重新登录并刷新身份)$/ }).click();
  await expect(page.getByLabel('成员账号')).toHaveValue(profile.username);
  await expect(page.getByLabel('本地共享区根目录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择共享目录', exact: true })).toHaveCount(0);
}

export async function memberProfile({ page }, username) {
  const snapshot = await page.evaluate(() => window.admin.call('snapshot'));
  const user = snapshot.state?.users?.[username];
  if (!snapshot.profile || !user) throw new Error('测试成员不存在：' + username);
  const id = (snapshot.profile.mode === 'local' ? 'local_' : 'member_') + createHash('sha256').update(JSON.stringify([snapshot.state.teamId, username])).digest('hex').slice(0, 40);
  return { mode: snapshot.profile.mode, localRoot: snapshot.profile.localRoot, id, name: user.name || username, host: snapshot.profile.host, port: snapshot.profile.port, username, fingerprint: snapshot.profile.fingerprint, manifestPath: '', projects: [], workPath: '' };
}
