import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cliFile, findWindowsCliOnPath } from '../src/core/cli-path';
import { resolveProvider } from '../src/core/providers';
import { extractedCodexCli, installedCodexCli } from '../src/core/codex-installation';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'provider-paths-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('provider-paths-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, '工作区'), bin = path.join(root, '程序 tools & npm');
  await fs.mkdir(cwd); await fs.mkdir(bin);
  const put = async (dir: string, name: string) => { const file = path.join(dir, name); await fs.writeFile(file, 'fixture'); return file; };
  return { root, cwd, bin, put };
}

test('Windows finds npm CLI shims in quoted Unicode PATH directories for every provider', async t => {
  const f = await fixture(t);
  for (const name of ['codex', 'agent', 'cursor-agent', 'claude']) {
    await f.put(f.bin, name); await f.put(f.bin, name + '.ps1');
    const cmd = await f.put(f.bin, name + '.cmd');
    assert.equal(await findWindowsCliOnPath(name, { Path: '"' + f.bin + '"', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, f.cwd), cmd);
  }
});

test('Windows honors PATH and PATHEXT order, skips Unix shims and directory lookalikes', async t => {
  const f = await fixture(t), other = path.join(f.root, 'other'); await fs.mkdir(other);
  await f.put(f.cwd, 'codex'); await fs.mkdir(path.join(f.cwd, 'codex.exe'));
  const cmd = await f.put(f.bin, 'codex.cmd'), exe = await f.put(f.bin, 'codex.exe');
  await f.put(other, 'codex.exe');
  assert.equal(await findWindowsCliOnPath('codex', { PATH: f.bin + ';' + other, PATHEXT: '.CMD;.EXE' }, f.cwd), cmd);
  assert.equal(await findWindowsCliOnPath('codex', { PATH: f.bin + ';' + other }, f.cwd), exe);
  assert.equal(await findWindowsCliOnPath('codex', { PATH: f.cwd }, f.cwd), undefined);
  const local = await f.put(f.cwd, 'codex.cmd');
  assert.equal(await findWindowsCliOnPath('codex', { PATH: f.bin }, f.cwd), local);
});

test('an explicit npm shim resolves to its Windows launcher; custom launchers remain supported', async t => {
  const f = await fixture(t), shim = await f.put(f.bin, 'codex');
  assert.equal(await cliFile(shim, 'win32'), undefined);
  const cmd = await f.put(f.bin, 'codex.cmd');
  assert.equal(await cliFile(shim, 'win32'), cmd);
  assert.equal(await cliFile('"' + cmd + '"', 'win32'), cmd);
  for (const name of ['custom.ps1', 'fixture.mjs']) {
    const file = await f.put(f.bin, name); assert.equal(await cliFile(file, 'win32'), file);
  }
  assert.equal(await cliFile(shim, 'linux'), shim);
});

test('provider resolution uses local Codex, migrates old bundled paths and retains Cursor fallback', { skip: process.platform !== 'win32' }, async t => {
  const previousCwd = process.cwd(), previousEnv = { ...process.env };
  t.after(async () => {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (/^(path|pathext|localappdata|appdata|userprofile)$/i.test(key)) delete process.env[key];
    for (const [key, value] of Object.entries(previousEnv)) if (/^(path|pathext|localappdata|appdata|userprofile)$/i.test(key)) process.env[key] = value;
  });
  const f = await fixture(t);
  for (const key of Object.keys(process.env)) if (/^(path|pathext)$/i.test(key)) delete process.env[key];
  process.env.Path = f.bin; process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'; process.chdir(f.cwd);
  process.env.LOCALAPPDATA = path.join(f.root, 'Local'); process.env.APPDATA = path.join(f.root, 'Roaming'); process.env.USERPROFILE = path.join(f.root, 'User');
  const bundled = path.join(f.cwd, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin');
  await fs.mkdir(bundled, { recursive: true }); const fallback = await f.put(bundled, 'codex.exe');
  for (const [provider, name] of [['codex', 'codex'], ['cursor', 'agent'], ['claude', 'claude']] as const) {
    await f.put(f.bin, name); const cmd = await f.put(f.bin, name + '.cmd');
    assert.equal(await resolveProvider(provider), cmd);
    const explicit = await f.put(f.cwd, provider + '-custom.ps1');
    assert.equal(await resolveProvider(provider, explicit), explicit);
    await assert.rejects(resolveProvider(provider, path.join(f.cwd, 'missing.exe')), /CLI 路径无效/);
  }
  await fs.rm(path.join(f.bin, 'agent.cmd'));
  const cursorAlias = await f.put(f.bin, 'cursor-agent.cmd');
  assert.equal(await resolveProvider('cursor'), cursorAlias);
  await fs.rm(path.join(f.bin, 'codex.cmd'));
  const desktopBin = path.join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin/desktop-version');
  await fs.mkdir(desktopBin, { recursive: true }); const desktop = await f.put(desktopBin, 'codex.exe');
  assert.equal(await resolveProvider('codex'), desktop, 'stale node_modules binary is ignored');
  assert.equal(await resolveProvider('codex', fallback), desktop, 'old configured bundle is migrated');
  await fs.unlink(fallback);
  assert.equal(await resolveProvider('codex', fallback), desktop, 'migration also works after uninstall');
  const oldShimDir = path.join(f.cwd, 'node_modules/.bin'); await fs.mkdir(oldShimDir, { recursive: true });
  const oldShim = await f.put(oldShimDir, 'codex.cmd');
  const terminal = await f.put(f.bin, 'codex.cmd'); process.env.Path = oldShimDir + ';' + f.bin;
  assert.equal(await resolveProvider('codex', oldShim), terminal, 'skip old shim without hiding a valid terminal CLI');
  await fs.unlink(cursorAlias);
  const cursorBin = path.join(f.cwd, '.tools/cursor/dist-package'); await fs.mkdir(cursorBin, { recursive: true });
  const cursor = await f.put(cursorBin, 'cursor-agent.cmd');
  assert.equal(await resolveProvider('cursor'), cursor);
});

test('desktop discovery ignores helper directories and follows an updated extraction without caching a path', async t => {
  const f = await fixture(t), bin = path.join(f.root, 'OpenAI/Codex/bin');
  for (const name of ['old', 'new', 'helpers', 'lookalike']) await fs.mkdir(path.join(bin, name), { recursive: true });
  const old = await f.put(path.join(bin, 'old'), 'codex.exe');
  await f.put(path.join(bin, 'helpers'), 'node.exe');
  await fs.mkdir(path.join(bin, 'lookalike/codex.exe'));
  assert.equal(await extractedCodexCli(f.root), old);
  const newer = await f.put(path.join(bin, 'new'), 'codex.exe');
  await fs.utimes(old, new Date('2025-01-01'), new Date('2025-01-01'));
  await fs.utimes(newer, new Date('2025-02-01'), new Date('2025-02-01'));
  assert.equal(await installedCodexCli(f.root, async () => { throw new Error('Must not start a package query when extraction exists'); }), newer);
  await fs.unlink(newer);
  assert.equal(await extractedCodexCli(f.root), old);
});

test('desktop discovery supports a fresh Store installation and reports absence when unavailable', async t => {
  const f = await fixture(t), packaged = path.join(f.root, 'Store/app/resources');
  await fs.mkdir(packaged, { recursive: true }); const executable = await f.put(packaged, 'codex.exe');
  assert.equal(await installedCodexCli(f.root, async () => path.join(f.root, 'Store')), executable);
  assert.equal(await installedCodexCli(f.root, async () => ''), undefined);
  assert.equal(await installedCodexCli(f.root, async () => { throw new Error('Store unavailable'); }), undefined);
  await fs.unlink(executable);
  assert.equal(await installedCodexCli(f.root, async () => path.join(f.root, 'Store')), undefined);
});
