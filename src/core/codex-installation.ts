import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliFile } from './cli-path';

const exec = promisify(execFile);

// The desktop app extracts its CLI into a versioned directory. Re-scan instead
// of persisting that directory: an app update can replace it without updating PATH.
export async function extractedCodexCli(localAppData = process.env.LOCALAPPDATA || '') {
  if (!localAppData) return;
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const candidates: { file: string; time: number }[] = [];
  for (const name of await fs.readdir(bin).catch(() => [] as string[])) {
    const file = path.join(bin, name, 'codex.exe');
    const stat = await fs.stat(file).catch(() => undefined);
    if (stat?.isFile()) candidates.push({ file, time: stat.mtimeMs });
  }
  return candidates.sort((a, b) => b.time - a.time || a.file.localeCompare(b.file))[0]?.file;
}

async function desktopPackageRoot() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'],
  { windowsHide: true, timeout: 10000 });
  return stdout.trim();
}

export async function installedCodexCli(localAppData = process.env.LOCALAPPDATA || '', packageRoot = desktopPackageRoot) {
  const extracted = await extractedCodexCli(localAppData);
  if (extracted) return extracted;
  // A newly installed desktop app may not have extracted its CLI yet.
  const root = await packageRoot().catch(() => '');
  return root ? cliFile(path.join(root, 'app', 'resources', 'codex.exe')) : undefined;
}
