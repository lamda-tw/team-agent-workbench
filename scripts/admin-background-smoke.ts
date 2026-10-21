import { _electron as electron, expect as baseExpect, type ElectronApplication } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { EgressClientProxy } from '../src/core/egress';
import { decodeEgressInvite } from '../src/core/egress-config';

async function main() {
  const expect = baseExpect.configure({ timeout: 20000 });
  const root = process.cwd(), parent = path.resolve(root, '.test-data');
  await fs.mkdir(parent, { recursive: true });
  const data = await fs.mkdtemp(path.join(parent, 'admin-background-'));
  const reserved = net.createServer(); await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = (reserved.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  await fs.writeFile(path.join(data, 'egress.json'), JSON.stringify({ enabled: true, listenHost: '127.0.0.1', listenPort: port, publicHost: '127.0.0.1' }));
  // The app creates a new fixture identity; the real administrator's files and ports are never used.
  const env = { ...process.env, WORKBENCH_TEST: '1', WORKBENCH_ADMIN_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: ElectronApplication | undefined, client: EgressClientProxy | undefined;
  try {
    app = await electron.launch({ args: ['dist/admin'], cwd: root, env, timeout: 60000 });
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const snapshot = () => page.evaluate(() => window.admin.call('snapshot'));
    await expect.poll(async () => { const value = await snapshot(); return !!value.egress?.running && !!value.egress?.background; }).toBe(true);
    const initial = await snapshot();
    const accessCode = decodeEgressInvite(initial.egress.inviteCode).accessCode;
    client = new EgressClientProxy({ enabled: true, host: '127.0.0.1', port, certificateFingerprint: initial.egress.fingerprint, accessCode, username: 'background-test' });
    await client.probe();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.close(); });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return !!window && !window.isDestroyed() && !window.isVisible(); })).toBe(true);
    await client.probe();
    // A second launch should restore the hidden administrator rather than start another relay.
    await app.evaluate(({ app }) => { app.emit('second-instance'); });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await client.probe(); assert.deepEqual(errors, []);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app }) => { app.quit(); });
    await closed; app = undefined;
    await assert.rejects(client.probe());
    console.log(JSON.stringify({ passed: true, scenarios: ['authenticated-relay', 'close-to-background', 'relay-survives-window-close', 'second-launch-restores-window', 'explicit-quit-stops-relay'] }));
  } finally {
    await client?.stop(); await app?.close();
    assert.equal(path.dirname(path.resolve(data)), parent);
    await fs.rm(data, { recursive: true, force: true, maxRetries: 5 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
