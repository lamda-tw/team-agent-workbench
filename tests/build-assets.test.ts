import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Build scripts are native JavaScript.
import { publishRuntimeAssets } from '../scripts/build-assets.mjs';

test('rebuilding keeps the old main process paired with its original page, renderer and preload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-assets-'));
  try {
    const original = { 'index.html': '<script src="renderer.js"></script>', 'renderer.js': 'old API', 'chunk-mermaid.js': 'old lazy diagram renderer', 'renderer.css': 'old styles', 'preload.cjs': 'old bridge', 'egress-worker.cjs': 'old relay worker' };
    const loadedMainDirectory = await publishRuntimeAssets(root, original);
    const updated = { ...original, 'renderer.js': 'new API', 'chunk-mermaid.js': 'new lazy diagram renderer', 'preload.cjs': 'new bridge', 'egress-worker.cjs': 'new relay worker' };
    const nextMainDirectory = await publishRuntimeAssets(root, updated);
    assert.notEqual(loadedMainDirectory, nextMainDirectory);
    for (const [file, content] of Object.entries(original)) assert.equal(await fs.readFile(path.join(root, loadedMainDirectory, file), 'utf8'), content);
    for (const [file, content] of Object.entries(updated)) assert.equal(await fs.readFile(path.join(root, nextMainDirectory, file), 'utf8'), content);
    assert.equal(await publishRuntimeAssets(root, updated), nextMainDirectory, 'identical builds reuse immutable assets');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an existing asset mismatch fails instead of overwriting a running process asset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-assets-'));
  try {
    const files = { 'renderer.js': 'expected' }, directory = await publishRuntimeAssets(root, files);
    const target = path.join(root, directory, 'renderer.js');
    await fs.writeFile(target, 'unexpected');
    await assert.rejects(publishRuntimeAssets(root, files));
    assert.equal(await fs.readFile(target, 'utf8'), 'unexpected');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
