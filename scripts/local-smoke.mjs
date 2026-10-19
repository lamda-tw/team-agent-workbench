import { releaseRoot } from './release-paths.mjs';
const extendedAccounts = process.argv.includes('--accounts');
const aliceName = extendedAccounts ? '张三' : 'alice', bobName = extendedAccounts ? '10086' : 'bob';
const memberPassword = extendedAccounts ? '1' : 'member-test-password';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';
import { completeProjectSetup, completeProjectDirectory } from './onboarding-helpers.mjs';
import { memberProfile, setConnectionProfile } from './connection-helpers.mjs';
const expect = baseExpect.configure({ timeout: 20000 });

const root = process.cwd(), packaged = process.argv.includes('--packaged');
const data = path.join(root, '.test-data', 'local-ui-' + Date.now()), share = path.join(data, 'share');
await fs.mkdir(share, { recursive: true });
const fixture = await authLauncher(path.join(data, 'cli')); await fixture.write({ status: 'ready' });
const apps = [], pages = [], errors = [];
async function launch(edition, name) {
  const store = path.join(data, name); await fs.mkdir(store);
  if (edition === 'user') await fs.writeFile(path.join(store, 'settings.json'), JSON.stringify({ connections: [], providerPaths: { codex: fixture.launcher, cursor: fixture.launcher }, lastWorkspace: '' }));
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: store, WORKBENCH_ADMIN_DATA_DIR: store }; delete env.ELECTRON_RUN_AS_NODE;
  const config = packaged ? { executablePath: path.join(releaseRoot, edition, 'win-unpacked', 'Team Agent ' + (edition === 'user' ? 'User' : 'Admin') + '.exe'), args: [] } : { args: ['dist/' + edition] };
  const app = await electron.launch({ ...config, cwd: root, env, timeout: 60000 }); apps.push(app);
  const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); pages.push(page); return { app, page };
}
async function confirm(page) { await page.getByRole('button', { name: '确认执行', exact: true }).click(); await expect(page.locator('.modal')).toHaveCount(0); }
async function connectUser(user, username, profile) {
  const { page } = user;
  await setConnectionProfile(user, profile);
  await expect(page.getByRole('button', { name: '添加其他服务器', exact: true })).toHaveCount(0);

  await expect(page.getByLabel('共享工作路径', { exact: true })).toHaveCount(0);
  await page.getByLabel('成员账号').fill(username); await page.getByLabel('登录密码', { exact: true }).fill(memberPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page.getByLabel('成员账号')).toHaveCount(0);
}
try {
  const admin = await launch('admin', 'admin'); const ap = admin.page;
  await ap.getByLabel('共享区类型').selectOption('local'); await ap.getByLabel('本地共享区根目录').fill(share);
  await expect(ap.getByLabel('管理账号', { exact: true })).toHaveCount(0); await expect(ap.getByLabel('登录密码', { exact: true })).toHaveCount(0);
  await ap.getByRole('button', { name: '打开共享目录', exact: true }).click(); await expect(ap.locator('.modal')).toHaveCount(0);
  await ap.getByRole('button', { name: '初始化团队空间', exact: true }).click(); await confirm(ap);
  await ap.getByRole('button', { name: '创建项目组', exact: true }).click(); await ap.getByLabel('项目组名称').fill('competition'); await confirm(ap);
  for (const username of [aliceName, bobName]) {
    await ap.getByRole('button', { name: '创建用户', exact: true }).click();
    await ap.getByLabel('成员姓名', { exact: true }).fill(username); await ap.getByLabel('登录账号', { exact: true }).fill(username);
    await ap.getByLabel('初始密码', { exact: true }).fill(memberPassword); await ap.getByLabel('再次输入密码', { exact: true }).fill(memberPassword);
    await ap.locator('.modal .check-row').filter({ hasText: 'competition' }).first().locator('input').check();
    if (username === aliceName) await ap.locator('.modal .check-row').filter({ hasText: '内容组管理员' }).locator('input').check();
    await confirm(ap);
  }
  const aliceProfile = await memberProfile(admin, aliceName);
  assert.equal(aliceProfile.mode, 'local'); assert.equal(aliceProfile.localRoot, share); assert(!JSON.stringify(aliceProfile).includes('password'));
  const alice = await launch('user', 'alice'); await connectUser(alice, aliceName, aliceProfile);
  await completeProjectSetup(alice.page, '华为算法比赛');
  const bobProfile = await memberProfile(admin, bobName);
  const bob = await launch('user', 'bob'); await connectUser(bob, bobName, bobProfile); await completeProjectDirectory(bob.page);
  const snapshot = await alice.page.evaluate(() => window.workbench.call('snapshot')), p = snapshot.connection.profile.projects[0];
  assert.equal(await bob.page.getByTitle('创建远端项目', { exact: true }).count(), 0);
  const source = path.join(data, 'competition-note.md'); await fs.writeFile(source, '# 比赛协同联调\n用户 A 与用户 B 各迭代两轮。');
  await alice.app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, source);
  await alice.page.getByTitle('上传文件到当前目录', { exact: true }).click();
  await expect.poll(async () => (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0]?.status, { timeout: 15000 }).toBe('done');
  const uploaded = (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0];
  assert((await fs.stat(path.join(share, ...uploaded.target.split('/').filter(Boolean)))).isFile());
  await bob.page.getByTitle('刷新工作组、项目和文件', { exact: true }).click(); await bob.page.locator('.file-row').filter({ hasText: 'competition-note.md' }).click();
  await expect(bob.page.locator('.preview-content')).toContainText('各迭代两轮');
  await alice.page.getByTitle('新建会话', { exact: true }).click(); await alice.page.getByLabel('Codex 登录状态').getByText('已登录', { exact: true }).waitFor(); await alice.page.getByRole('button', { name: '创建会话', exact: true }).click();
  await alice.page.getByTitle('重命名会话', { exact: true }).click(); await alice.page.getByLabel('会话名称', { exact: true }).fill('算法基线验证'); await alice.page.getByRole('button', { name: '保存名称', exact: true }).click(); await expect(alice.page.locator('.session-title-row')).toContainText('算法基线验证');
  await alice.page.getByLabel('任务输入', { exact: true }).fill('为算法比赛建立基线');
  if (!await alice.page.getByRole('button', { name: '查看阶段摘要', exact: true }).isVisible()) await alice.page.locator('.session-materials > summary').click(); await alice.page.getByRole('button', { name: '查看阶段摘要', exact: true }).click(); await alice.page.getByRole('button', { name: '更正摘要', exact: true }).click(); await alice.page.getByLabel('阶段摘要正文').fill('# 比赛第一轮\n量化接口和数据已就绪'); await alice.page.getByRole('button', { name: '保存并返回' }).click();
  await fixture.write({ status: 'ready', fileApproval: true });
  await alice.page.getByTitle('发送任务', { exact: true }).click();
  const approval = alice.page.locator('.approval'); await expect(approval).toContainText('Codex 请求修改文件');
  await approval.getByText('查看请求详情', { exact: true }).click();
  await expect(approval.locator('details pre')).toContainText('solution.py'); await expect(approval.locator('details pre')).toContainText('+new_value');
  await approval.getByRole('button', { name: '拒绝', exact: true }).click(); await expect(approval).toHaveCount(0);
  const session = (await alice.page.evaluate(() => window.workbench.call('snapshot'))).sessions[0];
  await alice.page.evaluate(id => window.workbench.call('session.uploadTrajectory', { id }), session.id);
  await expect.poll(async () => (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0]?.status).toBe('done');
  const history = (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers[0];
  const sharedHistory = await bob.page.evaluate(x => window.workbench.call('remote.preview', x), { projectId: p.id, path: history.target }); assert.equal(sharedHistory.type, 'binary');
  await fixture.write({ status: 'ready', turn: 'success', preparationResult: { artifacts: [
    { category: 'finding', title: '方向性结论', fields: { statement: '建议先检查数据覆盖范围，再评估是否调整方案。', uncertainty: '当前只是方向性判断，收益尚待验证。' }, repoUrl: '' },
    { category: 'issue', title: '数据覆盖风险', fields: { problem: '样本覆盖范围尚未核对', impact: '可能误判方案收益' } }
  ] } });
  await alice.page.getByRole('button', { name: '整理成果', exact: true }).click();
  await expect(alice.page.getByRole('heading', { name: '选择整理结果', exact: true })).toBeVisible();
  await alice.page.getByRole('button', { name: '整理所选类型（2）', exact: true }).click();
  await expect(alice.page.getByLabel('整理状态')).toContainText('已整理好', { timeout: 20000 });
  await expect(alice.page.getByText('补充仓库链接后即可上传', { exact: true })).toHaveCount(0);
  await expect(alice.page.getByLabel('GitHub 仓库链接')).toBeHidden();
  await expect(alice.page.getByText('结论与发现', { exact: true })).toBeVisible(); await expect(alice.page.getByText('问题与风险', { exact: true })).toBeVisible();
  const riskChoice = alice.page.getByLabel(/选择成果：.*数据覆盖风险/); await riskChoice.click(); await expect(alice.page.getByRole('button', { name: '确认上传 1 项', exact: true })).toBeEnabled(); await riskChoice.click();
  await expect(alice.page.getByRole('button', { name: '确认上传 2 项', exact: true })).toBeEnabled();
  await alice.page.getByLabel('给团队的补充（可选）').fill('同事可先复核样本，再决定下一轮工作。');
  await alice.page.getByRole('button', { name: /^确认上传/ }).click();
  await expect.poll(async () => (await alice.page.evaluate(() => window.workbench.call('snapshot'))).transfers.filter(t => t.metadata?.category).map(t => t.status), { timeout: 20000 }).toEqual(['done', 'done']);
  await expect(alice.page.getByRole('button', { name: '查看上传结果', exact: true })).toHaveCount(2);
  await alice.page.locator('.artifact-result').filter({ hasText: '方向性结论' }).getByRole('button', { name: '查看上传结果', exact: true }).click();
  await expect(alice.page.locator('.result-card.is-expanded')).toContainText('方向性结论'); await expect(alice.page.locator('.result-card-details')).toContainText('来自：算法基线验证');
  const resultSnapshot = await alice.page.evaluate(() => window.workbench.call('snapshot')); const conclusion = resultSnapshot.transfers.find(t => t.name.includes('方向性结论')); const risk = resultSnapshot.transfers.find(t => t.name.includes('数据覆盖风险'));
  assert.equal(path.posix.dirname(conclusion.target).endsWith('/findings'), true); assert.equal(path.posix.dirname(risk.target).endsWith('/issues'), true);
  const conclusionFile = path.join(share, ...conclusion.target.split('/').filter(Boolean));
  const zip = JSON.parse(execFileSync('python', ['-c', 'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', conclusionFile], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(zip).sort(), ['README.md', 'manifest.json']);
  assert.match(zip['README.md'], /建议先检查数据覆盖范围/); assert.match(zip['README.md'], /同事可先复核样本/);
  assert(!zip['README.md'].includes('GitHub 仓库：')); assert.equal('repoUrl' in JSON.parse(zip['manifest.json']), false); assert.equal(JSON.parse(zip['manifest.json']).category, 'finding');
  const visible = await bob.page.evaluate(x => window.workbench.call('remote.list', x), { projectId: p.id, path: path.posix.dirname(conclusion.target) });
  assert(visible.some(entry => entry.path === conclusion.target));
  const row = ap.locator('tbody tr').filter({ hasText: bobName });
  await row.getByRole('button', { name: '停用', exact: true }).click(); await confirm(ap);
  await assert.rejects(bob.page.evaluate(x => window.workbench.call('remote.list', x), { projectId: p.id, path: p.remoteRoot }), /已停用/);
  await row.getByRole('button', { name: '启用', exact: true }).click(); await confirm(ap);
  assert((await bob.page.evaluate(x => window.workbench.call('remote.list', x), { projectId: p.id, path: p.remoteRoot })).length);
  assert.equal(await alice.page.evaluate(() => typeof window.admin), 'undefined'); assert.equal(await ap.evaluate(() => typeof window.workbench), 'undefined'); assert.deepEqual(errors, []);
  if (!packaged) { await ap.screenshot({ path: path.join(data, 'admin.png'), timeout: 10000 }); await bob.page.screenshot({ path: path.join(data, 'user-bob.png'), timeout: 10000 }); }
  await fs.writeFile(path.join(data, 'result.json'), JSON.stringify({ passed: true, packaged, extendedAccounts, sharedRoot: share, cases: ['admin bootstrap', 'create group', 'create members/subadmin', 'direct member login setup', 'concurrent admin and two users', 'project creation', 'real disk upload', 'teammate preview', 'Codex authentication UI', 'file approval includes exact diff', 'handoff editing', 'history archive', 'uploaded histories are group-public', 'conclusion upload with direct result jump; teammate access and package contents', 'live disable/enable', 'edition isolation'] }, null, 2));
  console.log('Local filesystem administrator + two users UI passed:', data);
} catch (error) { for (const app of apps) await app.evaluate(({ app }) => app.exit(1)).catch(() => {}); throw error; }
finally { for (const app of apps.reverse()) await app.close().catch(() => {}); }
