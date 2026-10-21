import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';
import { AdminConnection } from '../src/admin/connection';
import { adminOperationSchema, adminProfileSchema, adminConnectSchema } from '../src/admin/types';
import { systemUsername } from '../src/core/account-login';
import { inflateSync } from 'node:zlib';
const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;

test('admin schemas reject privilege and content operations; secrets are not profile fields', () => {
  assert.equal(adminOperationSchema.safeParse({ op: 'write', path: '/etc/passwd' }).success, false);
  assert.equal(adminOperationSchema.safeParse({ op: 'user_create', username: '-R /', password: 'abcdefgh', name: 'bad' }).success, false);
  const profile = adminProfileSchema.parse({ host: 'host', port: 22, username: 'admin', password: 'secret', sudoPassword: 'secret', root: '/srv/teamspace' });
  assert.equal('password' in profile, false); assert.equal('sudoPassword' in profile, false);
});

test('only the local admin connection accepts omitted account and password', () => {
  const profile = { mode: 'local' as const, localRoot: 'D:/share', host: 'local', port: 22 };
  const local = adminConnectSchema.parse({ profile }); assert.equal(local.password, ''); assert.equal(local.profile.username, '');
  for (const mode of [undefined, 'sftp']) {
    assert.equal(adminConnectSchema.safeParse({ profile: { ...profile, mode } }).success, false);
    assert.equal(adminConnectSchema.safeParse({ profile: { ...profile, mode, username: 'root' } }).success, false);
    assert.equal(adminConnectSchema.safeParse({ profile: { ...profile, mode, username: 'root' }, password: '1' }).success, true);
  }
});

test('environment preparation accepts only fixed sources and requires an absolute offline server directory', () => {
  assert.equal(adminOperationSchema.safeParse({ op: 'environment_prepare', source: 'shell' }).success, false);
  assert.equal(adminOperationSchema.safeParse({ op: 'environment_prepare', source: 'offline', packageDirectory: 'C:/packages' }).success, false);
  assert.equal(adminOperationSchema.safeParse({ op: 'environment_prepare', source: 'offline', packageDirectory: '/opt/packages' }).success, true);
});

test('environment preparation works before initialization and preserves administrator state', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  f.state.initialized = false;
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'root', root: '/srv/teamspace', fingerprint: '' }, 'login-secret', '', async () => true);
    const before = structuredClone(remote.snapshot.state);
    await remote.operation({ op: 'environment_prepare', source: 'offline', packageDirectory: '/opt/packages' });
    assert.equal(remote.snapshot.aclBackend, 'libacl'); assert.deepEqual(remote.snapshot.state, before);
    assert.equal(remote.snapshot.busy, false);
    assert.equal(f.requests.filter(request => request.op === 'environment_prepare').length, 1);
    assert(!f.requests.some(request => ['initialize', 'user_create', 'group_create'].includes(request.op)));
  } finally { remote.disconnect(); await f.close(); }
});

async function fixture(role: 'root' | 'sudo' | 'project', writableManifest = false, alias = 'worker', login?: string) {
  const requests: any[] = [], commands: string[] = [], clients: any[] = [], programs: string[] = [];
  const state: any = { initialized: true, users: {}, groups: {}, sftpConfigured: true, storageVersion: 1 };
  const control = { failNext: false, holdStorage: false, startupError: '', authenticationAttempts: 0, missingCommands: [] as string[], setupIssues: [] as string[] };
  const server = new Server({ hostKeys: [key] }, client => {
    clients.push(client); client.on('error', () => {});
    client.on('authentication', context => { if (context.method === 'password') control.authenticationAttempts++; context.method === 'password' && context.password === 'login-secret' && (!login || context.username === login) ? context.accept() : context.reject(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', (accept, reject) => {
        if (role !== 'project') { reject(); return; }
        const sftp = accept(), content = Buffer.from(JSON.stringify({ version: 1, root: '/srv/teamspace', users: { [alias]: { contentGroups: [{ id: 'wb_test_ocr', name: 'OCR' }] } } }));
        sftp.on('LSTAT', (id, target) => sftp.attrs(id, { mode: target.endsWith('.json') ? (writableManifest ? 0o100666 : 0o100644) : 0o40755, uid: 0, gid: 0, size: content.length, atime: 0, mtime: 0 }));
        sftp.on('OPEN', id => sftp.handle(id, Buffer.from('roles')));
        sftp.on('FSTAT', id => sftp.attrs(id, { mode: 0o100644, uid: 0, gid: 0, size: content.length, atime: 0, mtime: 0 }));
        sftp.on('READ', (id, _handle, offset, length) => offset >= content.length ? sftp.status(id, utils.sftp.STATUS_CODE.EOF) : sftp.data(id, content.subarray(offset, offset + length)));
        sftp.on('CLOSE', id => sftp.status(id, utils.sftp.STATUS_CODE.OK));
      });
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command); const channel = accept();
        if (info.command === 'id -u') { channel.write(role === 'root' ? '0\n' : '1001\n'); channel.exit(0); channel.end(); return; }
        if (role === 'project') { channel.stderr.write('not in sudoers'); channel.exit(1); channel.end(); return; }
        assert.match(info.command, /WORKBENCH_CODE_READY/); assert(info.command.length < 500);
        let buffer = '', authorized = role === 'root', programReceived = false;
        channel.on('data', (data: Buffer) => {
          buffer += data.toString(); let n: number;
          while ((n = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
            if (!authorized) { assert.equal(line, 'sudo-secret'); authorized = true; channel.write('WORKBENCH_CODE_READY\n'); continue; }
            if (!programReceived) {
              const program = inflateSync(Buffer.from(line, 'base64')).toString();
              programs.push(program);
              assert.match(program, /def main\(request\)/); programReceived = true;
              if (control.startupError) { channel.stderr.write(control.startupError); channel.exit(1); channel.end(); return; }
              channel.write('WORKBENCH_READY\n'); continue;
            }
            const input = JSON.parse(line); requests.push(input);
            if (input.expectedTeamId && input.op !== 'probe' && input.expectedTeamId !== state.teamId) {
              channel.write(JSON.stringify({ ok: false, error: '[MEMBER_TEAM] 团队身份已变化' }) + '\n'); channel.exit(1); channel.end(); continue;
            }
            if (input.op === 'members_sync') {
              const { users, groups, ...metadata } = state;
              const full = input.since === undefined;
              channel.write(JSON.stringify({ ok: true, value: { protocol: 1, teamId: state.teamId, sequence: 1, full, users: full ? users : {}, groups: full ? groups : {}, deletedUsers: [], deletedGroups: [], ...(full ? { metadata } : {}) } }) + '\n'); channel.exit(0); channel.end(); continue;
            }
            if (input.op === 'storage_usage' && control.holdStorage) continue;
            if (control.failNext && !['probe', 'status'].includes(input.op)) {
              control.failNext = false;
              state.operations = { 'group_create:ocr': { id: 'group_create:ocr', op: 'group_create', request: { op: 'group_create', label: 'ocr' }, status: 'failed', completed: ['成员用户组已创建'], error: 'injected failure' } };
              channel.write(JSON.stringify({ ok: false, error: 'injected failure' }) + '\n'); channel.exit(1); channel.end(); continue;
            }
            const result = input.op === 'environment_prepare' ? { environment: { missingCommands: [], setupIssues: [], aclBackend: 'libacl', serviceManager: 'systemd' } } : input.op === 'probe' ? { administrator: true, actor: role, missingCommands: control.missingCommands, setupIssues: control.setupIssues, serviceManager: 'systemd' } : input.op === 'status' ? state : input.op === 'storage_usage' ? { scannedAt: '2026-09-20T00:00:00.000Z', path: input.path, name: '共享空间', total: { bytes: 10, files: 1, directories: 1, directBytes: 0 }, volume: { totalBytes: 100, freeBytes: 60 }, categories: [], groups: [], users: [], children: [], childCount: 0, offset: input.offset, limit: input.limit, warningCount: 0, warnings: [] } : { state };
            channel.write(JSON.stringify({ ok: true, value: result }) + '\n'); channel.exit(0); channel.end();
          }
        });
        if (authorized) channel.write('WORKBENCH_CODE_READY\n'); else { channel.stderr.write('WORKBENCH_'); setTimeout(() => channel.stderr.write('SUDO'), 5); }
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { requests, commands, programs, control, state, port: address.port, close: async () => { clients.forEach(c => c.end()); await new Promise<void>(r => server.close(() => r())); } };
}

test('server update uploads current worker files after a rebuild without reconnecting', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-admin-code-'));
  const f = await fixture('root'), remote = new AdminConnection(path.join(directory, 'admin.py'), () => {});
  const workerFrom = (program: string) => {
    const payload = program.match(/CONTENT_WORKER_ZLIB_BASE64 = '([^']+)'/)?.[1];
    assert(payload);
    return inflateSync(Buffer.from(payload, 'base64')).toString();
  };
  try {
    for (const name of ['admin.py', 'acl_support.py', 'group_ops.py', 'content.py']) await fs.copyFile(path.join('server', name), path.join(directory, name));
    await fs.appendFile(path.join(directory, 'content.py'), '\n# old-worker-before-rebuild\n');
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'root', root: '/srv/teamspace', fingerprint: '' }, 'login-secret', '', async () => true);
    assert.match(workerFrom(f.programs.at(-1)!), /old-worker-before-rebuild/);
    await fs.writeFile(path.join(directory, 'content.py'), (await fs.readFile('server/content.py', 'utf8')) + '\n# current-worker-after-rebuild\n');
    await remote.operation({ op: 'storage_upgrade' });
    const uploaded = workerFrom(f.programs.at(-1)!);
    assert.match(uploaded, /current-worker-after-rebuild/);
    assert.doesNotMatch(uploaded, /old-worker-before-rebuild/);
    assert.equal(f.requests.at(-1).op, 'storage_upgrade');
    assert.equal(f.control.authenticationAttempts, 1);
  } finally {
    remote.disconnect(); await f.close();
    assert.equal(await fs.realpath(path.dirname(directory)), await fs.realpath(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('member polling pins the team, requests a delta and omits installation payload', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  f.state.teamId = 'team-a';
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'root', root: '/srv/teamspace', fingerprint: '' }, 'login-secret', '', async () => true);
    assert.equal(remote.snapshot.profile!.teamId, 'team-a');
    const before = structuredClone(remote.snapshot.state);
    const first = await remote.memberSync('team-a'); assert.equal(first.full, true);
    const next = await remote.memberSync('team-a', first.sequence); assert.equal(next.full, false); assert.deepEqual(next.users, {});
    assert.equal(f.requests.at(-1).expectedTeamId, 'team-a'); assert.equal(f.requests.at(-1).since, 1);
    assert.match(f.programs.at(-1)!, /CONTENT_WORKER_ZLIB_BASE64 = ''/);
    assert.deepEqual(remote.snapshot.state, before); assert.equal(remote.snapshot.busy, false);
    f.state.teamId = 'team-b';
    await assert.rejects(remote.memberSync('team-a', 1), /MEMBER_TEAM/);
    await assert.rejects(remote.operation({ op: 'user_enabled', username: 'alice', enabled: false }), /MEMBER_TEAM/);
  } finally { remote.disconnect(); await f.close(); }
});
test('admin rejects a changed server identity before sending login credentials', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await assert.rejects(remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: 'SHA256:wrong-server', root: '/srv/teamspace' }, 'login-secret', '', async () => { throw new Error('不应询问'); }), /服务器身份发生变化.*登录密码尚未发送/);
    assert.equal(f.control.authenticationAttempts, 0);
  } finally { remote.disconnect(); await f.close(); }
});

test('admin connection shows missing prerequisites and refresh clears them without reconnecting', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  f.control.missingCommands = ['setfacl']; f.control.setupIssues = ['请安装 acl'];
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', root: '/srv/teamspace', fingerprint: '' }, 'login-secret', '', async () => true);
    assert.equal(remote.snapshot.connected, true);
    assert.deepEqual(remote.snapshot.missingCommands, ['setfacl']); assert.deepEqual(remote.snapshot.setupIssues, ['请安装 acl']);
    f.control.missingCommands = []; f.control.setupIssues = [];
    await remote.operation({ op: 'status' });
    assert.deepEqual(remote.snapshot.setupIssues, []); assert.deepEqual(remote.snapshot.missingCommands, []);
    assert.equal(f.control.authenticationAttempts, 1);
    assert.deepEqual(f.requests.slice(-2).map(item => item.op), ['probe', 'status']);
  } finally { remote.disconnect(); await f.close(); }
});
for (const role of ['root', 'sudo'] as const) test(role + ': SSH verifies privilege and sends passwords only over stdin', async () => {
  const f = await fixture(role), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', 'sudo-secret', async () => true);
    assert.equal(remote.snapshot.role, 'administrator');
    await remote.operation({ op: 'user_create', username: 'alice', name: '测试成员', password: 'new-secret' });
    assert.equal(f.requests.at(-1).password, 'new-secret');
    assert(!JSON.stringify(remote.snapshot).includes('secret')); assert(!f.commands.some(c => c.includes('secret')));
  } finally { remote.disconnect(); await f.close(); }
});

test('Python startup failures preserve diagnostics without misreporting missing Python or sudo access', async () => {
  for (const role of ['root', 'sudo'] as const) {
    const f = await fixture(role), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
    f.control.startupError = 'Traceback: io.UnsupportedOperation: stream encoding after the first read';
    try {
      await assert.rejects(remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', 'sudo-secret', async () => true), (error: Error) => {
        assert.match(error.message, /Python 已启动/); assert.match(error.message, /io.UnsupportedOperation/);
        assert.doesNotMatch(error.message, /请确认 Linux 已安装|sudo 权限/); return true;
      });
      assert.equal(f.requests.length, 0, 'no business request is sent before the script is ready');
      assert.equal(remote.snapshot.connected, false);
      assert(!f.commands.some(command => command.includes('secret')));
    } finally { remote.disconnect(); await f.close(); }
  }
});
test('remote storage usage is a scoped read-only administrator operation', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
    const report = await remote.storageUsage({ path: 'projects/OCR', offset: 20, limit: 50 });
    assert.equal(report.total.bytes, 10);
    assert.deepEqual(f.requests.at(-1), { op: 'storage_usage', path: 'projects/OCR', offset: 20, limit: 50, root: '/srv/teamspace' });
    assert.equal(remote.snapshot.busy, false);
    f.control.holdStorage = true;
    const controller = new AbortController(), pending = remote.storageUsage({ path: '', offset: 0, limit: 100 }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /取消空间统计/);
  } finally { remote.disconnect(); await f.close(); }
});
test('group content managers cannot log into the system administration app', async () => {
  const f = await fixture('project'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await assert.rejects(remote.connect({ host: '127.0.0.1', port: f.port, username: 'worker', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true));
    assert.equal(remote.snapshot.verified, false); assert.equal(remote.snapshot.role, undefined);
    await assert.rejects(remote.operation({ op: 'user_create', username: 'bad', name: 'bad', password: 'new-secret' }), /只有总管理员/);
    await assert.rejects(remote.storageUsage({ path: '', offset: 0, limit: 100 }), /只有总管理员/);
    assert(f.commands.includes('id -u'));
  } finally { remote.disconnect(); await f.close(); }
});
test('writable role manifest cannot grant a project admin entry', async () => {
  const f = await fixture('project', true), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await assert.rejects(remote.connect({ host: '127.0.0.1', port: f.port, username: 'worker', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true));
    assert.equal(remote.snapshot.verified, false);
  } finally { remote.disconnect(); await f.close(); }
});

test('#7 remote operation failure automatically refreshes partial state for recovery', async () => {
  const f = await fixture('root'), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
  try {
    await remote.connect({ host: '127.0.0.1', port: f.port, username: 'admin', fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
    f.control.failNext = true;
    await assert.rejects(remote.operation({ op: 'group_create', label: 'ocr' }), /injected failure/);
    assert.equal(remote.snapshot.busy, false); assert.equal(f.requests.at(-1).op, 'status');
    assert.deepEqual(remote.snapshot.state!.operations!['group_create:ocr'].completed, ['成员用户组已创建']);
  } finally { remote.disconnect(); await f.close(); }
});


test('admin app preserves literal root accounts and rejects mapped project members', async () => {
  for (const [role, alias, login] of [['root', 'OpsAdmin', 'OpsAdmin'], ['project', '张三', systemUsername('张三')]] as const) {
    const f = await fixture(role, false, alias, login), remote = new AdminConnection(path.resolve('server/admin.py'), () => {});
    try {
      const connect = remote.connect({ host: '127.0.0.1', port: f.port, username: alias, fingerprint: '', root: '/srv/teamspace' }, 'login-secret', '', async () => true);
      if (role === 'root') { await connect; assert.equal(remote.snapshot.role, 'administrator'); assert.equal(remote.snapshot.profile!.username, alias); }
      else { await assert.rejects(connect); assert.equal(remote.snapshot.verified, false); }
    } finally { remote.disconnect(); await f.close(); }
  }
});
