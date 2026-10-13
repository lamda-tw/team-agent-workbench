import fs from 'node:fs/promises';
import path from 'node:path';
import { sameNativePath } from './native-transcript';

export interface CodexDesktopBridge { version: 1; endpoint: string; sourceHome: string; executable: string; pid: number; expiresAt: string; approvalRoutingVersion?: 1; process?: import('./codex-process').ProcessIdentity; }
export async function readCodexDesktopBridge(sourceHome: string): Promise<CodexDesktopBridge | undefined> {
  const file = process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  if (!file) return;
  let value: CodexDesktopBridge;
  try { value = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
  catch { throw new Error('Codex 联动连接配置无法读取，请在会话中重新连接'); }
  let endpoint: URL;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('Codex 同步 Beta 配置无效'); }
  if (value.version !== 1 || endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/rpc\/[a-f0-9]{64}$/.test(endpoint.pathname)
      || !value.sourceHome || !sameNativePath(value.sourceHome, sourceHome) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new Error('Codex 联动连接配置已失效或不属于当前个人账号目录，请在会话中重新连接');
  }
  return value;
}
