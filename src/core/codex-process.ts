import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sameNativePath } from './native-transcript';

const run = promisify(execFile);
export interface ProcessIdentity { pid: number; startedAt: string; executable: string }
export function processAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'ESRCH' ? false : undefined; }
}
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  if (processAlive(pid) === false) return;
  if (process.platform === 'win32') {
    const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p){[pscustomobject]@{pid=$p.ProcessId;startedAt=$p.CreationDate.ToUniversalTime().ToString('O');executable=$p.ExecutablePath}|ConvertTo-Json -Compress}`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000 });
    if (!stdout.trim()) return;
    const value = JSON.parse(stdout);
    if (!value.executable || !value.startedAt || value.pid !== pid) throw new Error('无法确认后台进程身份');
    return value;
  }
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return { pid, startedAt: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], executable: await fs.readlink(`/proc/${pid}/exe`) };
}
export async function sameProcess(expected: ProcessIdentity): Promise<boolean | undefined> {
  if (processAlive(expected.pid) === false) return false;
  try {
    const actual = await processIdentity(expected.pid);
    return !!actual && actual.startedAt === expected.startedAt && sameNativePath(actual.executable, expected.executable);
  } catch { return undefined; }
}
export async function stopOwnedProcess(identity: ProcessIdentity) {
  const same = await sameProcess(identity);
  if (same === false) return;
  if (!same) throw new Error('无法核对后台进程，未结束其他程序');
  if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  else process.kill(identity.pid, 'SIGTERM');
}
