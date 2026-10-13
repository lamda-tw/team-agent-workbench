import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({ entryPoints: ['scripts/codex-desktop-beta.ts'], outfile: '.test-data/codex-desktop-beta/launcher.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['@electron/asar', 'ssh2', 'electron/cli.js'] });
await copyFile('src/core/project-journal-worker.cjs', '.test-data/codex-desktop-beta/project-journal-worker.cjs');
