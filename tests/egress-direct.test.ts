import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { EgressClientProxy } from '../src/core/egress';
import { decodeEgressInvite, encodeEgressInvite } from '../src/core/egress-config';
import { testTlsIdentity } from './fixtures/tls-identity';

const accessCode = 'fixture-direct-access-code-only';
const clientConfig = (port: number, fingerprint = '00'.repeat(32)) => ({ enabled: true, viaSharedServer: false, host: '127.0.0.1', port, certificateFingerprint: fingerprint, accessCode, username: 'fixture' });
const listen = async (server: net.Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as net.AddressInfo).port; };
const close = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));

test('a refused direct connection retains its actionable reason without leaking connection credentials', async () => {
  const server = net.createServer(), port = await listen(server); await close(server);
  const proxy = new EgressClientProxy(clientConfig(port));
  try {
    await assert.rejects(proxy.probe(), /拒绝连接/);
    assert.equal(proxy.status().available, false);
    assert.match(proxy.status().detail, /拒绝连接/);
    assert(!JSON.stringify(proxy.status()).includes(accessCode));
  } finally { await proxy.stop(); }
});

test('direct invitation validates the certificate before sending credentials and reports rejected or malformed handshakes', { timeout: 5000 }, async () => {
  const identity = testTlsIdentity(), sockets = new Set<net.Socket>(), received: string[] = [];
  let response = '{"ok":true}\n';
  const server = tls.createServer(identity, socket => {
    socket.on('error', () => {});
    let input = '';
    socket.on('data', chunk => { input += chunk.toString(); if (input.includes('\n')) { received.push(input); socket.end(response); } });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  const port = await listen(server);
  const invite = decodeEgressInvite(encodeEgressInvite({ version: 1, host: '127.0.0.1', port, fingerprint: identity.fingerprint, accessCode }));
  const config = { ...clientConfig(invite.port, invite.fingerprint), host: invite.host, accessCode: invite.accessCode };
  const proxy = new EgressClientProxy(config, async () => { throw new Error('direct connection must not use SSH'); });
  try {
    await proxy.start(); await proxy.probe(); assert.equal(proxy.status().available, true);
    const count = received.length;
    await proxy.configure({ ...config, certificateFingerprint: '00'.repeat(32) });
    await assert.rejects(proxy.probe(), /身份不匹配/);
    assert.equal(received.length, count);
    await proxy.configure(config);
    response = '{"ok":false,"error":"出口接入码无效"}\n';
    await assert.rejects(proxy.probe(), /接入码无效/);
    assert.match(proxy.status().detail, /接入码无效/);
    for (const invalid of ['not-json\n', 'null\n', '{"ok":"true"}\n', '{}\n']) {
      response = invalid;
      await assert.rejects(proxy.probe(), /握手响应无效/);
      assert.match(proxy.status().detail, /握手响应无效/);
    }
    response = '{"ok":true}\n'; await proxy.probe(); assert.equal(proxy.status().available, true);
  } finally { await proxy.stop(); for (const socket of sockets) socket.destroy(); await close(server); }
});

test('a direct peer closing before TLS completes rejects the probe without an uncaught socket error', { timeout: 3000 }, async () => {
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  const proxy = new EgressClientProxy(clientConfig(await listen(server)));
  try { await assert.rejects(proxy.probe(), /连接/); assert.equal(proxy.status().available, false); }
  finally { await proxy.stop(); await close(server); }
});

for (const stage of ['certificate', 'write'] as const) {
  test(`TLS ${stage} failure is returned to the probe instead of escaping the secureConnect callback`, async t => {
    const reset = () => Object.assign(new Error('fixture private transport diagnostic'), { code: 'ECONNRESET' });
    const socket = Object.assign(new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }), {
      getPeerCertificate() { if (stage === 'certificate') throw reset(); return { fingerprint256: '00'.repeat(32) }; },
    });
    if (stage === 'write') t.mock.method(socket, 'write', () => { throw reset(); });
    t.mock.method(tls, 'connect', () => socket as unknown as tls.TLSSocket);
    const proxy = new EgressClientProxy(clientConfig(1));
    const pending = proxy.probe();
    // The event emitter discards returned promises. A rejection here would be unhandled in production.
    const rejected = assert.rejects(pending, /连接已重置|连接已取消/);
    try {
      await socket.listeners('secureConnect')[0].call(socket);
      await rejected;
      assert.match(proxy.status().detail, /连接已重置/);
      assert(!JSON.stringify(proxy.status()).includes('private transport diagnostic'));
    } finally { await proxy.stop(); await rejected; }
  });
}

test('a direct TLS timeout rejects promptly and a late handshake cannot send credentials', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const socket = Object.assign(new Duplex({ read() {}, write(_chunk, _encoding, done) { writes++; done(); } }), {
    getPeerCertificate: () => ({ fingerprint256: '00'.repeat(32) }),
  });
  t.mock.method(tls, 'connect', () => socket as unknown as tls.TLSSocket);
  const proxy = new EgressClientProxy(clientConfig(1));
  try {
    const rejected = assert.rejects(proxy.probe(), /连接管理端超时/);
    t.mock.timers.tick(15000); await rejected;
    assert.equal(proxy.status().available, false); assert.match(proxy.status().detail, /超时/);
    await socket.listeners('secureConnect')[0].call(socket);
    assert.equal(writes, 0); assert.equal(socket.destroyed, true);
  } finally { await proxy.stop(); }
});
