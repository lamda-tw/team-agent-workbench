import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// OS launchers, certificates and process identity/termination need separate validation.
const desktopOnly = new Set(['launcher.test.ts', 'egress.test.ts', 'codex-process.test.ts']);
const selected = process.argv.slice(2);
const files = selected.length ? await Promise.all(selected.map(async file => {
  const resolved = path.resolve(root, file);
  if (path.dirname(resolved) !== path.join(root, 'tests') || !resolved.endsWith('.test.ts') || desktopOnly.has(path.basename(resolved))) throw new Error('此测试不属于后台测试范围：' + file);
  const info = await stat(resolved).catch(error => { if (error.code === 'ENOENT') return; throw error; });
  if (!info?.isFile()) throw new Error('测试文件不存在或不是文件：' + file);
  return resolved;
})) : (await readdir(path.join(root, 'tests'))).filter(file => file.endsWith('.test.ts') && !desktopOnly.has(file)).sort().map(file => path.join(root, 'tests', file));

const child = spawn(process.execPath, ['--require', path.join(root, 'scripts/background-guard.cjs'), '--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
  cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, WORKBENCH_BACKGROUND_TESTS: '1' },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
