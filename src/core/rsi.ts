import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicJson } from './store';
import type { TextTask } from './background-text';
import type { AgentSession } from '../shared/types';
import { applyMemory, emptyMemory, evidenceKey, latestProjectEvidence, pendingEvidence, projectContext } from './rsi-context';
import { candidateBundle, learningPrompt, policyBundle, policyPrompt } from './rsi-prompts';
import { assertLearningCurrent, learningReference } from './rsi-learning';
import { rsiAnswerSchema, rsiCaseSchema, rsiConfigSchema, rsiDefaultRules, rsiPolicySchema, rsiReactionSchema, rsiShadowSettingsSchema, rsiReview, rsiFeedbackState, type RsiInbox,
  type RsiAnswer, type RsiCase, type RsiConfig, type RsiEvaluation, type RsiEvidence, type RsiObservation,
  type RsiPolicy, type RsiProject, type RsiScope, type RsiScore, type RsiView } from '../shared/rsi';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = () => new Date().toISOString();
const parse = (value: string) => JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
const busy = (session: AgentSession) => ['starting', 'running', 'approval'].includes(session.status);
const modelKey = (session: AgentSession) => `${session.provider}/${session.model || 'default'}/${session.reasoningEffort || 'default'}`;
const atOrBefore = (value: string, cutoff: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.parse(cutoff);
function contextSettings(config: RsiConfig) {
  const limit = Math.floor(config.contextChars / 10);
  return { goals: config.goals.slice(0, limit), acceptance: config.acceptance.slice(0, limit), role: config.role.slice(0, limit), preference: config.preference.slice(0, limit) };
}
export interface RsiHost {
  scope(projectId: string): RsiScope;
  session(projectId: string): AgentSession | undefined;
  sessions?(projectId: string): AgentSession[];
  collect(projectId: string): Promise<RsiObservation[]>;
  changed(): void;
  execution?(projectId: string, config: RsiConfig): AgentSession;
  resolveExecution?(session: AgentSession): Promise<AgentSession>;
}
export function rsiContext(evidence: RsiEvidence[], config: RsiConfig, rules: RsiPolicy['rules'], cutoff = iso()) {
  const eligible = evidence.filter(item => atOrBefore(item.eventAt, cutoff) && atOrBefore(item.observedAt, cutoff) && item.source !== 'evaluation');
  // Prefer the latest available revision of a source; independent corroboration remains separate.
  const latest = new Map<string, RsiEvidence>();
  for (const item of eligible) { const key = item.source + ':' + item.sourceId; if (!latest.has(key) || latest.get(key)!.observedAt <= item.observedAt) latest.set(key, item); }
  const rank = (item: RsiEvidence) => rules.retrieval === 'goal-first' ? Number(item.source === 'configuration' || item.source === 'project') : rules.retrieval === 'failures-first' ? Number(/失败|错误|未达标|failure|error/i.test(item.text)) : 0;
  const sorted = [...latest.values()].sort((a, b) => rank(b) - rank(a) || b.observedAt.localeCompare(a.observedAt));
  const selected: RsiEvidence[] = [];
  let remaining = config.contextChars - JSON.stringify(contextSettings(config)).length - 64;
  for (const item of sorted) {
    if (remaining < 300 || selected.length >= 40) break;
    const bounded = { ...item, text: item.text.slice(0, Math.min(3500, remaining - 250)) };
    const size = JSON.stringify(bounded).length;
    if (size > remaining) continue;
    selected.push(bounded); remaining -= size;
  }
  return selected;
}
export function rsiPrompt(evidence: RsiEvidence[], config: RsiConfig, rules: RsiPolicy['rules']) {
  return policyPrompt({ rules }, JSON.stringify({ ...contextSettings(config), evidence }));
}
export function validateRsiAnswer(raw: unknown, evidence: RsiEvidence[], max: number): RsiAnswer {
  const answer = rsiAnswerSchema.parse(raw), ids = new Set(evidence.map(item => item.id));
  if (answer.suggestions.length > max) answer.suggestions = answer.suggestions.slice(0, max);
  for (const id of [...answer.state.evidenceIds, ...answer.suggestions.flatMap(item => item.evidenceIds)]) if (!ids.has(id)) throw new Error('Agent 引用了本次输入之外的证据，建议未发布');
  if (new Set(answer.sessionStates.map(state => state.sessionId)).size !== answer.sessionStates.length) throw new Error('会话摘要重复，无法确定应保存的状态');
  for (const state of answer.sessionStates) if (!state.evidenceIds.every(id => evidence.some(item => item.id === id && item.sessionId === state.sessionId))) throw new Error('会话摘要引用了其他会话或未提供的证据');
  return answer;
}
export function scoreRsi(answer: RsiAnswer, test: RsiCase): RsiScore {
  const text = answer.suggestions.map(item => item.title + '\n' + item.action).join('\n').toLowerCase();
  const found = test.required.filter(term => text.includes(term.toLowerCase())).length;
  const violations = test.forbidden.filter(term => text.includes(term.toLowerCase())).length;
  const omission = test.shouldSuggest && !answer.suggestions.length ? 1 : 0;
  const interruption = !test.shouldSuggest && !!answer.suggestions.length ? 1 : 0;
  const quality = test.shouldSuggest ? (test.required.length ? found / test.required.length : Number(!!text)) : Number(!text);
  return { quality, omissions: omission, interruptions: interruption, violations, chars: JSON.stringify(answer).length };
}
function sumScores(scores: RsiScore[]): RsiScore {
  return scores.reduce((out, value) => ({ quality: out.quality + value.quality / scores.length, omissions: out.omissions + value.omissions, interruptions: out.interruptions + value.interruptions, violations: out.violations + value.violations, chars: out.chars + value.chars }), { quality: 0, omissions: 0, interruptions: 0, violations: 0, chars: 0 });
}

/** Local, account-owned evidence ledger. This never writes shared files or sends user messages. */
export class RsiEngine {
  private projects: Record<string, RsiProject> = {};
  private preferences: Record<string, { text: string; at: string }> = {};
  private readyTask?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, { stage: string; promise: Promise<void>; controller: AbortController }>();
  private pending = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private draining = false;
  private closed = false;
  constructor(private root: string, private host: RsiHost, public runText: TextTask, private timing = { debounceMs: 25000, retryMs: 60000 }) {}
  get busy() { return this.jobs.size > 0; }
  private async ready() {
    if (!this.readyTask) this.readyTask = (async () => {
      const file = path.join(this.root, 'rsi-v2.json');
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (![2, 3].includes(saved.version) || !saved.projects || typeof saved.projects !== 'object') throw new Error('项目助手数据格式不兼容');
        if (saved.version === 2) await fs.copyFile(file, file + '.v2-backup', 1).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
        this.projects = saved.projects;
        this.preferences = saved.preferences || {};
        for (const project of Object.values(this.projects)) {
          // Older releases also persisted untouched defaults while collecting evidence.
          // Upgrade those defaults, but preserve explicit settings and quiet mode.
          if (project.config.enabled === false && !project.settingsConfigured && !project.config.quiet && !project.evidence.some(item => item.source === 'configuration' && item.sourceId === 'explicit-project-settings' && item.assertion === 'explicit')) project.config.enabled = true;
          project.config = rsiConfigSchema.parse(project.config);
          project.memory ||= emptyMemory();
          for (const policy of project.policies) {
            rsiPolicySchema.parse(policy.rules); policy.bundle ||= policyBundle();
            if (policy.bundle.contract !== 1) throw new Error('AI推荐策略协议不兼容，原策略已保留');
          }
          for (const run of project.runs) if (run.status === 'running') { run.status = 'interrupted'; run.error = '上次运行已中断，可重新分析；不会自动重复调用。'; }
        }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    })();
    await this.readyTask;
  }
  private project(projectId: string) {
    const scope = this.host.scope(projectId);
    let project = this.projects[scope.key];
    if (!project) {
      const base: RsiPolicy = { id: randomUUID(), createdAt: iso(), rules: structuredClone(rsiDefaultRules), bundle: policyBundle(), hypothesis: '初始策略', evidenceIds: [], status: 'active', scope: 'user-project' };
      project = this.projects[scope.key] = { scope, config: rsiConfigSchema.parse({}), memory: emptyMemory(), revision: 0, evidence: [], events: [], suggestions: [], runs: [], policies: [base], activePolicyId: base.id, cases: [], evaluations: [], releases: [], calls: [] };
    }
    if (project.scope.account !== scope.account || project.scope.user !== scope.user || project.scope.projectId !== scope.projectId) throw new Error('项目助手身份不匹配');
    // One-time migration only. Later foreground-session choices never change this project setting.
    if (this.host.execution && !project.config.execution) {
      const prior = this.host.session(projectId);
      project.config.execution = { provider: prior?.provider || 'codex', model: prior?.model || '', reasoningEffort: prior?.reasoningEffort, networkRoute: prior?.networkRoute || 'direct' };
    }
    return project;
  }
  private execution(projectId: string) {
    const project = this.project(projectId);
    return this.host.execution ? this.host.execution(projectId, project.config) : this.host.session(projectId);
  }
  private async edit<T>(projectId: string, apply: (project: RsiProject) => T): Promise<T> {
    await this.ready();
    const work = this.writes.catch(() => {}).then(async () => {
      const project = this.project(projectId), before = structuredClone(this.projects), preferences = structuredClone(this.preferences);
      try { const result = apply(project); await atomicJson(path.join(this.root, 'rsi-v2.json'), { version: 3, projects: this.projects, preferences: this.preferences }); this.host.changed(); return structuredClone(result); }
      catch (error) { this.projects = before; this.preferences = preferences; throw error; }
    });
    this.writes = work.then(() => {}, () => {}); return work;
  }
  async view(projectId: string): Promise<RsiView> {
    await this.ready(); await this.writes;
    const project = this.project(projectId);
    const reusablePolicies: RsiView['reusablePolicies'] = [];
    for (const source of Object.values(this.projects)) {
      if (source.scope.key === project.scope.key || source.scope.account !== project.scope.account) continue;
      try { if (this.host.scope(source.scope.projectId).key !== source.scope.key) continue; } catch { continue; }
      const policy = source.policies.find(item => item.id === source.activePolicyId)!;
      if (!source.evaluations.some(item => item.candidateId === policy.id && item.passed)) continue;
      reusablePolicies.push({ projectId: source.scope.projectId, policyId: policy.id, guidance: policy.rules.guidance, validatedProjects: this.proofs(policy).size });
    }
    const source = this.execution(projectId), sourceSession = source ? { id: source.id, title: source.title, provider: source.provider, model: source.model, reasoningEffort: source.reasoningEffort } : undefined;
    return structuredClone({ ...project, sourceSession, personalPreference: this.preferences[project.scope.account]?.text || '', reusablePolicies, busy: this.jobs.has(project.scope.key), stage: this.jobs.get(project.scope.key)?.stage, queued: !!(project.pending?.recommendation || project.pending?.learning) });
  }
  private proofs(policy: RsiPolicy) {
    const family = policy.familyId || policy.id, projects = new Set<string>();
    for (const project of Object.values(this.projects)) for (const item of project.policies) if ((item.familyId || item.id) === family && project.evaluations.some(evaluation => evaluation.candidateId === item.id && evaluation.passed) && project.releases.some(release => release.to === item.id && release.evaluationId)) projects.add(project.scope.key);
    return projects;
  }
  private linkableSessions(projectId: string) {
    const sessions = this.host.sessions?.(projectId) ?? [this.host.session(projectId)].filter((item): item is AgentSession => !!item);
    return sessions.filter(item => item.purpose === 'work' && !item.closedAt);
  }
  async inbox(projectId: string): Promise<RsiInbox> {
    const view = await this.view(projectId), sessions = this.linkableSessions(projectId);
    return { projectId, enabled: view.config.enabled && !view.config.quiet, busy: view.busy, queued: view.queued, lastError: view.lastError,
      sessions: sessions.map(({ id, title }) => ({ id, title })),
      items: [...view.suggestions].reverse().map(suggestion => ({ ...suggestion, review: rsiReview(suggestion.id, view.events),
        evidence: suggestion.evidenceIds.map(id => view.evidence.find(item => item.id === id)).filter((item): item is RsiEvidence => !!item).map(({ id, source, text, eventAt }) => ({ id, source, text: text.slice(0, 3500), eventAt })) })).filter(item => !item.review.closed) };
  }
  private effectiveConfig(project: RsiProject): RsiConfig {
    const preference = this.preferences[project.scope.account]?.text;
    return { ...project.config, preference: [project.config.preference, preference && '用户明确声明的长期偏好：' + preference].filter(Boolean).join('\n') };
  }
  async personalPreference(projectId: string, text: string) {
    if (text.length > 2000) throw new Error('长期偏好最多 2000 字符');
    return this.edit(projectId, project => {
      this.preferences[project.scope.account] = { text: text.trim(), at: iso() };
      for (const item of Object.values(this.projects)) if (item.scope.account === project.scope.account) item.revision++;
      return text.trim();
    });
  }
  async reuse(projectId: string, sourceProjectId: string, policyId: string) {
    this.host.scope(sourceProjectId);
    return this.edit(projectId, project => {
      const source = this.project(sourceProjectId), policy = source.policies.find(item => item.id === policyId && item.status === 'active');
      if (source.scope.account !== project.scope.account || source.scope.key === project.scope.key || !policy || !source.evaluations.some(item => item.candidateId === policyId && item.passed)) throw new Error('只能复用同账号可访问项目中已通过评估的策略');
      const id = randomUUID(), at = iso(), evidenceId = hash([project.scope.key, id]);
      project.evidence.push({ id: evidenceId, scope: project.scope.key, source: 'project', sourceId: id, factKey: `${sourceProjectId}/${policyId}`, eventAt: at, observedAt: at, version: policyId, text: `用户请求验证来自项目 ${sourceProjectId} 的已发布策略：${policy.rules.guidance}`, hash: hash(policy.rules), assertion: 'explicit', actor: project.scope.user });
      const candidate: RsiPolicy = { id, createdAt: at, baseId: project.activePolicyId, bundle: structuredClone(policy.bundle), familyId: policy.familyId || policy.id, origin: { projectId: sourceProjectId, policyId }, rules: structuredClone(policy.rules), hypothesis: '复用另一项目的经验，需在当前项目独立评估适用性', evidenceIds: [evidenceId], status: 'candidate', scope: 'user-project' };
      candidate.heldOutCaseIds = project.cases.map(item => item.id);
      project.policies.push(candidate); project.revision++; return candidate;
    });
  }
  async configure(projectId: string, input: unknown) {
    const parsed = rsiConfigSchema.partial().strict().parse(input);
    // Zod defaults can still materialize through optional fields; only caller-supplied keys are a patch.
    const patch = Object.fromEntries(Object.keys(input as object).map(key => [key, parsed[key as keyof typeof parsed]]));
    return this.updateConfig(projectId, previous => rsiConfigSchema.parse({ ...previous, ...patch }));
  }
  async configureShadow(projectId: string, input: unknown) {
    const patch = rsiShadowSettingsSchema.parse(input);
    return this.updateConfig(projectId, config => ({ ...config, ...patch, quiet: false }));
  }
  private async updateConfig(projectId: string, update: (config: RsiConfig) => RsiConfig) {
    const result = await this.edit(projectId, project => { project.config = update(project.config); project.settingsConfigured = true; project.revision++; return project.config; });
    if (!result.enabled) { this.pending.delete(projectId); this.jobs.get(this.host.scope(projectId).key)?.controller.abort(); await this.edit(projectId, project => { project.pending = {}; }); }
    await this.observe(projectId, [{ source: 'configuration', sourceId: 'explicit-project-settings', factKey: 'explicit-project-settings', version: hash(result), eventAt: iso(), actor: this.host.scope(projectId).user, assertion: 'explicit', text: JSON.stringify(result) }]);
    if (result.enabled && !result.quiet) this.enqueue(projectId, 'settings');
    return result;
  }
  async observe(projectId: string, inputs: RsiObservation[]) {
    await this.ready(); await this.writes;
    const current = new Map(this.project(projectId).evidence.map(item => [evidenceKey(item), item]));
    if (inputs.every(input => { const prior = current.get(`${input.source}:${input.sourceId}`); return prior?.version === input.version && prior.text === input.text; })) return [];
    return this.edit(projectId, project => {
      const added: string[] = [];
      const latest = new Map(project.evidence.map(item => [evidenceKey(item), item]));
      for (const input of inputs) {
        const key = `${input.source}:${input.sourceId}`, prior = latest.get(key);
        if (prior?.version === input.version && prior.text === input.text) continue;
        const id = hash([project.scope.key, input.source, input.sourceId, input.version, input.text, prior?.id]);
        // IDs, scope and collection time are always supplied by the harness, not the model.
        project.evidence.push({ ...structuredClone(input), id, scope: project.scope.key, observedAt: iso(), hash: hash(input.text), supersedes: prior?.id }); added.push(id);
        latest.set(key, project.evidence[project.evidence.length - 1]);
      }
      if (added.length) project.revision++;
      return added;
    });
  }
  async collect(projectId: string) {
    if (this.closed) return [];
    this.host.scope(projectId); const inputs = await this.host.collect(projectId);
    return this.closed ? [] : this.observe(projectId, inputs);
  }
  async forgetSession(projectId: string, sessionId: string) {
    const key = this.host.scope(projectId).key;
    this.pending.delete(projectId); const job = this.jobs.get(key); job?.controller.abort(); await job?.promise;
    await this.edit(projectId, project => {
      const removed = new Set(project.evidence.filter(item => item.sessionId === sessionId).map(item => item.id));
      const suggestions = new Set(project.suggestions.filter(item => item.sessionId === sessionId || item.evidenceIds.some(id => removed.has(id))).map(item => item.id));
      for (const item of project.evidence) if (suggestions.has(item.suggestionId || '')) removed.add(item.id);
      project.evidence = project.evidence.filter(item => !removed.has(item.id) && !suggestions.has(item.suggestionId || ''));
      if (project.memory) {
        delete project.memory.sessions[sessionId];
        for (const [key, cursor] of Object.entries(project.memory.analyzed)) if (removed.has(cursor.evidenceId)) delete project.memory.analyzed[key];
        if (project.memory.overview?.state.evidenceIds.some(id => removed.has(id))) delete project.memory.overview;
      }
      project.suggestions = project.suggestions.filter(item => !suggestions.has(item.id));
      project.events = project.events.filter(item => !suggestions.has(item.suggestionId));
      project.runs = project.runs.filter(item => !item.evidenceIds.some(id => removed.has(id)) && (!item.snapshot || !JSON.stringify(item.snapshot).includes(sessionId) && ![...removed].some(id => item.snapshot!.reference.includes(id))));
      const cases = new Set(project.cases.filter(item => item.evidence.some(evidence => removed.has(evidence.id))).map(item => item.id));
      project.cases = project.cases.filter(item => !cases.has(item.id));
      project.evaluations = project.evaluations.filter(item => !item.caseIds.some(id => cases.has(id)));
      // Derived strategies lose their evidence when the source session is deleted.
      const affected = new Set(project.policies.filter(item => [...item.evidenceIds, ...(item.sourceEvidenceIds || [])].some(id => removed.has(id))).map(item => item.id));
      let changed = true;
      while (changed) { changed = false; for (const policy of project.policies) if (policy.baseId && affected.has(policy.baseId) && !affected.has(policy.id)) { affected.add(policy.id); changed = true; } }
      project.policies = project.policies.filter(item => !affected.has(item.id));
      project.learningRuns = project.learningRuns?.filter(item => !item.evidenceIds.some(id => removed.has(id)) && !affected.has(item.baseId));
      project.evaluations = project.evaluations.filter(item => !affected.has(item.candidateId) && !affected.has(item.baselineId));
      project.releases = project.releases.filter(item => !affected.has(item.from) && !affected.has(item.to));
      if (affected.has(project.activePolicyId)) {
        const base = project.policies.find(item => !item.baseId)!;
        base.status = 'active'; project.activePolicyId = base.id;
      }
      project.revision++; project.lastError = undefined;
    });
  }
  async feedback(projectId: string, input: unknown) {
    const reaction = rsiReactionSchema.parse(input), scope = this.host.scope(projectId);
    if (['edited', 'feedback', 'action', 'outcome'].includes(reaction.kind) && !reaction.text) throw new Error('请补充原因、执行记录或结果依据');
    if (reaction.linkedSessionId !== undefined && reaction.kind !== 'supplement') throw new Error('请在补充信息中关联会话');
    if (reaction.feedbackTarget && !['accepted', 'rejected', 'feedback', 'supplement'].includes(reaction.kind)) throw new Error('推荐评价不能标记为执行记录或结果');
    if (reaction.outcome !== undefined && reaction.kind !== 'outcome') throw new Error('实际结果必须单独记录，不能由接受或反馈代替');
    const result = await this.edit(projectId, project => {
      const suggestion = project.suggestions.find(item => item.id === reaction.suggestionId);
      if (!suggestion) throw new Error('建议不属于当前项目');
      const duplicate = project.events.find(item => item.requestId === reaction.requestId);
      if (duplicate) { if (duplicate.suggestionId !== reaction.suggestionId || duplicate.kind !== reaction.kind || duplicate.text !== reaction.text || duplicate.linkedSessionId !== reaction.linkedSessionId || duplicate.outcome !== reaction.outcome || duplicate.feedbackTarget !== reaction.feedbackTarget || duplicate.expectedDecisionId !== reaction.expectedDecisionId) throw new Error('重复请求标识与原事件不同'); return duplicate; }
      const review = rsiReview(suggestion.id, project.events);
      if (reaction.expectedDecisionId !== undefined && reaction.expectedDecisionId !== (review.decisionEventId || null)) throw new Error('推荐的处理已更新，请核对最新状态后再保存');
      if (reaction.kind === 'supplement') {
        if (review.decision === 'pending') throw new Error('请先接受或拒绝这条推荐');
        if (reaction.linkedSessionId && (review.decision !== 'accepted' || reaction.linkedSessionId !== review.linkedSessionId && !this.linkableSessions(projectId).some(item => item.id === reaction.linkedSessionId))) throw new Error('只能为已接受的推荐关联当前账号在本项目中的开放工作会话');
      }
      const at = iso(), id = randomUUID(), evidenceId = hash([scope.key, id]);
      const decisionEventId = ['accepted', 'rejected'].includes(reaction.kind) ? id : rsiFeedbackState(suggestion.id, project.events).decision?.id;
      const event = { ...reaction, id, at, actor: scope.user, evidenceId, decisionEventId };
      project.events.push(event);
      const text = JSON.stringify({ ...reaction, decisionEventId });
      project.evidence.push({ id: evidenceId, scope: scope.key, source: 'interface', sourceId: id, factKey: reaction.requestId, eventAt: at, observedAt: at, version: '1', text, hash: hash(text), assertion: 'explicit', actor: scope.user, suggestionId: suggestion.id, sessionId: suggestion.sessionId });
      project.revision++;
      return event;
    });
    const current = await this.view(projectId);
    if (current.config.enabled && current.config.autoLearn && reaction.text && ['accepted', 'rejected', 'feedback', 'supplement', 'outcome'].includes(reaction.kind)) this.enqueue(projectId, 'learn');
    return result;
  }
  async completed(projectId: string) {
    if (this.closed) return;
    const current = await this.view(projectId);
    if (!current.config.enabled) return;
    const added = await this.collect(projectId);
    if (added.length || pendingEvidence(await this.view(projectId)).length) this.enqueue(projectId, 'turn');
  }
  async activate(projectId: string) {
    if (this.closed) return;
    const view = await this.view(projectId);
    if (!view.config.enabled || view.config.quiet) return;
    await this.completed(projectId);
    if (view.pending?.recommendation || view.pending?.learning) this.wake(projectId);
  }
  private wake(projectId: string) {
    this.pending.set(projectId, 'pending');
    if (!this.timer) { this.timer = setInterval(() => void this.drain(), 1000); this.timer.unref(); }
  }
  enqueue(projectId: string, trigger = 'manual', delay = this.timing.debounceMs) {
    if (this.closed) return;
    this.host.scope(projectId); this.wake(projectId);
    void this.edit(projectId, project => {
      if (!project.config.enabled || project.config.quiet) return;
      project.pending ||= {};
      if (trigger === 'learn') project.pending.learning ||= { dueAt: Date.now() + delay };
      else project.pending.recommendation ||= { trigger, dueAt: Date.now() + delay };
    }).catch(() => {});
  }
  private async drain() {
    if (this.closed || this.draining) return;
    this.draining = true;
    try { for (const [projectId] of this.pending) {
      try {
        const view = await this.view(projectId);
        if (!view.config.enabled || view.config.quiet || this.jobs.has(view.scope.key)) continue;
        const task = view.pending?.recommendation, learning = view.pending?.learning;
        if (!task && !learning) { this.pending.delete(projectId); continue; }
        const operation = task && task.dueAt <= Date.now() ? 'recommend' : learning && learning.dueAt <= Date.now() ? 'learn' : undefined;
        if (!operation) continue;
        await this.edit(projectId, project => { if (operation === 'recommend') delete project.pending?.recommendation; else delete project.pending?.learning; });
        await this.start(projectId, operation, operation === 'learn' ? 'learn' : task!.trigger);
      } catch (error: any) {
        this.pending.delete(projectId);
        await this.edit(projectId, project => { project.lastError = error.message; }).catch(() => {});
      }
    } } finally { this.draining = false; }
  }
  async start(projectId: string, operation: 'recommend' | 'learn' | 'evaluate', trigger = 'manual', candidateId?: string) {
    const project = await this.view(projectId);
    if (!project.config.enabled) throw new Error('请先开启项目助手');
    if (this.jobs.has(project.scope.key)) throw new Error('项目助手正在处理上一项任务，请完成后再试');
    const session = this.execution(projectId);
    if (!session || session.closedAt) throw new Error('请先在本项目创建或打开一条工作会话');
    if (!session.model && !this.host.resolveExecution) throw new Error('请在项目设置中选择 AI推荐模型');
    if (busy(session)) { if (operation === 'recommend') { this.enqueue(projectId, trigger); return; } throw new Error('请在当前回复完成后执行策略评估'); }
    let frozenSession = structuredClone(session); const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      try {
        if (this.host.resolveExecution) frozenSession = await this.host.resolveExecution(frozenSession);
        if (!frozenSession.model) throw new Error('无法确定默认模型，请在项目设置中选择 AI推荐模型');
        if (operation === 'recommend') await this.recommend(projectId, frozenSession, trigger, controller.signal);
        else if (operation === 'learn') await this.learn(projectId, frozenSession, controller.signal);
        else await this.evaluate(projectId, frozenSession, candidateId!, controller.signal);
      } catch (error: any) {
        try { if (this.host.scope(projectId).key !== project.scope.key) return; } catch { return; }
        await this.edit(projectId, current => {
          current.lastError = error.message;
          for (const run of current.runs) if (run.status === 'running') { run.status = controller.signal.aborted ? 'interrupted' : 'error'; run.error = error.message; run.finishedAt = iso(); run.durationMs = Date.now() - Date.parse(run.at); }
          if (!controller.signal.aborted && current.config.enabled && operation === 'recommend') { current.pending ||= {}; current.pending.recommendation = { trigger: 'retry', dueAt: Date.now() + this.timing.retryMs }; this.wake(projectId); }
        }).catch(() => {}); // Revoked account/project access must not leak an old task into a new identity.
      } finally { this.jobs.delete(project.scope.key); this.host.changed(); }
    });
    this.jobs.set(project.scope.key, { stage: operation, promise, controller }); this.host.changed();
  }
  async settled() { await Promise.all([...this.jobs.values()].map(job => job.promise)); await this.writes; }
  private async call(projectId: string, session: AgentSession, prompt: string, purpose: string, signal: AbortSignal) {
    if (signal.aborted || this.closed) throw new Error('项目助手已停止');
    const scopeKey = this.host.scope(projectId).key;
    if (!this.jobs.has(scopeKey)) throw new Error('项目身份已变化，任务已停止');
    const current = this.execution(projectId);
    const matches = (value?: AgentSession) => value && value.id === session.id && !value.closedAt && value.provider === session.provider && (!value.model || value.model === session.model) && value.reasoningEffort === session.reasoningEffort && value.networkRoute === session.networkRoute;
    if (!matches(current)) throw new Error('会话或模型配置已变化，请重新分析');
    await this.edit(projectId, project => {
      if (project.scope.key !== scopeKey) throw new Error('项目身份已变化，任务已停止');
      if (!project.config.enabled) throw new Error('项目助手已关闭');
      project.calls.push({ at: iso(), purpose, model: modelKey(session) });
    });
    const response = await this.runText(session, prompt, signal);
    if (this.host.scope(projectId).key !== scopeKey) throw new Error('项目身份已变化，任务已停止');
    if (signal.aborted || this.closed) throw new Error('项目助手已停止');
    if (!matches(this.execution(projectId))) throw new Error('会话或模型配置已变化，请重新分析');
    return response;
  }
  private async recommend(projectId: string, session: AgentSession, trigger: string, signal: AbortSignal) {
    await this.collect(projectId);
    const project = await this.view(projectId), policy = project.policies.find(item => item.id === project.activePolicyId)!;
    const config = this.effectiveConfig(project), configHash = hash(config);
    const last = project.runs.filter(item => item.status === 'completed' && item.output !== undefined && item.state).at(-1);
    if (project.config.quiet) return;
    const urgent = pendingEvidence(project).some(item => item.sourceId === 'project-brief' || item.source === 'configuration');
    if (!['manual', 'remaining'].includes(trigger) && !urgent && last && Date.now() < Date.parse(last.at) + policy.rules.cooldownMinutes * 60000) {
      this.enqueue(projectId, trigger, Date.parse(last.at) + policy.rules.cooldownMinutes * 60000 - Date.now()); return;
    }
    if (trigger !== 'manual' && !pendingEvidence(project).length) return;
    const context = projectContext(project, config), { evidence } = context;
    if (!evidence.length) return;
    const prompt = policyPrompt(policy, context.reference), runId = randomUUID();
    await this.edit(projectId, current => {
      current.lastError = undefined;
      current.runs.push({ id: runId, at: iso(), policyId: policy.id, model: session.model!, provider: session.provider, route: session.networkRoute || 'direct', trigger, inputHash: hash(prompt), evidenceIds: evidence.map(item => item.id), inputChars: prompt.length, status: 'running', suggestions: [],
        snapshot: { capturedAt: iso(), revision: project.revision, policyHash: hash({ bundle: policy.bundle, rules: policy.rules }), configHash, evidence: structuredClone(evidence), delta: context.coverage, reference: context.reference } });
    });
    const output = await this.call(projectId, session, prompt, 'recommend', signal);
    const answer = validateRsiAnswer(parse(output), evidence, policy.rules.maxSuggestions);
    // Read stable source revisions again; unrelated new messages do not invalidate this snapshot.
    await this.collect(projectId);
    await this.edit(projectId, current => {
      if (current.scope.key !== project.scope.key) throw new Error('项目身份已变化，任务已停止');
      const run = current.runs.find(item => item.id === runId)!;
      run.output = output; run.status = 'completed'; run.finishedAt = iso(); run.durationMs = Date.now() - Date.parse(run.at);
      const latest = latestProjectEvidence(current), versions = new Map(latest.map(item => [evidenceKey(item), item.id]));
      const changed = evidence.some(item => versions.get(evidenceKey(item)) !== item.id);
      const officialChanged = latest.filter(item => item.sourceId === 'project-brief').some(item => !project.evidence.some(old => old.id === item.id));
      if (configHash !== hash(this.effectiveConfig(current)) || current.activePolicyId !== policy.id || changed || officialChanged) {
        run.decision = '目标、配置或引用依据已变化，等待重新分析';
        current.pending ||= {}; current.pending.recommendation = { trigger: 'revalidate', dueAt: Date.now() + this.timing.debounceMs }; this.wake(projectId); return;
      }
      applyMemory(current, context.coverage, answer, evidence, iso());
      run.state = answer.state;
      for (const item of answer.suggestions.sort((a, b) => b.priority - a.priority)) {
        const fingerprint = hash([item.action.replace(/\s+/g, '').toLowerCase(), [...item.evidenceIds].sort()]);
        if (current.suggestions.some(prior => prior.fingerprint === fingerprint)) continue;
        const sessions = new Set(evidence.filter(source => item.evidenceIds.includes(source.id)).map(source => source.sessionId).filter(Boolean));
        const suggestion = { ...item, fingerprint, id: randomUUID(), runId, policyId: policy.id, createdAt: iso(), sessionId: sessions.size === 1 ? [...sessions][0]! : '', projectId };
        current.suggestions.push(suggestion); run.suggestions.push(suggestion.id);
      }
      run.decision = run.suggestions.length ? '推荐已保存，等待用户处理' : '没有新的适用建议';
      if (pendingEvidence(current).length) {
        const backlog = context.remaining > 0;
        current.pending ||= {}; current.pending.recommendation = { trigger: backlog ? 'remaining' : 'turn', dueAt: Date.now() + (backlog ? this.timing.debounceMs : policy.rules.cooldownMinutes * 60000) }; this.wake(projectId);
      } else delete current.pending?.recommendation;
    });
  }
  private async learn(projectId: string, session: AgentSession, signal: AbortSignal) {
    const project = await this.view(projectId), base = project.policies.find(item => item.id === project.activePolicyId)!;
    const reference = learningReference(project, base), prompt = learningPrompt(reference.data);
    const inputHash = hash({ prompt, baseId: base.id, bundle: base.bundle, model: modelKey(session), heldOut: project.cases.map(item => item.id) });
    if (project.learningRuns?.some(item => item.inputHash === inputHash)) return;
    const schema = z.object({ decision: z.enum(['candidate', 'keep']).optional(), hypothesis: z.string().min(1), evidenceIds: z.array(z.string()).min(1), rules: rsiPolicySchema }).strict();
    const candidate = schema.parse(parse(await this.call(projectId, session, prompt, 'learn', signal)));
    // Timing/volume changes need temporal workload evaluation, not just content replay.
    candidate.rules.cooldownMinutes = base.rules.cooldownMinutes;
    candidate.rules.maxSuggestions = base.rules.maxSuggestions;
    if (candidate.evidenceIds.some(id => !reference.data.evidence.some(item => item.id === id))) throw new Error('改进假设引用了未提供的证据');
    if (!candidate.evidenceIds.some(id => reference.feedbackIds.includes(id))) throw new Error('改进假设必须引用明确反馈或结果，不能只引用项目原文');
    const unchanged = hash(candidate.rules) === hash(base.rules);
    if (candidate.decision === 'keep' && !unchanged) throw new Error('保留策略与改写规则相互矛盾，现行策略不变');
    await this.edit(projectId, current => {
      if (current.scope.key !== project.scope.key) throw new Error('项目身份已变化，任务已停止');
      if (current.activePolicyId !== base.id || current.revision !== project.revision) throw new Error('项目证据或有效策略已变化，请重新提炼');
      const id = unchanged ? undefined : randomUUID(), at = iso(), sourceEvidenceIds = reference.inputEvidence.map(item => item.id);
      current.learningRuns ||= [];
      current.learningRuns.push({ inputHash, baseId: base.id, model: modelKey(session), at, evidenceIds: sourceEvidenceIds, feedbackIds: reference.feedbackIds,
        prompt, outcome: unchanged ? 'unchanged' : 'candidate', hypothesis: candidate.hypothesis, candidateId: id });
      if (id) current.policies.push({ hypothesis: candidate.hypothesis, evidenceIds: candidate.evidenceIds, rules: candidate.rules,
        sourceEvidenceIds, feedbackEvidenceIds: reference.feedbackIds, feedbackDecisions: Object.fromEntries(reference.data.examples.map(item => [item.recommendation.id, item.decision.eventId || null])),
        learningInputHash: inputHash, bundle: candidateBundle(base), id, createdAt: at, baseId: base.id, heldOutCaseIds: project.cases.map(item => item.id), status: 'candidate', scope: 'user-project' });
      current.lastError = undefined;
    });
  }
  async addCase(projectId: string, input: unknown) {
    const value = rsiCaseSchema.parse(input);
    if (!atOrBefore(value.cutoff, iso())) throw new Error('回放时间不能晚于当前时间');
    if (value.shouldSuggest && !value.required.length) throw new Error('请填写至少一项独立判定的预期动作');
    return this.edit(projectId, project => {
      const evidence = value.evidenceIds.map(id => project.evidence.find(item => item.id === id));
      if (evidence.some(item => !item || !atOrBefore(item.eventAt, value.cutoff) || !atOrBefore(item.observedAt, value.cutoff) || item.source === 'evaluation')) throw new Error('案例引用了不可访问、未来或评估答案中的证据');
      const test: RsiCase = { ...value, id: randomUUID(), createdAt: iso(), evidence: structuredClone(evidence as RsiEvidence[]), config: this.effectiveConfig(project), author: project.scope.user };
      project.cases.push(test); return test;
    });
  }
  private async evaluate(projectId: string, session: AgentSession, candidateId: string, signal: AbortSignal) {
    const project = await this.view(projectId), candidate = project.policies.find(item => item.id === candidateId && item.status === 'candidate');
    if (!candidate || candidate.baseId !== project.activePolicyId) throw new Error('候选策略的基线已变化，请重新提炼');
    assertLearningCurrent(project, candidate);
    const base = project.policies.find(item => item.id === candidate.baseId)!;
    const learned = new Set(candidate.evidenceIds.map(id => project.evidence.find(item => item.id === id)?.factKey));
    const cases = project.cases.filter(test => (candidate.heldOutCaseIds?.includes(test.id) ?? test.createdAt < candidate.createdAt) && test.evidence.every(item => !learned.has(item.factKey)));
    if (cases.length < 3 || !cases.some(test => !test.shouldSuggest)) throw new Error('需要至少 3 个预先保留且未用于学习的案例，包括一个不应打扰的案例');
    if (new Set(cases.map(test => hash([[...new Set(test.evidence.map(item => item.factKey))].sort(), test.shouldSuggest]))).size !== cases.length) throw new Error('保留案例不能重复计算');
    const outputs: RsiEvaluation['outputs'] = [], baselineScores: RsiScore[] = [], candidateScores: RsiScore[] = [];
    for (const test of cases) {
      const responses: RsiAnswer[] = [];
      for (const policy of [base, candidate]) {
        // The candidate is evaluated through the same assembler as production, with only frozen held-out sources.
        const replay = { ...project, config: test.config, evidence: test.evidence, policies: [policy], activePolicyId: policy.id, memory: emptyMemory(), suggestions: [], events: [], runs: [] };
        const context = projectContext(replay, test.config);
        const response = validateRsiAnswer(parse(await this.call(projectId, session, policyPrompt(policy, context.reference), 'evaluate', signal)), context.evidence, policy.rules.maxSuggestions);
        responses.push(response);
      }
      outputs.push({ caseId: test.id, baseline: responses[0], candidate: responses[1] });
      baselineScores.push(scoreRsi(responses[0], test)); candidateScores.push(scoreRsi(responses[1], test));
    }
    const baseline = sumScores(baselineScores), score = sumScores(candidateScores), reasons: string[] = [];
    if (score.quality < baseline.quality) reasons.push('基础回归得分下降');
    if (score.omissions > baseline.omissions) reasons.push('遗漏增加');
    if (score.interruptions > baseline.interruptions || score.interruptions) reasons.push('存在不应打扰时提出建议');
    if (score.violations > baseline.violations || score.violations) reasons.push('触发禁止动作');
    if (score.chars > Math.max(baseline.chars * 1.5, 3000 * cases.length)) reasons.push('输出开销超过护栏');
    await this.edit(projectId, current => {
      if (current.scope.key !== project.scope.key) throw new Error('项目身份已变化，任务已停止');
      if (current.activePolicyId !== base.id || current.revision !== project.revision) throw new Error('评估期间项目或策略已变化，结果不用于发布');
      current.evaluations.push({ contract: 2, policyHash: hash([base.bundle, base.rules, candidate.bundle, candidate.rules]), id: randomUUID(), at: iso(), candidateId, baselineId: base.id, projectRevision: project.revision, model: modelKey(session), caseIds: cases.map(item => item.id), baseline, candidate: score, passed: !reasons.length, reasons, outputs });
      current.lastError = undefined;
    });
  }
  async reviewEvaluation(projectId: string, evaluationId: string, input: unknown) {
    const review = z.object({ approved: z.boolean(), reason: z.string().trim().min(1).max(4000) }).strict().parse(input);
    let session = this.execution(projectId);
    if (session && this.host.resolveExecution) session = await this.host.resolveExecution(session);
    return this.edit(projectId, project => {
      const evaluation = project.evaluations.find(item => item.id === evaluationId);
      const candidate = project.policies.find(item => item.id === evaluation?.candidateId && item.status === 'candidate');
      const base = project.policies.find(item => item.id === project.activePolicyId)!;
      if (!evaluation || !candidate || evaluation.contract !== 2 || !evaluation.passed
        || project.evaluations.filter(item => item.candidateId === candidate.id).at(-1)?.id !== evaluation.id) throw new Error('请先完成当前候选的基础回归检查');
      assertLearningCurrent(project, candidate);
      if (evaluation.projectRevision !== project.revision || evaluation.baselineId !== base.id || candidate.baseId !== base.id
        || evaluation.policyHash !== hash([base.bundle, base.rules, candidate.bundle, candidate.rules])) throw new Error('评审对象已变化，请重新评估');
      if (!session || evaluation.model !== modelKey(session)) throw new Error('模型配置已变化，需要重新评估');
      evaluation.qualityReview = { ...review, actor: project.scope.user, at: iso() };
      return evaluation;
    });
  }
  async publish(projectId: string, candidateId: string) {
    await this.ready();
    let execution = this.execution(projectId);
    if (execution && this.host.resolveExecution) execution = await this.host.resolveExecution(execution);
    return this.edit(projectId, project => {
      const candidate = project.policies.find(item => item.id === candidateId && item.status === 'candidate');
      const evaluation = project.evaluations.filter(item => item.candidateId === candidateId).at(-1);
      if (!candidate || !evaluation?.passed || evaluation.contract !== 2 || evaluation.baselineId !== project.activePolicyId || candidate.baseId !== project.activePolicyId) throw new Error('候选尚未通过当前基线的独立评估，保留有效版本');
      assertLearningCurrent(project, candidate);
      if (evaluation.projectRevision !== project.revision) throw new Error('评估后项目证据或配置已变化，需要重新评估');
      const session = execution;
      if (!session || evaluation.model !== modelKey(session)) throw new Error('模型配置已变化，需要重新评估');
      const base = project.policies.find(item => item.id === project.activePolicyId)!;
      if (evaluation.policyHash !== hash([base.bundle, base.rules, candidate.bundle, candidate.rules])) throw new Error('评估对象已变化，需要重新评估');
      if (!evaluation.qualityReview?.approved) throw new Error('基础回归不能证明推荐质量，请先完成人工质量评审');
      project.releases.push({ id: randomUUID(), at: iso(), from: base.id, to: candidate.id, actor: project.scope.user, evaluationId: evaluation.id, reason: '独立对照评估通过后发布' });
      base.status = 'retired'; candidate.status = 'active'; project.activePolicyId = candidate.id;
      if (this.proofs(candidate).size >= 2) for (const other of Object.values(this.projects)) for (const policy of other.policies) if ((policy.familyId || policy.id) === (candidate.familyId || candidate.id)) policy.scope = 'general';
      return candidate;
    });
  }
  async rollback(projectId: string) {
    return this.edit(projectId, project => {
      const last = project.releases.at(-1); if (!last) throw new Error('没有可回退版本');
      const previous = project.policies.find(item => item.id === last.from)!;
      project.policies.find(item => item.id === project.activePolicyId)!.status = 'retired';
      project.releases.push({ id: randomUUID(), at: iso(), from: project.activePolicyId, to: previous.id, actor: project.scope.user, reason: '用户回退' });
      previous.status = 'active'; project.activePolicyId = previous.id; return previous;
    });
  }
  async pause() { clearInterval(this.timer); this.timer = undefined; this.pending.clear(); for (const job of this.jobs.values()) job.controller.abort(); await this.settled(); }
  async close() { this.closed = true; await this.pause(); }
}
