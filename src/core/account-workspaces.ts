import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { accountIdentity } from '../shared/account-data';
import { ownsBinding } from '../shared/account-scope';
import { projectDirectoryKey } from '../shared/project-directory';
import type { AgentSession, ConnectionProfile, Draft, ProjectConclusion, Settings, Transfer } from '../shared/types';
import { atomicJson } from './store';
import { settingsSchema } from './config';
import { recoverAccountWindows, resumeAccountRecovery, type AccountMigration } from './account-workspace-recovery';

export const accountDirectory = (root: string, profile: ConnectionProfile) => path.join(root, 'account-workspaces', createHash('sha256').update(accountIdentity(profile)).digest('hex'));
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return fallback; throw new Error('无法读取本地账号资料，原文件已保留：' + file); }
}
export async function legacyWindowRoots(root: string) {
  const directories = [root];
  for (const name of ['instances', 'window-state']) {
    const parent = path.join(root, name);
    const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
    directories.push(...entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[1-9]\d*$/.test(entry.name)).sort((a, b) => Number(a.name) - Number(b.name)).map(entry => path.join(parent, entry.name)));
  }
  return directories;
}
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
async function copy(source: string, target: string) {
  const stat = await fs.lstat(source).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stat || stat.isSymbolicLink()) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false, filter: async file => !(await fs.lstat(file)).isSymbolicLink() });
}

/** Publish a complete account dataset once. Legacy windows remain an untouched backup.
 * The process-wide pool serializes callers; Electron's userData lock excludes another writer.
 * A failed import leaves only a staging directory and can be retried without trusting partial data.
 */
export async function migrateAccountWorkspace(root: string, profile: ConnectionProfile, seedRoot?: string) {
  const destination = accountDirectory(root, profile), owner = accountIdentity(profile);
  await resumeAccountRecovery(destination, owner, copy);
  const existing = await json<AccountMigration | undefined>(path.join(destination, 'migration.json'), undefined);
  if (existing && existing.owner !== owner) throw new Error('账号数据目录身份不匹配');
  if (!existing && await fs.stat(destination).catch(() => undefined)) throw new Error('账号数据目录缺少迁移记录，请保留目录后检查：' + destination);
  const normalize = (directory: string) => process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  const scanned = new Set(existing?.sources.map(normalize));
  const directories = (await legacyWindowRoots(root)).filter(directory => !scanned.has(normalize(directory)));
  if (existing && !directories.length) return destination;
  const staging = destination + '.migrating-' + randomUUID();
  await fs.mkdir(staging, { recursive: true });
  const sources = await Promise.all(directories.map(async directory => {
    const raw = await json<any>(path.join(directory, 'settings.json'), undefined);
    if (raw?.offlineAuthorization && !raw.workspaceSnapshot) raw.workspaceSnapshot = raw.offlineAuthorization;
    const settings = raw ? settingsSchema.parse(raw) : undefined;
    const records = await Promise.all(['sessions', 'drafts', 'transfers', 'conclusions'].map(async name => {
      const data = await json<any[]>(path.join(directory, name + '.json'), []);
      if (!Array.isArray(data)) throw new Error('本地资料格式错误：' + path.join(directory, name + '.json'));
      return data;
    }));
    const modified = Math.max(...await Promise.all(['settings', 'sessions', 'drafts', 'conclusions'].map(name => fs.stat(path.join(directory, name + '.json')).then(stat => stat.mtimeMs).catch(() => 0))));
    return { directory, settings, records, modified };
  }));
  sources.sort((a, b) => b.modified - a.modified);
  const sameAccount = sources.filter(source => source.settings?.workspaceSnapshot && accountIdentity(source.settings.workspaceSnapshot.profile) === owner);
  const extraSeed = seedRoot ? await json<Settings | undefined>(path.join(seedRoot, 'settings.json'), undefined) : undefined;
  const seed = sameAccount[0] || sources.find(source => source.directory === seedRoot) || (extraSeed ? { directory: seedRoot!, settings: extraSeed } : undefined);
  const settings: Settings = settingsSchema.parse({ providerPaths: seed?.settings?.providerPaths || { codex: '', cursor: '', claude: '' }, lastWorkspace: '', autoUploadMinutes: seed?.settings?.autoUploadMinutes, sidebarProjectHeight: seed?.settings?.sidebarProjectHeight, trustedServerIdentities: seed?.settings?.trustedServerIdentities || {}, egress: seed?.settings?.egress, connections: [profile], workspaceSnapshot: sameAccount[0]?.settings?.workspaceSnapshot });
  if (settings.workspaceSnapshot) Object.assign(settings.workspaceSnapshot.profile, { id: profile.id, host: profile.host });
  settings.projectDirectories = {}; settings.contentAliases = {}; settings.contentSeen = {}; settings.contentUpdates = []; settings.dismissedContentUpdateIds = [];
  const hash = path.basename(destination), prefix = `${profile.id}:${profile.username}:`;
  // Only the last verified owner can claim unlabelled settings or old personal results.
  for (const source of [...sources].reverse()) {
    if (!sameAccount.includes(source)) {
      // An old account switch put unsynchronized aliases/activity in its own snapshot.
      const pending = await json<Record<string, any>>(path.join(source.directory, 'accounts', hash + '.json.pending'), {});
      for (const [key, value] of Object.entries(pending)) {
        if (key.startsWith('alias:') && typeof value === 'string') settings.contentAliases[key.slice(6)] = value;
        else if (key.startsWith('seen:') && value) settings.contentSeen[prefix + key.slice(5)] = value;
        else if (key.startsWith('update:') && value) { const eventId = prefix + key.slice(7); settings.contentUpdates = [...settings.contentUpdates.filter(item => item.eventId !== eventId), { ...value, eventId }]; }
        else if (key.startsWith('dismissed:') && value) settings.dismissedContentUpdateIds.push(prefix + key.slice(10));
      }
      continue;
    }
    const old = source.settings!;
    Object.assign(settings.contentAliases, old.contentAliases);
    Object.assign(settings.contentSeen, old.contentSeen);
    settings.contentUpdates = [...new Map([...settings.contentUpdates!, ...(old.contentUpdates || [])].map(item => [item.eventId, item])).values()];
    settings.dismissedContentUpdateIds = [...new Set([...settings.dismissedContentUpdateIds!, ...(old.dismissedContentUpdateIds || [])])];
    settings.localWorkspace = old.localWorkspace; settings.verifiedLocalWorkspace = old.verifiedLocalWorkspace; settings.lastWorkspace = old.lastWorkspace;
  }
  for (const source of [...sources].reverse()) {
    for (const project of profile.projects) {
      const key = projectDirectoryKey(profile, project.id), directory = source.settings?.projectDirectories?.[key];
      if (directory !== undefined) settings.projectDirectories[key] = directory;
    }
  }
  const rekey = (key: string) => key.replace(new RegExp('^[^:]+:' + profile.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'), prefix);
  settings.contentUpdates = [...new Map(settings.contentUpdates!.map(item => [rekey(item.eventId), { ...item, eventId: rekey(item.eventId) }])).values()];
  settings.contentSeen = Object.fromEntries(Object.entries(settings.contentSeen!).map(([key, value]) => [rekey(key), value]));
  settings.dismissedContentUpdateIds = [...new Set(settings.dismissedContentUpdateIds!.map(rekey))];
  const selected = [new Map<string, AgentSession>(), new Map<string, Draft>(), new Map<string, Transfer>(), new Map<string, ProjectConclusion>()] as const;
  const inputs: Record<string, unknown> = {}, conflicts: { kind: string; id: string; source: string }[] = [];
  const ids = new Set<string>();
  for (const source of sources) for (const session of source.records[0] as AgentSession[]) if (ownsBinding(profile, session.binding)) ids.add(session.id);
  for (const source of sources) {
    const sourceOwner = source.settings?.workspaceSnapshot?.profile;
    const belongs = (record: any, kind: number) => kind === 3 ? (record.accountOwner || (sourceOwner && accountIdentity(sourceOwner))) === owner : record.binding ? ownsBinding(profile, record.binding) : kind === 1 && ids.has(record.sessionId);
    const selectedIds: string[][] = [[], [], [], []];
    const remap = async (value: any, key = ''): Promise<any> => {
      if (Array.isArray(value)) return Promise.all(value.map(item => remap(item, key)));
      if (value && typeof value === 'object') {
        const imported = Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await remap(v, k)])));
        if (key === 'binding' && ownsBinding(profile, value)) Object.assign(imported, { connectionId: profile.id, host: profile.host });
        return imported;
      }
      // Never rewrite prompts, message text, source labels or user code directories.
      if (typeof value === 'string' && ['localPath', 'inputDir', 'outputPath', 'handoffPath', 'nativePath', 'outputFiles'].includes(key) && path.isAbsolute(value) && inside(source.directory, value)) {
        const relative = path.relative(source.directory, value);
        if (['sessions', 'drafts', 'packages', 'uploads', 'accounts', 'codex-home'].includes(relative.split(path.sep)[0])) {
          await copy(value, path.join(staging, relative)); return path.join(destination, relative);
        }
      }
      // Preparation sessions run inside their draft directory; user workspaces stay in place.
      if (key === 'cwd' && typeof value === 'string' && inside(path.join(source.directory, 'drafts'), value)) return path.join(destination, path.relative(source.directory, value));
      return value;
    };
    for (let kind = 0; kind < selected.length; kind++) for (const record of source.records[kind]) {
      if (!belongs(record, kind)) continue;
      if (!/^[a-f0-9-]{36}$/i.test(record.id)) throw new Error('旧资料包含无效标识，已保留原文件：' + source.directory);
      if (selected[kind].has(record.id)) { conflicts.push({ kind: ['session', 'draft', 'transfer', 'conclusion'][kind], id: record.id, source: source.directory }); continue; }
      const imported = await remap(record);
      if (kind === 3) imported.accountOwner = owner;
      (selected[kind] as Map<string, any>).set(record.id, imported); selectedIds[kind].push(record.id);
    }
    for (const id of selectedIds[0]) await copy(path.join(source.directory, 'sessions', id), path.join(staging, 'sessions', id));
    for (const id of selectedIds[1]) await copy(path.join(source.directory, 'drafts', id), path.join(staging, 'drafts', id));
    const oldInputs = await json<Record<string, unknown>>(path.join(source.directory, 'inputs.json'), {});
    for (const id of selectedIds[0]) if (oldInputs[id]) inputs[id] = oldInputs[id];
    // Native Codex history belongs to the session, never to the window's latest login.
    const nativeSessions = selectedIds[0].map(id => selected[0].get(id)!).filter(session => session.provider === 'codex' && session.nativeId && session.codexStorage === 'workbench');
    for (const session of nativeSessions) session.codexNeedsRegistration = true;
    const nativeIds = new Map(nativeSessions.map(session => [session.nativeId!, session]));
    async function rollouts(directory: string) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await rollouts(file);
        else for (const [id, session] of nativeIds) if (entry.name.endsWith('-' + id + '.jsonl') || entry.name.endsWith('-' + id + '.jsonl.zst')) {
          const relative = path.relative(source.directory, file); await copy(file, path.join(staging, relative)); session.nativePath = path.join(destination, relative);
        }
      }
    }
    if (nativeIds.size) for (const name of ['sessions', 'archived_sessions']) await rollouts(path.join(source.directory, 'codex-home', name));
  }
  // Keep the latest merge base, so remote deletions are not mistaken for new local results.
  for (const source of sources) for (const suffix of ['.json', '.json.pending']) await copy(path.join(source.directory, 'accounts', hash + suffix), path.join(staging, 'accounts', hash + suffix));
  if (seed) await copy(path.join(seed.directory, 'egress-access.bin'), path.join(staging, 'egress-access.bin'));
  // Learned policies and their evidence are account data, never installation defaults.
  const rsi: any = { version: 3, projects: {}, preferences: {} };
  for (const source of sources) {
    const saved = await json<any>(path.join(source.directory, 'rsi-v2.json'), undefined);
    if (!saved) continue;
    if (![2, 3].includes(saved.version)) throw new Error('AI推荐数据版本不兼容，原目录已保留');
    for (const [key, project] of Object.entries(saved.projects || {}) as [string, any][]) {
      if (project.scope?.account !== owner) continue;
      const prior = rsi.projects[key];
      if (!prior || project.revision > prior.revision) rsi.projects[key] = project;
    }
    if (!rsi.preferences[owner] && saved.preferences?.[owner]) rsi.preferences[owner] = saved.preferences[owner];
  }
  if (Object.keys(rsi.projects).length) await atomicJson(path.join(staging, 'rsi-v2.json'), rsi);
  await atomicJson(path.join(staging, 'settings.json'), settingsSchema.parse(settings));
  for (const [index, name] of ['sessions', 'drafts', 'transfers', 'conclusions'].entries()) await atomicJson(path.join(staging, name + '.json'), [...selected[index].values()]);
  await atomicJson(path.join(staging, 'inputs.json'), inputs);
  await atomicJson(path.join(staging, 'migration.json'), { version: 2, owner, completedAt: new Date().toISOString(), sources: sources.map(source => source.directory), counts: selected.map(records => records.size), recordIds: selected.map(records => [...records.keys()]), conflicts });
  if (existing) {
    await recoverAccountWindows(destination, owner, staging, existing, copy);
    return destination;
  }
  // Antivirus and file indexers can briefly hold a newly written directory on Windows.
  // Keep the complete staging tree intact and retry only transient locks.
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(staging, destination); break; }
    catch (error: any) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || await fs.stat(destination).then(() => true).catch(() => false)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
  return destination;
}

/** One owner of mutable state and runtime per account, with reference-counted windows. */
export class AccountWorkspacePool<T> {
  private entries = new Map<string, { value: T; references: number }>();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private create: (profile: ConnectionProfile, seedRoot?: string) => Promise<T>, private close: (value: T) => Promise<void>) {}
  private serial<R>(operation: () => Promise<R>): Promise<R> { const next = this.operations.catch(() => {}).then(operation); this.operations = next; return next; }
  acquire(profile: ConnectionProfile, seedRoot?: string) {
    return this.serial(async () => {
      const key = accountIdentity(profile);
      let entry = this.entries.get(key);
      if (!entry) { entry = { value: await this.create(profile, seedRoot), references: 0 }; this.entries.set(key, entry); }
      entry.references++;
      let released = false;
      return { value: entry.value, release: () => this.serial(async () => {
        if (released) return;
        if (entry!.references === 1) { await this.close(entry!.value); this.entries.delete(key); }
        entry!.references--; released = true;
      }) };
    });
  }
}
