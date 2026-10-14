import { z } from 'zod';

export interface QuestionMember { username: string; name: string }
export interface QuestionAnswer { id: string; body: string; createdAt: string }
export interface QuestionFollowUp { id: string; body: string; createdAt: string; target?: string }
export interface QuestionRecipient extends QuestionMember {
  sessionId?: string; state: 'pending' | 'linked' | 'running' | 'replied'; runId?: string; activityRevision: number;
  answers: QuestionAnswer[]; endSuggestedAt?: string;
}
export interface TeamQuestion {
  id: string; projectId: string; author: string; authorName: string; sessionId: string;
  title: string; body: string; context: string; createdAt: string; updatedAt: string; revision: number; activityRevision: number;
  closedAt?: string; followUps?: QuestionFollowUp[]; recipients: QuestionRecipient[]; recipientCount: number;
}
const uuid = z.string().uuid();
export const questionCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), id: uuid, sessionId: uuid, title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(12000), context: z.string().max(24000).default(''), recipients: z.array(z.string().min(1).max(160)).min(1).max(50).refine(a => new Set(a).size === a.length) }),
  z.object({ kind: z.literal('link'), id: uuid, sessionId: uuid }),
  z.object({ kind: z.literal('run'), id: uuid, sessionId: uuid, runId: uuid }),
  z.object({ kind: z.literal('reply'), id: uuid, runId: uuid, body: z.string().trim().min(1).max(48000) }),
  z.object({ kind: z.literal('fail'), id: uuid, runId: uuid }),
  z.object({ kind: z.literal('follow'), id: uuid, followId: uuid, body: z.string().trim().min(1).max(12000), target: z.string().trim().min(1).max(160).optional() }),
  z.object({ kind: z.literal('suggest'), id: uuid, username: z.string().trim().min(1).max(160) }),
  z.object({ kind: z.literal('resume'), id: uuid, username: z.string().trim().min(1).max(160) }),
  z.object({ kind: z.literal('close'), id: uuid }),
]);
export type QuestionCommand = z.infer<typeof questionCommandSchema>;
export function questionView(question: TeamQuestion, username: string): TeamQuestion | undefined {
  if (question.author === username) return structuredClone(question);
  const own = question.recipients.find(r => r.username === username);
  if (own) {
    const copy = structuredClone(question);
    return { ...copy, sessionId: '', activityRevision: own.activityRevision, recipients: [structuredClone(own)], followUps: copy.followUps?.filter(item => !item.target || item.target === username) };
  }
}
/** Called under the storage lock; replies never replace another recipient's answers. */
export function changeQuestion(items: TeamQuestion[], projectId: string, actor: QuestionMember, members: QuestionMember[], raw: QuestionCommand, at: string) {
  const command = questionCommandSchema.parse(raw), existing = items.find(q => q.id === command.id);
  if (command.kind === 'create') {
    if (existing) {
      if (existing.author !== actor.username || existing.sessionId !== command.sessionId || existing.title !== command.title || existing.body !== command.body || existing.context !== command.context || JSON.stringify(existing.recipients.map(r => r.username)) !== JSON.stringify(command.recipients)) throw new Error('问题编号已使用');
      return existing;
    }
    const recipients = command.recipients.map(username => {
      const member = members.find(m => m.username === username);
      if (!member || username === actor.username) throw new Error('请选择当前用户组的其他有效成员');
      return { ...member, state: 'pending' as const, activityRevision: 1, answers: [] };
    });
    const question: TeamQuestion = { ...command, projectId, author: actor.username, authorName: actor.name, recipients, recipientCount: recipients.length, revision: 1, activityRevision: 1, createdAt: at, updatedAt: at };
    delete (question as any).kind;
    items.push(question); return question;
  }
  if (!existing || !questionView(existing, actor.username)) throw new Error('问题不存在或无权访问');
  if (command.kind === 'close' || command.kind === 'follow' || command.kind === 'suggest' || command.kind === 'resume') {
    const named = (username: string) => existing.recipients.find(recipient => recipient.username === username);
    if (command.kind === 'close') {
      const recipient = named(actor.username);
      const inDialogue = !!recipient && (!!recipient.sessionId || recipient.answers.length > 0 || recipient.state !== 'pending');
      if (existing.author !== actor.username && !inDialogue) throw new Error('只有发问人或已参与对话的回答者可以结束提问');
      if (existing.closedAt) return existing;
      existing.closedAt = at;
    } else if (command.kind === 'follow') {
      if (existing.author !== actor.username) throw new Error('只有发问人可以继续同一问题');
      if (existing.closedAt) throw new Error('问题已关闭，不能继续补充');
      if (command.target && !named(command.target)) throw new Error('后续信息的接收人不存在');
      const follows = existing.followUps ||= [];
      const prior = follows.find(item => item.id === command.followId);
      if (prior) { if (prior.body !== command.body || (prior.target || '') !== (command.target || '')) throw new Error('后续信息编号已使用'); return existing; }
      follows.push({ id: command.followId, body: command.body, createdAt: at, ...(command.target ? { target: command.target } : {}) });
      if (command.target) delete named(command.target)!.endSuggestedAt;
    } else if (command.kind === 'suggest') {
      const recipient = named(command.username);
      if (!recipient) throw new Error('对话成员不存在');
      if (existing.author !== actor.username && actor.username !== command.username) throw new Error('只有发问人或这位回答者可以建议结束');
      if (existing.closedAt) throw new Error('问题已关闭');
      if (recipient.endSuggestedAt) return existing;
      recipient.endSuggestedAt = at;
    } else {
      if (existing.author !== actor.username) throw new Error('只有发问人可以继续自动对话');
      const recipient = named(command.username);
      if (!recipient) throw new Error('对话成员不存在');
      if (existing.closedAt) throw new Error('问题已关闭');
      if (!recipient.endSuggestedAt) return existing;
      delete recipient.endSuggestedAt;
    }
  } else {
    const recipient = existing.recipients.find(r => r.username === actor.username);
    if (!recipient) throw new Error('只有指定接收人可以回答');
    if (command.kind === 'reply') { const prior = recipient.answers.find(a => a.id === command.runId); if (prior) { if (prior.body !== command.body) throw new Error('答复编号已使用'); return existing; } }
    if (existing.closedAt) throw new Error('问题已关闭，答案保留在自己的 Session 中，不再回传');
    if (command.kind === 'link') {
      if (recipient.state === 'running') throw new Error('此问题正在回答，不能更换关联');
      if (recipient.sessionId === command.sessionId) return existing;
      recipient.sessionId = command.sessionId; recipient.state = 'linked';
    } else if (command.kind === 'run') {
      if (recipient.sessionId !== command.sessionId) throw new Error('Session 关联已改变');
      if (recipient.runId === command.runId) return existing;
      if (recipient.state === 'running') throw new Error('此问题已在其他窗口回答中');
      recipient.runId = command.runId; recipient.state = 'running';
    } else {
      if (recipient.runId !== command.runId) throw new Error('答复不属于当前回答轮次');
      if (command.kind === 'reply') { recipient.answers.push({ id: command.runId, body: command.body, createdAt: at }); recipient.state = 'replied'; }
      else if (recipient.state === 'running') recipient.state = 'linked';
      else return existing;
    }
  }
  existing.revision++;
  if (command.kind === 'reply' || command.kind === 'close' || command.kind === 'follow' || command.kind === 'suggest' || command.kind === 'resume') {
    existing.activityRevision = existing.revision;
    for (const recipient of existing.recipients) {
      const dialogue = !!recipient.sessionId || recipient.answers.length > 0 || recipient.state !== 'pending';
      const include = command.kind === 'close' ? dialogue : command.kind === 'follow' ? !command.target || recipient.username === command.target : command.kind === 'reply' ? recipient.username === actor.username : recipient.username === command.username;
      if (include) recipient.activityRevision = existing.revision;
    }
  }
  existing.updatedAt = at; return existing;
}
export interface QuestionJob { questionId: string; projectId: string; sessionId: string; runId: string; phase: 'queued' | 'running' | 'ready' | 'sent' | 'error' | 'closed' | 'tracked'; mode?: 'answer' | 'import' | 'auto' | 'ingest'; sourceId?: string; covered?: string[]; peer?: string; answer?: string; error?: string; released?: boolean }
export interface QuestionDialogue { questionId: string; projectId: string; peer: string; sessionId: string; mode: 'auto'; suggested?: boolean }
export interface QuestionInbox { items: TeamQuestion[]; read: Record<string, number>; jobs: QuestionJob[]; dialogues?: QuestionDialogue[]; error?: string }
