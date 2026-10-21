import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AdminWindowStore, adminNodeKey, isAdminWindowSource } from '../src/admin/window-store';
import { pathToFileURL } from 'node:url';
import type { AdminProfile } from '../src/admin/types';

const profile = (host: string): AdminProfile => ({ host, port: 22, username: 'root', fingerprint: 'fixture', root: '/srv/teamspace' });
test('IPC verifies the owned local page while accepting equivalent URL encoding in Windows short paths', () => {
  const entry = path.resolve('目录~1', 'index.html'), url = pathToFileURL(entry).href;
  assert(isAdminWindowSource(url, entry));
  assert(isAdminWindowSource(url.replace('%7E', '~'), entry));
  for (const foreign of [undefined, 'https://untrusted.invalid', url + '?other', url + '.other', pathToFileURL(path.resolve('other.html')).href]) assert.equal(isAdminWindowSource(foreign, entry), false);
});
async function fixture(t: { after(fn: () => Promise<void>): void }, available: (port: number) => Promise<boolean> = async () => true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'admin-windows-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('admin-windows-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store: new AdminWindowStore(root, available) };
}

test('concurrent launches claim independent directories and reuse a closed window without rewriting legacy data', async t => {
  const { root, store } = await fixture(t);
  await fs.writeFile(path.join(root, 'egress-secrets.bin'), 'existing-key');
  const slots = await Promise.all([store.claim(), store.claim(), store.claim()]);
  assert.deepEqual(slots, [1, 2, 3]); assert.equal(store.directory(1), root);
  assert.equal(new Set(slots.map(slot => store.directory(slot))).size, 3);
  store.release(2); assert.equal(await store.claim(), 2);
  assert.equal(await store.claim(undefined, true), 4);
  assert.equal(await fs.readFile(path.join(root, 'egress-secrets.bin'), 'utf8'), 'existing-key');
  assert.throws(() => store.directory(-1), /无效/);
});

test('node profiles survive restart, cannot overwrite another node and exclude passwords', async t => {
  const { root, store } = await fixture(t); const a = await store.claim(), b = await store.claim();
  await store.saveProfile(a, { ...profile('A.internal'), password: 'DO_NOT_SAVE' } as AdminProfile);
  await store.saveProfile(b, profile('b.internal'));
  await assert.rejects(store.saveProfile(a, profile('b.internal')), /独立窗口/);
  const reopened = new AdminWindowStore(root);
  assert.equal(await reopened.find(profile('a.internal')), a);
  assert.equal(await reopened.find(profile('b.internal')), b);
  assert.equal(await reopened.find({ ...profile('a.internal'), username: 'other' }), undefined);
  assert.equal(await reopened.find({ ...profile('a.internal'), root: '/srv/other' }), undefined);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'connection.json'), 'utf8'), /DO_NOT_SAVE|password/);
  assert.notEqual(adminNodeKey(profile('a.internal')), adminNodeKey({ ...profile('a.internal'), port: 2222 }));
  assert.notEqual(adminNodeKey({ ...profile('local'), mode: 'local', localRoot: path.join(root, 'a') }), adminNodeKey({ ...profile('local'), mode: 'local', localRoot: path.join(root, 'b') }));
});

test('new egress ports skip occupied and reserved ports while saved access endpoints never silently change', async t => {
  const { root, store } = await fixture(t, async port => port !== 18443 && port !== 18445);
  const a = await store.claim(), b = await store.claim(), c = await store.claim();
  await fs.writeFile(path.join(root, 'egress.json'), JSON.stringify({ listenPort: 18443 }));
  assert.deepEqual(await Promise.all([store.defaultPort(a), store.defaultPort(b), store.defaultPort(c)]), [18443, 18444, 18446]);
  await assert.rejects(store.reservePort(c, 18444), /另一中央节点/);
  assert.equal(await store.defaultPort(c), 18446);
  await store.reservePort(c, 19000); assert.equal(await store.defaultPort(c), 19000);
  await fs.writeFile(path.join(store.directory(c), 'egress.json'), JSON.stringify({ listenPort: 19000 }));
  const reopened = new AdminWindowStore(root, async () => false);
  assert.equal(await reopened.defaultPort(c), 19000, 'a temporarily occupied saved port must report a startup failure, not change distributed codes');
});

test('competing port edits are serialized and malformed persisted configuration is not overwritten', async t => {
  const { root, store } = await fixture(t); const a = await store.claim(), b = await store.claim();
  const results = await Promise.allSettled([store.reservePort(a, 19999), store.reservePort(b, 19999)]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  await fs.writeFile(path.join(root, 'egress.json'), 'broken');
  await assert.rejects(new AdminWindowStore(root).defaultPort(1));
  assert.equal(await fs.readFile(path.join(root, 'egress.json'), 'utf8'), 'broken');
});
