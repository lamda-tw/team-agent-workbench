import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { exportStandaloneEgress, isStandaloneEgress, standaloneEgressSchema, type StandaloneEgressState } from '../src/admin/standalone-egress-state';
import { ensureEgressCertificate } from '../src/admin/egress-certificate';
import { StandaloneEgress } from '../src/admin/standalone-egress';
import { EgressClientProxy } from '../src/core/egress';
import { adminEgressConfigSchema, encodeEgressInvite } from '../src/core/egress-config';
import { testTlsIdentity } from './fixtures/tls-identity';
import type { ReverseEgressTunnel } from '../src/admin/reverse-egress';

const secret = { accessCode: 'original-access-code-with-enough-characters', upstreamPassword: 'original-proxy-password' };

test('export retains both invitations and certificate bytes without writing any administrator files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-relay-export-'));
  try {
    const identity = testTlsIdentity(), certificateRoot = path.join(root, 'egress-tls'); await fs.mkdir(certificateRoot);
    const config = adminEgressConfigSchema.parse({ enabled: true, publicHost: 'admin.internal', listenPort: 18443 });
    const profile = { host: 'ssh.internal', port: 2202, username: 'root', fingerprint: 'SHA256:' + 'a'.repeat(43), root: '/srv/teamspace' };
    const key = createHash('sha256').update(JSON.stringify([profile.host, profile.port, profile.fingerprint, profile.root])).digest('hex');
    const files = {
      'egress.json': JSON.stringify(config), 'egress-secrets.bin': 'encrypted fixture',
      'connection.json': JSON.stringify(profile), 'reverse-egress.json': JSON.stringify({ [key]: { enabled: true, remotePort: 34567, memberAccessConfigured: true } }),
      'egress-tls/egress-certificate.json': JSON.stringify({ pfx: path.join(certificateRoot, 'identity.pfx'), cer: path.join(certificateRoot, 'identity.cer'), password: 'pfx-password' }),
      'egress-tls/identity.pfx': 'ORIGINAL PFX BYTES', 'egress-tls/identity.cer': identity.cert,
    };
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(root, file), content);
    const exported = await exportStandaloneEgress(root, bytes => { assert.equal(bytes.toString(), 'encrypted fixture'); return JSON.stringify(secret); });
    assert.deepEqual(exported.secret, secret); assert.equal(Buffer.from(exported.certificate.pfx, 'base64').toString(), 'ORIGINAL PFX BYTES');
    const original = { host: config.publicHost, port: config.listenPort, fingerprint: identity.fingerprint.replace(/:/g, ''), accessCode: secret.accessCode };
    const copied = { host: exported.config.publicHost, port: exported.config.listenPort, fingerprint: exported.certificate.fingerprint, accessCode: exported.secret.accessCode };
    assert.equal(encodeEgressInvite({ version: 1, ...original }), encodeEgressInvite({ version: 1, ...copied }));
    const route = { host: profile.host, port: profile.port, fingerprint: profile.fingerprint, relayPort: 34567 };
    const { username, password, ...exportedRoute } = exported.reverse!;
    assert.equal(username, profile.username); assert.equal(password, undefined);
    assert.equal(encodeEgressInvite({ version: 2, ...original, sharedServer: route }), encodeEgressInvite({ version: 2, ...copied, sharedServer: exportedRoute }));
    for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content);
    await fs.unlink(path.join(root, 'egress-secrets.bin'));
    await assert.rejects(exportStandaloneEgress(root, () => JSON.stringify(secret)), /ENOENT/);
    await assert.rejects(fs.access(path.join(root, 'egress-secrets.bin')), /ENOENT/, 'missing credentials must never be replaced');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('standalone ownership fails closed on missing certificates and never creates replacement identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-relay-marker-'));
  try {
    assert.equal(await isStandaloneEgress(root), false);
    await fs.writeFile(path.join(root, 'standalone-egress.json'), 'invalid metadata');
    assert.equal(await isStandaloneEgress(root), true, 'even a damaged marker prevents GUI takeover');
    await assert.rejects(ensureEgressCertificate(path.join(root, 'missing'), true), /不会自动更换/);
    assert.deepEqual(await fs.readdir(root), ['standalone-egress.json']);
    assert.throws(() => standaloneEgressSchema.parse({ version: 1 }), /config/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('standalone restarts accept the original member credential and preserve the reverse route', async () => {
  const identity = testTlsIdentity();
  const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as net.AddressInfo).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const originalCreate = tls.createServer;
  // Preserve the TLS boundary while substituting ephemeral PEM for OS-only PFX generation.
  (tls as any).createServer = (options: tls.TlsOptions, listener: (socket: tls.TLSSocket) => void) => {
    assert.equal((options.pfx as Buffer).toString(), 'same-pfx'); assert.equal(options.passphrase, 'same-passphrase');
    return originalCreate({ key: identity.key, cert: identity.cert, minVersion: options.minVersion }, listener);
  };
  class Tunnel extends EventEmitter {
    options: any; stopped = false;
    snapshot() { return { state: this.stopped ? 'disabled' : 'connected' }; }
    async start(options: unknown) { this.options = options; }
    stop() { this.stopped = true; }
  }
  const state: StandaloneEgressState = {
    version: 1, config: adminEgressConfigSchema.parse({ enabled: true, publicHost: '127.0.0.1', listenHost: '127.0.0.1', listenPort: port }), secret,
    certificate: { pfx: Buffer.from('same-pfx').toString('base64'), passphrase: 'same-passphrase', fingerprint: identity.fingerprint.replace(/:/g, '') },
    reverse: { host: 'shared.internal', port: 2202, fingerprint: 'SHA256:' + 'a'.repeat(43), relayPort: 34567, username: 'tunnel-user', password: 'saved-tunnel-password' },
  };
  try {
    for (let run = 0; run < 2; run++) {
      const tunnel = new Tunnel(), service = new StandaloneEgress(structuredClone(state), () => {}, tunnel as unknown as ReverseEgressTunnel);
      const client = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port, certificateFingerprint: state.certificate.fingerprint, accessCode: secret.accessCode, username: 'member' });
      try {
        await service.start(); await client.probe();
        assert.equal(client.status().available, true);
        assert.equal(tunnel.options.remotePort, 34567); assert.equal(tunnel.options.password, 'saved-tunnel-password');
        assert.equal(tunnel.options.localPort, port);
        assert.doesNotMatch(JSON.stringify(service.snapshot()), /saved-tunnel-password|original-access|pfx|passphrase/);
        const wrong = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port, certificateFingerprint: state.certificate.fingerprint, accessCode: 'wrong', username: 'member' });
        try { await assert.rejects(wrong.probe(), /接入码/); } finally { await wrong.stop(); }
      } finally { await client.stop(); await service.stop(); }
      assert.equal(service.snapshot().running, false); assert.equal(tunnel.stopped, true);
    }
    const missingPassword = structuredClone(state); delete missingPassword.reverse!.password;
    const service = new StandaloneEgress(missingPassword, () => {});
    try { await assert.rejects(service.start(), /凭据/); } finally { await service.stop(); }
  } finally { tls.createServer = originalCreate; }
});
