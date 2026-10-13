import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { processAlive, processIdentity, sameProcess, stopOwnedProcess } from '../src/core/codex-process';

test('recovery never treats an invalid PID or a different process birth time as its own backend', async () => {
  assert.equal(processAlive(0), undefined); assert.equal(processAlive(99999999), false);
  const identity = await processIdentity(process.pid); assert(identity);
  assert.equal(await sameProcess(identity), true);
  assert.equal(await sameProcess({ ...identity, startedAt: 'different' }), false);
  // A mismatched record must never stop this test runner.
  await stopOwnedProcess({ ...identity, startedAt: 'different' }); assert.equal(processAlive(process.pid), true);
});
test('only the verified test-owned backend is terminated', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const identity = await processIdentity(child.pid!); assert(identity);
    await stopOwnedProcess({ ...identity, startedAt: 'old process' }); assert.equal(processAlive(child.pid!), true);
    await stopOwnedProcess(identity); await exited; assert.equal(processAlive(child.pid!), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
