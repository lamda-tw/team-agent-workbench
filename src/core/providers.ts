import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider, ProviderInfo } from '../shared/types';
import { spawnCLI } from './rpc';
import { cliFile, findWindowsCliOnPath } from './cli-path';
import { installedCodexCli } from './codex-installation';
const exec = promisify(execFile);
export async function resolveProvider(provider: Provider, configured = ''): Promise<string> {
  const base = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const oldCodexPaths = [
    path.join(process.cwd(), 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
    path.join(process.cwd(), 'node_modules/.bin/codex.cmd'),
    ...(base ? [path.join(base, 'providers/codex/bin/codex.exe')] : []),
  ].map(file => path.resolve(file).toLowerCase());
  const isOldCodex = (file: string) => provider === 'codex' && oldCodexPaths.includes(path.resolve(file.trim().replace(/^"(.*)"$/, '$1')).toLowerCase());
  // Existing settings may point to the removed Workbench runtime. Migrate only
  // those known paths to automatic discovery; other explicit paths remain strict.
  if (configured.trim() && !isOldCodex(configured)) {
    const file = await cliFile(configured);
    if (!file) throw new Error('CLI 路径无效，请选择可运行的 CLI 文件（Windows 使用 .exe、.cmd 或 .ps1）。');
    return file;
  }
  // Prefer the user's installation. Only Cursor retains a bundled fallback.
  const names = provider === 'codex' ? ['codex'] : provider === 'claude' ? ['claude'] : ['agent', 'cursor-agent'];
  for (const name of names) {
    if (process.platform === 'win32') {
      const file = await findWindowsCliOnPath(name, process.env, process.cwd(), isOldCodex);
      if (file) return file;
    } else {
      try {
        const matches = (await exec('which', [name], { timeout: 5000 })).stdout.trim().split(/\r?\n/).filter(Boolean);
        for (const found of matches) { const file = await cliFile(found); if (file) return file; }
      } catch {}
    }
  }
  const bundled = provider === 'cursor' && base ? path.join(base, 'providers/cursor/cursor-agent.cmd') : '';
  const dev = provider === 'cursor' ? path.join(process.cwd(), '.tools/cursor/dist-package/cursor-agent.cmd') : '';
  for (const candidate of [bundled, dev]) { const file = await cliFile(candidate); if (file) return file; }
  if (provider === 'claude' && process.platform === 'win32') {
    const native = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const file = await cliFile(native); if (file) return file;
  }
  const home = os.homedir(), local = process.env.LOCALAPPDATA || '';
  const candidates = provider === 'cursor' ? [path.join(local, 'cursor-agent', 'agent.exe'), path.join(local, 'cursor-agent', 'cursor-agent.cmd'), path.join(home, '.local', 'bin', 'agent.exe'), path.join(home, '.local', 'bin', 'agent'), path.join(home, '.local', 'bin', 'cursor-agent'), path.join(process.cwd(), '.tools', 'cursor', 'cursor-agent.cmd')] : provider === 'claude' ? [path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude')] : [path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'), path.join(home, '.local', 'bin', 'codex.exe')];
  if (provider === 'cursor') candidates.push(path.join(process.cwd(), '.tools', 'cursor', 'dist-package', 'cursor-agent.cmd'));
  for (const candidate of candidates) { const file = await cliFile(candidate); if (file) return file; }
  if (provider === 'codex' && process.platform === 'win32') {
    const desktop = await installedCodexCli(); if (desktop) return desktop;
  }
  throw new Error(provider === 'cursor' ? '未找到 Cursor Agent CLI。Cursor 编辑器的 cursor 命令不是 Agent CLI，请安装 agent 或在设置中选择其路径。' : provider === 'claude' ? '未找到 Claude Code CLI，请安装 claude 或在设置中选择其路径。' : '未找到本机 Codex CLI。请安装 Codex CLI 或 Codex 桌面版，再到 agent管理中重新检测；也可手动选择 CLI 程序路径。');
}
export async function inspectProvider(provider: Provider, configured: string): Promise<ProviderInfo> {
  try {
    const executable = await resolveProvider(provider, configured);
    const version = await new Promise<string>((resolve, reject) => {
      const child = spawnCLI(executable, ['--version'], os.homedir()); let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI 版本检测超时')); }, 15000);
      child.stdout.on('data', data => { output += data.toString(); });
      child.stderr.on('data', data => { output += data.toString(); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output.trim().slice(0, 300)) : reject(new Error(output.slice(0, 300) || 'CLI 无法启动')); });
    });
    return { provider, path: executable, available: true, version, detail: provider === 'codex' ? 'App Server · 使用个人 Codex 登录' : provider === 'claude' ? 'CLI · 使用本机 Claude Code 登录' : 'ACP · 使用个人 Cursor 登录' };
  } catch (e: any) { return { provider, path: configured, available: false, version: '', detail: e.message }; }
}
