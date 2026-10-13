import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { NativeSessionCatalog, NativeSessionEntry, NativeSessionGroup } from '../shared/native-sessions';
import { findCodexRollout } from './codex-storage';
import { nativeCwd } from './native-transcript';

const nativeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const codexHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
export const cursorChatsRoot = () => path.resolve(process.env.WORKBENCH_CURSOR_CHATS || path.join(os.homedir(), '.cursor', 'chats'));

function inside(root: string, file: string) {
  const rel = path.relative(nativeCwd(root), nativeCwd(file));
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

export function nativeRecordAllowed(provider: 'codex' | 'cursor', nativePath: string) {
  if (!nativePath) return false;
  if (provider === 'codex') return inside(path.join(codexHome(), 'sessions'), nativePath) || inside(path.join(codexHome(), 'archived_sessions'), nativePath);
  return inside(cursorChatsRoot(), nativePath);
}

async function continuationBlock(cwd: string) {
  const directory = nativeCwd(cwd);
  if (!directory) return '没有工作目录，无法在工作台继续';
  if (!(await fs.stat(directory).catch(() => undefined))?.isDirectory()) return '工作目录已经不在，无法在工作台继续';
}

export function nativeSessionName(name?: string | null, title?: string | null) {
  const short = (name || '').replace(/\s+/g, ' ').trim();
  if (short) return short.slice(0, 120);
  const line = (title || '').trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() || '';
  return (line || '未命名会话').slice(0, 120);
}

function openReadOnly(file: string) {
  try { return new DatabaseSync(file, { readOnly: true, timeout: 1500 }); }
  catch (error: any) { throw new Error('会话索引暂时读不了：' + (error?.message || error)); }
}

async function codexStateFile(home: string) {
  const names = (await fs.readdir(home).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^state_\d+\.sqlite$/.test(name));
  names.sort((left, right) => Number(left.match(/\d+/)![0]) - Number(right.match(/\d+/)![0]));
  return names.length ? path.join(home, names[names.length - 1]) : undefined;
}

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const pathKey = (value: string) => process.platform === 'win32' ? nativeCwd(value).toLowerCase() : nativeCwd(value);

async function codexProjects(db: DatabaseSync, home: string) {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  const projects = new Map<string, NativeSessionGroup>();
  const roots: { projectId: string; path: string }[] = [];
  const aliases = new Map<string, string>();
  if (tables.has('projects')) for (const row of db.prepare('SELECT id, name, position FROM projects').all() as { id: string; name: string; position: number }[]) {
    if (row.name?.trim()) projects.set(row.id, { id: row.id, name: row.name.trim(), position: Number(row.position) || 0, kind: 'project' });
  }
  if (tables.has('project_roots')) for (const row of db.prepare('SELECT project_id, path FROM project_roots').all() as { project_id: string; path: string }[]) {
    if (projects.has(row.project_id) && row.path?.trim()) roots.push({ projectId: row.project_id, path: pathKey(row.path) });
  }
  if (tables.has('project_idempotency_keys')) for (const row of db.prepare('SELECT key, project_id FROM project_idempotency_keys').all() as { key: string; project_id: string }[]) {
    if (projects.has(row.project_id)) aliases.set(row.key, row.project_id);
  }
  // Desktop migrations can populate projects before moving thread membership into SQLite.
  // Read only the project fields in this Codex home's state; never write or expose the state.
  let desktop: Record<string, any> = {};
  try { desktop = record(JSON.parse(await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8'))); }
  catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const migrations = record(desktop['app-server-project-id-by-legacy-project-id-by-host']);
  for (const [host, mappings] of Object.entries(migrations)) if (host.startsWith('local:') && pathKey(host.slice(6)) === pathKey(home)) {
    for (const [legacyId, id] of Object.entries(record(mappings))) if (typeof id === 'string' && projects.has(id)) aliases.set(legacyId, id);
  }
  const order = Array.isArray(desktop['project-order']) ? desktop['project-order'] : [];
  for (const [legacyId, value] of Object.entries(record(desktop['local-projects']))) {
    const project = record(value); if (typeof project.name !== 'string' || !project.name.trim()) continue;
    const id = aliases.get(legacyId) || legacyId;
    aliases.set(legacyId, id);
    const position = order.indexOf(legacyId);
    if (!projects.has(id)) projects.set(id, { id, name: project.name.trim(), position: position < 0 ? projects.size : position, kind: 'project' });
    else if (position >= 0) projects.get(id)!.position = position;
    for (const root of Array.isArray(project.rootPaths) ? project.rootPaths : []) if (typeof root === 'string' && root.trim()) roots.push({ projectId: id, path: pathKey(root) });
  }
  const assignments = record(desktop['thread-project-assignments']);
  const projectless = new Set(Array.isArray(desktop['projectless-thread-ids']) ? desktop['projectless-thread-ids'] : []);
  const hints = record(desktop['thread-workspace-root-hints']);
  const groupFor = (thread: { id: string; project_id: string | null; cwd: string | null }) => {
    if (thread.project_id && projects.has(thread.project_id)) return thread.project_id;
    if (Object.hasOwn(assignments, thread.id)) {
      const assignment = record(assignments[thread.id]);
      const id = aliases.get(assignment.projectId) || assignment.projectId;
      return assignment.projectKind === 'local' && projects.has(id) ? id : undefined;
    }
    if (projectless.has(thread.id) || thread.project_id) return undefined;
    const cwd = thread.cwd?.trim() || (typeof hints[thread.id] === 'string' ? hints[thread.id] : '');
    if (!cwd) return undefined;
    const directory = pathKey(cwd);
    const matches = roots.filter(root => { const relative = path.relative(root.path, directory); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); });
    const longest = Math.max(-1, ...matches.map(root => root.path.length));
    const ids = new Set(matches.filter(root => root.path.length === longest).map(root => root.projectId));
    // A shared root alone cannot decide which of two projects owns a chat.
    return ids.size === 1 ? [...ids][0] : undefined;
  };
  return { projects: [...projects.values()], groupFor };
}

async function listCodex(home: string, linked: Map<string, string>): Promise<NativeSessionCatalog> {
  const state = await codexStateFile(home);
  if (!state) return { provider: 'codex', groups: [], sessions: [] };
  const db = openReadOnly(state);
  try {
    const { projects, groupFor } = await codexProjects(db, home);
    const sections = db.prepare('SELECT id, name FROM thread_sections').all() as { id: string; name: string | null }[];
    const threads = db.prepare('SELECT id, name, title, first_user_message, cwd, project_id, thread_section_id, archived, recency_at_ms, model FROM threads').all() as { id: string; name: string | null; title: string | null; first_user_message: string | null; cwd: string | null; project_id: string | null; thread_section_id: string | null; archived: number | null; recency_at_ms: number | null; model: string | null }[];
    const sectionNames = new Map(sections.map(section => [section.id, (section.name || '').trim()]));
    const groups: NativeSessionGroup[] = [];
    const sessions: (NativeSessionEntry & { model?: string; nativePath?: string })[] = [];
    groups.push(...projects);
    let sectionPosition = -1_000_000;
    for (const section of sections) {
      const name = (section.name || '').trim();
      if (name) groups.push({ id: 'section:' + section.id, name, position: sectionPosition++, kind: 'section' });
    }
    for (const thread of threads) {
      if (thread.archived) continue;
      if (!nativeIdPattern.test(thread.id)) continue;
      const rollout = await findCodexRollout(home, thread.id);
      if (!rollout || !nativeRecordAllowed('codex', rollout)) continue;
      let groupId = groupFor(thread);
      if (!groupId && thread.thread_section_id && sectionNames.get(thread.thread_section_id)) groupId = 'section:' + thread.thread_section_id;
      sessions.push({
        nativeId: thread.id, name: nativeSessionName(thread.name, thread.title || thread.first_user_message), groupId,
        cwd: thread.cwd || '', updatedAt: Number(thread.recency_at_ms) || 0, linkedSessionId: linked.get(thread.id), unavailable: await continuationBlock(thread.cwd || ''),
        model: thread.model || undefined, nativePath: rollout,
      });
    }
    const used = new Set(sessions.map(session => session.groupId).filter(Boolean));
    return { provider: 'codex', groups: groups.filter(group => used.has(group.id)).sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, 'zh-CN')), sessions: sessions.map(({ nativeId, name, groupId, cwd, updatedAt, linkedSessionId, unavailable }) => ({ nativeId, name, groupId, cwd, updatedAt, linkedSessionId, ...(unavailable ? { unavailable } : {}) })) };
  } finally { db.close(); }
}

async function cursorTitle(file: string) {
  try {
    const meta = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!meta || typeof meta !== 'object') return { title: '', cwd: '', updatedAt: 0, hasConversation: false };
    const title = typeof meta.title === 'string' ? meta.title : '';
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
    const updatedAt = Number(meta.updatedAtMs) || Number(meta.createdAtMs) || 0;
    return { title, cwd, updatedAt, hasConversation: meta.hasConversation !== false || !!title.trim() };
  } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return { title: '', cwd: '', updatedAt: 0, hasConversation: false }; }
}

async function listCursor(root: string, linked: Map<string, string>): Promise<NativeSessionCatalog> {
  const groups = new Map<string, NativeSessionGroup>();
  const sessions: NativeSessionEntry[] = [];
  const hashes = await fs.readdir(root, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const hash of hashes) {
    if (!hash.isDirectory() || hash.isSymbolicLink()) continue;
    const hashDir = path.join(root, hash.name);
    const children = await fs.readdir(hashDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || !nativeIdPattern.test(child.name)) continue;
      const directory = path.join(hashDir, child.name);
      if (!nativeRecordAllowed('cursor', directory)) continue;
      const meta = await cursorTitle(path.join(directory, 'meta.json'));
      if (!meta.hasConversation && !meta.title.trim()) continue;
      const cwd = meta.cwd.trim();
      let groupId: string | undefined;
      if (cwd) {
        groupId = cwd;
        const current = groups.get(cwd);
        const position = -(meta.updatedAt || 0);
        if (!current || position < current.position) groups.set(cwd, { id: cwd, name: cwd, position, kind: 'workspace' });
      }
      sessions.push({ nativeId: child.name, name: nativeSessionName(meta.title, ''), groupId, cwd, updatedAt: meta.updatedAt, linkedSessionId: linked.get(child.name), unavailable: await continuationBlock(cwd) });
    }
  }
  return { provider: 'cursor', groups: [...groups.values()].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, 'zh-CN')), sessions };
}

export async function listNativeSessions(provider: 'codex' | 'cursor', linked = new Map<string, string>()): Promise<NativeSessionCatalog> {
  return provider === 'codex' ? listCodex(codexHome(), linked) : listCursor(cursorChatsRoot(), linked);
}

export async function resolveNativeSession(provider: 'codex' | 'cursor', nativeId: string) {
  if (provider === 'codex') {
    const home = codexHome();
    const state = await codexStateFile(home);
    if (!state) return;
    const db = openReadOnly(state);
    try {
      const thread = db.prepare('SELECT id, name, title, first_user_message, cwd, model, archived FROM threads WHERE id = ?').get(nativeId) as { id: string; name: string | null; title: string | null; first_user_message: string | null; cwd: string | null; model: string | null; archived: number | null } | undefined;
      if (!thread || thread.archived) return;
      const nativePath = await findCodexRollout(home, nativeId);
      if (!nativePath) return;
      const model = thread.model && thread.model.length <= 256 && /^[^\x00-\x1f]+$/.test(thread.model) ? thread.model : undefined;
      return { nativeId, name: nativeSessionName(thread.name, thread.title || thread.first_user_message), cwd: nativeCwd(thread.cwd || ''), model, nativePath };
    } finally { db.close(); }
  }
  const root = cursorChatsRoot();
  const hashes = await fs.readdir(root, { withFileTypes: true }).catch((error: any) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const hash of hashes) {
    if (!hash.isDirectory() || hash.isSymbolicLink()) continue;
    const directory = path.join(root, hash.name, nativeId);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
      if (!meta || typeof meta !== 'object') continue;
      const cwd = nativeCwd(typeof meta.cwd === 'string' ? meta.cwd : '');
      return { nativeId, name: nativeSessionName(typeof meta.title === 'string' ? meta.title : '', ''), cwd, nativePath: directory };
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}
