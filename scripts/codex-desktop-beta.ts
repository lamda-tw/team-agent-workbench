import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as asar from '@electron/asar';
import { startCodexSharedBackend, privateBridgeDirectory, installedCodexDesktopExecutable } from '../src/core/codex-shared-backend';
import type { CodexDesktopBridge } from '../src/core/codex-desktop-bridge';
import { prepareCodexDesktopBetaDemo } from './prepare-codex-desktop-beta-demo';
import { sameNativePath } from '../src/core/native-transcript';

const exec = promisify(execFile);
const parent = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TeamAgentWorkbench', 'codex-desktop-beta');
const activeFile = path.join(parent, 'active.json');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function powershell(code: string) { return (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, timeout: 15000 })).stdout.trim(); }
async function desktop(requireClosed = true) {
  if (process.platform !== 'win32') throw new Error('此联调入口仅适用于 Windows');
  const packageRoot = await powershell('(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation');
  if (!packageRoot) throw new Error('未找到已安装的 Codex 桌面版');
  const app = path.join(packageRoot, 'app', 'ChatGPT.exe'), archive = path.join(packageRoot, 'app', 'resources', 'app.asar');
  const transportFile = asar.listPackage(archive).find(file => /application-network-startup-.*\.js$/.test(file));
  if (!transportFile || !asar.extractFile(archive, transportFile.replace(/^[/\\]/, '')).toString().includes('CODEX_APP_SERVER_WS_URL')) throw new Error('当前桌面版本没有确认可用的共享后台入口，请使用普通启动入口');
  const running = await powershell('Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\'" | Where-Object { $_.ExecutablePath -like "*OpenAI.Codex*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object -ExpandProperty ProcessId');
  if (requireClosed && running) throw new Error('请先保存并结束运行中的 Codex 聊天，然后退出 Codex 桌面版，再打开此 Beta 入口。不会自动关闭你的聊天。');
  const executable = await installedCodexDesktopExecutable(path.join(packageRoot, 'app', 'resources', 'codex.exe'));
  const { stdout } = await exec(executable, ['app-server', '--help'], { windowsHide: true, timeout: 10000 });
  if (!stdout.includes('--ws-auth')) throw new Error('桌面版 Codex 后台不支持所需连接验证，请使用普通启动入口');
  return { app, executable };
}
async function active() {
  try {
    const { file } = JSON.parse(await fs.readFile(activeFile, 'utf8'));
    const relative = path.relative(parent, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    const descriptor: CodexDesktopBridge = JSON.parse(await fs.readFile(file, 'utf8'));
    const url = new URL(descriptor.endpoint);
    if (descriptor.version !== 1 || url.hostname !== '127.0.0.1' || url.protocol !== 'ws:' || !/^\/rpc\/[a-f0-9]{64}$/.test(url.pathname)) return;
    return { file, descriptor };
  } catch { return; }
}
async function control(descriptor: CodexDesktopBridge, operation: 'readyz' | 'stop') {
  const url = new URL(descriptor.endpoint); url.protocol = 'http:'; url.pathname += '/' + operation;
  return fetch(url, { method: operation === 'stop' ? 'POST' : 'GET', signal: AbortSignal.timeout(3000) });
}
async function main() {
  const mode = process.argv[2] || 'launch';
  if (!['launch', 'serve', 'stop', 'check'].includes(mode)) throw new Error('无效的 Beta 入口操作');
  if (mode === 'serve') {
    const input = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
    try {
      const backend = await startCodexSharedBackend(input);
      const timer = setTimeout(() => void backend.close(), 86400000); timer.unref();
      process.once('SIGINT', () => void backend.close()); process.once('SIGTERM', () => void backend.close());
    } catch { await fs.writeFile(path.join(input.stateDirectory, 'failed.txt'), '共享后台未能启动；普通启动入口不受影响。'); process.exitCode = 1; }
    return;
  }
  if (mode === 'stop') {
    const current = await active();
    if (current && !(await control(current.descriptor, 'stop').catch(() => undefined))?.ok) throw new Error('无法确认 Beta 后台已停止；请检查 Beta 应用状态。没有终止其他进程。');
    console.log('已请求停止同步 Beta 后台。下次使用原来的普通启动入口即可。'); return;
  }
  const target = await desktop(mode !== 'check');
  if (mode === 'check') { console.log('当前桌面版具备共享后台入口；未启动后台，也未修改设置。'); return; }
  const repo = process.argv[3] ? path.resolve(process.argv[3]) : process.cwd();
  // This developer-only entry uses the existing dependency/runtime installation.
  // Do not run a dependency reinstall while the shared backend is already alive.
  try { await exec(process.execPath, ['scripts/build.mjs'], { cwd: repo, windowsHide: true, timeout: 180000 }); }
  catch { throw new Error('工作台构建失败，未启动共享后台；请先用普通入口检查开发环境'); }
  const sourceHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  let current = await active();
  if (current && (!sameNativePath(current.descriptor.sourceHome, sourceHome) || !sameNativePath(current.descriptor.executable, target.executable) || Date.parse(current.descriptor.expiresAt) <= Date.now() || !(await control(current.descriptor, 'readyz').catch(() => undefined))?.ok)) {
    throw new Error('已有 Beta 后台的配置已改变或无法确认状态。请先结束测试并使用停止 Beta 入口，再重新启动；不会另起一个后台写入相同历史。');
  }
  if (!current) {
    const directory = await privateBridgeDirectory(parent);
    const input = path.join(directory, 'input.json');
    await fs.writeFile(input, JSON.stringify({ executable: target.executable, sourceHome, cwd: repo, stateDirectory: directory }), { mode: 0o600 });
    const manager = spawn(process.execPath, [__filename, 'serve', input], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CODEX_APP_SERVER_WS_URL: undefined } });
    manager.unref(); const file = path.join(directory, 'bridge.json'), deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await fs.stat(path.join(directory, 'failed.txt')).catch(() => undefined)) throw new Error('共享 Codex 后台未能启动，未打开应用；请使用普通入口');
      try { const descriptor: CodexDesktopBridge = JSON.parse(await fs.readFile(file, 'utf8')); current = { file, descriptor }; break; } catch {}
      await delay(150);
    }
    if (!current) throw new Error('共享 Codex 后台启动超时，未打开应用；请使用普通入口');
    await fs.writeFile(activeFile, JSON.stringify({ file }), { mode: 0o600 });
  }
  // Only these children receive the Beta settings. Do not set global environment,
  // edit the desktop installation, copy login secrets, or terminate other chats.
  const demo = await prepareCodexDesktopBetaDemo(current.descriptor, path.dirname(current.file));
  const environment = { ...process.env, CODEX_APP_SERVER_WS_URL: current.descriptor.endpoint,
    CODEX_APP_SERVER_FORCE_CLI: undefined, ELECTRON_RUN_AS_NODE: undefined, WORKBENCH_CODEX_DESKTOP_BRIDGE: current.file, WORKBENCH_DATA_DIR: demo.userData };
  // Empty conversations in a new local folder are not necessarily visible in
  // the desktop's project sidebar. Use its verified conversation deep link.
  spawn(target.app, ['codex://threads/' + demo.nativeId], { env: environment, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  spawn(process.execPath, [require.resolve('electron/cli.js'), path.join(repo, 'dist', 'user')], { env: environment, cwd: repo, detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  console.log('同步 Beta 已启动。两端打开“Codex 同步 Beta 验证”即可测试；共享区是独立的本地文件夹，不会连接中央节点。');
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
