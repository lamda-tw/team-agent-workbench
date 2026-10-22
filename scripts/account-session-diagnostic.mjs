import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const identity = profile => profile && JSON.stringify([profile.host?.toLowerCase(), profile.port, profile.username, profile.fingerprint]);
const summary = profile => profile && ({ host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, key: createHash('sha256').update(identity(profile)).digest('hex') });
const personal = session => session.binding?.connectionId === '__personal__' && session.binding.host === 'personal' && session.binding.fingerprint === 'PERSONAL';
const count = sessions => ({ sessions: sessions.length, nativeLinked: sessions.filter(session => session.nativeId || session.nativeSourceId).length, closed: sessions.filter(session => session.closedAt).length, messages: sessions.reduce((total, session) => total + (session.messages?.length || 0), 0) });
async function json(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('无法读取：' + file); }
}
// Read-only metadata report. Never include prompts, replies, tokens, passwords or CLI history.
export async function diagnoseAccountSessions(root, username) {
  root = path.resolve(root);
  await fs.access(root);
  const directories = [root, path.join(root, 'personal')];
  for (const name of ['instances', 'window-state', 'account-workspaces']) {
    const entries = await fs.readdir(path.join(root, name), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    directories.push(...entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && (name === 'account-workspaces' ? /^[a-f0-9]{64}$/.test(entry.name) : /^[1-9]\d*$/.test(entry.name))).map(entry => path.join(root, name, entry.name)));
  }
  const datasets = [], inventory = [], errors = [];
  for (const directory of directories) {
    try {
      const settings = await json(path.join(directory, 'settings.json'), {}), sessions = await json(path.join(directory, 'sessions.json'), []);
      if (!Array.isArray(sessions)) throw new Error('会话索引不是列表：' + directory);
      const profile = (settings.workspaceSnapshot || settings.offlineAuthorization)?.profile;
      const mine = sessions.filter(session => session.binding?.username === username);
      const local = sessions.filter(personal), unbound = sessions.filter(session => !session.binding);
      const stat = await fs.stat(path.join(directory, 'sessions.json')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      inventory.push({ directory: path.relative(root, directory) || '.', indexExists: !!stat, bytes: stat?.size, updatedAt: stat?.mtime.toISOString(), totalSessions: sessions.length, matchedAccount: mine.length, localSessions: local.length, unboundSessions: unbound.length });
      if (profile?.username !== username && !mine.length && !local.length && !unbound.length) continue;
      const groups = new Map();
      for (const session of mine) {
        const key = identity(session.binding);
        if (!groups.has(key)) groups.set(key, { account: summary(session.binding), sessions: 0, nativeLinked: 0, closed: 0, messages: 0, missingProject: 0, outdatedGroup: 0 });
        const item = groups.get(key), project = profile?.projects?.find(project => project.id === session.binding?.project?.id);
        item.sessions++; if (session.nativeId || session.nativeSourceId) item.nativeLinked++; if (session.closedAt) item.closed++;
        item.messages += session.messages?.length || 0;
        if (!project) item.missingProject++; else if (project.groupName !== session.binding.project.groupName) item.outdatedGroup++;
      }
      const migration = await json(path.join(directory, 'migration.json'), undefined);
      datasets.push({ directory: path.relative(root, directory) || '.', currentAccount: summary(profile), groups: [...groups.values()], local: count(local), unbound: count(unbound), migration: migration && { version: migration.version, counts: migration.counts, sources: migration.sources?.map(source => path.relative(root, source) || '.'), recoveredAt: migration.recoveredAt } });
    } catch (error) { errors.push(error.message); }
  }
  return { root, username, inventory, datasets, errors, notice: '只读检查；本机会话属于当前 Windows 用户，不据此认定为指定的 SSH 账号。仅输出索引统计和连接标识，不导出对话正文、密码或令牌，不修改任何记录。' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  const root = args.includes('--root') ? value('--root') : process.env.WORKBENCH_DATA_DIR || (process.env.APPDATA && path.join(process.env.APPDATA, 'TeamAgentUser'));
  const username = args.includes('--account') ? value('--account') : undefined;
  if (!root || root.startsWith('--') || !username || username.startsWith('--')) throw new Error('用法：node scripts/account-session-diagnostic.mjs --account taowen [--root 本地数据目录]');
  void diagnoseAccountSessions(root, username).then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error.message); process.exitCode = 1; });
}
