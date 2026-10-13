import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({entryPoints:['scripts/cursor-native-beta.ts'],outfile:'.test-data/cursor-native-beta/launcher.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['playwright','ssh2','electron/cli.js','original-fs']});
await copyFile('src/core/project-journal-worker.cjs','.test-data/cursor-native-beta/project-journal-worker.cjs');
