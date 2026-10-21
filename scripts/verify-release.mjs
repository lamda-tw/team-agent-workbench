import { releaseRoot } from './release-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractFile, listPackage } from '@electron/asar';
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const hashes = [];
for (const edition of ['admin', 'user']) {
  const base = path.join(releaseRoot, edition, 'win-unpacked'), archive = path.join(base, 'resources/app.asar');
  assert.equal(JSON.parse(extractFile(archive, 'package.json').toString()).version, version);
  assert.equal(await fs.stat(path.join(base, 'resources/providers/codex')).then(() => true, () => false), false, 'Codex must use the local user installation');
  for (const file of ['main.cjs', 'preload.cjs', 'renderer.js', 'renderer.css', 'index.html']) assert.equal(sha(extractFile(archive, file)), sha(await fs.readFile(path.join('dist', edition, file))), edition + '/' + file);
  const files = listPackage(archive).map(s => s.split(String.fromCharCode(92)).join('/'));
  if (edition === 'admin') assert.equal(sha(extractFile(archive, 'admin.py')), sha(await fs.readFile('server/admin.py')));
  else assert(!files.some(f => f === '/admin.py'));
  assert.equal(sha(await fs.readFile(path.join(base, 'docs/local-filesystem.md'))), sha(await fs.readFile('docs/local-filesystem.md')));
  assert.equal(sha(await fs.readFile(path.join(base, 'docs/admin-management.md'))), sha(await fs.readFile('docs/admin-management.md')));
  assert.equal(sha(await fs.readFile(path.join(base, 'docs/session-experience.md'))), sha(await fs.readFile('docs/session-experience.md')));
  assert(!files.some(f => /(?:^|\/)(?:auth\.json|settings\.json|sessions\.json|drafts\.json|registry\.json|\.env)$/.test(f)), 'Application archive must not contain local account or work data');
  assert.equal(sha(await fs.readFile(path.join(base, '使用说明.md'))), sha(await fs.readFile('README.md')));
  for (const ext of ['exe', 'zip']) {
    const file = path.join(releaseRoot, edition, `TeamAgent-${edition}-${version}-x64.${ext}`);
    if (ext === 'zip') execFileSync('python', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None', file], { windowsHide: true });
    hashes.push(`${sha(await fs.readFile(file))}  ${edition}/${path.basename(file)}  ${(await fs.stat(file)).size} bytes`);
  }
  console.log(edition, 'ASAR, docs, ZIP integrity and installer hashes verified');
}
async function walk(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await walk(root, name)); else result.push(name);
  }
  return result;
}
for (const [provider, source] of [['cursor', '.tools/cursor/dist-package']]) {
  const files = await walk(source);
  for (const file of files) assert.equal(sha(await fs.readFile(path.join(source, file))), sha(await fs.readFile(path.join(releaseRoot, 'user/win-unpacked/resources/providers', provider, file))), provider + '/' + file);
  console.log(provider, files.length, 'runtime files verified');
}
const contents = hashes.join('\n') + '\n';
await fs.writeFile(path.join(releaseRoot, `SHA256SUMS-${version}.txt`), contents);
await fs.writeFile(`docs/SHA256SUMS-${version}.txt`, contents);
