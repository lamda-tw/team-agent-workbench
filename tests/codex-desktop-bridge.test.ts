import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { readCodexDesktopBridge } from '../src/core/codex-desktop-bridge';
import type { AgentSession } from '../src/shared/types';

test('desktop bridge is explicit, links only work sessions, and rejects mismatched profiles and expired endpoints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-desktop-bridge-'));
  const prior = process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  try {
    const personal = path.join(root, 'personal'), nativeId = randomUUID(), file = path.join(root, 'bridge.json');
    const native = path.join(personal, 'sessions', 'rollout-' + nativeId + '.jsonl');
    await fs.mkdir(path.dirname(native), { recursive: true }); await fs.writeFile(native, 'original');
    const s = { id: randomUUID(), nativeId, nativeLive: true, provider: 'codex', purpose: 'work', cwd: root } as AgentSession;
    const descriptor = { version: 1, endpoint: 'ws://127.0.0.1:12345/rpc/' + 'a'.repeat(64), sourceHome: personal, executable: 'unused', pid: 123, expiresAt: new Date(Date.now() + 60000).toISOString() };
    delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
    assert.equal(await readCodexDesktopBridge(personal), undefined);
    await fs.writeFile(file, JSON.stringify(descriptor)); process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE = file;
    const linked = await prepareCodexStorage(path.join(root, 'data'), s, personal);
    assert.equal(linked.sharedEndpoint, descriptor.endpoint); assert.equal(linked.home, personal); assert.equal(linked.resumePath, native);
    await assert.rejects(fs.access(path.join(root, 'data', 'codex-home')), 'shared mode never initializes a second history index');
    for (const purpose of ['prepare', 'background'] as const) {
      const privateStorage = await prepareCodexStorage(path.join(root, purpose), { ...s, purpose, nativeLive: false, nativeId: undefined }, personal);
      assert.equal(privateStorage.sharedEndpoint, undefined); assert.notEqual(privateStorage.home, personal);
    }
    const fresh = await prepareCodexStorage(path.join(root, 'fresh'), { ...s, nativeLive: false, nativeId: undefined }, personal);
    assert.equal(fresh.sharedEndpoint, undefined);
    await assert.rejects(prepareCodexStorage(root, { ...s, networkRoute: 'management' }, personal), /管理端/);
    for (const changes of [{ sourceHome: root }, { expiresAt: new Date(0).toISOString() }, { endpoint: 'ws://192.168.1.1:12345/rpc/' + 'a'.repeat(64) }, { endpoint: 'ws://127.0.0.1:12345/rpc/' + 'a'.repeat(64) + '?token=leak' }]) {
      await fs.writeFile(file, JSON.stringify({ ...descriptor, ...changes })); await assert.rejects(readCodexDesktopBridge(personal), /无效|失效/);
    }
    await fs.rm(file); await assert.rejects(prepareCodexStorage(root, s, personal), /无法读取/, 'missing bridge never silently starts another process');
    assert.equal(await fs.readFile(native, 'utf8'), 'original');
  } finally {
    if (prior === undefined) delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE; else process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
