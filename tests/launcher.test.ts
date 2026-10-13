import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');

const exec = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };

test('only user and admin launchers are exposed and both use the unified hidden startup flow', async () => {
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && /\.(cmd|bat|ps1)$/i.test(entry.name)).map(entry => entry.name).sort();
  assert.deepEqual(entries, ['start-admin-dev.cmd', 'start-user-dev.cmd']);
  for (const edition of ['user', 'admin']) {
    const script = await fs.readFile(path.join(root, `start-${edition}-dev.cmd`), 'utf8');
    assert.match(script, new RegExp(`scripts\\\\start-dev-hidden\\.ps1" ${edition}`));
    assert.match(script, /-WindowStyle Hidden/);
  }
});

async function launcherFixture(t: { after: (fn: () => Promise<void>) => void }) {
  // Exercise real PowerShell process startup, including spaces, Chinese and shell metacharacters.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench 启动 & ')));
  t.after(async () => {
    assert.equal(path.dirname(dir), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('workbench 启动 & '));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await fs.mkdir(path.join(dir, 'scripts'));
  await fs.mkdir(path.join(dir, 'bin'));
  // This console Node test double needs hiding, unlike the real GUI application.
  const helper = await fs.readFile(path.join(root, 'scripts/start-dev-hidden.ps1'), 'utf8');
  await fs.writeFile(path.join(dir, 'scripts/start-dev-hidden.ps1'), helper);
  const desktopLauncher = await fs.readFile(path.join(root, 'scripts/launch-desktop.mjs'), 'utf8');
  const silentFixture = desktopLauncher.replace('windowsHide: false', 'windowsHide: true');
  assert.notEqual(silentFixture, desktopLauncher);
  await fs.writeFile(path.join(dir, 'scripts/launch-desktop.mjs'), silentFixture);
  await fs.copyFile(path.join(root, 'scripts/startup-process.ps1'), path.join(dir, 'scripts/startup-process.ps1'));
  await fs.copyFile(path.join(root, 'scripts/startup-dependencies.mjs'), path.join(dir, 'scripts/startup-dependencies.mjs'));
  await fs.copyFile(path.join(root, 'scripts/electron-runtime-cache.mjs'), path.join(dir, 'scripts/electron-runtime-cache.mjs'));
  const dependencies = { electron: '44.3.0', esbuild: '0.28.2', ssh2: '1.17.0' };
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies }));
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': { dependencies }, ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => ['node_modules/' + name, { version }])),
  } }));
  const eventsPath = path.join(dir, 'events.jsonl');
  const runner = path.join(dir, 'npm-fixture.cjs');
  const installerSource = String.raw`
const fs = require('node:fs'), path = require('node:path');
const root = process.cwd(), packageRoot = path.join(root, 'node_modules/electron');
fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ step: 'electron-install', cwd: root }) + '\n');
if (process.env.LAUNCHER_FAIL_STEP === 'electron') process.exit(18);
if (process.env.LAUNCHER_EMPTY_BINARY === '1') process.exit(0);
const electron = path.join(packageRoot, 'dist/electron.exe');
if (!fs.existsSync(electron)) {
  fs.copyFileSync(process.execPath, electron);
}
fs.writeFileSync(path.join(packageRoot, 'dist/version'), 'v44.3.0');
fs.writeFileSync(path.join(packageRoot, 'path.txt'), 'electron.exe');
`;
  await fs.writeFile(runner, `
const fs = require('node:fs'), path = require('node:path');
const root = process.cwd(), step = process.argv[2];
if (step === '--version') { console.log('11.0.0'); process.exit(0); }
const event = value => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify(value) + '\\n');
event({ step, args: process.argv.slice(2), cwd: root });
if (process.env.LAUNCHER_FAIL_STEP === step) process.exit(17);
if (step === 'ci') {
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
  for (const name of ['electron/dist', 'esbuild', 'ssh2']) fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  for (const name of ['esbuild', 'ssh2']) fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version: lock.packages['node_modules/' + name].version }));
  fs.writeFileSync(path.join(root, 'node_modules/.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key)) }));
  // Like Electron 44, npm installs only the package; a separate step installs its binary.
  fs.writeFileSync(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: '44.3.0' }));
  fs.writeFileSync(path.join(root, 'node_modules/electron/install.js'), ${JSON.stringify(installerSource)});
} else if (step === 'run') {
  for (const edition of ['user', 'admin']) {
    const out = path.join(root, 'dist', edition); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
    fs.writeFileSync(path.join(out, 'main.cjs'), 'require("node:fs").appendFileSync(' + JSON.stringify(path.join(root, 'events.jsonl')) + ', JSON.stringify({step:"launch", pid:process.pid, edition:' + JSON.stringify(edition) + ', cwd:process.cwd(), electronRunAsNode:process.env.ELECTRON_RUN_AS_NODE || ""})+"\\\\n")');
  }
}
`);
  await fs.writeFile(path.join(dir, 'bin/npm.cmd'), '@echo off\r\n"%LAUNCHER_TEST_NODE%" "%LAUNCHER_TEST_RUNNER%" %*\r\nexit /b %errorlevel%\r\n');
  const env: NodeJS.ProcessEnv = { ...process.env, LAUNCHER_TEST_NODE: process.execPath, LAUNCHER_TEST_RUNNER: runner, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_ELECTRON_CACHE: path.join(dir, '.electron-cache') };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = path.join(dir, 'bin') + path.delimiter + (process.env.Path || process.env.PATH);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const run = (edition: string, extra: NodeJS.ProcessEnv = {}) => exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'scripts/start-dev-hidden.ps1'), edition, '-NoDialogs'], { cwd: os.tmpdir(), env: { ...env, ...extra }, windowsHide: true, timeout: 30000 }).catch(async error => {
    const logs = path.join(dir, '.test-data/launcher');
    for (const name of await fs.readdir(logs).catch(() => [])) if (/\.log$|\.err$/.test(name)) error.message += '\n' + name + ': ' + await fs.readFile(path.join(logs, name), 'utf8');
    throw error;
  });
  const events = async (): Promise<Array<{ step: string; pid?: number; edition?: string; cwd: string; electronRunAsNode?: string; args?: string[] }>> => {
    const text = await fs.readFile(eventsPath, 'utf8').catch(() => '');
    return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const launched = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const launches = (await events()).filter(e => e.step === 'launch');
      if (launches.length >= count) {
        // The event is written before process exit. Wait for release of the Windows image lock.
        try { process.kill(launches[count - 1].pid!, 0); }
        catch (error: any) { if (error.code === 'ESRCH') return; throw error; }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Application did not start');
  };
  return { dir, run, events, launched };
}

test('first launch installs locked dependencies; both editions start from paths with spaces', windows, async t => {
  const f = await launcherFixture(t);
  await f.run('user'); await f.launched(1);
  await f.run('admin'); await f.launched(2);
  const events = await f.events();
  assert.equal(events.filter(e => e.step === 'ci').length, 1);
  assert.equal(events.filter(e => e.step === 'electron-install').length, 1);
  assert.equal(events.filter(e => e.step === 'run').length, 2);
  assert.deepEqual(events.filter(e => e.step === 'launch').map(e => e.edition), ['user', 'admin']);
  for (const e of events.filter(e => e.step === 'launch')) {
    assert.equal(e.cwd, f.dir); assert.equal(e.electronRunAsNode, '');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(f.dir, 'package.json'), 'utf8'));
  manifest.description = 'metadata update must reuse installed dependencies';
  await fs.writeFile(path.join(f.dir, 'package.json'), JSON.stringify(manifest));
  await f.run('user'); await f.launched(3);
  assert.equal((await f.events()).filter(e => e.step === 'ci').length, 1);
  const lock = JSON.parse(await fs.readFile(path.join(f.dir, 'package-lock.json'), 'utf8'));
  manifest.dependencies.ssh2 = '1.17.1';
  lock.packages[''].dependencies.ssh2 = '1.17.1';
  lock.packages['node_modules/ssh2'].version = '1.17.1';
  await fs.writeFile(path.join(f.dir, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(f.dir, 'package-lock.json'), JSON.stringify(lock));
  await f.run('user'); await f.launched(4);
  assert.equal((await f.events()).filter(e => e.step === 'ci').length, 2, 'lockfile update must prepare dependencies again');
  assert.equal((await f.events()).filter(e => e.step === 'electron-install').length, 1, 'the previous Electron runtime survives npm ci in a separate cache');
});

test('failed install is retried and failed build never launches an older app', windows, async t => {
  const f = await launcherFixture(t);
  await assert.rejects(f.run('user', { LAUNCHER_FAIL_STEP: 'ci' }), /依赖安装失败/);
  assert.equal((await f.events()).filter(e => e.step === 'launch').length, 0);
  await f.run('user'); await f.launched(1);
  await assert.rejects(f.run('user', { LAUNCHER_FAIL_STEP: 'run' }), /当前代码构建失败/);
  assert.equal((await f.events()).filter(e => e.step === 'launch').length, 1);
  await f.run('admin'); await f.launched(2);
  assert.equal((await f.events()).filter(e => e.step === 'ci').length, 2);
});

test('concurrent user and admin startup shares one dependency install', windows, async t => {
  const f = await launcherFixture(t);
  const results = await Promise.allSettled([f.run('user'), f.run('admin')]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  await f.launched(2);
  const events = await f.events();
  assert.equal(events.filter(e => e.step === 'ci').length, 1);
  assert.equal(events.filter(e => e.step === 'electron-install').length, 1);
  assert.equal(events.filter(e => e.step === 'run').length, 2);
  assert.deepEqual(events.filter(e => e.step === 'launch').map(e => e.edition).sort(), ['admin', 'user']);
});

test('Electron download failure retries only the binary and never launches an incomplete app', windows, async t => {
  const f = await launcherFixture(t);
  await assert.rejects(f.run('user', { LAUNCHER_FAIL_STEP: 'electron' }), /Electron 运行文件准备失败/);
  assert.deepEqual((await f.events()).map(event => event.step), ['ci', 'electron-install']);
  await f.run('admin'); await f.launched(1);
  const events = await f.events();
  assert.equal(events.filter(event => event.step === 'ci').length, 1);
  assert.equal(events.filter(event => event.step === 'electron-install').length, 2);
  assert.equal(events.filter(event => event.step === 'run').length, 1);
});

test('missing Electron executable, metadata and stale version restore from cache without downloading', windows, async t => {
  const f = await launcherFixture(t);
  await f.run('user'); await f.launched(1);
  // Windows scanners can retain the executable briefly even after the child has exited.
  for (let attempt = 0; ; attempt++) {
    try { await fs.unlink(path.join(f.dir, 'node_modules/electron/dist/electron.exe')); break; }
    catch (error: any) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 20) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await f.run('admin'); await f.launched(2);
  await fs.unlink(path.join(f.dir, 'node_modules/electron/path.txt'));
  await f.run('user'); await f.launched(3);
  await fs.writeFile(path.join(f.dir, 'node_modules/electron/dist/version'), '43.0.0');
  await f.run('admin'); await f.launched(4);
  const events = await f.events();
  assert.equal(events.filter(event => event.step === 'ci').length, 1);
  assert.equal(events.filter(event => event.step === 'electron-install').length, 1);
});

test('an incomplete Electron cache falls back to the pinned installer', windows, async t => {
  const f = await launcherFixture(t);
  await f.run('user'); await f.launched(1);
  await fs.unlink(path.join(f.dir, '.electron-cache', `v44.3.0-${process.platform}-${process.arch}`, 'dist/electron.exe'));
  await fs.unlink(path.join(f.dir, 'node_modules/electron/dist/electron.exe'));
  await f.run('admin'); await f.launched(2);
  const events = await f.events();
  assert.equal(events.filter(event => event.step === 'ci').length, 1);
  assert.equal(events.filter(event => event.step === 'electron-install').length, 2);
});

test('a successful Electron installer exit without runtime files still blocks build and launch', windows, async t => {
  const f = await launcherFixture(t);
  await assert.rejects(f.run('user', { LAUNCHER_EMPTY_BINARY: '1' }), /Electron 运行文件准备失败/);
  assert.deepEqual((await f.events()).map(event => event.step), ['ci', 'electron-install']);
  await f.run('user'); await f.launched(1);
  assert.equal((await f.events()).filter(event => event.step === 'ci').length, 1);
});

test('missing Node.js gives an actionable error before installation or build', windows, async t => {
  const f = await launcherFixture(t);
  await assert.rejects(f.run('user', { Path: path.join(f.dir, 'bin') }), /请先安装 64 位 Node.js/);
  assert.deepEqual(await f.events(), []);
});

test('both launchers find portable Node without system PATH and prefer the latest complete version', windows, async t => {
  const f = await launcherFixture(t);
  for (const version of ['24.9.0', '24.19.0', '25.0.0']) {
    const dir = path.join(f.dir, '.tools', `node-v${version}-win-x64`); await fs.mkdir(dir, { recursive: true });
    try { await fs.link(process.execPath, path.join(dir, 'node.exe')); } catch { await fs.copyFile(process.execPath, path.join(dir, 'node.exe')); }
    if (version !== '25.0.0') await fs.copyFile(path.join(f.dir, 'bin/npm.cmd'), path.join(dir, 'npm.cmd'));
  }
  await f.run('user', { Path: path.join(f.dir, 'bin') }); await f.launched(1);
  await f.run('admin', { Path: path.join(f.dir, 'bin') }); await f.launched(2);
  const logs = path.join(f.dir, '.test-data/launcher');
  const startup = (await fs.readdir(logs)).filter(name => /-\d+\.log$/.test(name));
  assert.equal(startup.length, 2);
  for (const name of startup) {
    const text = await fs.readFile(path.join(logs, name), 'utf8');
    assert.match(text, /Node: .*node-v24\.19\.0-win-x64\\node\.exe/);
    assert.match(text, /Npm: .*node-v24\.19\.0-win-x64\\npm\.cmd/);
  }
});

test('broken portable Node and broken npm fall through to a usable portable runtime', windows, async t => {
  const f = await launcherFixture(t);
  for (const version of ['24.7.0', '24.8.0', '24.9.0']) {
    const dir = path.join(f.dir, '.tools', `node-v${version}-win-x64`); await fs.mkdir(dir, { recursive: true });
    if (version === '24.9.0') await fs.writeFile(path.join(dir, 'node.exe'), 'not an executable');
    else await fs.copyFile(process.execPath, path.join(dir, 'node.exe'));
    if (version === '24.8.0') await fs.writeFile(path.join(dir, 'npm.cmd'), '@exit /b 27\r\n');
    else await fs.copyFile(path.join(f.dir, 'bin/npm.cmd'), path.join(dir, 'npm.cmd'));
  }
  await f.run('user', { Path: path.join(f.dir, 'bin') }); await f.launched(1);
  const files = await fs.readdir(path.join(f.dir, '.test-data/launcher'));
  const log = await fs.readFile(path.join(f.dir, '.test-data/launcher', files.find(name => /user-.*-\d+\.log$/.test(name))!), 'utf8');
  assert.match(log, /Skipped: .*24\.9\.0/); assert.match(log, /Skipped: .*24\.8\.0/);
  assert.match(log, /Node: .*24\.7\.0/);
  assert.equal((await f.events()).filter(event => event.step === 'ci').length, 1);
});

test('explicit offline Node directory works without system or project runtimes', windows, async t => {
  const f = await launcherFixture(t), dir = path.join(f.dir, 'offline node'); await fs.mkdir(dir);
  await fs.copyFile(process.execPath, path.join(dir, 'node.exe')); await fs.copyFile(path.join(f.dir, 'bin/npm.cmd'), path.join(dir, 'npm.cmd'));
  await f.run('admin', { Path: path.join(f.dir, 'bin'), WORKBENCH_NODE_DIR: dir }); await f.launched(1);
});

test('broken project runtime falls back to system Node without changing persistent PATH', windows, async t => {
  const f = await launcherFixture(t), dir = path.join(f.dir, '.tools/node-v24.99.0-win-x64'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.exe'), 'broken'); await fs.copyFile(path.join(f.dir, 'bin/npm.cmd'), path.join(dir, 'npm.cmd'));
  const before = process.env.Path || process.env.PATH;
  await f.run('user'); await f.launched(1);
  assert.equal(process.env.Path || process.env.PATH, before);
});
