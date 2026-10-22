import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store';
import { projectName } from './project-layout';
import type { Project, ProjectBriefState, RemoteBinding } from '../shared/types';
import { projectBriefSchema, type ProjectBrief } from '../shared/project-brief';
import { applyConflictText, applyConflictVersion, canonicalSync, mergeSyncValue, verifiableTextMerge, type SyncChoice, type SyncConflict } from '../shared/sync-conflict';
import { conflictToken, type SyncConflicts } from './sync-conflicts';

interface Entry { project: Project; pendingCreate?: boolean; creation?: { brief?: ProjectBrief }; localOnly?: boolean; brief?: ProjectBrief; base?: ProjectBrief; revision: number; centralRevision: number; error?: string; conflict?: SyncConflict }
interface Host { owner?(): string; projects(): Project[]; retainedProjects?(): Project[]; binding(id: string): RemoteBinding; connected(): boolean; create(name: string, group: string | undefined, brief: ProjectBrief | undefined, id: string): Promise<Project>; read(binding: RemoteBinding): Promise<ProjectBriefState>; save(binding: RemoteBinding, brief: ProjectBrief, revision: number): Promise<unknown>; changed(): void }

export class ProjectSync {
  private accounts: Record<string, Record<string, Entry>> = {};
  private owner() { return this.host.owner?.() || 'local'; }
  private get entries(): Record<string, Entry> { return this.accounts[this.owner()] ||= {}; }
  private ready?: Promise<void>;
  private writes = Promise.resolve();
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private polling?: NodeJS.Timeout;
  private closed = false;
  constructor(private root: string, private host: Host, private conflicts: SyncConflicts) {}
  init() { return this.ready ||= fs.readFile(path.join(this.root, 'project-sync.json'), 'utf8').then(raw => { this.accounts = JSON.parse(raw).accounts || {}; }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw new Error('本机项目记录无法读取，原文件已保留'); }); }
  projects() {
    const projects = new Map([...this.host.projects(), ...Object.values(this.entries).map(entry => entry.project)].map(project => [project.id, project]));
    for (const project of this.host.retainedProjects?.() || []) if (!projects.has(project.id)) projects.set(project.id, project);
    return [...projects.values()];
  }
  isHistoryOnly(id: string) { const entry = this.entries[id]; return !entry?.localOnly && !entry?.pendingCreate && !this.host.projects().some(project => project.id === id) && this.projects().some(project => project.id === id); }
  states() {
    const ids = new Set([...Object.keys(this.entries), ...this.projects().filter(project => this.isHistoryOnly(project.id)).map(project => project.id)]);
    return Object.fromEntries([...ids].map(id => {
      const entry = this.entries[id], historyOnly = this.isHistoryOnly(id);
      return [id, { pending: !historyOnly && (!!entry?.pendingCreate || canonicalSync(entry?.brief) !== canonicalSync(entry?.base)), localOnly: historyOnly || !!entry?.localOnly, historyOnly, error: historyOnly ? undefined : entry?.error, history: this.conflicts.history.filter(item => item.key === 'project:' + id && item.owner === this.owner()).slice(0, 30).map(({ id, at, method }) => ({ id, at, method })), conflict: !historyOnly && entry?.conflict ? this.conflicts.view(entry.conflict) : undefined }];
    }));
  }
  private persist() { const data = structuredClone({ accounts: this.accounts }); const next = this.writes.catch(() => {}).then(() => atomicJson(path.join(this.root, 'project-sync.json'), data)); this.writes = next; return next; }
  async create(name: string, groupName?: string, brief?: ProjectBrief, localOnly = false, identifier?: string) {
    await this.init(); name = projectName(name); if (brief) brief = projectBriefSchema.parse(brief);
    const id = identifier || 'project_' + randomUUID().replace(/-/g, '');
    if (this.projects().some(item => item.id === id || item.name === name && item.groupName === groupName)) throw new Error('此项目已存在，请直接打开');
    const project: Project = { id, name, groupName, groupLabel: localOnly ? '本机项目' : undefined, remoteRoot: '/local-projects/' + id, uploadPath: '/local-projects/' + id, historyPath: '/local-projects/' + id + '/trajectories', briefRevision: brief ? 1 : 0 };
    this.entries[id] = { project, brief, revision: brief ? 1 : 0, centralRevision: 0, pendingCreate: !localOnly, localOnly };
    try { await this.persist(); } catch (error) { delete this.entries[id]; throw error; }
    this.host.changed(); this.schedule(); return project;
  }
  async read(id: string): Promise<ProjectBriefState> {
    await this.init(); const project = this.projects().find(item => item.id === id); if (!project) throw new Error('项目不存在');
    const entry = this.entries[id];
    if (entry) return { brief: structuredClone(entry.brief), revision: entry.revision };
    this.entries[id] = { project, revision: 0, centralRevision: 0 };
    await this.persist(); this.schedule(); return { revision: 0 };
  }
  async save(id: string, brief: ProjectBrief, revision: number) {
    await this.init(); brief = projectBriefSchema.parse(brief);
    const project = this.projects().find(item => item.id === id); if (!project) throw new Error('项目不存在');
    const entry = this.entries[id] ||= { project, revision: 0, centralRevision: 0 };
    if (entry.revision !== revision) throw new Error('本机项目资料已更新，请重新打开后合并修改');
    const before = structuredClone(entry);
    entry.brief = brief; entry.revision++; entry.project.briefRevision = entry.revision; entry.conflict = undefined;
    try { await this.persist(); } catch (error) { this.entries[id] = before; throw error; }
    this.host.changed(); this.schedule(); return { brief, revision: entry.revision };
  }
  schedule() {
    if (this.closed) return;
    if (!this.polling) this.polling = setInterval(() => void this.sync(), 60000).unref();
    clearTimeout(this.timer); this.timer = setTimeout(() => void this.sync(), 1500).unref();
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed || !this.host.connected()) return Promise.resolve();
    return this.running = this.flush().catch(error => { for (const entry of Object.values(this.entries)) if (!entry.localOnly) entry.error = error instanceof Error ? error.message : '同步暂不可用'; this.host.changed(); }).finally(() => { this.running = undefined; });
  }
  private async flush() {
    await this.init(); await this.conflicts.init();
    const owner = this.owner(), entries = this.entries;
    const valid = () => { if (owner !== this.owner()) throw new Error('账号已改变，本机项目保持原归属'); };
    for (const project of this.projects()) {
      if (this.closed || !this.host.connected() || owner !== this.owner()) break;
      if (this.isHistoryOnly(project.id)) continue;
      const entry = entries[project.id] ||= { project, revision: 0, centralRevision: 0 };
      if (entry.localOnly) continue;
      try {
        if (entry.pendingCreate) {
          if (!entry.creation) { entry.creation = { brief: structuredClone(entry.brief) }; await this.persist(); }
          const createdBrief = structuredClone(entry.creation.brief);
          const result = await this.host.create(project.name, project.groupName, createdBrief, project.id); valid();
          if (result.id !== project.id) throw new Error('中央节点需更新项目同步服务，本机项目已保留');
          entry.project = result; entry.base = createdBrief; entry.centralRevision = result.briefRevision || 0; entry.pendingCreate = false; entry.creation = undefined;
          await this.persist();
        }
        const binding = this.host.binding(project.id), remote = await this.host.read(binding); valid();
        const local = structuredClone(entry.brief), merged = mergeSyncValue(entry.base, local, remote.brief);
        if (merged.fields.length) {
          const conflict: SyncConflict = { key: 'project:' + project.id, token: conflictToken(entry.base, local, remote.brief), base: entry.base, local, remote: remote.brief, merged: merged.value, fields: merged.fields };
          const ai = this.conflicts.view(conflict).ai;
          if (ai?.status === 'ready' && !ai.unresolved?.length && verifiableTextMerge(conflict, ai.fields || [])) {
            merged.value = applyConflictText(conflict, ai.fields || []); await this.conflicts.record(conflict.key, local, remote.brief, merged.value, 'ai-auto', owner);
          } else { entry.conflict = conflict; entry.error = undefined; continue; }
        }
        const next = merged.value === undefined ? undefined : projectBriefSchema.parse(merged.value);
        if (canonicalSync(next) !== canonicalSync(remote.brief) && next) await this.host.save(binding, next, remote.revision);
        valid();
        // The user may edit locally while the request is in flight.
        const after = mergeSyncValue(local, entry.brief, next);
        entry.base = after.fields.length ? local : next; entry.centralRevision = remote.revision + (canonicalSync(next) !== canonicalSync(remote.brief) ? 1 : 0);
        if (!after.fields.length && canonicalSync(entry.brief) !== canonicalSync(after.value)) { entry.brief = after.value as ProjectBrief | undefined; entry.revision++; }
        entry.project.briefRevision = entry.revision; entry.conflict = undefined; entry.error = undefined;
      } catch (error) { entry.error = error instanceof Error ? error.message : '等待恢复连接后自动同步'; }
      finally { await this.persist(); this.host.changed(); }
    }
    if (owner === this.owner()) this.conflicts.enqueue(Object.values(entries).flatMap(entry => entry.conflict ? [entry.conflict] : []));
  }
  async resolve(id: string, token: string, choice: SyncChoice, fields?: { path: string[]; text: string }[]) {
    const entry = this.entries[id], conflict = entry?.conflict;
    if (!entry || !conflict || conflict.token !== token || canonicalSync(conflict.local) !== canonicalSync(entry.brief)) throw new Error('项目资料已改变，请查看最新冲突');
    const value = choice === 'local' || choice === 'remote' ? applyConflictVersion(conflict, choice) : choice === 'merged' ? applyConflictText(conflict, fields || []) : undefined;
    if (!value) throw new Error('项目说明只能保留一个合并版本');
    const brief = projectBriefSchema.parse(value), revision = entry.revision, owner = this.owner();
    await this.conflicts.record(conflict.key, conflict.local, conflict.remote, brief, choice, this.owner());
    if (owner !== this.owner() || entry.revision !== revision || entry.conflict?.token !== token) throw new Error('项目资料已改变，请查看最新冲突');
    // A new remote version is compared against the exact version the user reviewed.
    entry.base = conflict.remote as ProjectBrief; entry.brief = brief; entry.revision++; entry.conflict = undefined;
    await this.persist(); this.host.changed(); this.schedule();
  }
  async undo(id: string, resolutionId: string) {
    await this.init(); const entry = this.entries[id];
    const record = this.conflicts.history.find(item => item.id === resolutionId && item.key === 'project:' + id && item.owner === this.owner());
    if (!entry || !record || canonicalSync(entry.brief) !== canonicalSync(record.after)) throw new Error('资料已有后续修改，原版本仍保存在合并记录中');
    const brief = projectBriefSchema.parse(record.before), revision = entry.revision, owner = this.owner();
    await this.conflicts.record(record.key, entry.brief, entry.base, brief, 'undo', this.owner());
    if (owner !== this.owner()) throw new Error('账号已改变，请重新打开项目');
    await this.save(id, brief, revision);
  }
  async removeLocal(id: string) { await this.init(); if (!this.entries[id]?.localOnly) throw new Error('仅可移除已迁出的本机项目入口'); delete this.entries[id]; await this.persist(); this.host.changed(); }
  async settle() { await this.running; }
  async close() { this.closed = true; clearTimeout(this.timer); clearInterval(this.polling); await this.running; await this.writes; }
}
