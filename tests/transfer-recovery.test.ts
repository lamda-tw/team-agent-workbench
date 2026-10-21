import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SFTPWrapper } from 'ssh2';
import { Store } from '../src/core/store';
import { TransferQueue } from '../src/core/transfers';
import { storageRequest } from '../src/core/storage-requests';
import { Workbench } from '../src/core/workbench';
import type { SharedFiles } from '../src/core/shared-files';
import type { RemoteBinding, TransferPhase } from '../src/shared/types';
// @ts-expect-error Protocol fixture shared with Electron tests.
import { teamServer } from './fixtures/team-server.mjs';

const binding: RemoteBinding = { connectionId: 'server', host: 'files.internal', port: 22, username: 'alice', fingerprint: 'SHA256:fixture', project: { id: 'project_test', name: '测试项目', remoteRoot: '/projects/test', uploadPath: '/projects/test/submissions/alice', historyPath: '/projects/test/trajectories/alice' } };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('传输状态等待超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function sha(body: string) { return createHash('sha256').update(body).digest('hex'); }

test('lost upload acknowledgement survives restart and retry reads the same receipt without a duplicate publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-transfer-receipt-'));
  try {
    const file = path.join(root, 'report.md'); await fs.writeFile(file, '同一份成果');
    const receipts = new Map<string, any>(); let commits = 0, sends = 0, allowed = true, loseAck = true;
    const remote = {
      loadManifest: async () => { if (!allowed) throw new Error('当前账号已退出项目组'); return [binding.project]; },
      channel: (requested: RemoteBinding) => { assert.equal(requested.username, 'alice'); return {}; },
      ensurePersonalFolder: async () => {},
      upload: async (_binding: RemoteBinding, _local: string, target: string, progress: (bytes: number, total: number) => void, _metadata: unknown, hash: string, requestId: string, phase: (value: TransferPhase) => Promise<void>) => {
        sends++; assert.equal(hash, sha('同一份成果'));
        if (receipts.has(requestId)) { await phase('verifying'); return receipts.get(requestId); }
        await phase('streaming'); progress(15, 15); await phase('awaiting_receipt');
        const receipt = { path: target, sha256: hash, size: 15, author: 'alice', id: 'published-once' };
        receipts.set(requestId, receipt); commits++;
        if (loseAck) { loseAck = false; throw new Error('连接在回执送达前断开'); }
        await phase('verifying'); return receipt;
      },
    } as unknown as SharedFiles;
    const first = new Store(root); await first.init();
    const queue = new TransferQueue(first, remote, () => {});
    const task = await queue.enqueue(file, binding, binding.project.uploadPath, 'upload');
    await until(() => task.status === 'error' && !(queue as any).active);
    assert.equal(task.phase, 'awaiting_receipt'); assert.match(task.error!, /先查询原请求回执/);
    const requestId = task.requestId; assert.equal(commits, 1);
    const restored = new Store(root); await restored.init();
    const recovered = restored.transfers[0]; assert.equal(recovered.requestId, requestId);
    const restarted = new TransferQueue(restored, remote, () => {});
    allowed = false;
    await assert.rejects(restarted.retry(recovered.id), /已退出项目组/);
    assert.equal(recovered.status, 'error'); assert.equal(sends, 1);
    allowed = true;
    await restarted.retry(recovered.id); await until(() => recovered.status === 'done' && !(restarted as any).active);
    assert.equal(recovered.requestId, requestId); assert.equal(commits, 1); assert.equal(sends, 2);
    assert.equal(recovered.phase, 'completed'); assert.equal(restored.transfers.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('SFTP upload reuses its request receipt after acknowledgement is lost', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-transfer-sftp-receipt-'));
  const server = await teamServer(), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); await wb.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    const project = await syncedProject(wb, '回执恢复'), binding = wb.remote.binding(project.id);
    const file = path.join(root, 'source.txt'); await fs.writeFile(file, 'payload');
    const target = binding.project.uploadPath + '/result.txt', requestId = randomUUID();
    const payload = { op: 'publish', projectId: project.id, target, sha256: sha('payload'), metadata: { kind: 'file', title: '结果' } };
    const channel = wb.remote.channel(binding) as SFTPWrapper; let checks = 0;
    await assert.rejects(storageRequest(channel, 'alice', payload, () => { if (++checks === 3) throw new Error('客户端未收到回执'); }, file, () => {}, requestId), /客户端未收到回执/);
    const index = project.remoteRoot + '/.workbench-content.json';
    assert.equal(JSON.parse(server.nodes.get(index).data.toString()).length, 1);
    const receipt = await storageRequest(channel, 'alice', payload, () => {}, file, () => {}, requestId);
    assert.equal(receipt.path, target); assert.equal(receipt.sha256, sha('payload'));
    assert.equal(JSON.parse(server.nodes.get(index).data.toString()).length, 1);
    const pendingId = randomUUID(), requestPath = '/.workbench/inbox/alice/' + pendingId + '.request.json';
    const pendingReceipt = '/.workbench/outbox/alice/' + pendingId + '.json';
    server.nodes.set(requestPath, { mode: 0o100600, uid: 1001, gid: 100, data: Buffer.from(JSON.stringify({ ...payload, staging: pendingId + '.upload' })) });
    await assert.rejects(storageRequest(channel, 'alice', { ...payload, target: target + '-other' }, () => {}, file, () => {}, pendingId), /请求与当前记录不一致/);
    setTimeout(() => server.nodes.set(pendingReceipt, { mode: 0o100640, uid: 0, gid: 100, data: Buffer.from(JSON.stringify({ ok: true, value: receipt })) }), 30);
    let resentBytes = 0;
    assert.equal((await storageRequest(channel, 'alice', payload, () => {}, file, count => { resentBytes += count; }, pendingId)).path, target);
    assert.equal(resentBytes, 0, 'a pending server request is polled without overwriting its staging file');
  } finally { await wb.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('partial upload restarts from the immutable snapshot; changed local bytes block retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-transfer-partial-'));
  try {
    const file = path.join(root, 'result.txt'); await fs.writeFile(file, 'original');
    let sends = 0, fail = true; const requestIds: string[] = [];
    const remote = {
      loadManifest: async () => [binding.project], channel: () => ({}), ensurePersonalFolder: async () => {},
      upload: async (_binding: RemoteBinding, _local: string, target: string, _progress: unknown, _metadata: unknown, hash: string, requestId: string, phase: (value: TransferPhase) => Promise<void>) => {
        sends++; requestIds.push(requestId); await phase('streaming');
        if (fail) { fail = false; throw new Error('上传中途断线'); }
        await phase('verifying'); return { path: target, sha256: hash, size: 8, author: 'alice' };
      },
    } as unknown as SharedFiles;
    const store = new Store(root); await store.init(); const queue = new TransferQueue(store, remote, () => {});
    const task = await queue.enqueue(file, binding, binding.project.uploadPath, 'upload');
    await until(() => task.status === 'error' && !(queue as any).active);
    assert.equal(task.phase, 'streaming'); assert.match(task.error!, /从头传输/);
    await fs.writeFile(file, 'tampered');
    await assert.rejects(queue.retry(task.id), /快照已改变/); assert.equal(sends, 1);
    await fs.writeFile(file, 'original');
    await queue.retry(task.id); await until(() => task.status === 'done' && !(queue as any).active);
    assert.deepEqual(requestIds, [task.id, task.id]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a definitive server rejection uses a fresh request after permission is restored', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-transfer-rejected-'));
  try {
    const file = path.join(root, 'result.txt'); await fs.writeFile(file, 'payload');
    const requestIds: string[] = []; let reject = true;
    const remote = {
      loadManifest: async () => [binding.project], channel: () => ({}), ensurePersonalFolder: async () => {},
      upload: async (_binding: RemoteBinding, _local: string, target: string, _progress: unknown, _metadata: unknown, hash: string, requestId: string, phase: (value: TransferPhase) => Promise<void>) => {
        requestIds.push(requestId);
        if (reject) { await phase('rejected'); throw new Error('项目权限被撤销'); }
        await phase('verifying'); return { path: target, sha256: hash, size: 7, author: 'alice' };
      },
    } as unknown as SharedFiles;
    const store = new Store(root); await store.init(); const queue = new TransferQueue(store, remote, () => {});
    const task = await queue.enqueue(file, binding, binding.project.uploadPath, 'upload');
    await until(() => task.status === 'error' && !(queue as any).active);
    assert.equal(task.phase, 'rejected'); reject = false;
    await queue.retry(task.id); await until(() => task.status === 'done' && !(queue as any).active);
    assert.notEqual(requestIds[0], requestIds[1]); assert.equal(task.requestId, requestIds[1]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('download retries only the same remote version and never marks an incomplete local copy done', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-transfer-download-'));
  try {
    const destination = path.join(root, 'download.txt'); let remoteBody = 'version-one', fail = true, downloads = 0;
    const remote = {
      loadManifest: async () => [binding.project], channel: () => ({}),
      downloadInfo: async () => ({ sha256: sha(remoteBody), size: Buffer.byteLength(remoteBody) }),
      download: async (_binding: RemoteBinding, _target: string, local: string, progress: (bytes: number, total: number) => void, expected: { sha256: string; size: number }) => {
        downloads++;
        if (fail) { fail = false; progress(3, expected.size); throw new Error('下载中途断线'); }
        await fs.writeFile(local, remoteBody); progress(expected.size, expected.size);
      },
    } as unknown as SharedFiles;
    const store = new Store(root); await store.init(); const queue = new TransferQueue(store, remote, () => {});
    const task = await queue.enqueueDownload(binding, '/projects/test/submissions/alice/result.txt', destination);
    await until(() => task.status === 'error' && !(queue as any).active);
    assert.equal(task.kind, 'download'); assert.equal(task.phase, 'streaming');
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    remoteBody = 'version-two';
    await assert.rejects(queue.retry(task.id), /远端文件内容已改变/); assert.equal(downloads, 1);
    remoteBody = 'version-one';
    await queue.retry(task.id); await until(() => task.status === 'done' && !(queue as any).active);
    assert.equal(await fs.readFile(destination, 'utf8'), 'version-one'); assert.equal(store.transfers.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('upload-cache cleanup never deletes a downloaded file placed under the application data root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-transfer-cache-'));
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init();
    const local = path.join(root, 'uploads', 'download.txt'); await fs.mkdir(path.dirname(local), { recursive: true }); await fs.writeFile(local, 'keep me');
    wb.store.transfers.push({ id: randomUUID(), kind: 'download', status: 'done', name: 'download.txt', bytes: 7, total: 7, target: '/projects/test/file.txt', projectName: '测试项目', createdAt: new Date().toISOString(), localPath: local, binding });
    assert.deepEqual(await wb.cleanUploadCache(), { count: 0, bytes: 0 });
    assert.equal(await fs.readFile(local, 'utf8'), 'keep me');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
