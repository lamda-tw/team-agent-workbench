import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentSession, Draft, ProjectConclusion, Settings, Transfer, SessionInput } from '../shared/types';
import { settingsSchema } from './config';
import { activityStateSchema } from './activity-state';
import { migrateSessionContext } from './session-context';
import { repairConclusionImports } from './conclusion-import-repair';
import { accountIdentity } from '../shared/account-data';
import { rememberPreparationProgress } from '../shared/preparation-progress';
import { migrateProjectDirectories } from '../shared/project-directory';
import { linkConclusionPublications } from './conclusion-publications';
export async function atomicJson(file: string, data: unknown, ascii = false) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(temp, ascii ? json.replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) : json, { mode: 0o600 });
    // Windows scanners may briefly hold the destination. Never unlink the old file to replace it.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (e: any) {
        if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export class Store {
  activity: import('../shared/activity-assistant').ActivityAssistantState = { baselines: {}, jobs: [] };
  saved?: () => void;
  settings: Settings = { connections: [], providerPaths: { codex: '', cursor: '', claude: '' }, lastWorkspace: '', trustedServerIdentities: {} };
  sessions: AgentSession[] = []; transfers: Transfer[] = []; drafts: Draft[] = []; conclusions: ProjectConclusion[] = [];
  inputs: Record<string, SessionInput> = {};
  private writes: Promise<void> = Promise.resolve();
  constructor(public root: string) {}
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.root, 'activity-assistant.json'), 'utf8'));
      this.activity = activityStateSchema.parse(state);
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地 activity-assistant.json 无法读取'); }
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.root, 'settings.json'), 'utf8'));
      // Older builds stored the verified workspace as a time-limited lease; carry it over without the timestamps.
      if (raw && typeof raw === 'object') {
        if (raw.offlineAuthorization && !raw.workspaceSnapshot) raw.workspaceSnapshot = { profile: raw.offlineAuthorization.profile, workspaces: raw.offlineAuthorization.workspaces };
        delete raw.offlineAuthorization;
      }
      this.settings = settingsSchema.parse(raw);
      migrateProjectDirectories(this.settings);
    } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地设置损坏，请保留文件并检查：' + path.join(this.root, 'settings.json')); }
    for (const key of ['sessions', 'transfers', 'drafts', 'conclusions'] as const) {
      try { const data = JSON.parse(await fs.readFile(path.join(this.root, key + '.json'), 'utf8')); if (!Array.isArray(data)) throw new Error('Invalid array'); (this[key] as unknown[]) = data; } catch (e: any) { if (e.code !== 'ENOENT') throw new Error(`本地 ${key}.json 无法读取`); }
    }
    try { this.inputs = JSON.parse(await fs.readFile(path.join(this.root, 'inputs.json'), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('本地 inputs.json 无法读取'); }
    this.sessions.forEach(s => { delete s.cliConnection; delete s.desktopSyncPending; delete s.desktopWaitingApproval; if (['starting', 'running', 'approval'].includes(s.status)) { s.status = s.closedAt || s.stoppedAt || s.codexDesktop ? 'idle' : 'error'; if(s.codexDesktop)s.error=undefined; if (s.status === 'error') s.error = '应用关闭时任务尚未完成，已中断；可检查已有结果后继续发送。'; } s.approvals = []; migrateSessionContext(s); });
    // MCP now belongs to configuration, not the next-message selection. Keep historic messages intact.
    for (const session of this.sessions) if (session.provider === 'cursor' && this.inputs[session.id]?.capabilities) {
      this.inputs[session.id].capabilities = this.inputs[session.id].capabilities!.filter(item => !item.id.startsWith('plugin:mcp:'));
    }
    this.drafts.forEach(d => {
      if (!d.preparationVersion && !d.submitted) {
        // Preserve the user's previous final explanation when upgrading older drafts.
        d.body = d.body || d.generatedBody || ''; d.supplement ??= '';
        if (d.binding) d.target = d.binding.project.uploadPath;
        d.preparationVersion = 1;
        if (d.body && d.generation !== 'running') { d.generation = 'ready'; d.generationError = undefined; }
      }
      if (d.generation === 'running') { d.generation = 'error'; d.generationError = '应用关闭后整理已中断，可重试整理，“给团队的补充”已保留。'; }
      else if (!d.generation) { const s = this.sessions.find(s => s.id === d.prepareSessionId); d.generation = d.generatedBody ? 'ready' : 'error'; d.generationError = d.generatedBody ? undefined : s?.error || '此前的整理未完成，可重试整理，“给团队的补充”已保留。'; }
    });
    for (const draft of this.drafts) {
      const snapshot = draft.snapshot;
      if (!snapshot?.lastMessageId || snapshot.lastMessageLength !== undefined || draft.restored) continue;
      try {
        const messages = JSON.parse(await fs.readFile(path.join(draft.inputDir, 'conversation.json'), 'utf8'));
        if (createHash('sha256').update(JSON.stringify(messages)).digest('hex') !== snapshot.conversationHash) continue;
        const last = messages.at(-1);
        if (last?.id === snapshot.lastMessageId && typeof last.text === 'string') snapshot.lastMessageLength = last.text.length;
      } catch { /* Missing legacy snapshots retain the conservative boundary replay. */ }
    }
    for (const session of this.sessions) rememberPreparationProgress(session, this.drafts);
    this.transfers.forEach(t => { if (t.status === 'running' || t.status === 'queued') { t.status = 'error'; t.error = t.phase === 'awaiting_receipt' ? '应用重启前服务器可能已接收，重试时会先核对原请求回执' : t.phase === 'streaming' ? '应用重启前传输未完成，重试会校验身份和内容后从头传输' : '应用重启前尚未完成，确认服务器连接后可重试'; } });
    await this.repairConclusionImports();
    // Preserve the exact pre-repair backup, then stamp legacy personal results
    // before login can change the active account or drafts restore their results.
    const owner = this.settings.workspaceSnapshot?.profile;
    if (owner) for (const item of this.conclusions) item.accountOwner ||= accountIdentity(owner);
    linkConclusionPublications(this.conclusions, this.drafts, this.transfers);
  }
  async repairConclusionImports() {
    const before = structuredClone({ conclusions: this.conclusions, updates: this.settings.contentUpdates || [] });
    const profile = this.settings.workspaceSnapshot?.profile;
    if (!repairConclusionImports(this.conclusions, this.settings.contentUpdates || [], profile ? accountIdentity(profile) : '')) return;
    // Keep the pre-repair records recoverable; never edit Sessions or drafts.
    const after = structuredClone({ conclusions: this.conclusions, settings: this.settings });
    const next = this.writes.catch(() => {}).then(async () => {
      await atomicJson(path.join(this.root, 'migrations', 'import-links-' + randomUUID() + '.json'), before);
      await atomicJson(path.join(this.root, 'conclusions.json'), after.conclusions);
      await atomicJson(path.join(this.root, 'settings.json'), after.settings);
    });
    this.writes = next; await next;
  }
  save() {
    const data = JSON.parse(JSON.stringify({ settings: this.settings, sessions: this.sessions, inputs: this.inputs, transfers: this.transfers, drafts: this.drafts, conclusions: this.conclusions, 'activity-assistant': this.activity }));
    const next = this.writes.catch(() => {}).then(async () => { for (const [key, value] of Object.entries(data)) await atomicJson(path.join(this.root, key + '.json'), value); });
    this.writes = next; return next.then(() => { this.saved?.(); });
  }
  sessionDir(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效会话 ID'); return path.join(this.root, 'sessions', id); }
  async event(id: string, event: unknown) {
    const dir = this.sessionDir(id); await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
  }
}
