import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store';
import { settingsSchema } from './config';

export interface AccountMigration {
  version: number; owner: string; completedAt: string; sources: string[]; counts: number[];
  recordIds?: string[][]; conflicts?: unknown[]; recoveredAt?: string;
}
type Copy = (source: string, target: string) => Promise<void>;
const recordNames = ['sessions', 'drafts', 'transfers', 'conclusions'] as const;
const allowedFiles = new Set(['settings.json', 'inputs.json', 'migration.json', 'rsi-v2.json', ...recordNames.map(name => name + '.json')]);
const journalName = 'account-recovery.pending.json';
async function read<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return fallback; throw new Error('无法恢复本地账号资料，原文件已保留：' + file); }
}
async function records(directory: string, name: string) {
  const value = await read<any[]>(path.join(directory, name + '.json'), []);
  if (!Array.isArray(value)) throw new Error('本地资料格式错误：' + path.join(directory, name + '.json'));
  return value;
}

/** Runs before the account store opens. An interrupted multi-file repair is replayed
 * before exposing the dataset, so edits/deletions made later can never be replayed over. */
export async function resumeAccountRecovery(destination: string, owner: string, copy: Copy) {
  const journal = await read<{ owner: string; staging: string; backup: string; backupFiles: string[]; files: Record<string, unknown> } | undefined>(path.join(destination, journalName), undefined);
  if (!journal) return;
  const staging = path.resolve(journal.staging), prefix = path.resolve(destination) + '.migrating-';
  if (journal.owner !== owner || !staging.startsWith(prefix) || path.dirname(staging) !== path.dirname(path.resolve(destination)) || !/^[a-f0-9-]{36}$/.test(journal.backup) || !journal.files || Object.keys(journal.files).some(name => !allowedFiles.has(name)) || (journal.files['migration.json'] as AccountMigration)?.owner !== owner || !Array.isArray(journal.backupFiles) || journal.backupFiles.some(name => !Object.hasOwn(journal.files, name))) throw new Error('账号恢复记录无效，原目录已保留');
  const backup = path.join(destination, 'migrations', 'window-recovery-' + journal.backup);
  for (const name of journal.backupFiles) await copy(path.join(destination, name), path.join(backup, name));
  // No credentials or another account's files. Existing attachments are never overwritten.
  for (const name of ['sessions', 'drafts', 'packages', 'uploads', 'accounts', 'codex-home']) await copy(path.join(staging, name), path.join(destination, name));
  for (const [name, data] of Object.entries(journal.files).filter(([name]) => name !== 'migration.json')) await atomicJson(path.join(destination, name), data);
  await atomicJson(path.join(destination, 'migration.json'), journal.files['migration.json']);
  await fs.unlink(path.join(destination, journalName));
  // Retain staging and pre-repair JSON as recovery evidence; neither is a migration source.
}

export async function recoverAccountWindows(destination: string, owner: string, staging: string, prior: AccountMigration, copy: Copy) {
  const incoming = await read<AccountMigration>(path.join(staging, 'migration.json'), undefined as never);
  const known = recordNames.map((_, index) => new Set(prior.recordIds?.[index] || []));
  // v1 manifests had counts but no imported IDs. The old windows are untouched
  // backups: use them to avoid resurrecting a previously imported, then deleted record.
  if (!prior.recordIds) for (const source of prior.sources) for (const [index, name] of recordNames.entries()) {
    for (const record of await records(source, name)) known[index].add(record.id);
  }
  const files: Record<string, any> = {}, before: Record<string, any> = {}, added: string[][] = [];
  for (const [index, name] of recordNames.entries()) {
    const current = await records(destination, name), existingIds = new Set(current.map(item => item.id));
    before[name + '.json'] = current;
    const candidates = await records(staging, name);
    const additions = candidates.filter(item => !existingIds.has(item.id) && !known[index].has(item.id));
    if (name === 'drafts') {
      const sessionIds = new Set(files['sessions.json'].map((item: any) => item.id));
      // Do not recreate a draft for an explicitly deleted parent session.
      for (let index = additions.length - 1; index >= 0; index--) if (known[0].has(additions[index].sessionId) && !sessionIds.has(additions[index].sessionId)) additions.splice(index, 1);
    }
    added[index] = additions.map(item => item.id);
    files[name + '.json'] = [...current, ...additions];
    for (const item of [...current, ...candidates]) known[index].add(item.id);
  }
  const settings = await read<any>(path.join(destination, 'settings.json'), {}), recovered = await read<any>(path.join(staging, 'settings.json'), {});
  before['settings.json'] = settings;
  files['settings.json'] = settingsSchema.parse({ ...settings,
    projectDirectories: { ...recovered.projectDirectories, ...settings.projectDirectories },
  });
  const inputs = await read<Record<string, unknown>>(path.join(destination, 'inputs.json'), {}), recoveredInputs = await read<Record<string, unknown>>(path.join(staging, 'inputs.json'), {});
  before['inputs.json'] = inputs;
  files['inputs.json'] = { ...inputs, ...Object.fromEntries(added[0].filter(id => recoveredInputs[id] && !Object.hasOwn(inputs, id)).map(id => [id, recoveredInputs[id]])) };
  const rsi = await read<any>(path.join(staging, 'rsi-v2.json'), undefined);
  if (rsi) {
    const current = await read<any>(path.join(destination, 'rsi-v2.json'), undefined);
    before['rsi-v2.json'] = current;
    files['rsi-v2.json'] = current ? { ...current, projects: { ...rsi.projects, ...current.projects }, preferences: { ...rsi.preferences, ...current.preferences } } : rsi;
  }
  files['migration.json'] = { ...prior, version: 2, sources: [...new Set([...prior.sources, ...incoming.sources])], recordIds: known.map(ids => [...ids]), counts: recordNames.map(name => files[name + '.json'].length), recoveredAt: new Date().toISOString() };
  for (const name of Object.keys(files)) if (JSON.stringify(files[name]) === JSON.stringify(before[name])) delete files[name];
  // Record original presence before writing: a retry must not back up a newly
  // created partial file as if it were present before the repair.
  const backupFiles: string[] = [];
  for (const name of Object.keys(files)) if (await fs.stat(path.join(destination, name)).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; })) backupFiles.push(name);
  // Write the complete plan first; no account file is replaced until every source is valid.
  await atomicJson(path.join(destination, journalName), { owner, staging, backup: randomUUID(), backupFiles, files });
  await resumeAccountRecovery(destination, owner, copy);
}
