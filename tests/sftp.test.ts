import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';
import { friendlySftp, SftpConnection } from '../src/core/sftp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
test('nologin SFTP reply identifies incomplete member access configuration', () => {
  assert.match(friendlySftp(new Error('Packet length 1416128883 exceeds max length of 262144')).message, /成员登录配置异常.*重新创建该成员账号/);
});
test('disconnected SFTP errors point to the visible account login action', () => {
  assert.throws(() => new SftpConnection().channel(), /中央节点连接已断开，请重新连接后再试/);
});
test('legacy SFTP stays read-only, preserves UTF-8, propagates denial and blocks escaping symlinks', async () => {
  const CODE = utils.sftp.STATUS_CODE, files = new Map([['/project/readme.md', Buffer.from('项目说明：中文')]]), clients: any[] = [], renames: string[][] = [];
  let authenticationAttempts = 0;
  const server = new Server({ hostKeys: [key] }, client => {
    clients.push(client); client.on('error', () => {}); client.on('authentication', c => { if (c.method === 'password') authenticationAttempts++; c.method === 'password' && c.password === 'secret' ? c.accept() : c.reject(); });
    client.on('ready', () => client.on('session', accept => accept().on('sftp', accept => {
      const s = accept(), handles = new Map<string, string>(); let seq = 0;
      const stat = (target: string) => ({ mode: files.has(target) ? 0o100644 : 0o40755, uid: 1001, gid: 1001, size: files.get(target)?.length || 0, atime: 0, mtime: 0 });
      s.on('REALPATH', (id, target) => s.name(id, [{ filename: target === '/project/escape' ? '/outside' : target, longname: '', attrs: stat(target) }]));
      s.on('LSTAT', (id, target) => s.attrs(id, stat(target)));
      s.on('STAT', (id, target) => s.attrs(id, stat(target)));
      s.on('OPENDIR', (id, target) => target === '/project/denied' ? s.status(id, CODE.PERMISSION_DENIED) : s.handle(id, Buffer.from('directory')));
      s.on('FSTAT', (id, handle) => s.attrs(id, stat(handles.get(handle.toString())!)));
      s.on('OPEN', (id, target, flags) => {
        if (target.includes('/denied/')) { s.status(id, CODE.PERMISSION_DENIED); return; }
        if (flags & utils.sftp.OPEN_MODE.WRITE) files.set(target, Buffer.alloc(0));
        if (!files.has(target)) { s.status(id, CODE.NO_SUCH_FILE); return; }
        const handle = String(++seq); handles.set(handle, target); s.handle(id, Buffer.from(handle));
      });
      s.on('READ', (id, handle, offset, length) => { const data = files.get(handles.get(handle.toString())!)!; offset >= data.length ? s.status(id, CODE.EOF) : s.data(id, data.subarray(offset, offset + length)); });
      s.on('WRITE', (id, handle, offset, data) => { const target = handles.get(handle.toString())!, before = files.get(target)!; const next = Buffer.alloc(Math.max(before.length, offset + data.length)); before.copy(next); data.copy(next, offset); files.set(target, next); s.status(id, CODE.OK); });
      s.on('CLOSE', id => s.status(id, CODE.OK));
      s.on('RENAME', (id, from, to) => { renames.push([from, to]); files.set(to, files.get(from)!); files.delete(from); s.status(id, CODE.OK); });
      s.on('REMOVE', (id, target) => { files.delete(target); s.status(id, CODE.OK); });
    })));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port, remote = new SftpConnection(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-sftp-'));
  try {
    const profile = { id: 'test', name: 'fixture', host: '127.0.0.1', port, username: 'alice', fingerprint: '', manifestPath: '', projects: [{ id: 'p', name: 'p', remoteRoot: '/project', uploadPath: '/project', historyPath: '/project' }] };
    let observed = '';
    await assert.rejects(remote.connect(profile, 'secret', async fingerprint => { observed = fingerprint; return false; }), /已取消首次连接.*登录密码尚未发送/);
    assert.match(observed, /^SHA256:/); assert.equal(authenticationAttempts, 0);
    await assert.rejects(remote.connect({ ...profile, fingerprint: 'SHA256:wrong-server' }, 'secret', async () => { throw new Error('不应询问'); }), /服务器身份发生变化.*重新确认/);
    assert.equal(authenticationAttempts, 0);
    await remote.connect(profile, 'secret', async fingerprint => fingerprint === observed);
    assert.equal(remote.profile!.fingerprint, observed); assert.equal(authenticationAttempts, 1);
    assert.deepEqual(remote.profile!.projects, []); // Client-supplied entries cannot grant access.
    // This transport-only fixture has no team metadata; discovery is covered by workspace/workgroup tests.
    remote.profile!.projects = profile.projects;
    const binding = remote.binding('p');
    assert.deepEqual(await remote.verifyDirectory('/project'), { path: '/project', canonicalPath: '/project' });
    await assert.rejects(remote.verifyDirectory('/project/denied'), /Linux 拒绝访问/);
    await assert.rejects(remote.verifyDirectory('/project/readme.md'), /必须是.*目录/);
    const preview = await remote.preview(binding, '/project/readme.md'); assert.equal(preview.content, '项目说明：中文');
    const local = path.join(dir, 'readme.md'); await remote.download(binding, '/project/readme.md', local); assert.equal(await fs.readFile(local, 'utf8'), preview.content);
    await assert.rejects(remote.upload(binding, local, '/project/new.md', () => {}), /尚未启用受控文件操作/); assert.equal(renames.length, 0);
    await assert.rejects(remote.upload(binding, local, '/project/denied/file.md', () => {}), /尚未启用受控文件操作/);
    await assert.rejects(remote.download(binding, '/project/escape', local), /符号链接/);
    assert.throws(() => remote.channel({ ...binding, username: 'bob' }), /身份不一致/);
  } finally { remote.disconnect(); clients.forEach(c => c.end()); await new Promise<void>(r => server.close(() => r())); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
