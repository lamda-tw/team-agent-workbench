import { releaseRoot } from './release-paths.mjs';
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = process.cwd(), data = path.join(root, '.test-data', 'packaged-' + Date.now());
await fs.mkdir(data, { recursive: true });
const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: data + '-user', WORKBENCH_ADMIN_DATA_DIR: data + '-admin' }; delete env.ELECTRON_RUN_AS_NODE;
// Migration smoke: no development Node.js/CLI commands or repository cwd available.
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') + ';' + (process.env.SystemRoot || 'C:\\Windows');
const apps = [];
try {
  for (const edition of ['admin', 'user']) {
    const executablePath = path.join(releaseRoot, edition, 'win-unpacked', edition === 'admin' ? 'Team Agent Admin.exe' : 'Team Agent User.exe');
    const app = await electron.launch({ executablePath, args: [], cwd: data, env, timeout: 60000 }); apps.push(app);
    const page = await app.firstWindow(); await page.getByRole('button', { name: '取消', exact: true }).waitFor();
    const dataPath = await app.evaluate(({ app }) => app.getPath('userData')); assert.equal(dataPath, data + '-' + edition);
    if (edition === 'user') {
      await page.getByText('连接中央节点', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '连接', exact: true }).isDisabled(), true);
      const state = await page.evaluate(() => window.workbench.call('snapshot'));
      assert.equal(state.workspaceReady, false);
      await assert.rejects(page.evaluate(() => window.workbench.call('session.create', { provider: 'codex', cwd: 'C:\\' })));
      assert.deepEqual(state.providers.map(p => p.provider).sort(), ['claude', 'codex', 'cursor']);
      for (const provider of ['cursor']) {
        const bundled = state.providers.find(p => p.provider === provider);
        assert(bundled.available && bundled.path.includes('resources'), `${provider} must use its packaged runtime`);
      }
      const codex = state.providers.find(p => p.provider === 'codex');
      assert(!codex.path.includes('providers\\codex') && !codex.path.includes('providers/codex'), 'Codex must not use a bundled runtime');
      // Codex and Claude Code use the user's installation; absence must not block the app.
      await assert.rejects(page.evaluate(() => window.workbench.call('operation', { op: 'user_create' })));
    } else {
      assert.equal(await page.evaluate(() => typeof window.workbench), 'undefined');
      await assert.rejects(page.evaluate(() => window.admin.call('operation', { op: 'user_create', username: 'alice', name: 'test', password: '12345678' })));
    }
    console.log(edition, 'packaged executable starts, first-use connection dialog and edition isolation verified');
  }
  assert.notEqual(apps[0].process().pid, apps[1].process().pid);
  console.log('Both editions start without development PATH or repository cwd; Cursor is bundled, Codex/Claude use local installations.');
} finally { for (const app of apps.reverse()) await app.close(); }
