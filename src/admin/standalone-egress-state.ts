import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { adminEgressConfigSchema, sharedServerRouteSchema } from '../core/egress-config';

export const standaloneEgressSchema = z.object({
  version: z.literal(1),
  config: adminEgressConfigSchema.refine(config => config.enabled, '请先在管理端保存并启用出口'),
  secret: z.object({ accessCode: z.string().min(24).max(512), upstreamPassword: z.string().optional() }),
  certificate: z.object({ pfx: z.string().min(1), passphrase: z.string(), fingerprint: z.string().regex(/^[A-F0-9]{64}$/) }),
  reverse: sharedServerRouteSchema.extend({ username: z.string().min(1), password: z.string().optional() }).optional(),
});
export type StandaloneEgressState = z.infer<typeof standaloneEgressSchema>;

/** Read existing identity only. Missing/corrupt data must never rotate invitations. */
export async function exportStandaloneEgress(root: string, decrypt: (value: Buffer) => string): Promise<StandaloneEgressState> {
  const read = async (file: string) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
  const config = adminEgressConfigSchema.parse(await read('egress.json'));
  const secret = JSON.parse(decrypt(await fs.readFile(path.join(root, 'egress-secrets.bin'))));
  const files = await read('egress-tls/egress-certificate.json');
  const certificate = new X509Certificate(await fs.readFile(files.cer));
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('出口证书已过期，请先在管理端处理');
  const state: StandaloneEgressState = {
    version: 1, config, secret,
    certificate: { pfx: (await fs.readFile(files.pfx)).toString('base64'), passphrase: files.password, fingerprint: certificate.fingerprint256.replace(/:/g, '').toUpperCase() },
  };
  let records: Record<string, { enabled: boolean; remotePort: number; memberAccessConfigured: boolean }> = {};
  try { records = await read('reverse-egress.json'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (Object.values(records).some(record => record.enabled)) {
    const profile = await read('connection.json');
    const key = createHash('sha256').update(JSON.stringify([profile.host.toLowerCase(), profile.port, profile.fingerprint, profile.root])).digest('hex');
    const record = records[key];
    if (!record?.enabled || profile.mode === 'local') throw new Error('已保存的反向隧道与当前服务器不匹配，请先在管理端确认');
    if (!record.memberAccessConfigured || !record.remotePort) throw new Error('请先在管理端完成反向隧道和成员授权');
    state.reverse = { host: profile.host, port: profile.port, fingerprint: profile.fingerprint, username: profile.username, relayPort: record.remotePort };
  }
  return standaloneEgressSchema.parse(state);
}

export const standaloneMarkerName = 'standalone-egress.json';
export async function isStandaloneEgress(root: string) {
  try { await fs.access(path.join(root, standaloneMarkerName)); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}
