import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from '../core/store';
import type { AdminOperation, AdminSnapshot, AdminState } from './types';
import { applyMemberDelta, memberApplySchema, memberCreateSchema, type MemberCommand, type MemberDelta, type MemberSyncView, type PendingMember } from './member-protocol';

interface Transport {
  snapshot: AdminSnapshot;
  memberSync(teamId?: string, since?: number, requestIds?: string[]): Promise<MemberDelta>;
  operation(command: AdminOperation): Promise<any>;
}
type Cache = { version: 1; teamId?: string; state?: AdminState; sequence?: number; lastSyncedAt?: string; pending: PendingMember[] };

// A single queue owns reads, writes and submission receipts for this node window.
// Only creation drafts are durable; passwords and privileged edits never go to disk.
export class AdminMemberSync {
  private cache: Cache = { version: 1, pending: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private pollTask?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private error?: string;
  constructor(private directory: string, private transport: () => Transport, private changed: () => void, private canSync: () => boolean = () => true) {}
  private get file() { return path.join(this.directory, 'members.json'); }
  async init() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8')) as Cache;
      if (value.version !== 1 || !Array.isArray(value.pending) || value.state?.teamId !== value.teamId) throw new Error('Invalid member cache');
      value.pending = value.pending.map(item => ({ ...item, command: memberCreateSchema.parse(item.command) }));
      this.cache = value;
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('成员缓存无法读取，请保留 members.json 并检查本机数据'); }
  }
  view(): MemberSyncView { return structuredClone({ teamId: this.cache.teamId, lastSyncedAt: this.cache.lastSyncedAt, error: this.error, pending: this.cache.pending }); }
  snapshot(): AdminSnapshot {
    const current = this.transport().snapshot;
    return { ...current, state: current.connected ? current.state : this.cache.state, memberSync: this.view() };
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(() => { if (this.stopped) throw new Error('成员同步已停止'); return action(); });
    this.queue = next; return next;
  }
  async settle() { await this.queue.catch(() => {}); }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.sync(); }, 10000); this.timer.unref?.(); } }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private save() { return atomicJson(this.file, this.cache); }
  private available() { const s = this.transport().snapshot; return !this.stopped && this.canSync() && s.connected && s.verified && s.role === 'administrator' && s.state?.initialized && !s.busy; }
  private async pull() {
    const transport = this.transport();
    const delta = await transport.memberSync(this.cache.teamId || transport.snapshot.profile?.teamId, this.cache.sequence, this.cache.pending.map(item => item.id));
    if (this.stopped || transport !== this.transport() || !transport.snapshot.connected) return;
    if (this.cache.teamId && delta.teamId !== this.cache.teamId) throw new Error('[MEMBER_TEAM] 团队身份已变化，已停止成员同步与开通');
    const state = applyMemberDelta(this.cache.state, delta);
    this.cache = { ...this.cache, teamId: delta.teamId, state, sequence: delta.sequence, lastSyncedAt: new Date().toISOString() };
    this.cache.pending = this.cache.pending.filter(item => delta.receipts?.[item.id] !== 'done');
    transport.snapshot.state = structuredClone(state);
    if (transport.snapshot.profile) transport.snapshot.profile.teamId = delta.teamId;
    this.error = undefined; await this.save(); this.changed();
  }
  sync() {
    if (this.stopped) return Promise.resolve();
    if (this.pollTask) return this.pollTask;
    this.pollTask = this.serial(async () => {
      if (!this.available()) return;
      try {
        await this.pull();
        for (const item of [...this.cache.pending]) {
          if (item.status !== 'pending' || !this.available()) continue;
          const snapshot = this.transport().snapshot;
          if (snapshot.missingCommands?.length || snapshot.setupIssues?.length) continue;
          await this.sendPending(item);
          if (this.error) break;
        }
      } catch (error: any) { this.error = error.message; this.changed(); }
    }).catch(error => { if (!this.stopped) { this.error = error.message; this.changed(); } }).finally(() => { this.pollTask = undefined; });
    return this.pollTask;
  }
  async create(raw: unknown, id: string = randomUUID()) {
    const command = memberCreateSchema.parse(raw);
    const duplicate = await this.serial(async () => {
      if (!this.cache.teamId || !this.cache.state?.initialized) throw new Error('请先连接并同步团队，再保存待开通成员');
      const previous = this.cache.pending.find(item => item.id === id);
      if (previous) { if (JSON.stringify(previous.command) !== JSON.stringify(command)) throw new Error('请求编号已用于其他待开通成员'); return previous; }
      const sameAccount = this.cache.pending.find(item => item.command.username.toLowerCase() === command.username.toLowerCase());
      if (sameAccount) return sameAccount;
      if (this.cache.pending.length >= 1000) throw new Error('待开通成员过多，请先处理已有待办');
      this.cache.pending.push({ id, command, status: 'pending', createdAt: new Date().toISOString() });
      await this.save(); this.changed();
    });
    if (duplicate?.status === 'blocked') return { queued: false, blockedError: duplicate.error || '此账号的待开通任务已阻塞，请先处理' };
    await this.sync();
    const current = this.cache.pending.find(item => item.id === (duplicate?.id || id));
    return { queued: !!current, blockedError: current?.status === 'blocked' ? current.error || '此账号的待开通任务已阻塞，请先处理' : undefined };
  }
  private async sendPending(item: PendingMember) {
    try {
      await this.transport().operation(memberApplySchema.parse({ op: 'members_apply', teamId: this.cache.teamId, requestId: item.id, command: item.command }));
      this.cache.pending = this.cache.pending.filter(value => value.id !== item.id);
      await this.save(); await this.pull();
    } catch (error: any) {
      item.error = error.message;
      if (error.remoteRejected || /^\[MEMBER_/.test(error.message) || this.transport().snapshot.profile?.mode === 'local') item.status = 'blocked';
      else this.error = error.message;
      await this.save(); this.changed();
    }
  }
  removePending(id: string) { return this.serial(async () => { this.cache.pending = this.cache.pending.filter(item => item.id !== id); await this.save(); this.changed(); }); }
  // Every operation (including legacy group tools) shares the polling queue. A
  // delayed poll can never replace the result of a more recent local mutation.
  operation(operation: AdminOperation) {
    return this.serial(async () => {
      if (this.cache.teamId && this.transport().snapshot.state?.teamId !== this.cache.teamId) throw new Error('[MEMBER_TEAM] 团队身份不一致，请重新连接原中央节点');
      let result;
      try { result = await this.transport().operation(operation); }
      finally {
        if (this.available()) try { await this.pull(); } catch (error: any) { this.error = error.message; this.changed(); }
      }
      return result;
    });
  }
  apply(command: MemberCommand, requestId: string) {
    if (!this.cache.teamId) return Promise.reject(new Error('请先同步团队成员'));
    return this.operation(memberApplySchema.parse({ op: 'members_apply', teamId: this.cache.teamId, requestId, command }));
  }
}
