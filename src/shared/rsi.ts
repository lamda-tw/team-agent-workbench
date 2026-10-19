import { z } from 'zod';

export const rsiConfigSchema = z.object({
  enabled: z.boolean().default(false), autoLearn: z.boolean().default(false),
  contextChars: z.number().int().min(2000).max(24000).default(12000),
  dailyCalls: z.number().int().min(1).max(100).default(24),
  role: z.string().trim().max(2000).default(''), preference: z.string().trim().max(2000).default(''),
  goals: z.string().trim().max(6000).default(''), acceptance: z.string().trim().max(6000).default(''),
  quiet: z.boolean().default(false),
});
export type RsiConfig = z.infer<typeof rsiConfigSchema>;
export const rsiShadowSettingsSchema = rsiConfigSchema.pick({ enabled: true, dailyCalls: true }).required().strict();
export interface RsiShadowSettings {
  config: RsiConfig;
  sourceSession?: { title: string; provider: string; model?: string };
}
export const rsiPolicySchema = z.object({
  guidance: z.string().trim().min(1).max(6000),
  cooldownMinutes: z.number().int().min(0).max(1440),
  maxSuggestions: z.number().int().min(1).max(3),
  retrieval: z.enum(['recent', 'goal-first', 'failures-first']),
}).strict();
export type RsiPolicyRules = z.infer<typeof rsiPolicySchema>;
export const rsiDefaultRules: RsiPolicyRules = {
  guidance: '围绕项目目标提出有来源依据的可执行下一步，说明条件和未知。不能把计划、采纳或模型自评写成已完成。证据不足或没有值得打扰的新进展时返回空建议。',
  cooldownMinutes: 10, maxSuggestions: 2, retrieval: 'goal-first',
};
export type RsiSource = 'session' | 'interface' | 'project' | 'execution' | 'evaluation' | 'configuration';
export interface RsiScope { key: string; account: string; projectId: string; user: string }
export interface RsiEvidence {
  id: string; scope: string; source: RsiSource; sourceId: string; factKey: string;
  eventAt: string; observedAt: string; version: string; text: string; hash: string;
  assertion: 'explicit' | 'observed' | 'inferred'; actor: string; sessionId?: string;
  suggestionId?: string; taskId?: string; artifact?: string;
}
export type RsiObservation = Omit<RsiEvidence, 'id' | 'scope' | 'observedAt' | 'hash'>;
export const rsiSuggestionSchema = z.object({
  title: z.string().trim().min(1), action: z.string().trim().min(1), reason: z.string().trim().min(1),
  evidenceIds: z.array(z.string()).min(1), conditions: z.array(z.string()), uncertainty: z.string(),
  priority: z.number().min(0).max(1),
}).strict();
export const rsiAnswerSchema = z.object({
  state: z.object({ progress: z.string(), blockers: z.array(z.string()), unknowns: z.array(z.string()), evidenceIds: z.array(z.string()) }).strict(),
  suggestions: z.array(rsiSuggestionSchema),
}).strict();
export type RsiAnswer = z.infer<typeof rsiAnswerSchema>;
export interface RsiSuggestion extends z.infer<typeof rsiSuggestionSchema> {
  id: string; runId: string; policyId: string; createdAt: string; fingerprint: string;
  sessionId: string; projectId: string;
}
export const rsiReactionSchema = z.object({
  suggestionId: z.string(), kind: z.enum(['presented', 'visible', 'accepted', 'rejected', 'dismissed', 'deferred', 'edited', 'feedback', 'action', 'outcome']),
  text: z.string().trim().max(6000).default(''), requestId: z.string().min(1).max(160),
  outcome: z.enum(['success', 'failure', 'rework', 'unknown']).optional(),
}).strict();
export type RsiReaction = z.infer<typeof rsiReactionSchema>;
export interface RsiEvent extends RsiReaction { id: string; at: string; actor: string; evidenceId: string }
export interface RsiRun {
  id: string; at: string; policyId: string; model: string; provider: string; route: string;
  trigger: string; inputHash: string; evidenceIds: string[]; inputChars: number;
  finishedAt?: string; durationMs?: number;
  status: 'running' | 'completed' | 'error' | 'interrupted'; error?: string;
  decision?: string; state?: RsiAnswer['state']; suggestions: string[]; output?: string;
}
export interface RsiPolicy {
  id: string; createdAt: string; rules: RsiPolicyRules; baseId?: string;
  hypothesis: string; evidenceIds: string[]; status: 'active' | 'candidate' | 'retired';
  scope: 'user-project' | 'project' | 'personal' | 'general';
  familyId?: string; origin?: { projectId: string; policyId: string };
  heldOutCaseIds?: string[];
}
export const rsiCaseSchema = z.object({
  name: z.string().trim().min(1).max(180), evidenceIds: z.array(z.string()).min(1).max(60),
  cutoff: z.string().datetime(), shouldSuggest: z.boolean(),
  required: z.array(z.string().trim().min(1)).max(12), forbidden: z.array(z.string().trim().min(1)).max(12),
}).strict();
export interface RsiCase extends z.infer<typeof rsiCaseSchema> { id: string; createdAt: string; evidence: RsiEvidence[]; config: RsiConfig; author: string }
export interface RsiScore { quality: number; omissions: number; interruptions: number; violations: number; chars: number }
export interface RsiEvaluation {
  id: string; at: string; candidateId: string; baselineId: string; model: string;
  projectRevision: number;
  caseIds: string[]; baseline: RsiScore; candidate: RsiScore;
  passed: boolean; reasons: string[]; outputs: { caseId: string; baseline: RsiAnswer; candidate: RsiAnswer }[];
}
export interface RsiRelease { id: string; at: string; from: string; to: string; actor: string; evaluationId?: string; reason: string }
export interface RsiProject {
  scope: RsiScope; config: RsiConfig; revision: number; evidence: RsiEvidence[];
  events: RsiEvent[]; suggestions: RsiSuggestion[]; runs: RsiRun[]; policies: RsiPolicy[];
  activePolicyId: string; cases: RsiCase[]; evaluations: RsiEvaluation[]; releases: RsiRelease[];
  calls: { at: string; purpose: string; model: string }[]; lastError?: string;
}
export interface RsiView extends RsiProject {
  busy: boolean; stage?: string; queued: boolean; personalPreference: string;
  sourceSession?: { id: string; title: string; provider: string; model?: string; reasoningEffort?: string };
  reusablePolicies: { projectId: string; policyId: string; guidance: string; validatedProjects: number }[];
}

export function rsiSuggestionState(suggestion: RsiSuggestion, events: RsiEvent[]) {
  const reactions = events.filter(event => event.suggestionId === suggestion.id);
  const outcome = reactions.filter(event => event.kind === 'outcome').at(-1);
  if (outcome) return outcome.outcome === 'success' ? '已确认有效' : outcome.outcome === 'failure' ? '执行未达标' : outcome.outcome === 'rework' ? '需要返工' : '结果待确认';
  const intent = reactions.filter(event => ['accepted', 'rejected', 'dismissed', 'deferred', 'edited', 'action'].includes(event.kind)).at(-1);
  return intent ? ({ accepted: '已接受，效果待验证', rejected: '已拒绝', dismissed: '已关闭', deferred: '已延后', edited: '已修改', action: '已执行，结果待确认' } as Record<string, string>)[intent.kind] : '待判断';
}
