import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The user's own desktop app is already open. Callers must not write its session files. */
export async function userDesktopAppOpen(provider: 'codex' | 'cursor'): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const command = provider === 'codex'
    ? 'Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\'" | Where-Object { $_.ExecutablePath -like "*OpenAI.Codex*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object -ExpandProperty ProcessId'
    : 'Get-CimInstance Win32_Process -Filter "Name=\'Cursor.exe\'" | Where-Object { $_.CommandLine -notlike "*--type=*" } | Select-Object -ExpandProperty ProcessId';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 });
  return !!stdout.trim();
}
