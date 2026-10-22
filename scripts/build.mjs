import { build } from 'esbuild';
import { mkdir, mkdtemp, copyFile, cp, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { publishRuntimeAssets } from './build-assets.mjs';
const require = createRequire(import.meta.url);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const checkOnly = process.argv.includes('--check');
const outputRoot = checkOnly ? await mkdtemp(path.join(os.tmpdir(), 'workbench-build-check-')) : 'dist';
async function copyDependency(name, dest, sourceRequire = require, seen = new Set()) {
  if (seen.has(name)) return; seen.add(name);
  const jsonPath = sourceRequire.resolve(name + '/package.json'), dir = path.dirname(jsonPath), pkg = JSON.parse(await readFile(jsonPath, 'utf8'));
  await cp(dir, path.join(dest, 'node_modules', name), { recursive: true });
  for (const dependency of Object.keys(pkg.dependencies || {})) await copyDependency(dependency, dest, createRequire(jsonPath), seen);
}
for (const edition of ['user', 'admin']) {
  const out = path.join(outputRoot, edition); await mkdir(out, { recursive: true });
  const preload = await build({ entryPoints: [edition === 'user' ? 'src/main/preload.ts' : 'src/admin/preload.ts'], outfile: out + '/preload.cjs', write: false, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
  const renderer = await build({ entryPoints: [edition === 'user' ? 'src/renderer/main.tsx' : 'src/admin/renderer.tsx'], outdir: out, entryNames: 'renderer', chunkNames: 'chunk-[hash]', splitting: true, write: false, bundle: true, minify: true, platform: 'browser', format: 'esm', target: 'chrome130', loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } });
  const files = Object.fromEntries([...preload.outputFiles, ...renderer.outputFiles].map(file => [path.basename(file.path), file.contents]));
  files['index.html'] = await readFile('src/renderer/index.html');
  if (edition === 'user') files['project-journal-worker.cjs'] = await readFile('src/core/project-journal-worker.cjs');
  if (edition === 'user') {
    const worker=await build({entryPoints:['src/core/codex-desktop-worker.ts'],outfile:out+'/codex-desktop-worker.cjs',write:false,bundle:true,platform:'node',format:'cjs',target:'node22'});
    files['codex-desktop-worker.cjs']=worker.outputFiles[0].contents;
  }
  if (edition === 'admin') {
    const worker = await build({ entryPoints: ['src/admin/egress-worker.ts'], outfile: out + '/egress-worker.cjs', write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
    files['egress-worker.cjs'] = worker.outputFiles[0].contents;
  }
  const assets = await publishRuntimeAssets(out, files);
  const main = await build({ entryPoints: [edition === 'user' ? 'src/main/index.ts' : 'src/admin/main.ts'], outfile: out + '/main.cjs', write: false, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'ssh2', 'original-fs'], sourcemap: false, define: { __WORKBENCH_ASSETS__: JSON.stringify(assets) } });
  if (edition === 'admin') { await copyFile('server/acl_support.py', out + '/acl_support.py'); await copyFile('server/group_ops.py', out + '/group_ops.py'); await copyFile('server/admin.py', out + '/admin.py'); await copyFile('server/content.py', out + '/content.py'); }
  await copyDependency('ssh2', out);
  await writeFile(out + '/package.json', JSON.stringify({ name: 'team-agent-' + edition, version, description: 'Team Agent ' + edition, author: 'Team Agent Workbench', main: 'main.cjs', dependencies: { ssh2: '^1.17.0' } }, null, 2));
  // Keep conventional paths for release verification; running processes use assets/<hash>.
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(out, name), content);
  // Publish the main entry only after all of its dependencies and assets are ready.
  const pending = out + '/main.' + process.pid + '.pending.cjs';
  await writeFile(pending, main.outputFiles[0].contents); await rename(pending, out + '/main.cjs');
}
console.log(checkOnly ? `Build verified in ${outputRoot}; running application files were not changed.` : 'Built isolated User and Admin applications.');
