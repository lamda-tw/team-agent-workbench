import { build } from 'electron-builder';
import path from 'node:path';
import { cp, copyFile } from 'node:fs/promises';
import { releaseRoot } from './release-paths.mjs';
const requested = process.argv[2];
for (const edition of requested ? [requested] : ['admin', 'user']) {
  if (!['admin', 'user'].includes(edition)) throw new Error('Unknown edition');
  const product = edition === 'admin' ? 'Team Agent Admin' : 'Team Agent User';
  await build({ projectDir: process.cwd(), config: {
    appId: 'local.teamagent.' + edition, productName: product,
    directories: { app: path.resolve('dist', edition), output: path.join(releaseRoot, edition) },
    electronVersion: '44.3.0', electronDist: path.resolve('node_modules/electron/dist'),
    asar: true, npmRebuild: false, nodeGypRebuild: false, compression: 'store',
    files: ['**/*'],
    afterPack: async ({ appOutDir }) => {
      // Electron-builder excludes nested node_modules from extraResources. These
      // are the CLI's own native dependencies, so copy the official directory verbatim.
      if (edition === 'user') await cp('.tools/cursor/dist-package', path.join(appOutDir, 'resources/providers/cursor'), { recursive: true });
      await copyFile('README.md', path.join(appOutDir, '使用说明.md'));
      await cp('docs', path.join(appOutDir, 'docs'), { recursive: true, filter: source => !/SHA256SUMS/.test(source) });
      await copyFile('THIRD_PARTY.md', path.join(appOutDir, 'THIRD_PARTY.md'));
    },
    win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }], signAndEditExecutable: false,
      artifactName: 'TeamAgent-' + edition + '-${version}-${arch}.${ext}' },
    nsis: { oneClick: false, perMachine: false, differentialPackage: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true,
      shortcutName: edition === 'admin' ? '团队工作台-管理员版' : '团队工作台-用户版', uninstallDisplayName: product },
  }});
}
