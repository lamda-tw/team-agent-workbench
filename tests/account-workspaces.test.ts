import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { AccountWorkspacePool, accountDirectory, migrateAccountWorkspace } from '../src/core/account-workspaces';
import { Store, atomicJson } from '../src/core/store';
import { Workbench } from '../src/core/workbench';
import { SharedFiles } from '../src/core/shared-files';
import { accountIdentity } from '../src/shared/account-data';
import { projectDirectoryKey } from '../src/shared/project-directory';
import { prepareCodexStorage } from '../src/core/codex-storage';
import type { AgentSession, ConnectionProfile, Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Background-only SSH protocol fixture.
import { teamServer } from './fixtures/team-server.mjs';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-account-windows-')));
  t.after(async () => { assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert(path.basename(root).startsWith('workbench-account-windows-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const first = new Workbench(path.join(root, 'user'), () => {}, () => {});
  await first.store.init(); grantTestWorkspace(first, root);
  await first.store.save();
  const profile = structuredClone(first.store.settings.workspaceSnapshot!.profile);
  t.after(() => first.close());
  return { root, first, profile };
}

test('account migration retains owned compressed Codex histories for native resume and fork', async t => {
  const { root, first, profile } = await fixture(t);
  const session = await first.createSession('codex', root, offlineProjectId);
  session.nativeId = randomUUID(); session.codexStorage = 'workbench';
  const file = path.join(first.store.root, 'codex-home', 'archived_sessions', 'rollout-' + session.nativeId + '.jsonl.zst');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = zstdCompressSync('original history'); await fs.writeFile(file, bytes); session.nativePath = file;
  const other = path.join(path.dirname(file), 'rollout-' + randomUUID() + '.jsonl.zst'); await fs.writeFile(other, 'foreign');
  await first.store.save();
  const destination = await migrateAccountWorkspace(first.store.root, profile), migrated = new Store(destination); await migrated.init();
  const restored = migrated.sessions.find(value => value.id === session.id)!;
  const storage = await prepareCodexStorage(destination, restored, path.join(root, 'empty-personal'));
  assert.equal(restored.codexNeedsRegistration, true);
  assert.deepEqual(await fs.readFile(storage.resumePath!), bytes);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(path.dirname(storage.resumePath!)), [path.basename(file)]);
});

test('account migration retains evolved RSI policies and progress without importing another account', async t => {
  const { first, profile } = await fixture(t), owner = accountIdentity(profile);
  await first.rsi.observe(offlineProjectId, [{ source: 'project', sourceId: 'goal', factKey: 'goal', version: '1', eventAt: new Date().toISOString(), text: '保留策略与学习记录', actor: 'alice', assertion: 'explicit' }]);
  const view = await first.rsi.view(offlineProjectId), file = path.join(first.store.root, 'rsi-v2.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  original.projects['foreign'] = { ...structuredClone(original.projects[view.scope.key]), scope: { ...view.scope, account: 'another-account' } };
  await atomicJson(file, original);
  const destination = await migrateAccountWorkspace(first.store.root, profile);
  const migrated = JSON.parse(await fs.readFile(path.join(destination, 'rsi-v2.json'), 'utf8'));
  assert.equal(migrated.projects[view.scope.key].scope.account, owner);
  assert.deepEqual(migrated.projects[view.scope.key].policies, view.policies);
  assert.deepEqual(migrated.projects[view.scope.key].evidence, JSON.parse(JSON.stringify(view.evidence)));
  assert.equal(migrated.projects.foreign, undefined);
});

test('account migration retries a transient Windows directory lock without publishing partial data', async t => {
  const { root, first, profile } = await fixture(t), destination = accountDirectory(first.store.root, profile);
  const rename = fs.rename.bind(fs); let blocked = 0;
  const mock = t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (to === destination && from.startsWith(destination + '.migrating-') && blocked++ < 2) throw Object.assign(new Error('scanner lock'), { code: 'EPERM' });
    return rename(from, to);
  });
  try {
    assert.equal(await migrateAccountWorkspace(first.store.root, profile, root), destination);
    assert.equal(blocked, 3);
    assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'migration.json'), 'utf8')).owner, accountIdentity(profile));
  } finally { mock.mock.restore(); }
});

test('account migration finds sessions in a window now logged in as someone else and preserves histories, drafts, inputs and account isolation', async t => {
  const { root, first, profile } = await fixture(t), base = first.store.root;
  const second = new Workbench(path.join(base, 'instances', '2'), () => {}, () => {});
  await second.store.init(); grantTestWorkspace(second, root); t.after(() => second.close());
  second.store.settings.workspaceSnapshot!.profile.id = 'second-window-login';
  const a = await first.createSession('codex', root, offlineProjectId);
  const b = await second.createSession('codex', root, offlineProjectId);
  b.title = '原窗口中的算法比赛'; b.nativeId = randomUUID(); b.codexStorage = 'workbench';
  b.messages = [{ id: randomUUID(), role: 'user', text: 'Do not rewrite text: ' + second.store.root, createdAt: b.createdAt }];
  await second.saveInput(b.id, { text: '尚未发送', sourceIds: [], answers: {} });
  await second.store.event(b.id, { proof: 'original event' });
  const rollout = path.join(second.store.root, 'codex-home', 'sessions', '2026', 'rollout-' + b.nativeId + '.jsonl');
  await fs.mkdir(path.dirname(rollout), { recursive: true }); await fs.writeFile(rollout, 'native context'); b.nativePath = rollout;
  await fs.writeFile(path.join(path.dirname(rollout), 'unrelated.jsonl'), 'another account history');
  const draftId = randomUUID(), inputDir = path.join(second.store.root, 'drafts', draftId, 'input');
  await fs.mkdir(inputDir, { recursive: true }); await fs.writeFile(path.join(inputDir, 'conversation.json'), JSON.stringify(b.messages));
  const draft: Draft = { id: draftId, sessionId: b.id, title: '整理结果', body: '结论', files: [], inputDir, outputPath: path.join(inputDir, '..', 'draft.md'), createdAt: b.createdAt, binding: b.binding, generation: 'ready', preparationVersion: 1 };
  second.store.drafts.push(draft);
  const material = await second.createConclusion(offlineProjectId, '个人成果', '结论正文');
  const directoryKey = projectDirectoryKey(profile, offlineProjectId);
  second.store.settings.projectDirectories = { [directoryKey]: root };
  second.store.settings.workspaceSnapshot!.profile.username = 'bob';
  const foreign = await second.createSession('cursor', root, offlineProjectId);
  const foreignResult = await second.createConclusion(offlineProjectId, 'bob result', 'bob private');
  await first.store.save(); await second.store.save();
  await atomicJson(path.join(second.store.root, 'accounts', path.basename(accountDirectory(base, profile)) + '.json.pending'), { 'alias:project:result': '之前账号未同步的别名' });
  const before = await fs.readFile(path.join(second.store.root, 'sessions.json'), 'utf8');
  const destination = await migrateAccountWorkspace(base, profile, base), store = new Store(destination); await store.init();
  assert.deepEqual(new Set(store.sessions.map(s => s.id)), new Set([a.id, b.id]));
  assert(!store.sessions.some(s => s.id === foreign.id));
  assert.deepEqual(store.conclusions.map(item => item.id), [material.id]); assert(!store.conclusions.some(item => item.id === foreignResult.id));
  assert.equal(store.settings.projectDirectories?.[directoryKey], root);
  assert.equal(store.settings.contentAliases?.['project:result'], '之前账号未同步的别名');
  const restored = store.sessions.find(s => s.id === b.id)!;
  assert.equal(restored.binding!.connectionId, profile.id);
  assert.deepEqual(restored.messages, b.messages); assert.equal(restored.cwd, root); assert.equal(store.inputs[b.id].text, '尚未发送');
  assert.equal(await fs.readFile(path.join(store.sessionDir(b.id), 'events.jsonl'), 'utf8'), await fs.readFile(path.join(second.store.sessionDir(b.id), 'events.jsonl'), 'utf8'));
  assert.equal(await fs.readFile(path.join(store.drafts[0].inputDir, 'conversation.json'), 'utf8'), JSON.stringify(b.messages));
  assert(restored.nativePath!.startsWith(destination)); assert.equal(restored.codexNeedsRegistration, true);
  const personal = path.join(root, 'personal'); await fs.mkdir(personal);
  const storage = await prepareCodexStorage(destination, restored, personal);
  assert.equal(await fs.readFile(storage.resumePath!, 'utf8'), 'native context');
  assert.deepEqual(await fs.readdir(path.dirname(storage.resumePath!)), [path.basename(rollout)]);
  assert.equal(await fs.readFile(path.join(second.store.root, 'sessions.json'), 'utf8'), before, 'migration never changes the old window');
  assert.equal(await fs.readFile(rollout, 'utf8'), 'native context');
  // Explicit deletions in the new account directory must not resurrect from backups.
  store.sessions = []; store.drafts = []; store.conclusions = []; await store.save();
  assert.equal(await migrateAccountWorkspace(base, profile, second.store.root), destination);
  const reopened = new Store(destination); await reopened.init(); assert.equal(reopened.sessions.length, 0); assert.equal(reopened.conclusions.length, 0);
  const bob = { ...profile, username: 'bob' }, bobStore = new Store(await migrateAccountWorkspace(base, bob)); await bobStore.init();
  assert.deepEqual(bobStore.sessions.map(s => s.id), [foreign.id]); assert.deepEqual(bobStore.conclusions.map(s => s.id), [foreignResult.id]);
});

test('migration imports a duplicate session once, rejects damaged sources atomically, and distinguishes server identities', async t => {
  const { root, first, profile } = await fixture(t), base = first.store.root;
  const session = await first.createSession('codex', root, offlineProjectId); await first.store.save();
  const second = path.join(base, 'instances', '2'); await fs.mkdir(second, { recursive: true });
  await atomicJson(path.join(second, 'settings.json'), first.store.settings);
  await atomicJson(path.join(second, 'sessions.json'), [session]);
  const corrupt = path.join(second, 'drafts.json'); await fs.writeFile(corrupt, '{incomplete');
  await assert.rejects(migrateAccountWorkspace(base, profile), /无法读取本地账号资料/);
  await assert.rejects(fs.access(accountDirectory(base, profile)), { code: 'ENOENT' });
  await atomicJson(corrupt, []);
  const destination = await migrateAccountWorkspace(base, profile), store = new Store(destination); await store.init();
  assert.deepEqual(store.sessions.map(s => s.id), [session.id]);
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'migration.json'), 'utf8')); assert.equal(manifest.conflicts.length, 1);
  for (const change of [{ host: 'other.example' }, { port: profile.port + 1 }, { fingerprint: 'SHA256:different' }]) {
    const other = { ...profile, ...change }, otherStore = new Store(await migrateAccountWorkspace(base, other)); await otherStore.init();
    assert.notEqual(otherStore.root, destination); assert.equal(otherStore.sessions.length, 0);
  }
  assert.equal(accountDirectory(base, { ...profile, host: profile.host.toUpperCase(), id: 'another-login' }), destination);
});

test('concurrent account windows share one store and runtime owner, retain both writes, and close only after the last window', async t => {
  const { root, first, profile } = await fixture(t);
  let created = 0, closed = 0;
  const pool = new AccountWorkspacePool(async p => {
    created++;
    const wb = new Workbench(await migrateAccountWorkspace(first.store.root, p), () => {}, () => {});
    wb.detect = async () => []; await wb.init(); return wb;
  }, async wb => { closed++; await wb.close(); });
  const [a, b] = await Promise.all([pool.acquire(profile), pool.acquire({ ...profile, id: 'other-login' })]);
  assert.equal(a.value, b.value); assert.equal(created, 1);
  const [s1, s2] = await Promise.all([a.value.createSession('codex', root, offlineProjectId), b.value.createSession('cursor', root, offlineProjectId)]);
  assert.deepEqual(new Set(a.value.snapshot().sessions.map(s => s.id)), new Set([s1.id, s2.id]));
  await a.release(); assert.equal(closed, 0);
  await b.value.renameSession(s1.id, '另一个窗口仍可编辑');
  await b.release(); assert.equal(closed, 1); await b.release(); assert.equal(closed, 1);
  const reopened = await pool.acquire(profile); assert.equal(created, 2);
  assert.deepEqual(new Set(reopened.value.snapshot().sessions.map(s => s.id)), new Set([s1.id, s2.id]));
  assert.equal(reopened.value.session(s1.id).title, '另一个窗口仍可编辑');
  await reopened.release();
});

test('failed close preserves the account lease and simultaneous different accounts never share mutable data', async t => {
  const { profile } = await fixture(t); let fail = true, created = 0;
  const pool = new AccountWorkspacePool(async p => ({ owner: accountIdentity(p), number: ++created }), async () => { if (fail) throw new Error('disk full'); });
  const alice = await pool.acquire(profile), bob = await pool.acquire({ ...profile, username: 'bob' });
  assert.notEqual(alice.value, bob.value);
  await assert.rejects(alice.release(), /disk full/);
  const another = await pool.acquire(profile); assert.equal(another.value, alice.value); assert.equal(created, 2);
  await another.release(); fail = false; await alice.release(); await bob.release();
});

test('authenticated connection handoff logs in once and rejected passwords leave the existing account live', async t => {
  const { root, first } = await fixture(t), server = await teamServer(); t.after(() => server.close());
  const verifier = new SharedFiles(() => {});
  const profile: ConnectionProfile = await verifier.connect(server.profile('alice'), 'test-password', async () => true); await verifier.loadManifest();
  const wb = new Workbench(await migrateAccountWorkspace(first.store.root, profile), () => {}, () => {}); wb.detect = async () => []; await wb.init(); t.after(() => wb.close());
  await wb.configureWorkspace(profile, '', '', async () => { throw new Error('no second login'); }, verifier);
  verifier.disconnect(); assert.equal(wb.remote.connected, true, 'closing the verifier must not close the adopted connection');
  const project = await syncedProject(wb, '账号项目'), session = await wb.createSession('codex', root, project.id);
  const failed = new SharedFiles(() => {});
  await assert.rejects(failed.connect(server.profile('bob'), 'wrong-password', async () => true)); failed.disconnect();
  assert.equal(wb.remote.connected, true); assert.equal(wb.remote.profile?.username, 'alice'); assert.equal(wb.session(session.id).id, session.id);
  assert((await wb.remote.loadManifest()).some((item: any) => item.id === project.id));
  wb.remote.disconnect();
  const reconnect = new SharedFiles(() => {});
  const relogin = await reconnect.connect({ ...server.profile('alice'), id: 'different-window-id' }, 'test-password', async () => true);
  await reconnect.loadManifest(); await wb.configureWorkspace(relogin, '', '', async () => true, reconnect); reconnect.disconnect();
  assert.equal(wb.remote.profile!.id, profile.id); assert.doesNotThrow(() => wb.remote.channel(session.binding));
});
