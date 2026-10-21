import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { accountIdentity } from '../src/shared/account-data';
import { scopeAccountSnapshot, snapshotAccountKey } from '../src/shared/account-scope';
import type { AgentSession, Draft, Transfer } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error Background-only SSH protocol fixture.
import { teamServer } from './fixtures/team-server.mjs';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-account-scope-')));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  await wb.store.init(); grantTestWorkspace(wb, root);
  t.after(async () => {
    await wb.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('workbench-account-scope-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { root, wb };
}
function draft(session: AgentSession, root: string): Draft {
  return { id: randomUUID(), sessionId: session.id, title: session.title + ' 整理', body: '个人整理正文', binding: structuredClone(session.binding), files: [], generation: 'ready', inputDir: path.join(root, 'draft-input'), outputPath: path.join(root, 'draft.md'), createdAt: new Date().toISOString() };
}
function transfer(session: AgentSession, root: string): Transfer {
  return { id: randomUUID(), sessionId: session.id, binding: structuredClone(session.binding!), name: '个人上传', kind: 'history', status: 'done', bytes: 1, total: 1, localPath: path.join(root, 'history.zip'), target: '/history.zip', projectName: '项目', createdAt: new Date().toISOString() };
}

test('same group/project/connection does not share sessions, drafts, inputs, approvals or transfers across accounts', async t => {
  const { wb, root } = await fixture(t);
  const alice = await wb.createSession('codex', root, offlineProjectId);
  alice.title = '原账号会话'; alice.messages.push({ id: randomUUID(), role: 'user', text: 'alice private conversation', createdAt: alice.createdAt });
  const closed = await wb.createSession('codex', root, offlineProjectId); closed.closedAt = new Date().toISOString();
  await wb.saveInput(alice.id, { text: 'alice unsent input', sourceIds: [], answers: {} });
  const prepared = draft(alice, root); wb.store.drafts.push(prepared); wb.store.transfers.push(transfer(alice, root));
  const material = await wb.createConclusion(offlineProjectId, 'alice private result', 'private result body');
  const aliceProfile = structuredClone(wb.store.settings.workspaceSnapshot!.profile);
  wb.store.settings.workspaceSnapshot!.profile.username = 'bob';
  const bob = await wb.createSession('cursor', root, offlineProjectId);
  wb.store.drafts.push(draft(bob, root)); wb.store.transfers.push(transfer(bob, root));
  await wb.saveInput(bob.id, { text: 'bob input', sourceIds: [], answers: {} });
  const before = JSON.stringify(wb.store.sessions);
  const snapshot = wb.snapshot();
  assert.deepEqual(snapshot.sessions.map(session => session.id), [bob.id]);
  assert.deepEqual(Object.keys(snapshot.inputs), [bob.id]);
  assert.equal(snapshot.drafts.length, 1); assert.equal(snapshot.drafts[0].sessionId, bob.id);
  assert.equal(snapshot.transfers.length, 1); assert.equal(snapshot.transfers[0].sessionId, bob.id);
  assert.equal(wb.conclusions(offlineProjectId, true).length, 0);
  assert(!JSON.stringify(snapshot).includes('alice private conversation'));
  assert.equal(JSON.stringify(wb.store.sessions), before, 'filtering must not delete original records');
  assert.throws(() => wb.session(alice.id), /不属于当前账号/);
  assert.throws(() => wb.draft(prepared.id), /不属于当前账号/);
  assert.throws(() => wb.saveInput(alice.id, { text: 'overwrite', sourceIds: [], answers: {} }), /不属于当前账号/);
  assert.throws(() => wb.prepare(alice.id), /不属于当前账号/, 'cached draft reuse must check the session owner first');
  assert.throws(() => wb.answer(alice.id, 'approval', 'allow'), /不属于当前账号/);
  await assert.rejects(wb.readHandoff(alice.id), /不属于当前账号/);
  await assert.rejects(wb.renameSession(alice.id, 'overwrite'), /不属于当前账号/);
  await assert.rejects(wb.saveConclusion(material.id, 'overwrite', 'overwrite'), /不属于当前账号/);
  await assert.rejects(wb.saveConclusionAlias(material.id, 'overwrite'), /不属于当前账号/);
  await assert.rejects(wb.archiveConclusion(material.id, true), /不属于当前账号/);
  await assert.rejects(wb.attachConclusion(bob.id, material.id), /不属于当前账号/);
  wb.store.settings.workspaceSnapshot!.profile = aliceProfile;
  const restored = wb.snapshot();
  assert.deepEqual(new Set(restored.sessions.map(session => session.id)), new Set([alice.id, closed.id]));
  assert.equal(restored.inputs[alice.id].text, 'alice unsent input');
  assert.equal(wb.conclusions(offlineProjectId)[0].id, material.id);
  assert.equal(wb.session(alice.id).title, '原账号会话');
});

test('snapshot scope distinguishes server and fingerprint, hides unowned legacy data and keeps a stable key offline', async t => {
  const { wb, root } = await fixture(t);
  const session = await wb.createSession('codex', root, offlineProjectId);
  const snapshot = wb.snapshot();
  snapshot.activeTurns = { [session.id]: 'owned-turn', foreign: 'private-turn' };
  snapshot.sessions.push({ ...structuredClone(session), id: 'unowned', binding: undefined });
  snapshot.inputs.unowned = { text: 'unowned draft', sourceIds: [], answers: {} };
  assert.deepEqual(scopeAccountSnapshot(snapshot).activeTurns, { [session.id]: 'owned-turn' });
  assert.equal(scopeAccountSnapshot(snapshot).sessions.length, 1);
  const key = snapshotAccountKey(snapshot);
  snapshot.connection = { connected: true, profile: structuredClone(snapshot.settings.workspaceSnapshot!.profile), workspaces: [] };
  assert.equal(snapshotAccountKey(snapshot), key);
  snapshot.connection.profile.id = 'new-connection-record';
  assert.equal(scopeAccountSnapshot(snapshot).sessions.length, 1, 'same identity may log in through a new connection record');
  for (const field of ['username', 'host', 'fingerprint'] as const) {
    const other = structuredClone(snapshot); other.connection!.profile[field] = 'different';
    assert.equal(scopeAccountSnapshot(other).sessions.length, 0, field);
    assert.notEqual(snapshotAccountKey(other), key, 'account view must remount when identity changes');
  }
  const otherPort = structuredClone(snapshot); otherPort.connection!.profile.port++;
  assert.equal(scopeAccountSnapshot(otherPort).sessions.length, 0);
  const changing = scopeAccountSnapshot({ ...snapshot, accountChanging: true });
  assert.equal(changing.sessions.length, 0); assert.deepEqual(changing.inputs, {});
  assert.equal(changing.accountSync?.conflicts, undefined);
});

test('restart under another account restores prepared results to the source account, never the current login', async t => {
  const { wb, root } = await fixture(t);
  const alice = await wb.createSession('codex', root, offlineProjectId), prepared = draft(alice, root);
  const originalOwner = accountIdentity(alice.binding!);
  wb.store.drafts.push(prepared);
  await wb.saveDraftPersonal(prepared.id, [prepared.id]);
  wb.store.settings.workspaceSnapshot!.profile.username = 'bob';
  await wb.store.save();
  const restarted = new Workbench(wb.store.root, () => {}, () => {}); restarted.detect = async () => [];
  try {
    await restarted.init();
    assert.equal(restarted.snapshot().sessions.length, 0);
    assert.equal(restarted.snapshot().drafts.length, 0);
    assert.equal(restarted.conclusions(offlineProjectId, true).length, 0);
    assert.equal(restarted.store.conclusions.length, 1);
    assert.equal(restarted.store.conclusions[0].accountOwner, originalOwner);
    restarted.store.settings.workspaceSnapshot!.profile.username = 'alice';
    assert.equal(restarted.conclusions(offlineProjectId, true).length, 1);
  } finally { await restarted.close(); }
});

test('real login transitions preserve both accounts, reject late reads and prevent switching during writes or active tasks', async t => {
  const { wb, root } = await fixture(t), server = await teamServer();
  t.after(() => server.close());
  await wb.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true);
  const project = await syncedProject(wb, '共同项目');
  const alice = await wb.createSession('codex', root, project.id);
  await wb.saveInput(alice.id, { text: 'alice saved input', sourceIds: [], answers: {} });
  const epoch = wb.accountEpoch;
  let finishRead!: (value: string) => void;
  const pending = wb.runAccountOperation('session.history', () => new Promise<string>(resolve => { finishRead = resolve; }));
  const rejected = assert.rejects(pending, /账号已改变/);
  const activate = wb.accountSync.activate.bind(wb.accountSync);
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumeLogin = new Promise<void>(resolve => { resume = resolve; });
  wb.accountSync.activate = async (...args) => { enter(); await resumeLogin; return activate(...args); };
  const login = wb.configureWorkspace(server.profile('bob'), 'test-password', '', async () => true);
  await entered;
  const changing = wb.snapshot();
  assert.equal(changing.accountChanging, true);
  assert.equal(changing.connection, undefined, 'a provisional login must not label the old workspace as the new account');
  assert.deepEqual(changing.sessions, []); assert.deepEqual(changing.inputs, {});
  assert.throws(() => wb.session(alice.id), /正在登录/);
  resume(); await login; wb.accountSync.activate = activate;
  assert(wb.accountEpoch > epoch);
  finishRead('alice private history'); await rejected;
  assert.equal(wb.snapshot().sessions.length, 0);
  const bob = await wb.createSession('codex', root, project.id);
  bob.status = 'running';
  await assert.rejects(wb.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true), /先停止/);
  assert.equal(wb.remote.profile?.username, 'bob'); bob.status = 'idle';
  let finishWrite!: () => void;
  const writing = wb.runAccountOperation('session.attachLocal', () => new Promise<void>(resolve => { finishWrite = resolve; }));
  await assert.rejects(wb.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true), /等待传输或保存/);
  finishWrite(); await writing;
  await assert.rejects(wb.configureWorkspace(server.profile('alice'), 'wrong-password', '', async () => true));
  assert.deepEqual(wb.snapshot().sessions.map(session => session.id), [bob.id], 'failed login retains the last verified offline account');
  await wb.configureWorkspace(server.profile('alice'), 'test-password', '', async () => true);
  assert.deepEqual(wb.snapshot().sessions.map(session => session.id), [alice.id]);
  assert.equal(wb.snapshot().inputs[alice.id].text, 'alice saved input');
  wb.remote.disconnect();
  assert.deepEqual(wb.snapshot().sessions.map(session => session.id), [alice.id]);
  assert.equal(wb.store.sessions.length, 2);
});

test('cleaning upload cache leaves another account files and transfer metadata untouched', async t => {
  const { wb, root } = await fixture(t);
  const alice = await wb.createSession('codex', root, offlineProjectId);
  const a = transfer(alice, root); a.localPath = path.join(wb.store.root, 'packages', 'alice.zip');
  await fs.mkdir(path.dirname(a.localPath), { recursive: true }); await fs.writeFile(a.localPath, 'alice file');
  wb.store.settings.workspaceSnapshot!.profile.username = 'bob';
  const bob = await wb.createSession('codex', root, offlineProjectId);
  const b = transfer(bob, root); b.localPath = path.join(wb.store.root, 'packages', 'bob.zip');
  await fs.writeFile(b.localPath, 'bob file'); wb.store.transfers.push(a, b);
  assert.equal((await wb.cleanUploadCache()).count, 1);
  assert.equal(await fs.readFile(a.localPath, 'utf8'), 'alice file'); assert.equal(a.cacheCleared, undefined);
  assert.equal(b.cacheCleared, true);
});
