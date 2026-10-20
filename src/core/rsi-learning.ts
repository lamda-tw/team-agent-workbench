import { rsiFeedbackState, type RsiEvidence, type RsiPolicy, type RsiProject, type RsiRun } from '../shared/rsi';
import { evidenceKey } from './rsi-context';

/** Include source references used through memory and prior recommendations, not only raw delta text. */
function provenance(project: RsiProject, run: RsiRun, visited = new Set<string>()): RsiEvidence[] {
  if (visited.has(run.id)) return [];
  visited.add(run.id);
  if (!run.snapshot) throw new Error('推荐缺少当时的完整输入来源，请使用新的推荐反馈');
  const reference = JSON.parse(run.snapshot.reference);
  const ids = new Set<string>([...run.evidenceIds, ...run.snapshot.evidence.map(item => item.id),
    ...(reference.overview?.evidenceIds || []), ...(reference.sessions || []).flatMap((item: any) => item.evidenceIds || [])]);
  const related: RsiEvidence[] = [];
  for (const prior of reference.priorRecommendations || []) {
    const suggestion = project.suggestions.find(item => item.id === prior.id);
    const previousRun = project.runs.find(item => item.id === suggestion?.runId);
    if (!previousRun) throw new Error('推荐引用的历史来源已不可用，请使用新的推荐反馈');
    related.push(...provenance(project, previousRun, visited));
    for (const feedback of prior.feedback || []) {
      for (const id of [feedback.eventId, feedback.decisionEventId]) {
        const event = project.events.find(item => item.id === id);
        if (event) ids.add(event.evidenceId);
      }
    }
    const decision = project.events.find(item => item.id === prior.decision?.eventId);
    if (decision) ids.add(decision.evidenceId);
  }
  const own = [...ids].map(id => project.evidence.find(item => item.id === id));
  if (own.some(item => !item)) throw new Error('推荐引用的历史来源已不可用，请使用新的推荐反馈');
  return [...new Map([...own as RsiEvidence[], ...related].map(item => [item.id, item])).values()];
}

/** A feedback package stays intact: recommendation, decision, latest opinion and outcome. */
export function learningReference(project: RsiProject, base: RsiPolicy) {
  const heldOut = project.cases.flatMap(item => item.evidence);
  const forbiddenFacts = new Set(heldOut.map(item => item.factKey));
  const forbiddenSources = new Set(heldOut.map(evidenceKey));
  const eligible = (item: RsiEvidence) => !forbiddenFacts.has(item.factKey) && !forbiddenSources.has(evidenceKey(item))
    && Date.parse(item.eventAt) <= Date.now() && Date.parse(item.observedAt) <= Date.now();
  type Evidence = Pick<RsiEvidence, 'id' | 'source' | 'assertion' | 'sessionId' | 'text'>;
  const evidence: Evidence[] = [], examples: {
    recommendation: { id: string; title: string; action: string; reason: string; reasonTruncated: boolean };
    decision: { kind: 'accepted' | 'rejected' | 'pending'; eventId?: string; at?: string };
    closed: boolean;
    feedback?: { evidenceId: string; eventId: string; kind: string; feedbackTarget?: 'recommendation'; decisionEventId?: string };
    outcome?: { evidenceId: string; eventId: string; outcome: string; at: string; decisionEventId?: string; decision?: string };
    then: { model: string; policyId: string; evidenceIds: string[]; contextPartial: boolean };
  }[] = [];
  const data = { base: base.rules, evidence, examples };
  const inputEvidence = new Map<string, RsiEvidence>();
  const feedbackIds: string[] = [];
  const packages = project.suggestions.map(suggestion => {
    const state = rsiFeedbackState(suggestion.id, project.events);
    const signals = [state.feedback, state.outcome].filter(item => item?.text);
    return { suggestion, state, signals, order: Math.max(...signals.map(item => project.events.indexOf(item!)), -1) };
  }).filter(item => item.signals.length).sort((a, b) => b.order - a.order);
  for (const { suggestion, state, signals } of packages) {
    const run = project.runs.find(item => item.id === suggestion.runId);
    // A review of a held-out recommendation leaks its answer just as the original source does.
    if (!run?.snapshot) continue;
    const dependencies = provenance(project, run);
    if (dependencies.some(item => !eligible(item))) continue;
    const sources = signals.map(signal => project.evidence.find(item => item.id === signal!.evidenceId));
    if (sources.some(item => !item || !eligible(item))) continue;
    const added = sources.map((item, index) => ({ id: item!.id, source: item!.source, assertion: item!.assertion,
      sessionId: item!.sessionId, text: signals[index]!.text }));
    const example: typeof examples[number] = {
      recommendation: { id: suggestion.id, title: suggestion.title, action: suggestion.action, reason: suggestion.reason.slice(0, 500), reasonTruncated: suggestion.reason.length > 500 },
      decision: state.decision ? { kind: state.decision.kind as 'accepted' | 'rejected', eventId: state.decision.id, at: state.decision.at } : { kind: 'pending' },
      closed: state.closed,
      feedback: state.feedback?.text ? { evidenceId: state.feedback.evidenceId, eventId: state.feedback.id, kind: state.feedback.kind,
        feedbackTarget: state.feedback.feedbackTarget, decisionEventId: state.feedback.decisionEventId || state.decision?.id } : undefined,
      outcome: state.outcome?.text ? { evidenceId: state.outcome.evidenceId, eventId: state.outcome.id, outcome: state.outcome.outcome || 'unknown', at: state.outcome.at,
        decisionEventId: state.outcome.decisionEventId, decision: project.events.find(event => event.id === state.outcome!.decisionEventId)?.kind } : undefined,
      then: { model: run.model, policyId: run.policyId, evidenceIds: [], contextPartial: true },
    };
    examples.push(example); evidence.push(...added);
    if (JSON.stringify(data).length > project.config.contextChars) {
      examples.pop(); evidence.splice(evidence.length - added.length);
      // Never silently lose the newest opinion or clip a negation at the end.
      if (!examples.length) throw new Error('当前材料长度不足以完整容纳最新推荐反馈，请缩短反馈或调高参考长度；现行策略不变');
      break;
    }
    for (const item of sources) { inputEvidence.set(item!.id, item!); feedbackIds.push(item!.id); }
    // The recommendation itself was derived from all these sources, not just the
    // subset later chosen by a model as its explanatory citations.
    for (const item of dependencies) inputEvidence.set(item.id, item);
    if (state.decision) {
      const decisionEvidence = project.evidence.find(item => item.id === state.decision!.evidenceId);
      if (decisionEvidence) inputEvidence.set(decisionEvidence.id, decisionEvidence);
    }
  }
  if (!examples.length) throw new Error('需要明确反馈或实际结果依据，不能仅凭点击、曝光或无操作学习；保留案例不参与学习');
  // Feedback gets its budget first. Add the actual then-context only where it fits.
  for (const example of examples) {
    const suggestion = project.suggestions.find(item => item.id === example.recommendation.id)!;
    const run = project.runs.find(item => item.id === suggestion.runId)!;
    const originals = run.snapshot!.evidence;
    for (const item of originals) {
      if (item.source === 'interface') continue;
      if (evidence.some(value => value.id === item.id)) {
        example.then.evidenceIds.push(item.id);
        if (JSON.stringify(data).length > project.config.contextChars) example.then.evidenceIds.pop();
        continue;
      }
      const source = { id: item.id, source: item.source, assertion: item.assertion, sessionId: item.sessionId, text: item.text };
      evidence.push(source); example.then.evidenceIds.push(item.id);
      if (JSON.stringify(data).length > project.config.contextChars) { evidence.pop(); example.then.evidenceIds.pop(); continue; }
      inputEvidence.set(item.id, item);
    }
    const originalContext = JSON.parse(run.snapshot!.reference);
    example.then.contextPartial = example.then.evidenceIds.length !== originals.length
      || !!originalContext.coverage?.partial || !!originalContext.sessions?.length || !!originalContext.overview || !!originalContext.priorRecommendations?.length;
  }
  return { data, inputEvidence: [...inputEvidence.values()], feedbackIds };
}

export function assertLearningCurrent(project: RsiProject, policy: RsiPolicy) {
  // Reused policies have a separate project-local evaluation and no copied feedback.
  if (policy.origin) return;
  if (!policy.sourceEvidenceIds || !policy.feedbackEvidenceIds || !policy.feedbackDecisions) throw new Error('候选缺少完整学习来源，请重新提炼后再评估');
  const current = new Set(project.suggestions.flatMap(item => {
    const state = rsiFeedbackState(item.id, project.events);
    return [state.feedback, state.outcome].filter(event => event?.text).map(event => event!.evidenceId);
  }));
  const decisionChanged = Object.entries(policy.feedbackDecisions).some(([id, expected]) => (rsiFeedbackState(id, project.events).decision?.id || null) !== expected);
  if (decisionChanged || policy.feedbackEvidenceIds.some(id => !current.has(id)) || policy.sourceEvidenceIds.some(id => !project.evidence.some(item => item.id === id))) {
    throw new Error('候选依赖的反馈或来源已更新，请重新提炼；现行策略保持不变');
  }
}
