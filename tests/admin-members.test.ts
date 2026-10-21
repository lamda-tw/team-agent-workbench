import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemberConflict, MemberSyncStatus } from '../src/admin/member-sync-view';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { AdminMemberSync } from '../src/admin/member-sync';
import { applyMemberDelta, membershipChanges, rebaseMembership, type MemberCommand } from '../src/admin/member-protocol';
import { readRegistry, writeRegistry } from '../src/core/local-space';
import { LocalFileConnection } from '../src/core/local-files';
import { memberProfile } from './fixtures/member-profile';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-members-')), share = path.join(directory, 'share'); await fs.mkdir(share);
  const a = new LocalAdminConnection(() => {}), b = new LocalAdminConnection(() => {});
  const profile = { mode: 'local' as const, localRoot: share, host: 'local', port: 22, root: '/srv/teamspace', username: 'admin', fingerprint: '' };
  await a.connect(profile, '', '', async () => false); await a.operation({ op: 'initialize' });
  for (const label of ['one', 'two']) await a.operation({ op: 'group_create', label });
  await b.connect(profile, '', '', async () => false);
  const teamId = a.snapshot.state!.teamId!;
  const apply = (client: LocalAdminConnection, command: MemberCommand, requestId = randomUUID()) => client.operation({ op: 'members_apply', teamId, requestId, command });
  const create = (username: string): MemberCommand => ({ op: 'user_create', username, name: username, groups: [], contentAdminGroups: [] });
  const clean = async () => { a.disconnect(); b.disconnect(); assert.equal(await fs.realpath(path.dirname(directory)), await fs.realpath(os.tmpdir())); assert(path.basename(directory).startsWith('admin-members-')); await fs.rm(directory, { recursive: true, force: true }); };
  return { a, b, profile, directory, share, teamId, apply, create, clean };
}

test('two admins create distinct members concurrently; same account and request retries are isolated', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await Promise.all([f.apply(f.a, f.create('alice'), id), f.apply(f.b, f.create('bob'))]);
    const before = await readRegistry(f.share), accountId = before.state.users.alice.accountId;
    await f.apply(f.b, f.create('alice'), id);
    assert.deepEqual((await readRegistry(f.share)).credentials, before.credentials);
    assert.equal((await readRegistry(f.share)).state.users.alice.accountId, accountId);
    await assert.rejects(f.apply(f.b, f.create('Alice')), /MEMBER_EXISTS/);
    await assert.rejects(f.apply(f.b, f.create('charlie'), id), /MEMBER_REQUEST/);
    assert.deepEqual(Object.keys((await readRegistry(f.share)).state.users).sort(), ['alice', 'bob']);
  } finally { await f.clean(); }
});

test('member and group sync sends changes/deletions only, keeps passwords and receipts private', async () => {
  const f = await fixture();
  try {
    const first = await f.a.memberSync(); assert.equal(first.full, true);
    await f.apply(f.b, f.create('alice'));
    const delta = await f.a.memberSync(f.teamId, first.sequence);
    assert.equal(delta.full, false); assert.deepEqual(Object.keys(delta.users), ['alice']); assert.deepEqual(delta.groups, {});
    const cache = applyMemberDelta(applyMemberDelta(undefined, first), delta); assert(cache.users.alice.revision);
    assert(!JSON.stringify(delta).includes('memberRequests')); assert(!JSON.stringify(delta).includes('123456'));
    const unchanged = await f.a.memberSync(f.teamId, delta.sequence);
    assert.equal(unchanged.sequence, delta.sequence); assert.deepEqual(unchanged.users, {}); assert.equal(unchanged.metadata, undefined);
    const registry = await readRegistry(f.share); delete registry.state.users.alice; delete registry.state.groups.local_two; await writeRegistry(f.share, registry);
    const deleted = await f.a.memberSync(f.teamId, delta.sequence);
    assert.deepEqual(deleted.deletedUsers, ['alice']); assert.deepEqual(deleted.deletedGroups, ['local_two']);
    assert(!applyMemberDelta(cache, deleted).users.alice);
    await assert.rejects(f.a.memberSync('another-team', delta.sequence), /MEMBER_TEAM/);
  } finally { await f.clean(); }
});

test('stale membership edits are rejected, explicit rebase preserves concurrent additions', async () => {
  const f = await fixture();
  try {
    await f.apply(f.a, f.create('alice'));
    const base = (await f.a.memberSync()).users.alice;
    await f.apply(f.a, { op: 'member_groups', username: 'alice', expectedRevision: base.revision!, changes: [{ group: 'local_one', role: 'member' }] });
    const stale: MemberCommand = { op: 'member_groups', username: 'alice', expectedRevision: base.revision!, changes: [{ group: 'local_two', role: 'member' }] };
    await assert.rejects(f.apply(f.b, stale), /MEMBER_CONFLICT/);
    const current = (await f.b.memberSync()).users.alice;
    const rebased = rebaseMembership(base, current, ['local_two'], []);
    assert.deepEqual(new Set(rebased.groups), new Set(['local_one', 'local_two']));
    await f.apply(f.b, { ...stale, expectedRevision: current.revision!, changes: membershipChanges(current, rebased.groups, rebased.admins) });
    assert.deepEqual(new Set((await readRegistry(f.share)).state.users.alice.groups), new Set(['local_one', 'local_two']));
  } finally { await f.clean(); }
});

test('password resets invalidate old member versions but leave other members editable', async () => {
  const f = await fixture();
  try {
    await f.apply(f.a, f.create('alice')); await f.apply(f.b, f.create('bob'));
    const state = await f.a.memberSync();
    const requestId = randomUUID(), command: MemberCommand = { op: 'user_password', username: 'alice', password: 'reset-password', expectedRevision: state.users.alice.revision! };
    await f.apply(f.a, command, requestId);
    await assert.rejects(f.apply(f.a, { ...command, password: 'different-password' }, requestId), /MEMBER_REQUEST/);
    await assert.rejects(f.apply(f.b, { op: 'user_enabled', username: 'alice', enabled: false, expectedRevision: state.users.alice.revision! }), /MEMBER_CONFLICT/);
    await f.apply(f.b, { op: 'user_enabled', username: 'bob', enabled: false, expectedRevision: state.users.bob.revision! });
    assert.equal((await readRegistry(f.share)).state.users.bob.enabled, false);
    assert(!JSON.stringify(await f.a.memberSync()).includes('reset-password'));
  } finally { await f.clean(); }
});

test('offline creation survives restart and automatically opens only in its bound team', async () => {
  const f = await fixture(); let sync = new AdminMemberSync(path.join(f.directory, 'client'), () => f.a, () => {});
  try {
    await sync.init(); await sync.sync(); f.a.disconnect();
    const id = randomUUID(); assert.equal((await sync.create(f.create('offline'), id)).queued, true);
    assert.equal((await readRegistry(f.share)).state.users.offline, undefined);
    sync.stop(); sync = new AdminMemberSync(path.join(f.directory, 'client'), () => f.a, () => {}); await sync.init();
    assert.equal(sync.snapshot().state!.teamId, f.teamId); assert.equal(sync.view().pending[0].id, id);
    await f.a.connect(f.profile, '', '', async () => false); await sync.sync();
    assert.equal(sync.view().pending.length, 0); assert((await readRegistry(f.share)).state.users.offline);
    assert(!JSON.stringify(sync.view()).includes('123456'));
    f.a.disconnect(); await sync.create(f.create('wrong-team'));
    const registry = await readRegistry(f.share); registry.state.teamId = randomUUID(); await writeRegistry(f.share, registry);
    await f.a.connect(f.profile, '', '', async () => false); await sync.sync();
    assert.match(sync.view().error!, /MEMBER_TEAM/); assert.equal(sync.view().pending.length, 1);
    assert.equal((await readRegistry(f.share)).state.users['wrong-team'], undefined);
  } finally { sync.stop(); await f.clean(); }
});

test('a member changing their own password also invalidates an open administrator form', async () => {
  const f = await fixture(), member = new LocalFileConnection();
  try {
    await f.apply(f.a, f.create('alice'));
    await member.connect(memberProfile(f.a.snapshot.profile!, f.a.snapshot.state!, 'alice'), '123456', async () => false);
    await member.changePassword('123456', 'first-personal-password');
    const baseline = (await f.a.memberSync()).users.alice;
    await member.changePassword('first-personal-password', 'second-personal-password');
    await assert.rejects(f.apply(f.b, { op: 'user_password', username: 'alice', password: 'admin-password', expectedRevision: baseline.revision! }), /MEMBER_CONFLICT/);
  } finally { member.disconnect(); await f.clean(); }
});

test('lost successful response retries the durable request without creating a second member', async () => {
  const f = await fixture(); let lose = true;
  const transport = {
    get snapshot() { return { ...f.a.snapshot, profile: { ...f.a.snapshot.profile!, mode: 'sftp' as const } }; },
    memberSync: (team?: string, since?: number) => f.a.memberSync(team, since),
    operation: async (input: any) => { const result = await f.a.operation(input); if (lose) { lose = false; throw new Error('连接中断'); } return result; },
  };
  const sync = new AdminMemberSync(path.join(f.directory, 'client'), () => transport, () => {});
  try {
    await sync.init(); await sync.sync(); await sync.create(f.create('alice'));
    assert.equal(sync.view().pending.length, 1); assert.equal(sync.view().pending[0].status, 'pending');
    const original = (await readRegistry(f.share)).state.users.alice.accountId;
    await sync.sync(); assert.equal(sync.view().pending.length, 0);
    assert.equal((await readRegistry(f.share)).state.users.alice.accountId, original);
  } finally { sync.stop(); await f.clean(); }
});

test('one rejected offline draft does not block other pending members', async () => {
  const f = await fixture(), sync = new AdminMemberSync(path.join(f.directory, 'client'), () => f.a, () => {});
  try {
    await sync.init(); await sync.sync(); f.a.disconnect();
    await sync.create(f.create('alice')); await sync.create(f.create('bob'));
    await f.apply(f.b, f.create('alice')); await f.a.connect(f.profile, '', '', async () => false); await sync.sync();
    assert.equal(sync.view().pending.length, 1); assert.equal(sync.view().pending[0].command.username, 'alice'); assert.equal(sync.view().pending[0].status, 'blocked');
    assert((await readRegistry(f.share)).state.users.bob);
  } finally { sync.stop(); await f.clean(); }
});

test('Linux member protocol validation and transactions (mock OS, no user or service changes)', () => {
  for (const file of ['test_admin_members.py', 'test_admin.py', 'test_team_groups.py', 'test_content.py']) {
    const output = execFileSync('python', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', file, '-v'], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    assert.doesNotMatch(output, /FAILED/);
  }
});

test('completed receipts clear blocked drafts after recovery in another admin', async () => {
  const f = await fixture();
  let recovery = false;
  const transport = {
    get snapshot() { return f.a.snapshot; },
    memberSync: (team?: string, since?: number, ids?: string[]) => f.a.memberSync(team, since, ids),
    operation: async (input: any) => { if (!recovery) throw new Error('[MEMBER_RECOVERY] 请核对'); return f.a.operation(input); },
  };
  const sync = new AdminMemberSync(path.join(f.directory, 'client'), () => transport, () => {});
  try {
    await sync.init(); await sync.sync(); const id = randomUUID(); await sync.create(f.create('alice'), id);
    assert.equal(sync.view().pending[0].status, 'blocked');
    await f.apply(f.b, f.create('alice'), id); recovery = true;
    await sync.sync(); assert.equal(sync.view().pending.length, 0);
  } finally { sync.stop(); await f.clean(); }
});

test('membership handoffs reject stale successor roles', async () => {
  const f = await fixture();
  try {
    await f.apply(f.a, f.create('alice')); await f.apply(f.a, f.create('bob'));
    await f.a.operation({ op: 'group_member', username: 'alice', group: 'local_one', role: 'admin' });
    await f.a.operation({ op: 'group_member', username: 'bob', group: 'local_one', role: 'member' });
    const base = await f.a.memberSync();
    await f.b.operation({ op: 'user_enabled', username: 'bob', enabled: false });
    await assert.rejects(f.apply(f.a, { op: 'user_enabled', username: 'alice', enabled: false, expectedRevision: base.users.alice.revision!, handoffs: { local_one: 'bob' }, handoffRevisions: { bob: base.users.bob.revision! } }), /MEMBER_CONFLICT/);
    assert.equal((await readRegistry(f.share)).state.users.alice.enabled, true);
  } finally { await f.clean(); }
});

test('offline and conflict views show actionable status and retain a separate confirmation', () => {
  const baseline = { username: 'alice', name: 'Alice', enabled: true, revision: 'old' }, current = { ...baseline, enabled: false, revision: 'new' };
  const html = renderToStaticMarkup(React.createElement(MemberConflict, { baseline, current, confirm() {}, busy: false }));
  assert.match(html, /已启用/); assert.match(html, /已停用/); assert.match(html, /已查看变化，保留输入继续/);
  const offline = renderToStaticMarkup(React.createElement(MemberSyncStatus, { snapshot: { connected: false, verified: false, busy: false, memberSync: { teamId: 'team-a', pending: [{ id: randomUUID(), createdAt: new Date().toISOString(), command: { op: 'user_create', username: 'alice', name: 'Alice', groups: [], contentAdminGroups: [] }, status: 'pending' }] } }, refresh: async () => {} }));
  assert.match(offline, /联网后开通/); assert.match(offline, /待开通成员/); assert.match(offline, /移除待办/);
});
