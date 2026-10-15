import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const runner = path.join(root, 'scripts/test-background.mjs');

test('a missing selected test fails before starting the test suite', async () => {
  await assert.rejects(run(process.execPath, [runner, 'tests/launch-desktop.test.ts', 'tests/does-not-exist-script-audit.test.ts'], { cwd: root, windowsHide: true, timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /测试文件不存在或不是文件/);
    assert.doesNotMatch(error.stdout, /tests \d+|suites \d+/);
    return true;
  });
});

test('the background runner refuses desktop tests and paths outside the test directory', async () => {
  for (const selection of ['tests/launcher.test.ts', 'tests/egress.test.ts', 'tests/codex-process.test.ts', 'src/core/store.ts', '../outside.test.ts']) {
    await assert.rejects(run(process.execPath, [runner, selection], { cwd: root, windowsHide: true, timeout: 5000 }), (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /此测试不属于后台测试范围/);
      return true;
    });
  }
});
