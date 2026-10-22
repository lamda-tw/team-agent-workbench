import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Read-only Node diagnostic shared with support.
import { diagnoseAccountSessions } from '../scripts/account-session-diagnostic.mjs';

test('session diagnostics distinguish identity and group mismatches without disclosing conversation or credentials', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'account-session-diagnostic-'))), directory = path.join(root, 'window-state', '2');
  await fs.mkdir(directory, { recursive: true });
  try {
    const profile = { host: 'fixture.invalid', port: 22, username: 'taowen', fingerprint: 'SHA256:fixture', projects: [{ id: 'p', groupName: 'current-group' }] };
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ workspaceSnapshot: { profile }, password: 'DO_NOT_PRINT_PASSWORD' }));
    const sessions = [{ nativeId: 'native-id', binding: { ...profile, project: { id: 'p' } }, messages: [{ text: 'DO_NOT_PRINT_CONVERSATION' }] }];
    await fs.writeFile(path.join(directory, 'sessions.json'), JSON.stringify(sessions));
    const before = await fs.readFile(path.join(directory, 'sessions.json'));
    const result = await diagnoseAccountSessions(root, 'taowen'), serialized = JSON.stringify(result);
    assert.equal(result.datasets[0].groups[0].nativeLinked, 1);
    assert.equal(result.datasets[0].groups[0].outdatedGroup, 1);
    assert.equal(result.datasets[0].groups[0].messages, 1);
    assert(!serialized.includes('DO_NOT_PRINT'));
    assert.deepEqual(await fs.readFile(path.join(directory, 'sessions.json')), before);
    assert.deepEqual((await diagnoseAccountSessions(root, 'bob')).datasets, []);
  } finally {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert(path.basename(root).startsWith('account-session-diagnostic-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('diagnostics include login-free personal sessions and missing indexes without assigning them to the SSH user', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'account-session-diagnostic-'))), directory = path.join(root, 'personal');
  await fs.mkdir(directory, { recursive: true });
  try {
    const sessions = [{ nativeId: 'native-id', binding: { connectionId: '__personal__', host: 'personal', fingerprint: 'PERSONAL', username: 'local' }, messages: [{ text: 'PRIVATE_BODY' }] }];
    await fs.writeFile(path.join(directory, 'sessions.json'), JSON.stringify(sessions));
    const result = await diagnoseAccountSessions(root, 'taowen');
    assert.equal(result.inventory.find((item: any) => item.directory === '.').indexExists, false);
    assert.equal(result.inventory.find((item: any) => item.directory === 'personal').totalSessions, 1);
    assert.equal(result.datasets[0].local.nativeLinked, 1);
    assert.deepEqual(result.datasets[0].groups, []);
    assert(!JSON.stringify(result).includes('PRIVATE_BODY'));
  } finally {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert(path.basename(root).startsWith('account-session-diagnostic-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
