import assert from 'node:assert/strict';
import { CodexDesktopService } from '../../src/core/codex-desktop-service';
import { WebSocketRpc } from '../../src/core/websocket-rpc';

async function main() {
  const [sourceHome, parent, endpoint] = process.argv.slice(2);
  const originalEnv = { ...process.env };
  const service = new CodexDesktopService({ sourceHome, parent, running: async () => { throw new Error('Must reuse the existing backend'); } });
  const bridge = await service.ensure();
  assert.equal(bridge.endpoint, endpoint);
  assert(Date.parse(bridge.expiresAt) > Date.now(), 'an expired healthy connection must renew directly');
  const rpc = new WebSocketRpc(endpoint);
  try {
    assert.deepEqual(await rpc.request('initialize', { clientInfo: { name: 'loopback_fixture', version: '1' } }, 2500), { userAgent: 'loopback_fixture' });
  } finally { await rpc.close(); }
  assert.deepEqual({ ...process.env }, originalEnv, 'bypassing local connections must not change proxy settings');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
