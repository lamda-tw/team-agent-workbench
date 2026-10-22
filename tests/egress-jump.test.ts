import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { once, EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { EgressClientProxy } from '../src/core/egress';
import { forwardEgress } from '../src/core/ssh-egress';
import { SharedFiles } from '../src/core/shared-files';
import { userEgressSettingsSchema } from '../src/core/egress-config';
import { adminOperationSchema } from '../src/admin/types';
import { testTlsIdentity } from './fixtures/tls-identity';
// @ts-expect-error Background-only SSH protocol fixture.
import { teamServer } from './fixtures/team-server.mjs';

test('model traffic and health checks use SSH forwarding with end-to-end TLS identity and access-code checks', { timeout: 15000 }, async () => {
  const identity = testTlsIdentity(), sockets = new Set<net.Socket>(), received: any[] = [], forwards: any[] = [];
  const gateway = tls.createServer(identity, socket => {
    let buffer = '', ready = false;
    socket.on('data', chunk => {
      if (ready) { socket.write(chunk); return; }
      buffer += chunk.toString(); if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]); received.push(request);
      if (request.accessCode !== 'fixture-access') { socket.end('{"ok":false,"error":"出口接入码无效"}\n'); return; }
      if (request.kind === 'ping' || request.kind === 'status') socket.end('{"ok":true}\n');
      else { ready = true; socket.write('{"ok":true}\n'); }
    });
  });
  gateway.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayPort = (gateway.address() as net.AddressInfo).port, server = await teamServer();
  server.state.forward = (accept: any, reject: any, info: any) => {
    forwards.push(info); if (info.destIP !== 'admin.invalid' || info.destPort !== 18443) return reject();
    const upstream = net.connect(gatewayPort, '127.0.0.1'); sockets.add(upstream); upstream.on('error', () => upstream.destroy());
    upstream.once('connect', () => { const channel = accept(); channel.on('error', () => {}); upstream.pipe(channel).pipe(upstream); channel.once('close', () => upstream.destroy()); });
    upstream.once('close', () => sockets.delete(upstream));
  };
  const donor = new SharedFiles(() => {}), shared = new SharedFiles(() => {});
  const config = { enabled: true, viaSharedServer: true, host: 'admin.invalid', port: 18443, certificateFingerprint: identity.fingerprint, accessCode: 'fixture-access', username: 'alice' };
  const proxy = new EgressClientProxy(config, (host, port, signal) => shared.openEgressTunnel(host, port, signal));
  let client: net.Socket | undefined;
  try {
    await assert.rejects(proxy.probe(), /请先连接中央节点/); assert.match(proxy.status().detail, /请先连接中央节点/);
    await donor.connect(server.profile('alice'), 'test-password', async () => true); shared.adoptConnection(donor); donor.disconnect();
    await proxy.start(); await proxy.probe(); assert.equal(proxy.status().available, true); assert.match(proxy.status().detail, /中转/);
    const localPort = Number(new URL(proxy.environment().HTTPS_PROXY!).port);
    client = net.connect(localPort, '127.0.0.1'); await once(client, 'connect');
    client.write('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');
    assert.match(String((await once(client, 'data'))[0]), /200 Connection Established/);
    client.write('model-request-roundtrip'); assert.equal(String((await once(client, 'data'))[0]), 'model-request-roundtrip');
    assert(received.some(request => request.host === 'chatgpt.com' && request.username === 'alice'));
    assert(forwards.every(info => info.destIP === 'admin.invalid' && info.destPort === 18443));
    const closed = once(client, 'close'); await proxy.configure({ ...config, certificateFingerprint: '00'.repeat(32) }); await closed;
    const before = received.length; await assert.rejects(proxy.probe(), /身份不匹配/); assert.equal(received.length, before, 'wrong certificate must not receive the access code');
    await proxy.configure({ ...config, accessCode: 'wrong-code' }); await assert.rejects(proxy.probe(), /接入码无效/);
    await proxy.configure({ ...config, host: 'denied.invalid' }); await assert.rejects(proxy.probe(), /共享服务器/); assert.equal(proxy.status().available, false);
    await proxy.configure(config);
    client = net.connect(localPort, '127.0.0.1'); await once(client, 'connect'); client.write('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');
    assert.match(String((await once(client, 'data'))[0]), /200/);
    const disconnected = once(client, 'close'); shared.disconnect(); proxy.sharedServerConnectionChanged(false); await disconnected;
    assert.equal(proxy.status().available, false); await assert.rejects(proxy.probe(), /请先连接中央节点/);
  } finally { client?.destroy(); await proxy.stop(); donor.disconnect(); shared.disconnect(); for (const socket of sockets) socket.destroy(); await server.close(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
});

test('SSH cancellation disposes late channels and disconnects reject pending opens', async () => {
  let complete!: Function;
  const client = Object.assign(new EventEmitter(), { forwardOut: (...args: any[]) => { complete = args.at(-1); } });
  const controller = new AbortController(), pending = forwardEgress(client as any, 'admin.internal', 443, controller.signal);
  const rejected = assert.rejects(pending, /取消/); controller.abort(); await rejected;
  const channel = new Duplex({ read() {}, write(_data, _enc, done) { done(); } }); complete(undefined, channel); assert.equal(channel.destroyed, true);
  const disconnected = assert.rejects(forwardEgress(client as any, 'admin.internal', 443, new AbortController().signal), /断开/);
  client.emit('close'); await disconnected; assert.equal(client.listenerCount('close'), 0);
});

test('stopping or reconfiguring cancels a pending shared-server route without direct fallback', async () => {
  let signal!: AbortSignal;
  const proxy = new EgressClientProxy({ enabled: true, viaSharedServer: true, host: 'admin.invalid', port: 443, certificateFingerprint: 'AA'.repeat(32), accessCode: 'fixture', username: 'alice' }, (_host, _port, value) => {
    signal = value; return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new Error('中转连接已取消')), { once: true }));
  });
  const rejected = assert.rejects(proxy.probe(), /取消/); await proxy.stop(); await rejected; assert.equal(signal.aborted, true);
});

test('concurrent SSH tunnels share a disconnect watcher and release it on close', async () => {
  const channels: Duplex[] = [];
  const client = Object.assign(new EventEmitter(), { forwardOut: (...args: any[]) => {
    const channel = new Duplex({ read() {}, write(_data, _enc, done) { done(); } }); channels.push(channel); args.at(-1)(undefined, channel);
  } });
  await Promise.all(Array.from({ length: 24 }, () => forwardEgress(client as any, 'admin', 443, new AbortController().signal)));
  assert.equal(client.listenerCount('close'), 1); client.emit('close');
  await new Promise<void>(resolve => setImmediate(resolve)); assert(channels.every(channel => channel.destroyed)); assert.equal(client.listenerCount('close'), 0);
});

test('legacy settings default to direct and server allowlist rejects injected or wildcard destinations', () => {
  assert.equal(userEgressSettingsSchema.parse({ enabled: true, host: 'admin', port: 443, certificateFingerprint: 'AA'.repeat(32) }).viaSharedServer, false);
  for (const host of ['*', 'admin\nMatch all', 'https://admin', '[::1]', 'admin other', 'a..b', '::1%zone']) assert.equal(adminOperationSchema.safeParse({ op: 'egress_jump', host, port: 443, enabled: true }).success, false);
  assert.equal(adminOperationSchema.safeParse({ op: 'egress_jump', host: '::1', port: 443, enabled: true }).success, true);
});
