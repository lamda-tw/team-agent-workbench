import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSession } from '../shared/types';
import type { AgentRpc } from './rpc';
import { sameNativePath } from './native-transcript';
import { readCodexDesktopBridge } from './codex-desktop-bridge';

export interface CodexStorage { home: string; sourceHome: string; args: string[]; env: NodeJS.ProcessEnv; resumePath?: string; sharedEndpoint?: string; }
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };
const jobs = new Map<string, Promise<void>>();

export async function validateCodexStorage(rpc: AgentRpc, storage: CodexStorage) {
  const { requirements } = await rpc.request('configRequirements/read', {}, 15000);
  if (requirements?.sqliteHome) {
    const required = fileURLToPath(requirements.sqliteHome);
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(required) !== normalize(storage.env.CODEX_SQLITE_HOME!)) throw new Error('当前管理策略不允许独立保存工作台会话，请联系管理员调整会话存储设置');
  }
  if (!storage.sharedEndpoint && requirements?.cliAuthCredentialsStore && requirements.cliAuthCredentialsStore !== 'ephemeral') throw new Error('当前管理策略不允许工作台沿用临时登录，请联系管理员调整登录设置');
}

async function copyConfig(source: string, destination: string) {
  const temp = destination + '.' + randomUUID() + '.tmp';
  try { await fs.copyFile(source, temp); await fs.chmod(temp, 0o600); await fs.rename(temp, destination); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; await fs.rm(destination, { force: true }); }
  finally { await fs.rm(temp, { force: true }); }
}

async function initialize(home: string, sourceHome: string) {
  if (home === sourceHome || inside(sourceHome, home)) throw new Error('工作台会话目录必须与个人 Codex 目录分开');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(home)).isSymbolicLink()) throw new Error('工作台会话目录不能链接到其他目录');
  for (const dir of ['sessions', 'archived_sessions', 'sqlite']) {
    const target = path.join(home, dir); await fs.mkdir(target, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('工作台会话存储不能链接到其他目录');
  }
  const names = await fs.readdir(sourceHome).catch((e: any) => { if (e.code === 'ENOENT') return []; throw e; });
  // Retain personal CLI configuration and capabilities, never copy auth or history.
  const configs = ['config.toml', 'requirements.toml', 'managed_config.toml', 'AGENTS.md', 'AGENTS.override.md', ...names.filter(n => n.endsWith('.config.toml'))];
  for (const stale of await fs.readdir(home)) if (stale.endsWith('.config.toml') && !configs.includes(stale)) await fs.rm(path.join(home, stale));
  for (const name of configs) await copyConfig(path.join(sourceHome, name), path.join(home, name));
  for (const name of ['skills', 'plugins', 'rules', '.sandbox', '.sandbox-bin', '.sandbox-secrets']) {
    const source = path.join(sourceHome, name), destination = path.join(home, name);
    if (!(await fs.stat(source).catch(() => undefined))?.isDirectory()) continue;
    try { await fs.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // CLI may have created a private capability directory before it existed in
      // the personal profile. Keep that directory instead of deleting its data.
      if ((await fs.lstat(destination)).isSymbolicLink() && await fs.realpath(destination) !== await fs.realpath(source)) throw e;
    }
  }
}

async function locateRollout(root: string, id: string): Promise<string | undefined> {
  for (const item of await fs.readdir(root, { withFileTypes: true }).catch((e: any) => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (item.isSymbolicLink()) continue;
    const file = path.join(root, item.name);
    if (item.isDirectory()) { const found = await locateRollout(file, id); if (found) return found; }
    else if (item.isFile() && item.name.endsWith('-' + id + '.jsonl')) return file;
  }
}

export async function findCodexRollout(home: string, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return;
  return await locateRollout(path.join(home, 'sessions'), id) || await locateRollout(path.join(home, 'archived_sessions'), id);
}

async function releaseIsolatedNativeCopy(home: string, id: string, resumePath: string) {
  for (const dir of ['sessions', 'archived_sessions']) {
    const copy = await locateRollout(path.join(home, dir), id);
    if (copy && !sameNativePath(copy, resumePath)) await fs.rm(copy, { force: true });
  }
  for (const directory of [path.join(home, 'sqlite'), home]) {
    const names = (await fs.readdir(directory).catch((error: any) => { if (error.code === 'ENOENT') return [] as string[]; throw error; })).filter(name => /^state_\d+\.sqlite$/.test(name));
    for (const name of names) {
      const file = path.join(directory, name);
      let db: DatabaseSync;
      try { db = new DatabaseSync(file, { timeout: 1500 }); }
      catch (error: any) { throw new Error('隔离会话索引正被占用，请先停掉用户端的 Codex 后再继续：' + (error?.message || error)); }
      try {
        const columns = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[];
        if (!columns.some(column => column.name === 'rollout_path')) continue;
        db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(resumePath, id);
      } finally { db.close(); }
    }
  }
}

export async function refreshCodexConfiguration({ home, sourceHome }: Pick<CodexStorage, 'home' | 'sourceHome'>) {
  if (sameNativePath(home, sourceHome)) return; // Shared backend already reads the personal configuration.
  const previous = jobs.get(home) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => initialize(home, sourceHome)); jobs.set(home, job);
  try { await job; } finally { if (jobs.get(home) === job) jobs.delete(home); }
}

export async function prepareCodexStorage(root: string, session: AgentSession, sourceHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))): Promise<CodexStorage> {
  if (session.nativeLive && session.purpose === 'work' && process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE) {
    if (session.networkRoute === 'management') throw new Error('同步 Beta 使用桌面版的网络连接；通过管理端访问的会话请用普通入口');
    const bridge = (await readCodexDesktopBridge(sourceHome))!;
    const resumePath = session.nativeId && await findCodexRollout(sourceHome, session.nativeId);
    if (!resumePath) throw new Error('找不到原 Codex 会话记录，无法关联共享后台');
    return { home: sourceHome, sourceHome, args: [], env: { CODEX_HOME: sourceHome, CODEX_SQLITE_HOME: sourceHome }, resumePath, sharedEndpoint: bridge.endpoint };
  }
  const home = path.resolve(root, 'codex-home');
  await refreshCodexConfiguration({ home, sourceHome });
  let resumePath: string | undefined;
  // A session the user explicitly linked keeps the personal rollout as its only record.
  if (session.nativeLive) {
    if (!session.nativeId || !/^[a-f0-9-]{36}$/i.test(session.nativeId)) throw new Error('原会话标识无效，无法恢复上下文');
    resumePath = await findCodexRollout(sourceHome, session.nativeId);
    if (!resumePath) throw new Error('找不到原会话记录，无法恢复上下文；请恢复原 Codex 会话文件后重试');
    // An earlier resume may have left the same thread id pointing at a private copy.
    // Drop that copy so the next resume continues the personal rollout.
    await releaseIsolatedNativeCopy(home, session.nativeId, resumePath);
  }
  // Account migration copies each owned rollout, not another account's SQLite index.
  // Resume by its explicit file so the CLI can register it in the new private index.
  if (!session.nativeLive && session.nativeId && session.codexNeedsRegistration) {
    resumePath = await locateRollout(path.join(home, 'sessions'), session.nativeId) || await locateRollout(path.join(home, 'archived_sessions'), session.nativeId);
    if (!resumePath) throw new Error('迁移后的原会话记录未找到；请从保留的旧窗口目录恢复对应 Codex 历史后重试');
  }
  // Existing workbench sessions keep the full native history; only copy their own rollout.
  // Leave the original intact: removing entries from the desktop is a separate user action.
  if (!session.nativeLive && session.nativeId && session.codexStorage !== 'workbench') {
    if (!/^[a-f0-9-]{36}$/i.test(session.nativeId)) throw new Error('原会话标识无效，无法恢复上下文');
    const source = await locateRollout(path.join(sourceHome, 'sessions'), session.nativeId) || await locateRollout(path.join(sourceHome, 'archived_sessions'), session.nativeId);
    if (!source) throw new Error('找不到原会话记录，无法恢复上下文；请恢复原 Codex 会话文件后重试');
    const rel = path.relative(sourceHome, source), target = path.join(home, rel);
    if (!inside(home, target)) throw new Error('原会话路径无效');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target); resumePath = target;
  }
  const sqlite = path.join(home, 'sqlite');
  return { home, sourceHome, resumePath, env: { CODEX_HOME: home, CODEX_SQLITE_HOME: sqlite }, args: ['app-server', '-c', 'sqlite_home=' + JSON.stringify(sqlite), '-c', 'cli_auth_credentials_store="ephemeral"'] };
}
