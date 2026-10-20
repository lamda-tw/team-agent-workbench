import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'standalone-egress'));
await mkdir(out, { recursive: true });
for (const [entry, file, external] of [
  ['standalone-egress-entry', 'relay.cjs', []],
  ['standalone-egress-export', 'export.cjs', ['electron']],
]) await build({ absWorkingDir: root, entryPoints: [`src/admin/${entry}.ts`], outfile: path.join(out, file), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external, logLevel: 'warning' });
await copyFile(path.join(root, 'scripts', 'standalone-egress.ps1'), path.join(out, 'standalone-egress.ps1'));
console.log('Built standalone relay.');
