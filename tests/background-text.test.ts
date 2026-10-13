import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import { codexPermissionParams, cursorPermissionArgs } from '../src/core/permissions';
import type { AgentSession } from '../src/shared/types';

test('background permission presets cannot inherit preparation or full-access settings', () => {
  assert.equal(codexPermissionParams({ purpose: 'background', permissionMode: 'full' }).sandbox, 'read-only');
  assert.deepEqual(cursorPermissionArgs({ purpose: 'background', permissionMode: 'inherit' }), ['acp']);
});

for (const provider of ['codex', 'cursor'] as const) test(provider + ': background protocol requests read-only mode and refuses tools without notifying the user', { timeout: 6000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-background-protocol-'));
  const s: AgentSession = { id: randomUUID(), title: '后台', purpose: 'background', provider, cwd: root, status: 'idle', messages: [], sources: [], approvals: [], autoUpload: false, createdAt: '', handoffPath: path.join(root, 'unused.md') };
  let complete!: () => void, notifications = 0;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const runtime = new AgentRuntime(s, path.resolve('tests/fixtures/background-agent.mjs'), { changed: () => {}, event: () => {}, done: complete, needsApproval: () => { notifications++; } }, undefined, { TEST_BACKGROUND_PROVIDER: provider });
  try {
    await runtime.ensureStarted(); await runtime.prompt('仅返回 JSON'); await done;
    assert.equal(s.error, undefined); assert.equal(notifications, 0); assert.equal(s.approvals.length, 0);
    assert.deepEqual(JSON.parse(s.messages.filter(m => m.role === 'assistant').map(m => m.text).join('')), { refused: true });
    assert.equal(s.nativeId, 'background-thread');
  } finally { await runtime.close(); assert(root.startsWith(path.join(os.tmpdir(), 'wb-background-protocol-'))); await fs.rm(root, { recursive: true, force: true }); }
});
