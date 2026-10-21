import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { accountIdentity, accountRecordsSchema, type AccountRecords, type AccountSnapshot, type AccountSyncState } from '../shared/account-data';
import type { ConnectionProfile, Draft, ProjectConclusion } from '../shared/types';
import { Store, atomicJson } from './store';
import type { SharedFiles } from './shared-files';
import { contentAttachmentSchema } from '../shared/content';
import { hashFile } from './artifacts';
import { safeFilename } from './paths';
import { rememberPreparationProgress } from '../shared/preparation-progress';
import { applyConflictText, applyConflictVersion, canonicalSync, mergeSyncValue, verifiableTextMerge, type SyncChoice } from '../shared/sync-conflict';
import { conflictToken, SyncConflicts, type ConflictTextTask } from './sync-conflicts';

const canonical = canonicalSync;
type Resolution = { local: string; remote: string; choice: SyncChoice; value?: unknown };
export function mergeAccountRecords(base: AccountRecords, local: AccountRecords, remote: AccountRecords, choices: Record<string, Resolution> = {}) {
  const records: AccountRecords = {}, conflicts: NonNullable<AccountSyncState['conflicts']> = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[key] ?? null, l = local[key] ?? null, r = remote[key] ?? null;
    if (canonical(l) === canonical(r) || canonical(b) === canonical(r)) records[key] = l;
    else if (canonical(b) === canonical(l)) records[key] = r;
    else if (key.startsWith('update:') && l && r) {
      // A later explicit reopen wins over an earlier completion, while action history is retained.
      const leftTime = Date.parse(l.statusChangedAt || l.readAt || '') || 0, rightTime = Date.parse(r.statusChangedAt || r.readAt || '') || 0;
      const status = leftTime > rightTime ? l : rightTime > leftTime ? r : !l.readAt ? l : r;
      records[key] = { ...r, ...l, readAt: status.readAt, statusChangedAt: status.statusChangedAt, archiveReason: status.archiveReason, unavailableAt: l.unavailableAt || r.unavailableAt, actions: [...new Map([...(r.actions || []), ...(l.actions || [])].map((a: unknown) => [canonical(a), a])).values()] };
    }
    else if (key.startsWith('dismissed:')) records[key] = !!(l || r);
    else if (key.startsWith('seen:') && l && r) records[key] = { ...r, ...l };
    else {
      const resolution = choices[key];
      if (resolution?.local === canonical(l) && resolution.remote === canonical(r)) records[key] = resolution.choice === 'local' ? l : resolution.choice === 'remote' ? r : resolution.value;
      else {
        const result = mergeSyncValue(b, l, r);
        // Version history and update timestamps are bookkeeping; keep both histories
        // while leaving conflicting content, titles and provenance for review.
        if (key.startsWith('material:') && b && l && r) {
          const value = result.value as Record<string, unknown>;
          if (Array.isArray(l.versions) && Array.isArray(r.versions)) {
            value.versions = [...new Map([...r.versions, ...l.versions].map((item: unknown) => [canonical(item), item])).values()];
            result.fields = result.fields.filter(field => canonical(field.path) !== canonical(['versions']));
          }
          if (Number.isFinite(Date.parse(l.updatedAt)) && Number.isFinite(Date.parse(r.updatedAt))) {
            value.updatedAt = Date.parse(l.updatedAt) > Date.parse(r.updatedAt) ? l.updatedAt : r.updatedAt;
            result.fields = result.fields.filter(field => canonical(field.path) !== canonical(['updatedAt']));
          }
          if (Number.isInteger(l.version) && Number.isInteger(r.version)) {
            value.version = Math.max(l.version, r.version);
            result.fields = result.fields.filter(field => canonical(field.path) !== canonical(['version']));
          }
        }
        records[key] = result.value;
        if (result.fields.length) conflicts.push({ key, token: conflictToken(b, l, r), base: b, local: l, remote: r, merged: result.value, fields: result.fields });
      }
    }
  }
  return { records, conflicts };
}

export class AccountSync {
  state: AccountSyncState = { status: 'offline' };
  private profile?: ConnectionProfile;
  private base: AccountRecords = {};
  private timer?: NodeJS.Timeout;
  private polling?: NodeJS.Timeout;
  private running?: Promise<void>;
  private applying = false;
  private stopped = false;
  private generation = 0;
  private resolving = false;
  private choices: Record<string, Resolution> = {};
  readonly conflicts: SyncConflicts;
  constructor(private store: Store, private remote: SharedFiles, private changed: () => void, private reconcile?: () => void, runConflict?: ConflictTextTask) {
    store.saved = () => this.schedule();
    this.conflicts = new SyncConflicts(store.root, () => { this.state.conflicts = this.state.conflicts?.map(value => this.conflicts.view(value)); this.changed(); }, runConflict);
  }
  private file(profile: ConnectionProfile) { return path.join(this.store.root, 'accounts', createHash('sha256').update(accountIdentity(profile)).digest('hex') + '.json'); }
  private owns(draft: Draft, profile: ConnectionProfile) { return !!draft.binding && accountIdentity(draft.binding) === accountIdentity(profile); }
  private collect(profile = this.profile!): AccountRecords {
    const records: AccountRecords = {}, key = accountIdentity(profile), projectIds = new Set(profile.projects.map(project => project.id));
    // Losing group access must never mean deleting the account's existing private records.
    for (const [id, value] of Object.entries(this.base)) if (id.startsWith('draft:') && value && !projectIds.has(value.projectId)) records[id] = value;
    for (const item of this.store.conclusions) if (item.accountOwner === key) { const safeSource = (source: typeof item.sources[number]) => ({ ...source, path: source.path && !/^[A-Za-z]:|^file:/.test(source.path) ? source.path : undefined }); const { localFiles, ...material } = item; const files = localFiles?.map(({ id, name, sha256, size }) => ({ id, name, sha256, size })); records['material:' + item.id] = { ...material, ...(files?.length ? { localFiles: files } : {}), sources: item.sources.map(safeSource), versions: item.versions?.map(version => ({ ...version, sources: version.sources.map(safeSource) })) }; }
    for (const draft of this.store.drafts) if (this.owns(draft, profile)) {
      const selectedFiles = new Set([...(draft.artifacts?.flatMap(item => (item.attachments || []).filter(entry => entry.selected).map(entry => entry.fileId)) || []), ...((draft.attachments || []).filter(entry => entry.selected).map(entry => entry.fileId))]);
      // Account restoration contains reviewed results, never conversations, CLI state or local code paths.
      records['draft:' + draft.id] = { id: draft.id, sessionId: draft.sessionId, sourceSessionTitle: draft.sourceSessionTitle, projectId: draft.binding!.project.id, title: draft.title, titleAlias: draft.titleAlias, body: draft.body, supplement: draft.supplement, artifacts: draft.artifacts?.map(item => ({ ...item, evidenceIds: undefined, attachments: item.attachments?.filter(entry => entry.selected), submitted: item.submitted ? 'restored' : undefined })), attachments: draft.attachments?.filter(entry => entry.selected), personalSavedIds: draft.personalSavedIds, files: draft.files.filter(file => selectedFiles.has(file.id)).map(file => ({ id: file.id, name: file.name, sha256: file.sha256, size: file.size, fetchedAt: file.fetchedAt })), generation: draft.generation === 'running' ? 'error' : draft.generation, createdAt: draft.createdAt, generationFinishedAt: draft.generationFinishedAt, preparationVersion: draft.preparationVersion, emptyResult: draft.emptyResult, resultRules: draft.resultRules, preparationDirections: draft.preparationDirections, resultCategory: draft.resultCategory, resultSourceDetails: draft.resultSourceDetails, mergeProjectId: draft.mergeProjectId, conclusionMergeProjectId: draft.conclusionMergeProjectId, conclusionMergeInstruction: draft.conclusionMergeInstruction, mergeSources: draft.mergeSources, mergeCompletedAt: draft.mergeCompletedAt, mergeResultId: draft.mergeResultId, mergeResultPath: draft.mergeResultPath, submitted: draft.submitted ? 'restored' : undefined };
    }
    for (const [id, alias] of Object.entries(this.store.settings.contentAliases || {})) records['alias:' + id] = alias;
    const prefix = `${profile.id}:${profile.username}:`;
    for (const update of this.store.settings.contentUpdates || []) if (update.eventId.startsWith(prefix)) { const id = update.eventId.slice(prefix.length); records['update:' + id] = { ...update, eventId: id }; }
    for (const [id, seen] of Object.entries(this.store.settings.contentSeen || {})) if (id.startsWith(prefix)) records['seen:' + id.slice(prefix.length)] = seen;
    for (const id of this.store.settings.dismissedContentUpdateIds || []) if (id.startsWith(prefix)) records['dismissed:' + id.slice(prefix.length)] = true;
    return structuredClone(records);
  }
  private apply(records: AccountRecords, profile: ConnectionProfile, preserveLocalFiles: boolean | Set<string> = false) {
    const sources = new Map<string, string | undefined>(preserveLocalFiles ? this.recordFiles(preserveLocalFiles instanceof Set ? Object.fromEntries(Object.entries(records).filter(([key]) => preserveLocalFiles.has(key))) : records).map((file: { sha256: string }) => [file.sha256, this.ownedFile(profile, file.sha256)]) : []);
    const owner = accountIdentity(profile), projectIds = new Set(profile.projects.map(project => project.id));
    // A deletion received from another computer must not erase local progress.
    for (const session of this.store.sessions) rememberPreparationProgress(session, this.store.drafts);
    const materials: ProjectConclusion[] = [];
    for (const [key, value] of Object.entries(records)) {
      if (key.startsWith('material:') && value && typeof value.projectId === 'string' && value.id === key.slice(9) && typeof value.title === 'string' && typeof value.content === 'string' && Array.isArray(value.sources)) {
        const { localFiles: rawFiles, ...rest } = value;
        const localFiles = Array.isArray(rawFiles) ? rawFiles.flatMap((file: { id?: string; name?: string; sha256?: string; size?: number }) => file && typeof file.id === 'string' && typeof file.name === 'string' && typeof file.sha256 === 'string' && typeof file.size === 'number' ? [{ id: file.id, name: file.name, sha256: file.sha256, size: file.size, localPath: sources.get(file.sha256) || this.blobPath(file as { name: string; sha256: string; size: number }) }] : []) : [];
        const next = { ...rest, accountOwner: owner, ...(localFiles.length ? { localFiles } : {}) } as ProjectConclusion;
        const existing = this.store.conclusions.find(item => item.id === next.id && item.accountOwner === owner);
        if (existing) {
          // Ongoing local operations may hold this object while awaiting I/O.
          // Preserve its identity so subsequent edits do not land on a detached copy.
          for (const key of Object.keys(existing)) if (!Object.hasOwn(next, key)) delete (existing as any)[key];
          Object.assign(existing, next); materials.push(existing);
        } else materials.push(next);
      }
      if (key.startsWith('draft:') && value && projectIds.has(value.projectId) && /^[a-f0-9-]{36}$/.test(value.id) && value.id === key.slice(6) && typeof value.body === 'string') {
        const project = profile.projects.find(project => project.id === value.projectId)!;
        const existing = this.store.drafts.find(draft => draft.id === value.id), inputDir = path.join(this.store.root, 'drafts', value.id, 'input');
        const restored: Draft = { ...value, files: (value.files || []).map((file: any) => ({ ...file, localPath: this.blobPath(file), sourcePath: '账号附件：' + file.name })), inputDir, outputPath: path.join(inputDir, '..', 'draft.md'), restored: true, binding: { connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project }, generation: value.generation === 'running' ? 'error' : value.generation };
        if (!existing) this.store.drafts.push(restored);
        else if (!['running'].includes(existing.generation || '')) {
          const artifacts = restored.artifacts?.map(item => { const prior = existing.artifacts?.find(prior => prior.id === item.id); return { ...item, evidenceIds: prior?.evidenceIds || item.evidenceIds, submitted: prior?.submitted || item.submitted, attachments: [...(item.attachments || []), ...(prior?.attachments || []).filter(entry => !entry.selected && !item.attachments?.some(other => other.fileId === entry.fileId))] }; });
          Object.assign(existing, { title: value.title, titleAlias: value.titleAlias, body: value.body, supplement: value.supplement, artifacts, attachments: value.attachments || existing.attachments, personalSavedIds: [...new Set([...(existing.personalSavedIds || []), ...(value.personalSavedIds || [])])], emptyResult: value.emptyResult, resultRules: value.resultRules, preparationDirections: value.preparationDirections, resultCategory: value.resultCategory, resultSourceDetails: value.resultSourceDetails });
        }
      }
    }
    this.store.conclusions = [...this.store.conclusions.filter(item => item.accountOwner !== owner), ...materials];
    const prefix = `${profile.id}:${profile.username}:`;
    this.store.settings.contentAliases = Object.fromEntries(Object.entries(records).filter(([key, value]) => key.startsWith('alias:') && typeof value === 'string').map(([key, value]) => [key.slice(6), value]));
    this.store.settings.contentUpdates = Object.entries(records).filter(([key, value]) => key.startsWith('update:') && value).map(([key, value]) => ({ ...value, eventId: prefix + key.slice(7) }));
    this.store.settings.contentSeen = Object.fromEntries(Object.entries(records).filter(([key, value]) => key.startsWith('seen:') && value).map(([key, value]) => [prefix + key.slice(5), value]));
    this.store.settings.dismissedContentUpdateIds = Object.entries(records).filter(([key, value]) => key.startsWith('dismissed:') && value).map(([key]) => prefix + key.slice(10));
    this.store.drafts = this.store.drafts.filter(draft => !this.owns(draft, profile) || records['draft:' + draft.id] !== null || draft.generation === 'running');
  }
  private blobPath(file: { name: string; sha256: string; size: number }) { contentAttachmentSchema.parse({ ...file, path: '' }); return path.join(this.store.root, 'accounts', 'files', createHash('sha256').update(accountIdentity(this.profile!)).digest('hex'), file.sha256, safeFilename(file.name)); }
  private recordFiles(records: AccountRecords) {
    return Object.entries(records).flatMap(([key, value]) => !value ? [] : key.startsWith('draft:') ? value.files || [] : key.startsWith('material:') && Array.isArray(value.localFiles) ? value.localFiles : []);
  }
  private ownedFile(profile: ConnectionProfile, sha256: string) {
    return this.store.drafts.filter(draft => this.owns(draft, profile)).flatMap(draft => draft.files).find(file => file.sha256 === sha256)?.localPath
      || this.store.conclusions.filter(item => item.accountOwner === accountIdentity(profile)).flatMap(item => item.localFiles || []).find(file => file.sha256 === sha256)?.localPath;
  }
  private async files(records: AccountRecords, remoteRecords: AccountRecords, profile: ConnectionProfile, valid: () => void) {
    const known = new Set(this.recordFiles(remoteRecords).map((file: { sha256: string }) => file.sha256));
    const done = new Set<string>();
    for (const file of this.recordFiles(records)) {
      const local = this.blobPath(file); if (done.has(local)) continue; done.add(local);
      const source = this.ownedFile(profile, file.sha256);
      if (!known.has(file.sha256)) {
        if (!source || await hashFile(source) !== file.sha256) throw new Error('待同步附件不存在或已变化：' + file.name);
        valid(); await this.remote.accountFile(file.sha256, source, true); valid(); known.add(file.sha256);
      }
      if (await hashFile(local).catch(() => '') === file.sha256) continue;
      await fs.mkdir(path.dirname(local), { recursive: true });
      const temporary = local + '.' + randomUUID() + '.partial';
      try {
        if (source && await hashFile(source).catch(() => '') === file.sha256) await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
        else { valid(); await this.remote.accountFile(file.sha256, temporary, false); valid(); }
        await fs.rename(temporary, local);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }
  }
  async activate(profile: ConnectionProfile, previous?: ConnectionProfile) {
    await this.conflicts.init();
    this.generation++; clearTimeout(this.timer); clearInterval(this.polling); this.stopped = false;
    await this.running;
    if (previous) {
      const previousOwner = accountIdentity(previous);
      for (const item of this.store.conclusions) (item as any).accountOwner ||= previousOwner;
      if (previousOwner !== accountIdentity(profile)) {
        await atomicJson(this.file(previous) + '.pending', this.collect(previous));
        this.store.settings.contentAliases = {}; this.store.settings.contentSeen = {}; this.store.settings.contentUpdates = []; this.store.settings.dismissedContentUpdateIds = [];
      }
    }
    this.state = { status: 'pending' }; this.profile = structuredClone(profile); this.base = {}; this.choices = {};
    for (const item of this.store.conclusions) (item as any).accountOwner ||= accountIdentity(profile);
    try { this.base = JSON.parse(await fs.readFile(this.file(profile), 'utf8')).records; } catch (error: any) { if (error.code !== 'ENOENT') { this.state = { status: 'error', detail: '账号同步缓存无法读取，已保留本机资料' }; this.changed(); return; } }
    if (previous && accountIdentity(previous) !== accountIdentity(profile)) {
      try { this.apply(JSON.parse(await fs.readFile(this.file(profile) + '.pending', 'utf8')), profile); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    await this.sync();
    this.polling = setInterval(() => void this.sync(), 60000); this.polling.unref();
  }
  schedule() {
    if (this.applying || this.resolving || this.stopped || !this.profile) return;
    if (this.remote.profile && accountIdentity(this.remote.profile) === accountIdentity(this.profile)) this.profile = structuredClone(this.remote.profile);
    for (const item of this.store.conclusions) (item as any).accountOwner ||= accountIdentity(this.profile);
    if (canonical(this.collect()) === canonical(Object.fromEntries(Object.entries(this.base).filter(([, value]) => value != null)))) return;
    if (!this.remote.connected) { this.state = { ...this.state, status: 'offline', detail: '更改已保存在本机，登录后同步' }; this.changed(); return; }
    clearTimeout(this.timer); this.state = { ...this.state, status: 'pending' }; this.changed(); this.timer = setTimeout(() => void this.sync(), 1500); this.timer.unref();
  }
  async resolve(key: string, choice: SyncChoice, token?: string, fields?: { path: string[]; text: string }[]) {
    await this.running;
    if (this.resolving) throw new Error('正在保存冲突处理，请稍候');
    this.resolving = true; clearTimeout(this.timer);
    try {
      const profile = this.profile!, generation = this.generation;
      const conflict = this.state.conflicts?.find(item => item.key === key); if (!conflict) throw new Error('同步冲突已变化，请刷新');
      const valid = () => { if (generation !== this.generation || token !== conflict.token || canonical(this.collect()[key] ?? null) !== canonical(conflict.local)) throw new Error('内容已更新，请查看最新冲突后再处理'); };
      valid();
      let value = choice === 'local' || choice === 'remote' ? applyConflictVersion(conflict, choice) : conflict.remote;
      if (choice === 'merged') value = applyConflictText(conflict, fields || this.conflicts.view(conflict).ai?.fields || []);
      let copy: ProjectConclusion | undefined;
      if (choice === 'both') {
        if (!key.startsWith('material:') || !conflict.local || !conflict.remote) throw new Error('此对象不能同时保留两个版本');
        copy = structuredClone(conflict.local) as ProjectConclusion;
        const hash = conflict.token; copy.id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        copy.title += '（本机副本）'; delete copy.publication; delete copy.uploadState;
      }
      await this.conflicts.record(key, conflict.local, conflict.remote, value, choice, accountIdentity(profile)); valid();
      const records = this.collect(); records[key] = value;
      if (copy) records['material:' + copy.id] = copy;
      accountRecordsSchema.parse(records);
      this.apply(records, profile, true); await this.store.save();
      // This reviewed remote version is the new base, even while disconnected.
      // Any later central change will be compared against it instead of overwritten.
      this.base[key] = structuredClone(conflict.remote);
      await atomicJson(this.file(profile), { revision: 0, records: this.base });
      delete this.choices[key];
      this.state = { ...this.state, status: this.remote.connected ? 'pending' : 'offline', conflicts: this.state.conflicts?.filter(item => item.key !== key), history: this.conflicts.history.filter(item => !item.key.startsWith('project:') && item.owner === accountIdentity(profile)).slice(0, 50).map(({ id, key, at, method }) => ({ id, key, at, method })) };
      this.changed();
    } finally { this.resolving = false; }
    this.schedule(); await this.sync();
  }
  async undo(resolutionId: string) {
    const record = this.conflicts.history.find(item => item.id === resolutionId && !item.key.startsWith('project:') && item.owner === accountIdentity(this.profile!));
    if (!record || canonical(this.collect()[record.key] ?? null) !== canonical(record.after)) throw new Error('资料已有后续修改，不能直接撤销；原版本仍保存在冲突记录中');
    const before = canonical(this.collect()), records = this.collect(); records[record.key] = record.before;
    await this.conflicts.record(record.key, record.after, record.remote, record.before, 'undo', accountIdentity(this.profile!));
    if (canonical(this.collect()) !== before) throw new Error('资料已有后续修改，请重新查看');
    this.apply(records, this.profile!, true); await this.store.save(); this.changed();
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    if (!this.profile || this.resolving || this.stopped || !this.remote.connected) return Promise.resolve();
    if (this.remote.profile && accountIdentity(this.remote.profile) === accountIdentity(this.profile)) this.profile = structuredClone(this.remote.profile);
    const profile = this.profile, generation = this.generation;
    const valid = () => { if (generation !== this.generation || !this.remote.profile || accountIdentity(this.remote.profile) !== accountIdentity(profile)) throw new Error('账号已改变，未应用同步结果'); };
    this.running = (async () => {
      this.state = { ...this.state, status: 'syncing' }; this.changed();
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const snapshot = await this.remote.accountData(); valid();
          // Drop retired configuration records before conflict resolution and restoration.
          const retiredPreferences = Object.hasOwn(snapshot.records, 'result-rules:preferences');
          delete snapshot.records['result-rules:preferences'];
          delete this.base['result-rules:preferences'];
          accountRecordsSchema.parse(snapshot.records);
          const before = this.collect(); let merged = mergeAccountRecords(this.base, before, snapshot.records, this.choices);
          for (const conflict of merged.conflicts) {
            const ai = this.conflicts.view(conflict).ai;
            if (ai?.status === 'ready' && !ai.unresolved?.length && verifiableTextMerge(conflict, ai.fields || [])) {
              const value = applyConflictText(conflict, ai.fields || []);
              await this.conflicts.record(conflict.key, conflict.local, conflict.remote, value, 'ai-auto', accountIdentity(profile));
              this.choices[conflict.key] = { local: canonical(conflict.local), remote: canonical(conflict.remote), choice: 'merged', value };
            }
          }
          merged = mergeAccountRecords(this.base, before, snapshot.records, this.choices);
          const blocked = new Set(merged.conflicts.map(item => item.key)), oldBase = structuredClone(this.base);
          // A conflict holds only its own record. Other records continue to sync.
          for (const key of blocked) merged.records[key] = snapshot.records[key] ?? null;
          await this.files(Object.fromEntries(Object.entries(merged.records).filter(([key]) => !blocked.has(key))), snapshot.records, profile, valid); valid();
          const result = !retiredPreferences && canonical(merged.records) === canonical(snapshot.records) ? snapshot : await this.remote.accountData({ revision: snapshot.revision, records: accountRecordsSchema.parse(merged.records) }); valid();
          if (result.conflict) continue;
          // Edits made while the request was in flight remain pending, never overwritten.
          const after = mergeAccountRecords(before, this.collect(), result.records);
          for (const key of blocked) after.records[key] = this.collect()[key] ?? null;
          if (after.conflicts.some(item => !blocked.has(item.key))) { this.state = { status: 'pending', detail: '同步期间有新修改，稍后继续' }; return; }
          this.applying = true;
          try {
            this.apply(after.records, profile, blocked);
            // Older or interrupted clients may have uploaded a reviewed preparation
            // record without its derived personal result. Rebuild that local view
            // after restoration, then keep syncing until the repaired record is also
            // present in the account-private snapshot.
            this.reconcile?.();
            await this.store.repairConclusionImports(); this.base = structuredClone(result.records);
            for (const key of blocked) this.base[key] = oldBase[key] ?? null;
            await this.store.save(); await atomicJson(this.file(profile), { ...result, records: this.base });
          }
          finally { this.applying = false; }
          this.state.history = this.conflicts.history.filter(item => !item.key.startsWith('project:') && item.owner === accountIdentity(profile)).slice(0, 50).map(({ id, key, at, method }) => ({ id, key, at, method }));
          if (blocked.size) {
            const current = mergeAccountRecords(this.base, this.collect(), result.records, this.choices).conflicts;
            this.state = { ...this.state, status: 'conflict', conflicts: current.map(item => this.conflicts.view(item)), detail: `${current.length} 项分歧待处理，其他资料已继续同步` };
            this.conflicts.enqueue(current); return;
          }
          if (canonical(this.collect(profile)) !== canonical(Object.fromEntries(Object.entries(this.base).filter(([, value]) => value != null)))) {
            this.state = { status: 'pending', detail: '已恢复缺失的个人成果，正在回写账号资料' }; this.changed(); continue;
          }
          this.state = { status: 'synced', syncedAt: new Date().toISOString(), history: this.state.history }; this.choices = {}; return;
        }
        throw new Error('另一台电脑正在保存，稍后重试');
      } catch (error: any) { if (generation === this.generation) this.state = { ...this.state, status: 'error', detail: `账号资料尚未同步：${error.message}。本机内容已保留；旧服务器需更新存储服务。` }; }
      finally { this.changed(); }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
  async close() { clearTimeout(this.timer); clearInterval(this.polling); await Promise.race([this.sync(), new Promise<void>(resolve => { const timer = setTimeout(resolve, 8000); timer.unref(); })]); this.stopped = true; this.generation++; await this.conflicts.close(); }
}
