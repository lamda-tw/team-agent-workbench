import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function usabilityCases({ page, app, data, auth, profile }) {
  await auth.write({ status: 'ready' });
  const call = (action, payload) => page.evaluate(([action, payload]) => window.workbench.call(action, payload), [action, payload]);
  await call('provider.auth', { provider: 'codex', cwd: data });
  const state = await call('snapshot'), a = state.sessions[0];
  const b = await call('session.create', { provider: 'codex', cwd: data, projectId: state.connection.profile.projects[0].id });
  const select = id => page.locator(`.session-row[data-session-id="${id}"]`).click();
  const openDraft = async id => { await page.getByRole('button', { name: '打开成果整理', exact: true }).click(); await expect(page.getByRole('heading', { name: '成果整理', exact: true })).toBeVisible(); await page.locator(`.draft-task-card[data-draft-id="${id}"] .draft-task-open`).click(); };
  const input = page.getByLabel('任务输入', { exact: true });
  await select(a.id); await input.fill('A 独立输入');
  const source = path.join(data, 'reference-code.py'); await fs.writeFile(source, 'CODE_MUST_STAY_LOCAL = True');
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
  await page.getByRole('button', { name: '添加本地参考文件', exact: true }).click();
  // Project briefs are fixed references; these assertions concern the user's selected attachment.
  await expect(page.locator('.source-chips .selected:not(:disabled)')).toHaveCount(1);
  await select(b.id); await input.fill('B 独立输入'); await select(a.id);
  await expect(input).toHaveValue('A 独立输入'); await expect(page.locator('.source-chips .selected:not(:disabled)')).toHaveCount(1);
  await select(b.id); await expect(input).toHaveValue('B 独立输入'); await expect(page.locator('.source-chips .selected:not(:disabled)')).toHaveCount(0);
  // Failed asynchronous B request must leave both A and B text untouched.
  // Long enough that the assertion below still observes the pending check on a slow machine.
  await auth.write({ status: 'network', delay: 8000 });
  await call('provider.auth', { provider: 'codex', cwd: data });
  await page.getByRole('button', { name: '发送任务', exact: true }).click(); await select(a.id);
  assert.equal((await call('snapshot')).auth.codex.status, 'checking', 'The user must have switched to A while B is still awaiting authentication.');
  await page.locator('.toast').filter({ hasText: '无法完成登录检测' }).waitFor();
  await expect(input).toHaveValue('A 独立输入'); await select(b.id); await expect(input).toHaveValue('B 独立输入');
  // Every session owns a different file; both X and save-close flush edits.
  for (const [session, text] of [[a, '# A 的交接'], [b, '# B 的交接']]) {
    await select(session.id); if (!await page.getByRole('button', { name: '查看阶段摘要', exact: true }).isVisible()) await page.locator('.session-materials > summary').click(); await page.getByRole('button', { name: '查看阶段摘要', exact: true }).click(); await page.getByRole('button', { name: '更正摘要', exact: true }).click();
    await page.getByLabel('阶段摘要正文').fill(text);
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    assert.equal(await fs.readFile(session.handoffPath, 'utf8'), text);
  }
  assert.notEqual(a.handoffPath, b.handoffPath);
  // Simulate an unavailable destination, ensure X cannot silently discard text, then retry.
  await select(b.id); if (!await page.getByRole('button', { name: '查看阶段摘要', exact: true }).isVisible()) await page.locator('.session-materials > summary').click(); await page.getByRole('button', { name: '查看阶段摘要', exact: true }).click(); await page.getByRole('button', { name: '更正摘要', exact: true }).click();
  await fs.rename(b.handoffPath, b.handoffPath + '.saved'); await fs.mkdir(b.handoffPath);
  await page.getByLabel('阶段摘要正文').fill('# B 保存失败后恢复');
  await expect(page.getByRole('status')).toContainText('保存失败');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('窗口已保留');
  await fs.rmdir(b.handoffPath); await fs.rename(b.handoffPath + '.saved', b.handoffPath);
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  // Preparation is independent; AI text and optional human supplement are separate.
  await auth.write({ status: 'ready', turn: 'success' });
  const draft = await call('draft.prepare', { id: a.id });
  await openDraft(draft.id);
  await expect(page.getByLabel('整理状态')).toContainText('已整理好', { timeout: 20000 });
  await page.getByLabel('给团队的补充（可选）', { exact: true }).fill('只提交修改说明；验证通过，不附带代码。');
  await page.getByRole('button', { name: '工作会话', exact: true }).click();
  await openDraft(draft.id);
  await expect(page.getByLabel('给团队的补充（可选）', { exact: true })).toHaveValue('只提交修改说明；验证通过，不附带代码。');
  await expect(page.getByRole('region', { name: '整理结果', exact: true })).toContainText('https://github.com/owner/repo');
  await expect(page.getByText('已保存', { exact: true })).toHaveCount(0);
  await fs.rm(draft.outputPath); await fs.mkdir(draft.outputPath);
  await page.getByLabel('给团队的补充（可选）', { exact: true }).fill('保存失败后仍保留的说明');
  await expect(page.getByRole('status')).toContainText('保存失败');
  await page.getByRole('button', { name: '工作会话', exact: true }).click();
  await openDraft(draft.id);
  await expect(page.getByLabel('给团队的补充（可选）', { exact: true })).toHaveValue('保存失败后仍保留的说明');
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async (_window, options) => { dialog.closeGuardMessage = options.message; return { response: 0, checkboxChecked: false }; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await expect.poll(() => app.evaluate(({ dialog }) => dialog.closeGuardMessage)).toBe('保存失败，已保留窗口和待保存内容。');
  await expect(page.getByLabel('给团队的补充（可选）', { exact: true })).toHaveValue('保存失败后仍保留的说明');
  await fs.rmdir(draft.outputPath); await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.getByText('已保存', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^确认上传/ }).click();
  await expect(page.getByLabel('给团队的补充（可选）', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^确认上传/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除整理任务', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await call('snapshot')).transfers[0]?.status).toBe('done');
  await page.getByRole('button', { name: '打开成果整理', exact: true }).click();
  await expect(page.locator(`.draft-task-card[data-draft-id="${draft.id}"]`)).toContainText('已保留，不可删除');
  const evidence = (await call('snapshot')).drafts[0].files;
  assert.equal(evidence.length, a.sources.length + 1); // Existing project context plus the attachment, retained locally.
  assert.equal(evidence.filter(f => f.name === 'reference-code.py').length, 1);
  // A failed connection replacement must leave local sessions usable.
  await assert.rejects(call('remote.connect', { profile, password: 'wrong-password', localPath: data }));
  assert.equal((await call('snapshot')).workspaceReady, true);
  await page.getByRole('button', { name: '工作会话', exact: true }).click(); await select(a.id);
  await expect(input).toHaveValue('A 独立输入');
  console.log('UI regressions passed: per-session inputs/references/handoffs, late failure isolation, autosave navigation, save failure/retry, reference-only submit, failed reconnect.');
  return { a, b, draft };
}

export async function restoredCases(page, expected) {
  await page.getByText('连接中央节点', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('任务输入', { exact: true }).waitFor();
  await expect(page.getByText('先连接中央节点', { exact: true })).toHaveCount(0);
  await expect(page.getByText('连接中央节点', { exact: true })).toHaveCount(0);
  for (const [session, text] of [[expected.a, 'A 独立输入'], [expected.b, 'B 独立输入']]) {
    await page.locator(`.session-row[data-session-id="${session.id}"]`).click();
    await expect(page.getByLabel('任务输入', { exact: true })).toHaveValue(text);
  }
  await page.getByRole('button', { name: '打开成果整理', exact: true }).click();
  await page.locator(`.draft-task-card[data-draft-id="${expected.draft.id}"] .draft-task-open`).click();
  await expect(page.getByLabel('给团队的补充（可选）', { exact: true })).toHaveValue('保存失败后仍保留的说明');
  const snapshot = await page.evaluate(() => window.workbench.call('snapshot'));
  assert.equal(snapshot.connection, undefined); assert.equal(snapshot.workspaceReady, true);
  console.log('Restart without remote connection passed: inputs and drafts restored; local work remains available.');
}
