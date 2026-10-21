import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error Startup checks run as native JavaScript before dependencies are installed.
import { checkDependencies } from '../scripts/startup-dependencies.mjs';

const runtime = { major: 24, platform: 'win32', arch: 'x64' };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-dependencies-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('workbench-dependencies-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (file: string, value: unknown) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(value, null, 2));
  };
  const manifest: any = { name: 'fixture', version: '1.0.0', description: 'before', dependencies: { app: '^1.0.0' }, scripts: { build: 'node build.mjs' } };
  const pkg = (version: string) => ({ version, resolved: `https://registry.npmjs.org/fixture/-/fixture-${version}.tgz`, integrity: `sha512-fixture-${version}` });
  const packages: any = {
    'node_modules/app': { ...pkg('1.0.0'), dependencies: { nested: '^2.0.0' } },
    'node_modules/nested': pkg('2.0.0'),
    'node_modules/@esbuild/win32-x64': { ...pkg('0.28.2'), optional: true, os: ['win32'], cpu: ['x64'] },
    'node_modules/@esbuild/linux-x64': { ...pkg('0.28.2'), optional: true, os: ['linux'], cpu: ['x64'] },
    'node_modules/optional-native': { ...pkg('1.0.0'), optional: true },
  };
  const lock: any = { lockfileVersion: 3, packages: { '': structuredClone(manifest), ...packages } };
  const source = async () => { await write('package.json', manifest); await write('package-lock.json', lock); };
  await source();
  const installed: any = structuredClone(packages);
  delete installed['node_modules/@esbuild/linux-x64'];
  delete installed['node_modules/optional-native'];
  await write('node_modules/.package-lock.json', { lockfileVersion: 3, packages: installed });
  for (const [location, pkg] of Object.entries(installed) as Array<[string, any]>) await write(location + '/package.json', { version: pkg.version });
  const check = (currentRuntime = runtime) => checkDependencies(root, currentRuntime);
  const record = async (text = check().stamp) => {
    await fs.mkdir(path.join(root, '.test-data/launcher'), { recursive: true });
    await fs.writeFile(path.join(root, '.test-data/launcher/dependencies.txt'), text);
  };
  return { root, manifest, lock, installed, write, source, check, record };
}

test('a manual install and stale legacy hashes are reused after checking the installed tree', async t => {
  const f = await fixture(t);
  assert.equal(f.check().install, false);
  await f.record('A'.repeat(64) + ':' + 'B'.repeat(64) + ':24');
  assert.equal(f.check().install, false, 'metadata-only updates must not reinstall when old raw hashes differ');
  await f.record();
  assert.equal(f.check().install, false);
  await f.record('damaged record');
  assert.equal(f.check().install, false, 'a missing or damaged launcher record is not proof dependencies changed');
});

test('description, test scripts, root version/engines, key order and CRLF do not trigger installation', async t => {
  const f = await fixture(t);
  const before = f.check().stamp;
  await f.record();
  f.manifest.description = 'after';
  f.manifest.version = '1.1.0';
  f.manifest.engines = { node: '>=22.12.0' };
  f.manifest.scripts['test:extra'] = 'node test-extra.mjs';
  f.lock.packages[''] = structuredClone(f.manifest);
  f.lock.version = '1.1.0';
  await f.source();
  const reversed = Object.fromEntries(Object.entries(f.lock).reverse());
  await fs.writeFile(path.join(f.root, 'package-lock.json'), JSON.stringify(reversed, null, 4).replace(/\n/g, '\r\n'));
  assert.equal(f.check().install, false);
  assert.equal(f.check().stamp, before);
});

test('dependency, transitive resolution and install-script changes still require preparation', async t => {
  for (const change of ['manifest', 'transitive', 'integrity', 'script']) {
    const f = await fixture(t);
    await f.record();
    if (change === 'manifest') f.manifest.dependencies.app = '^2.0.0';
    if (change === 'transitive') f.lock.packages['node_modules/nested'].version = '2.1.0';
    if (change === 'integrity') f.lock.packages['node_modules/nested'].integrity = 'sha512-changed';
    if (change === 'script') f.manifest.scripts.postinstall = 'node prepare.mjs';
    await f.source();
    assert.equal(f.check().install, true, change);
  }
});

test('legacy/manual installs with outdated resolved versions or unsynchronized manifests are not adopted', async t => {
  const f = await fixture(t);
  f.lock.packages['node_modules/nested'].version = '2.1.0';
  await f.source();
  assert.equal(f.check().install, true);
  assert.match(f.check().reason, /不一致/);
  f.lock.packages['node_modules/nested'].version = '2.0.0';
  f.manifest.dependencies.app = '^2.0.0';
  await f.source();
  assert.equal(f.check().install, true);
});

test('removing unused dependencies reuses the verified remaining tree without clearing a live runtime', async t => {
  const f = await fixture(t);
  await f.record();
  delete f.manifest.dependencies.app;
  delete f.lock.packages[''].dependencies.app;
  delete f.lock.packages['node_modules/app'];
  delete f.lock.packages['node_modules/nested'];
  await f.source();
  assert.equal(f.check().install, false, 'unused installed packages do not require deleting the whole tree');
  assert.match(f.check().reason, /已核对/);
  await f.record();
  assert.equal(f.check().install, false);
});

test('a completed manual update is adopted even when a previous launcher stamp describes the old lock', async t => {
  const f = await fixture(t);
  await f.record();
  f.lock.packages['node_modules/nested'].version = '2.1.0';
  await f.source();
  assert.equal(f.check().install, true);
  f.installed['node_modules/nested'] = structuredClone(f.lock.packages['node_modules/nested']);
  await f.write('node_modules/nested/package.json', { version: '2.1.0' });
  await f.write('node_modules/.package-lock.json', { packages: f.installed });
  assert.equal(f.check().install, false);
});

test('missing packages are repaired even with a matching stamp, including the optional esbuild binary package', async t => {
  for (const location of ['app', 'nested', '@esbuild/win32-x64']) {
    const f = await fixture(t);
    await f.record();
    await fs.unlink(path.join(f.root, 'node_modules', location, 'package.json'));
    assert.equal(f.check().install, true, location);
    assert.match(f.check().reason, /缺失或损坏/);
  }
});

test('incomplete or mismatched npm install records cannot be mistaken for a ready tree', async t => {
  const f = await fixture(t);
  await f.record();
  f.installed['node_modules/nested'].integrity = 'sha512-other';
  await f.write('node_modules/.package-lock.json', { packages: f.installed });
  assert.equal(f.check().install, true);
  await fs.unlink(path.join(f.root, 'node_modules/.package-lock.json'));
  assert.equal(f.check().install, true);
});

test('Node major and platform changes trigger preparation; the same runtime is reused', async t => {
  const f = await fixture(t);
  await f.record();
  assert.equal(f.check().install, false);
  assert.equal(f.check({ ...runtime, major: 22 }).install, true);
  assert.equal(f.check({ ...runtime, arch: 'arm64' }).install, true);
  await f.record('A'.repeat(64) + ':' + 'B'.repeat(64) + ':22');
  assert.equal(f.check().install, true, 'legacy records preserve the previous Node major');
});

test('failed or cancelled npm installation is retried even if package files already exist', async t => {
  const f = await fixture(t);
  await f.record('{"pending":true}');
  assert.equal(f.check().install, true);
  assert.match(f.check().reason, /上次依赖安装未完成/);
});

test('legacy adoption cannot silently skip a root install script', async t => {
  const f = await fixture(t);
  f.manifest.scripts.postinstall = 'node prepare.mjs';
  await f.source();
  assert.equal(f.check().install, true);
});

test('an incomplete source lockfile reports an error rather than reusing an arbitrary installation', async t => {
  const f = await fixture(t);
  await f.write('package-lock.json', {});
  assert.throws(() => f.check(), /完整.*锁文件/);
});
