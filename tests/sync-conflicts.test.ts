import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mergeAccountRecords, AccountSync } from '../src/core/account-sync';
import { SyncConflicts } from '../src/core/sync-conflicts';
import { applyConflictText, verifiableTextMerge } from '../src/shared/sync-conflict';
import { Store } from '../src/core/store';
import { accountIdentity } from '../src/shared/account-data';
import type { SharedFiles } from '../src/core/shared-files';
import type { ConnectionProfile } from '../src/shared/types';

const profile: ConnectionProfile = { id: 'fixture', name: 'fixture', host: 'server', port: 22, username: 'alice', fingerprint: 'fixture', manifestPath: '', projects: [] };
const result = (id: string, content: string) => ({ id, projectId: 'p', title: id, content, sources: [], version: 1, updatedAt: '2026-10-21', accountOwner: accountIdentity(profile) });

test('field merge preserves independent edits and reports delete/edit conflicts instead of guessing', () => {
  const base = { title: 'original', content: 'base' }, local = { ...base, title: 'local' }, remote = { ...base, content: 'remote' };
  const merged = mergeAccountRecords({ 'material:a': base }, { 'material:a': local }, { 'material:a': remote });
  assert.deepEqual(merged.records['material:a'], { title: 'local', content: 'remote' }); assert.equal(merged.conflicts.length, 0);
  const deletion = mergeAccountRecords({ a: base }, { a: null }, { a: remote });
  assert.equal(deletion.conflicts.length, 1); assert.deepEqual(deletion.conflicts[0].fields[0].path, []);
  const conflict = mergeAccountRecords({ a: base }, { a: { ...base, content: 'date: 10' } }, { a: { ...base, content: 'date: 20' } }).conflicts[0];
  assert.equal(verifiableTextMerge(conflict, [{ path: ['content'], text: 'date: 20' }]), false);
  assert.throws(() => applyConflictText(conflict, [{ path: ['id'], text: 'other' }]), /字段/);
});

test('one conflicting record does not block others and conflicts survive restarting the synchronizer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-conflict-'));
  const store = new Store(root); await store.init();
  let snapshot = { revision: 1, records: { 'material:a': result('a', 'base'), 'material:b': result('b', 'base') } as Record<string, any> };
  const remote = { connected: true, profile, async accountData(write?: typeof snapshot) { if (write) snapshot = { revision: snapshot.revision + 1, records: structuredClone(write.records) }; return structuredClone(snapshot); } } as SharedFiles;
  let sync = new AccountSync(store, remote, () => {});
  try {
    await sync.activate(profile);
    store.conclusions.find(item => item.id === 'a')!.content = 'local'; store.conclusions.find(item => item.id === 'b')!.content = 'independent';
    snapshot.records['material:a'].content = 'central'; snapshot.revision++;
    await sync.sync();
    assert.equal(snapshot.records['material:b'].content, 'independent'); assert.equal(snapshot.records['material:a'].content, 'central');
    assert.equal(store.conclusions.find(item => item.id === 'a')!.content, 'local');
    const token = sync.state.conflicts![0].token;
    await sync.close(); sync = new AccountSync(store, remote, () => {}); await sync.activate(profile);
    assert.equal(sync.state.conflicts![0].token, token);
    store.conclusions.find(item => item.id === 'a')!.content = 'new local';
    await assert.rejects(sync.resolve('material:a', 'remote', token), /更新/);
    await sync.sync(); const latest = sync.state.conflicts![0];
    await sync.resolve(latest.key, 'merged', latest.token, [{ path: ['content'], text: 'resolved' }]);
    assert.equal(snapshot.records['material:a'].content, 'resolved');
    assert.equal(store.conclusions.find(item => item.id === 'a')!.content, 'resolved');
    await sync.undo(sync.conflicts.history[0].id); assert.equal(store.conclusions.find(item => item.id === 'a')!.content, 'new local');
  } finally { await sync.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('AI sees only conflicting fields, persists its suggestion and cannot propose a different field', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-ai-'));
  const base = { title: 'same', content: 'base', password: 'fixture-secret' };
  const conflict = mergeAccountRecords({ a: base }, { a: { ...base, content: 'left' } }, { a: { ...base, content: 'right' } }).conflicts[0];
  let prompt = '';
  const engine = new SyncConflicts(root, () => {}, async input => { prompt = input; return JSON.stringify({ summary: 'combine', fields: [{ path: ['content'], text: 'left and right', reason: 'both' }], unresolved: [] }); });
  try {
    await engine.init(); engine.enqueue([conflict]);
    for (let attempt = 0; attempt < 100 && engine.view(conflict).ai?.status !== 'ready'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(engine.view(conflict).ai?.status, 'ready'); assert(!prompt.includes('fixture-secret')); assert(!prompt.includes('"title"'));
    const restored = new SyncConflicts(root, () => {}); await restored.init(); assert.equal(restored.view(conflict).ai?.status, 'ready'); await restored.close();
  } finally { await engine.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('material conflicts retain both version histories and reject unsafe automatic whitespace merges', () => {
  const base = { content: 'base', version: 1, updatedAt: '2026-01-01', versions: [] };
  const local = { ...base, content: 'a b', version: 2, updatedAt: '2026-01-02', versions: [{ content: 'base' }] };
  const remote = { ...base, content: 'ab', version: 3, updatedAt: '2026-01-03', versions: [{ content: 'base' }, { content: 'middle' }] };
  const conflict = mergeAccountRecords({ 'material:a': base }, { 'material:a': local }, { 'material:a': remote }).conflicts[0];
  assert.deepEqual(conflict.fields.map(item => item.path), [['content']]);
  assert.equal(verifiableTextMerge(conflict, [{ path: ['content'], text: 'ab' }]), false);
  const merged = applyConflictText(conflict, [{ path: ['content'], text: 'reviewed' }]) as typeof remote;
  assert.equal(merged.versions.length, 2); assert.equal(merged.content, 'reviewed');
});

test('unlisted AI fields are rejected and structural decisions never invoke the model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-ai-invalid-')); let calls = 0;
  const engine = new SyncConflicts(root, () => {}, async () => { calls++; return JSON.stringify({ summary: 'bad', fields: [{ path: ['id'], text: 'changed', reason: 'bad' }], unresolved: [] }); });
  try {
    await engine.init();
    const conflict = mergeAccountRecords({ a: { content: 'base' } }, { a: { content: 'left' } }, { a: { content: 'right' } }).conflicts[0];
    engine.enqueue([conflict]);
    for (let i = 0; i < 100 && engine.view(conflict).ai?.status !== 'error'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(engine.view(conflict).ai?.error || '', /未授权/); assert.equal(calls, 1);
    const deletion = mergeAccountRecords({ b: { content: 'base' } }, { b: null }, { b: { content: 'changed' } }).conflicts[0];
    engine.enqueue([deletion]);
    for (let i = 0; i < 100 && engine.view(deletion).ai?.status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 1); assert(engine.view(deletion).ai?.unresolved?.length);
  } finally { await engine.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('offline conflict decisions and both copies persist through restart; new remote edits cause a new conflict', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-offline-choice-')), store = new Store(root); await store.init();
  let snapshot = { revision: 1, records: { 'material:a': result('a', 'base') } as Record<string, any> };
  const blobs = new Map<string, Buffer>();
  const remote = { connected: true, profile, async accountData(write?: typeof snapshot) { if (write) snapshot = { revision: snapshot.revision + 1, records: structuredClone(write.records) }; return structuredClone(snapshot); }, async accountFile(hash: string, file: string, upload: boolean) { if (upload) blobs.set(hash, await fs.readFile(file)); else await fs.writeFile(file, blobs.get(hash)!); } } as unknown as SharedFiles;
  let sync = new AccountSync(store, remote, () => {});
  try {
    await sync.activate(profile); const reference = store.conclusions[0];
    const file = path.join(root, 'local.txt'), bytes = Buffer.from('local evidence'); await fs.writeFile(file, bytes);
    reference.localFiles = [{ id: 'file-local', name: 'local.txt', localPath: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
    reference.content = 'local'; snapshot.records['material:a'].content = 'remote'; snapshot.revision++;
    await sync.sync(); assert.equal(store.conclusions[0], reference);
    (remote as any).connected = false;
    await sync.resolve('material:a', 'both', sync.state.conflicts![0].token);
    assert.equal(store.conclusions.length, 2); const copy = store.conclusions.find(item => item.content === 'local')!; assert(copy); assert.equal(await fs.readFile(copy.localFiles![0].localPath, 'utf8'), 'local evidence'); assert.equal(reference.content, 'remote');
    await sync.close(); const restored = new Store(root); await restored.init();
    sync = new AccountSync(restored, remote, () => {}); await sync.activate(profile);
    assert.equal(restored.conclusions.length, 2);
    (remote as any).connected = true; await sync.sync(); assert.equal(Object.keys(snapshot.records).length, 2);
    restored.conclusions.find(item => item.id === 'a')!.content = 'local again'; snapshot.records['material:a'].content = 'remote again'; snapshot.revision++;
    await sync.sync(); const conflict = sync.state.conflicts![0];
    (remote as any).connected = false; await sync.resolve('material:a', 'merged', conflict.token, [{ path: ['content'], text: 'reviewed offline' }]);
    snapshot.records['material:a'].content = 'changed after review'; snapshot.revision++;
    (remote as any).connected = true; await sync.sync();
    assert.equal(sync.state.status, 'conflict'); assert.equal(restored.conclusions.find(item => item.id === 'a')!.content, 'reviewed offline');
    assert.equal(snapshot.records['material:a'].content, 'changed after review');
  } finally { await sync.close(); await fs.rm(root, { recursive: true, force: true }); }
});
