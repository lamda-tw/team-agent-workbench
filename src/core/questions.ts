import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { accountIdentity } from '../shared/account-data';
import type { AgentSession, ConnectionProfile } from '../shared/types';
import { questionCommandSchema, type QuestionCommand, type QuestionInbox, type QuestionJob, type TeamQuestion } from '../shared/questions';
import { autoDialogueNotice, fillFollowNotice, incomingFollowNotice, incomingQuestionNotice, incomingReplyNotice, questionControl, withoutQuestionControl } from '../shared/session-context-text';
import { atomicJson, type Store } from './store';
import type { SharedFiles } from './shared-files';
import { freezeFile } from './artifacts';

type SavedInbox = QuestionInbox & { notified: Record<string, number>; followSeen?: Record<string, number>; suggestSeen?: Record<string, boolean> };
export class Questions {
  private buckets: Record<string, SavedInbox> = {};
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private saving: Promise<unknown> = Promise.resolve();
  private active = new Set<string>();
  private references = new Map<string, Promise<void>>();
  private autoRunning = false;
  private stopped = false;
  constructor(private store: Store, private remote: SharedFiles, private hooks: {
    profile: () => ConnectionProfile | undefined; session: (id: string) => AgentSession;
    send: (sessionId: string, text: string, runId: string, agentNotice: string, draft?: boolean) => Promise<boolean>;
    changed: () => void; notice: (text: string) => void;
  }) {}
  private get file() { return path.join(this.store.root, 'questions.json'); }
  private owner() { const profile = this.hooks.profile(); return profile && accountIdentity(profile); }
  private inbox(): SavedInbox | undefined {
    const owner = this.owner();
    return owner ? this.buckets[owner] ||= { items: [], read: {}, notified: {}, jobs: [] } : undefined;
  }
  view(): QuestionInbox { const inbox = this.inbox(); return inbox ? { items: inbox.items, read: inbox.read, jobs: inbox.jobs, dialogues: inbox.dialogues, replyModes: inbox.replyModes, fills: inbox.fills, error: inbox.error } : { items: [], read: {}, jobs: [] }; }
  private rememberFill(inbox: SavedInbox, questionId: string, peer: string | undefined, text: string) {
    const body = text.trim().slice(0, 12000);
    if (!peer || !body) return false;
    ((inbox.fills ||= {})[questionId] ||= {})[peer] = body;
    return true;
  }
  private rememberSessionFill(inbox: SavedInbox, session: AgentSession, answer: string) {
    const control = questionControl(answer);
    if (control.kind !== 'continue' || !control.body) return false;
    let wrote = false;
    for (const q of inbox.items) {
      if (q.closedAt || q.sessionId !== session.id) continue;
      const dialogue = inbox.dialogues?.find(item => item.questionId === q.id && item.sessionId === session.id);
      const peer = dialogue?.peer || (q.recipients.length === 1 ? q.recipients[0].username : '');
      if (this.rememberFill(inbox, q.id, peer, control.body)) wrote = true;
    }
    return wrote;
  }
  private save() { const value = JSON.stringify(this.buckets); const job = this.saving.catch(() => {}).then(() => atomicJson(this.file, JSON.parse(value))); this.saving = job; return job; }
  async init() {
    try { this.buckets = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    // A crashed submit is ambiguous: retain it for inspection, never automatically resend a model task.
    for (const inbox of Object.values(this.buckets)) for (const job of inbox.jobs) if (job.phase === 'running') { job.phase = 'error'; job.error = '上次回答中断，请检查 Session 中的结果后重新回答'; }
    this.timer = setInterval(() => void this.sync().catch(() => {}), 5000); this.timer.unref();
  }
  async members(projectId: string) { return this.remote.questionRequest(this.remote.binding(projectId), 'members'); }
  private async request(projectId: string, command: QuestionCommand) {
    const owner = this.owner(), inbox = this.inbox(); if (!owner || !inbox) throw new Error('请先连接团队账号');
    const question = await this.remote.questionRequest(this.remote.binding(projectId), command) as TeamQuestion;
    if (owner !== this.owner()) throw new Error('账号已切换');
    this.merge(inbox, question);
    if (command.kind === 'create' || command.kind === 'close' || command.kind === 'follow' || command.kind === 'suggest' || command.kind === 'resume') { inbox.read[question.id] = question.activityRevision; inbox.notified[question.id] = question.activityRevision; }
    if (command.kind === 'suggest' && question.author === owner) (inbox.suggestSeen ||= {})[question.id + ':' + command.username] = true;
    if (command.kind === 'resume' && question.author === owner && inbox.suggestSeen) delete inbox.suggestSeen[question.id + ':' + command.username];
    await this.save(); this.hooks.changed(); return question;
  }
  private merge(inbox: SavedInbox, q: TeamQuestion) {
    const prior = inbox.items.find(item => item.id === q.id && item.projectId === q.projectId);
    if (prior && prior.revision >= q.revision) return;
    if (prior) inbox.items.splice(inbox.items.indexOf(prior), 1, q); else inbox.items.push(q);
  }
  async create(sessionId: string, raw: unknown) {
    const session = this.hooks.session(sessionId);
    if (!session.binding || session.closedAt || session.purpose !== 'work') throw new Error('请选择当前项目中打开的工作 Session');
    const command = questionCommandSchema.parse({ ...(raw as object), kind: 'create', sessionId });
    return this.request(session.binding.project.id, command);
  }
  async closeQuestion(projectId: string, id: string) { return this.request(projectId, { kind: 'close', id }); }
  async follow(projectId: string, id: string, followId: string, body: string, target?: string) { return this.request(projectId, { kind: 'follow', id, followId, body, ...(target ? { target } : {}) }); }
  async answer(projectId: string, id: string, answerId: string, body: string) { return this.request(projectId, { kind: 'answer', id, answerId, body }); }
  lockedPeer(sessionId: string) {
    const inbox = this.inbox(), dialogue = inbox?.dialogues?.find(item => item.sessionId === sessionId);
    if (!dialogue) return inbox?.items.find(q => !q.closedAt && q.author !== this.hooks.profile()?.username && inbox.replyModes?.[q.id] === 'auto' && q.recipients.some(r => r.sessionId === sessionId))?.authorName;
    return inbox?.items.find(item => item.id === dialogue.questionId)?.recipients.find(item => item.username === dialogue.peer)?.name || dialogue.peer;
  }
  private assertWorkSession(sessionId: string, projectId: string) {
    const session = this.hooks.session(sessionId), owner = this.owner();
    if (!session.binding || session.binding.project.id !== projectId || session.closedAt || session.purpose !== 'work' || !owner || accountIdentity(session.binding) !== owner) throw new Error('只能使用同项目中自己打开的工作 Session');
    if (session.cursorNative) throw new Error('此 Cursor 桌面接入暂不支持自动对话，请选择其他工作 Session');
  }
  async importReply(projectId: string, id: string, sessionId: string, answerId: string) {
    const inbox = this.inbox(), profile = this.hooks.profile();
    if (!inbox || !profile) throw new Error('请先连接团队账号');
    const question = inbox.items.find(item => item.id === id && item.projectId === projectId);
    if (!question || question.author !== profile.username) throw new Error('只有发问人可以引入回复');
    if (question.closedAt) throw new Error('问题已关闭');
    const recipient = question.recipients.find(item => item.answers.some(answer => answer.id === answerId));
    if (!recipient) throw new Error('要引入的回复不存在');
    this.assertWorkSession(sessionId, projectId);
    const bound = inbox.dialogues?.find(item => item.sessionId === sessionId);
    if (bound && bound.peer !== recipient.username) throw new Error('这个自动 Session 只跟一个人进行，不能加入其他人的回答');
    if (bound) throw new Error('自动对话中的 Session 会自行接收这一位成员的回复');
    if (inbox.jobs.some(job => job.sourceId === answerId && job.sessionId === sessionId && job.phase !== 'error' && job.phase !== 'closed')) throw new Error('这条回复已经引入当前 Session');
    inbox.jobs.push({ questionId: id, projectId, sessionId, runId: randomUUID(), phase: 'queued', mode: 'import', sourceId: answerId, peer: recipient.username });
    await this.save(); this.hooks.changed(); void this.sync().catch(() => {});
    return question;
  }
  async startAuto(projectId: string, id: string, peer: string, sessionId: string) {
    const inbox = this.inbox(), profile = this.hooks.profile();
    if (!inbox || !profile) throw new Error('请先连接团队账号');
    const question = inbox.items.find(item => item.id === id && item.projectId === projectId);
    if (!question) throw new Error('问题不存在');
    if (question.author !== profile.username) {
      if (peer !== question.author || !question.recipients.some(r => r.username === profile.username)) throw new Error('只能与这条问题的发问人自动对话');
      this.assertWorkSession(sessionId, projectId);
      const locked = inbox.dialogues?.some(d => d.sessionId === sessionId) || inbox.items.some(q => q.author !== question.author && !q.closedAt && inbox.replyModes?.[q.id] === 'auto' && q.recipients.some(r => r.sessionId === sessionId));
      if (locked) throw new Error('这个 Session 已在进行另一条自动对话');
      return this.link(projectId, id, sessionId);
    }
    if (question.closedAt) throw new Error('问题已关闭');
    const recipient = question.recipients.find(item => item.username === peer);
    if (!recipient?.answers.length) throw new Error('对方第一次回答后才能开始自动对话');
    this.assertWorkSession(sessionId, projectId);
    const dialogues = inbox.dialogues ||= [];
    if (inbox.items.some(q => !q.closedAt && inbox.replyModes?.[q.id] === 'auto' && q.recipients.some(r => r.sessionId === sessionId))) throw new Error('这个 Session 已经在回答其他成员的提问');
    if (dialogues.some(item => item.sessionId === sessionId && !(item.questionId === id && item.peer === peer))) throw new Error('这个 Session 已经在和另一个人自动对话');
    const existing = dialogues.find(item => item.questionId === id && item.peer === peer);
    if (existing) { existing.sessionId = sessionId; existing.suggested = false; }
    else dialogues.push({ questionId: id, projectId, peer, sessionId, mode: 'auto' });
    if (recipient.endSuggestedAt) await this.request(projectId, { kind: 'resume', id, username: peer });
    await this.save(); this.hooks.changed(); void this.sync().catch(() => {});
    return this.inbox()?.items.find(item => item.id === id) || question;
  }
  async fillDraft(projectId: string, id: string, peer: string) {
    const inbox = this.inbox(), profile = this.hooks.profile();
    if (!inbox || !profile) throw new Error('请先连接团队账号');
    const question = inbox.items.find(item => item.id === id && item.projectId === projectId);
    if (!question || question.author !== profile.username) throw new Error('只有发问人可以起草继续提问');
    if (question.closedAt) throw new Error('问题已关闭');
    const recipient = question.recipients.find(item => item.username === peer);
    if (!recipient) throw new Error('对话成员不存在');
    const session = this.hooks.session(question.sessionId);
    if (session.cursorNative) throw new Error('此 Session 暂不能起草继续提问，请换一个工作 Session');
    this.assertWorkSession(question.sessionId, projectId);
    const dialogue = inbox.dialogues?.find(item => item.sessionId === question.sessionId);
    if (dialogue && !dialogue.suggested) throw new Error('这个 Session 正在自动对话，请先停止后再自动填入');
    if (['running', 'starting', 'approval'].includes(session.status) || inbox.jobs.some(job => job.sessionId === question.sessionId && ['queued', 'running', 'ready'].includes(job.phase))) throw new Error('这条提问的 Session 正在处理，请稍后再自动填入');
    inbox.jobs.push({ questionId: id, projectId, sessionId: question.sessionId, runId: randomUUID(), phase: 'queued', mode: 'fill', peer });
    await this.save(); this.hooks.changed(); void this.sync().catch(() => {});
  }
  async stopAuto(projectId: string, id: string, peer: string) {
    const inbox = this.inbox(); if (!inbox) return;
    const question = inbox.items.find(q => q.id === id && q.projectId === projectId);
    if (question && question.author !== this.hooks.profile()?.username && question.author === peer) {
      (inbox.replyModes ||= {})[id] = 'manual';
      for (const job of inbox.jobs) if (job.questionId === id && (!job.mode || job.mode === 'answer') && ['queued', 'running', 'ready'].includes(job.phase)) { job.phase = 'error'; job.error = '已停止自动回传，生成结果保留在 Session'; }
      await this.save(); this.hooks.changed(); void this.sync().catch(() => {}); return;
    }
    inbox.dialogues = inbox.dialogues?.filter(item => !(item.projectId === projectId && item.questionId === id && item.peer === peer));
    for (const job of inbox.jobs) if (job.projectId === projectId && job.questionId === id && job.peer === peer && job.mode === 'auto' && job.phase === 'queued') job.phase = 'closed';
    await this.save(); this.hooks.changed();
  }
  async read(id: string, revision: number) { const inbox = this.inbox(); if (!inbox) return; const q = inbox.items.find(q => q.id === id); if (q) inbox.read[id] = Math.max(inbox.read[id] || 0, Math.min(revision, q.activityRevision)); await this.save(); this.hooks.changed(); }
  async link(projectId: string, id: string, sessionId: string) {
    const s = this.hooks.session(sessionId);
    if (!s.binding || s.binding.project.id !== projectId || s.closedAt || s.purpose !== 'work') throw new Error('只能关联同项目中自己的打开的工作 Session');
    if (s.cursorNative) throw new Error('此 Cursor 桌面接入暂不支持自动回答，请选择其他工作 Session');
    const inbox = this.inbox()!;
    if (inbox.dialogues?.some(d => d.sessionId === sessionId)) throw new Error('这个 Session 已经在进行另一条自动对话');
    if (inbox.jobs.some(j => j.questionId === id && ['queued', 'running', 'ready'].includes(j.phase))) throw new Error('这条问题正在处理');
    const q = await this.request(projectId, { kind: 'link', id, sessionId });
    await this.reference(s, q);
    (inbox.replyModes ||= {})[id] = 'auto';
    inbox.jobs.push({ questionId: id, projectId, sessionId, runId: randomUUID(), phase: 'queued', mode: 'answer', sourceId: 'origin', peer: this.hooks.profile()?.username, covered: (q.followUps || []).filter(item => !item.target || item.target === this.hooks.profile()?.username).map(item => item.id) });
    await this.save(); this.hooks.changed(); void this.sync().catch(() => {}); return q;
  }
  private reference(session: AgentSession, q: TeamQuestion) {
    const key = session.id + ':' + q.id;
    const work = (this.references.get(key) || Promise.resolve()).catch(() => {}).then(() => this.writeReference(session, q));
    this.references.set(key, work);
    return work.finally(() => { if (this.references.get(key) === work) this.references.delete(key); });
  }
  private async writeReference(session: AgentSession, q: TeamQuestion) {
    const owner = this.owner();
    const valid = () => owner === this.owner() && !!session.binding && accountIdentity(session.binding) === owner && (this.inbox()?.items.find(item => item.id === q.id)?.revision || 0) <= q.revision;
    if (!valid()) return;
    const follows = (q.followUps || []).map(item => `## 后续 · ${item.createdAt}\n${item.body}`).join('\n\n');
    const body = `# 提问：${q.title}\n发问人：${q.authorName}\n状态：${q.closedAt ? '已关闭；不再回传答案' : '开放'}\n\n${q.body}\n\n${q.context}\n\n${follows}\n\n` + q.recipients.flatMap(r => r.answers.map(a => `## ${r.name} · ${a.createdAt}\n${a.body}`)).join('\n\n');
    const sourcePath = 'question:' + q.id, prior = session.sources.find(s => s.sourcePath === sourcePath);
    if (prior && await fs.readFile(prior.localPath, 'utf8').catch(() => '') === body) return;
    const folder = path.join(this.store.sessionDir(session.id), 'questions'); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, q.id + '-v' + q.revision + '.md'); await fs.writeFile(file, body, 'utf8');
    const source = await freezeFile(file, path.join(this.store.sessionDir(session.id), 'sources')); source.name = '提问 · ' + q.title; source.sourcePath = sourcePath;
    if (!valid()) return;
    if (prior) { source.id = prior.id; session.sources.splice(session.sources.indexOf(prior), 1, source); } else session.sources.push(source);
    session.autoUpload = false;
    await this.store.save();
  }
  async sync() {
    if (this.polling) return this.polling;
    const work = this.scan(); this.polling = work;
    try { await work; } finally { if (this.polling === work) this.polling = undefined; }
  }
  private async scan() {
    const profile = this.remote.profile, inbox = this.inbox(), owner = this.owner();
    if (this.stopped || !this.remote.connected || !profile || !inbox || !owner || accountIdentity(profile) !== owner) return;
    try {
      for (const project of profile.projects) {
        const before = new Map(inbox.items.filter(q => q.projectId === project.id).map(q => [q.id, q]));
        const questions = await this.remote.questionRequest(this.remote.binding(project.id)) as TeamQuestion[];
        if (owner !== this.owner() || this.stopped) return;
        // Remove records the server no longer permits this account to read.
        inbox.items = inbox.items.filter(q => q.projectId !== project.id || before.get(q.id) !== q || questions.some(n => n.id === q.id));
        for (const q of questions) this.merge(inbox, q);
      }
      inbox.items = inbox.items.filter(q => profile.projects.some(p => p.id === q.projectId));
      inbox.error = undefined;
      for (const q of inbox.items) {
        if (owner !== this.owner() || this.stopped) return;
        if (q.closedAt) inbox.dialogues = inbox.dialogues?.filter(item => item.questionId !== q.id);
        const self = q.recipients.find(recipient => recipient.username === profile.username);
        const inDialogue = q.author === profile.username || !!self && (!!self.sessionId || self.answers.length > 0 || self.state !== 'pending');
        let suggested = false;
        if (q.author === profile.username) for (const recipient of q.recipients) {
          if (!recipient.endSuggestedAt) continue;
          const key = q.id + ':' + recipient.username;
          if (inbox.suggestSeen?.[key]) continue;
          (inbox.suggestSeen ||= {})[key] = true; suggested = true;
          const dialogue = inbox.dialogues?.find(item => item.questionId === q.id && item.peer === recipient.username);
          if (dialogue) dialogue.suggested = true;
        }
        if ((inbox.notified[q.id] || 0) < q.activityRevision) {
          const prior = inbox.notified[q.id]; inbox.notified[q.id] = q.activityRevision;
          if (q.closedAt && prior && inDialogue) this.hooks.notice(`问题已关闭：${q.title}`);
          else if (!q.closedAt && suggested) this.hooks.notice(`自动对话建议结束：${q.title}`);
          else if (!q.closedAt && (q.author !== profile.username && !prior || q.author === profile.username && q.recipients.some(r => r.answers.length))) this.hooks.notice(q.author === profile.username ? `收到问题答复：${q.title}` : `收到提问：${q.title}`);
        } else if (suggested) this.hooks.notice(`自动对话建议结束：${q.title}`);
        const seenFollows = inbox.followSeen?.[q.id] || 0, follows = q.followUps?.length || 0;
        if (q.author !== profile.username && seenFollows > 0 && follows > seenFollows) this.hooks.notice(`问题有后续：${q.title}`);
        (inbox.followSeen ||= {})[q.id] = follows;
        this.queueContinuation(inbox, q, profile.username);
        const ids = q.author === profile.username ? [q.sessionId, ...(inbox.dialogues || []).filter(item => item.questionId === q.id).map(item => item.sessionId)] : q.recipients.filter(r => r.username === profile.username).flatMap(r => r.sessionId ? [r.sessionId] : []);
        for (const id of ids) { const session = this.store.sessions.find(s => s.id === id && s.binding && accountIdentity(s.binding) === owner && s.binding.project.id === q.projectId); if (session && !session.closedAt) await this.reference(session, q); }
      }
      for (const job of inbox.jobs) {
        if (owner !== this.owner() || this.stopped) return;
        const q = inbox.items.find(q => q.id === job.questionId);
        if (!q || q.closedAt) { if (!['sent', 'error', 'tracked'].includes(job.phase)) job.phase = 'closed'; continue; }
        if (job.phase === 'ready' && job.mode && job.mode !== 'answer') { job.phase = 'tracked'; continue; }
        if (job.phase === 'ready' && job.answer) {
          try { await this.request(job.projectId, { kind: 'reply', id: job.questionId, runId: job.runId, body: job.answer }); job.phase = 'sent'; job.error = undefined; }
          catch (e: any) { job.error = e.message; } // Delivery retry keeps the exact same answer ID.
        } else if (job.phase === 'error' && !job.released) {
          const own = q.recipients.find(r => r.username === profile.username);
          if (own?.state !== 'running' || own.runId !== job.runId) job.released = true;
          else await this.request(job.projectId, { kind: 'fail', id: job.questionId, runId: job.runId }).then(() => { job.released = true; }).catch(() => {});
        } else if (job.phase === 'queued' && !this.active.has(job.sessionId)) {
          const s = this.store.sessions.find(s => s.id === job.sessionId && s.binding && accountIdentity(s.binding) === owner);
          if (!s || s.closedAt) { job.phase = 'error'; job.error = '关联 Session 已关闭，请选择其他 Session'; continue; }
          if (job.mode === 'auto' && (this.autoRunning || inbox.jobs.some(other => other !== job && other.mode === 'auto' && other.phase === 'running'))) continue;
          if (['running', 'starting', 'approval'].includes(s.status) || inbox.jobs.some(other => other !== job && other.sessionId === s.id && other.phase === 'running')) continue;
          this.active.add(s.id); if (job.mode === 'auto') this.autoRunning = true;
          void this.start(job, q, owner).finally(() => { this.active.delete(s.id); if (job.mode === 'auto') { this.autoRunning = false; void this.sync().catch(() => {}); } }).catch(() => {});
        }
      }
      await this.save(); this.hooks.changed();
    } catch (e: any) { if (owner === this.owner()) { inbox.error = e.message; this.hooks.changed(); } }
  }
  private queueContinuation(inbox: SavedInbox, q: TeamQuestion, username: string) {
    if (q.closedAt) return;
    const known = new Set(inbox.jobs.filter(job => job.questionId === q.id).flatMap(job => [job.sourceId, ...(job.covered || [])]).filter((id): id is string => !!id));
    const open = (sessionId?: string) => !!sessionId && this.store.sessions.some(session => session.id === sessionId && !session.closedAt && session.binding && accountIdentity(session.binding) === this.owner());
    if (q.author === username) {
      for (const dialogue of inbox.dialogues || []) {
        if (dialogue.questionId !== q.id || dialogue.suggested || !open(dialogue.sessionId)) continue;
        const peer = q.recipients.find(recipient => recipient.username === dialogue.peer);
        if (!peer || peer.endSuggestedAt) continue;
        const seenOnSession = new Set(inbox.jobs.filter(job => job.questionId === q.id && job.sessionId === dialogue.sessionId).map(job => job.sourceId));
        for (const answer of peer.answers) {
          if (seenOnSession.has(answer.id)) continue;
          inbox.jobs.push({ questionId: q.id, projectId: q.projectId, sessionId: dialogue.sessionId, runId: randomUUID(), phase: 'queued', mode: 'auto', sourceId: answer.id, peer: peer.username });
          seenOnSession.add(answer.id);
        }
      }
      return;
    }
    const own = q.recipients.find(recipient => recipient.username === username), sessionId = own?.sessionId;
    if (!sessionId || !open(sessionId) || own?.endSuggestedAt || inbox.replyModes?.[q.id] === 'manual') return;
    const pending = inbox.jobs.find(job => job.questionId === q.id && job.mode !== 'import' && job.mode !== 'auto' && job.mode !== 'ingest' && job.mode !== 'fill' && job.phase === 'queued');
    for (const follow of (q.followUps || []).filter(item => !item.target || item.target === username)) {
      if (known.has(follow.id)) continue;
      if (pending) { pending.covered = [...new Set([...(pending.covered || []), follow.id])]; known.add(follow.id); continue; }
      inbox.jobs.push({ questionId: q.id, projectId: q.projectId, sessionId, runId: randomUUID(), phase: 'queued', mode: 'answer', sourceId: follow.id, covered: [follow.id], peer: username });
      known.add(follow.id);
    }
  }
  private async start(job: QuestionJob, q: TeamQuestion, owner: string) {
    try {
      const incoming = job.mode === 'import' || job.mode === 'auto' || job.mode === 'ingest';
      if (job.mode === 'fill') {
        if (owner !== this.owner() || this.stopped) return;
        job.phase = 'running'; await this.save(); this.hooks.changed();
        const peer = q.recipients.find(item => item.username === job.peer);
        const lines = [...(q.followUps || []).filter(item => !item.target || item.target === job.peer).map(item => ({ at: item.createdAt, text: `发问人：${item.body}` })), ...(peer?.answers || []).map(item => ({ at: item.createdAt, text: `${peer?.name || '对方'}：${item.body}` }))].sort((a, b) => a.at.localeCompare(b.at));
        const text = `问题：${q.title}\n${q.body}${q.context ? `\n\n附带资料：\n${q.context}` : ''}${lines.length ? `\n\n已有往来：\n${lines.map(item => item.text).join('\n\n')}` : ''}`;
        const sent = await this.hooks.send(job.sessionId, text, job.runId, fillFollowNotice(peer?.name || job.peer || '对方'), true);
        if (!sent && job.phase === 'running') throw new Error('没有起草出继续提问，请检查 Session');
        return;
      }
      if (!incoming) await this.request(job.projectId, { kind: 'run', id: job.questionId, sessionId: job.sessionId, runId: job.runId });
      if (owner !== this.owner() || this.stopped) return;
      job.phase = 'running'; await this.save(); this.hooks.changed();
      const followIds = new Set(job.covered || []);
      const follows = (q.followUps || []).filter(item => followIds.has(item.id) && (!item.target || item.target === job.peer));
      const reply = q.recipients.flatMap(recipient => recipient.answers.map(answer => ({ ...answer, name: recipient.name, username: recipient.username }))).find(answer => answer.id === job.sourceId);
      if (incoming && !reply) throw new Error('要接入的回复已不存在');
      const text = incoming
        ? `问题：${q.title}\n回复人：${reply!.name}\n${reply!.body}`
        : `问题：${q.title}\n${q.body}\n\n附带资料：\n${q.context}${follows.length ? `\n\n同一问题的后续信息：\n${follows.map(item => item.body).join('\n\n')}` : ''}`;
      const notice = incoming ? (job.mode === 'auto' ? autoDialogueNotice(reply!.name) : '') + incomingReplyNotice(reply!.name) : follows.length && job.sourceId !== 'origin' ? incomingFollowNotice(q.authorName) : incomingQuestionNotice(q.authorName);
      const sent = await this.hooks.send(job.sessionId, text, job.runId, notice);
      if (!sent && job.phase === 'running') throw new Error('本轮回答未完成，请检查 Session');
    } catch (e: any) { if (job.phase === 'running' || job.phase === 'queued') { job.phase = 'error'; job.error = e.message; } await this.save(); this.hooks.changed(); }
  }
  async completed(session: AgentSession) {
    // Completion can arrive during reconnect/account switching; persist to the
    // original account's outbox and deliver only when that account is active.
    const inbox = session.binding && this.buckets[accountIdentity(session.binding)]; if (!inbox) return;
    let lastUser = session.messages.length - 1;
    while (lastUser >= 0 && (session.messages[lastUser].role !== 'user' || session.messages[lastUser].steering)) lastUser--;
    const runId = session.messages[lastUser]?.context?.questionRunId;
    const job = inbox.jobs.find(j => j.sessionId === session.id && j.runId === runId && j.phase === 'running');
    const answer = session.messages.slice(lastUser + 1).filter(m => m.role === 'assistant' && !m.kind).at(-1)?.text.trim();
    const failed = session.closedAt || session.error || session.stoppedAt;
    if (!job) {
      if (!failed && this.rememberSessionFill(inbox, session, answer || '')) { await this.save(); this.hooks.changed(); }
      return;
    }
    if (job.mode === 'fill') {
      const body = withoutQuestionControl(answer || '').trim();
      if (failed || !body) { job.phase = 'error'; job.error = session.error || '没有起草出继续提问'; }
      else { job.answer = body.slice(0, 12000); job.phase = 'tracked'; this.rememberFill(inbox, job.questionId, job.peer, job.answer); }
      await this.save(); this.hooks.changed(); void this.sync().catch(() => {}); return;
    }
    if (job.mode === 'import' || job.mode === 'ingest') {
      job.phase = failed ? 'error' : 'tracked';
      if (job.phase === 'error') job.error = session.error || '回复引入已停止';
      else { const control = questionControl(answer || ''); if (control.kind === 'continue') this.rememberFill(inbox, job.questionId, job.peer, control.body); }
      await this.save(); this.hooks.changed(); void this.sync().catch(() => {}); return;
    }
    if (job.mode === 'auto') {
      const dialogue = inbox.dialogues?.find(item => item.questionId === job.questionId && item.peer === job.peer);
      const control = questionControl(answer || '');
      if (failed || !answer) { job.phase = 'error'; job.error = session.error || '自动对话已停止'; }
      else if (control.kind === 'end') {
        job.phase = 'tracked';
        if (dialogue) dialogue.suggested = true;
        for (const other of inbox.jobs) if (other !== job && other.mode === 'auto' && other.questionId === job.questionId && other.peer === job.peer && other.phase === 'queued') other.phase = 'closed';
        if (job.peer) await this.request(job.projectId, { kind: 'suggest', id: job.questionId, username: job.peer }).catch((error: any) => { job.error = error.message; });
      } else if (control.kind === 'continue' && control.body && dialogue && !dialogue.suggested) {
        job.phase = 'tracked';
        this.rememberFill(inbox, job.questionId, job.peer, control.body);
        await this.follow(job.projectId, job.questionId, randomUUID(), control.body, job.peer).catch((error: any) => { job.phase = 'error'; job.error = error.message; });
      } else job.phase = 'tracked';
      await this.save(); this.hooks.changed(); void this.sync().catch(() => {}); return;
    }
    const control = questionControl(answer || '');
    const body = control.kind === 'end' ? (control.body || '我认为这条提问可以结束。') : answer;
    if (failed || !body) { job.phase = 'error'; job.error = session.error || '回答已停止或没有生成答案'; }
    else if (body.length > 48000) { job.phase = 'error'; job.error = '答案过长，请在 Session 中精简后重新回答'; }
    else { job.answer = body; job.phase = 'ready'; if (control.kind === 'end' && job.peer) await this.request(job.projectId, { kind: 'suggest', id: job.questionId, username: job.peer }).catch((error: any) => { job.error = error.message; }); }
    await this.save(); this.hooks.changed(); void this.sync().catch(() => {});
  }
  async sessionStopped(session: AgentSession) {
    const inbox = session.binding && this.buckets[accountIdentity(session.binding)]; if (!inbox) return;
    for (const job of inbox.jobs) if (job.sessionId === session.id && ['queued', 'running'].includes(job.phase)) { job.phase = 'error'; job.error = '关联 Session 已停止，请检查结果后重新回答'; }
    await this.save(); this.hooks.changed(); void this.sync().catch(() => {});
  }
  async close() { this.stopped = true; clearInterval(this.timer); await this.polling?.catch(() => {}); await Promise.allSettled(this.references.values()); await this.saving; }
}
