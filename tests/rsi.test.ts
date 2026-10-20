import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RsiEngine, rsiContext, rsiPrompt, validateRsiAnswer } from '../src/core/rsi';
import { learningReference } from '../src/core/rsi-learning';
import { rsiConfigSchema, rsiDefaultRules, rsiSuggestionState, rsiReview, type RsiObservation, type RsiEvidence } from '../src/shared/rsi';
import type { AgentSession } from '../src/shared/types';
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const answer = (evidence: { id: string; text: string }[], action = '先检查开发集') => ({ state: { progress: '尚待验证', blockers: [], unknowns: ['真实效果待验证'], evidenceIds: evidence.map(item => item.id) }, suggestions: action ? [{ title: '下一步', action, reason: '项目要求', conditions: ['不修改冻结测试集'], uncertainty: '需要独立测试', evidenceIds: [evidence[0].id], priority: 0.8 }] : [] });
const observation = (id: string, text = id): RsiObservation => ({ source: 'session', sourceId: id, factKey: id, eventAt: new Date().toISOString(), version: '1', text, actor: 'alice', assertion: 'explicit' });
async function fixture(run: (value: { engine: RsiEngine; root: string; session: AgentSession; calls: string[]; observations: RsiObservation[]; owner: { name: string } }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-test-')), calls: string[] = [], observations = [observation('train', '实体抽取需要先改进开发集')], owner = { name: 'alice' };
  const session = { id: 's1', provider: 'codex', model: 'fixed-test-model', purpose: 'work', status: 'idle', messages: [], sources: [], approvals: [], createdAt: new Date().toISOString(), cwd: root, title: '研发', autoUpload: false, handoffPath: '' } as AgentSession;
  const engine = new RsiEngine(root, {
    scope: projectId => { if (!['p1', 'p2'].includes(projectId)) throw new Error('项目不可访问'); return { key: owner.name + ':' + projectId, account: owner.name, user: owner.name, projectId }; },
    session: () => session, collect: async () => structuredClone(observations), changed: () => {},
  }, async (_session, prompt) => {
    calls.push(prompt); const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    if (prompt.startsWith('RSI_PROTOCOL_V2:learn')) return JSON.stringify({ hypothesis: '边界问题需要先做边界审计；等待评审时不打扰，适用于当前项目', evidenceIds: data.evidence.filter((item: any) => item.source === 'interface').map((item: any) => item.id), rules: { ...rsiDefaultRules, guidance: '先做边界审计。等待评审不要打扰。' } });
    const policy = JSON.parse(prompt.split('\n').find(line => line.startsWith('POLICY_DATA='))!.slice('POLICY_DATA='.length));
    const improved = policy.guidance.startsWith('先做边界审计');
    const quiet = data.evidence.some((item: any) => item.text.includes('等待评审'));
    return JSON.stringify(answer(data.evidence, quiet && improved ? '' : improved ? '先做边界审计，使用开发集验证' : '先检查开发集'));
  }, { debounceMs: 0, retryMs: 60000 });
  try { await run({ engine, root, session, calls, observations, owner }); }
  finally { await engine.close(); await fs.rm(root, { recursive: true, force: true }); }
}
async function recommend(engine: RsiEngine) { await engine.start('p1', 'recommend'); await engine.settled(); return engine.view('p1'); }
async function approveQuality(engine: RsiEngine, projectId = 'p1') {
  const evaluation = (await engine.view(projectId)).evaluations.at(-1)!;
  return engine.reviewEvaluation(projectId, evaluation.id, { approved: true, reason: '测试人工评审：已逐条对比原文依据、建议适用性及表达，候选改善明确且无事实退化。' });
}
async function prepareLearning(engine: RsiEngine) {
  await engine.configure('p1', { enabled: true });
  let view = await recommend(engine);
  await engine.feedback('p1', { suggestionId: view.suggestions[0].id, kind: 'rejected', text: '必须先做边界审计，等待评审时不要打扰', requestId: 'feedback1' });
  for (let i = 0; i < 3; i++) {
    const ids = await engine.observe('p1', [observation('heldout-' + i, i === 2 ? '等待评审，不采取行动' : '独立开发集的实体边界错误 ' + i)]);
    await engine.addCase('p1', { name: '保留案例 ' + i, evidenceIds: ids, cutoff: new Date().toISOString(), shouldSuggest: i !== 2, required: i !== 2 ? ['边界审计'] : [], forbidden: ['修改冻结测试集'] });
  }
  await pause(); await engine.start('p1', 'learn'); await engine.settled(); view = await engine.view('p1');
  assert.equal(view.lastError, undefined); return view.policies.find(item => item.status === 'candidate')!;
}
test('project assistant defaults on, supports an explicit opt-out, and scopes data to account/project', async () => fixture(async ({ engine, calls, owner }) => {
  assert.equal((await engine.view('p1')).config.enabled, true);
  await engine.configureShadow('p1', { enabled: false });
  await engine.completed('p1'); assert.equal((await engine.view('p1')).queued, false);
  await assert.rejects(engine.start('p1', 'recommend'), /开启/); assert.equal(calls.length, 0);
  await engine.observe('p1', [observation('a')]); assert.equal((await engine.view('p2')).evidence.length, 0);
  assert.equal((await engine.view('p2')).config.enabled, true);
  owner.name = 'bob'; assert.equal((await engine.view('p1')).evidence.length, 0); assert.equal((await engine.view('p1')).config.enabled, true);
  await assert.rejects(engine.view('forbidden'), /不可访问/);
}));

test('restart upgrades untouched legacy defaults but preserves explicit disable and quiet mode', async () => fixture(async ({ engine, root, session }) => {
  const untouched = structuredClone(await engine.view('p1')); untouched.config.enabled = false;
  await engine.configureShadow('p2', { enabled: false });
  const disabled = structuredClone(await engine.view('p2'));
  assert.equal(disabled.settingsConfigured, true);
  const legacyDisabled = structuredClone(disabled); delete legacyDisabled.settingsConfigured; legacyDisabled.scope = { ...legacyDisabled.scope, key: 'alice:legacy', projectId: 'legacy' };
  disabled.evidence = []; // The atomic settings marker survives an interruption before the evidence write.
  const quiet = structuredClone(untouched); quiet.scope = { ...quiet.scope, key: 'alice:quiet', projectId: 'quiet' }; quiet.config.quiet = true;
  await engine.close();
  await fs.writeFile(path.join(root, 'rsi-v2.json'), JSON.stringify({ version: 2, projects: { 'alice:p1': untouched, 'alice:p2': disabled, 'alice:quiet': quiet, 'alice:legacy': legacyDisabled } }));
  const reopened = new RsiEngine(root, {
    scope: projectId => ({ key: 'alice:' + projectId, account: 'alice', user: 'alice', projectId }),
    session: () => session, collect: async () => [], changed() {},
  }, async () => { throw new Error('Opening settings must not call the model'); });
  try {
    assert.equal((await reopened.view('p1')).config.enabled, true);
    assert.equal((await reopened.view('p2')).config.enabled, false);
    assert(!('dailyCalls' in (await reopened.view('p2')).config));
    assert.equal((await reopened.view('legacy')).config.enabled, false);
    assert.equal((await reopened.view('quiet')).config.enabled, false);
    assert.equal((await reopened.view('quiet')).config.quiet, true);
    await reopened.observe('p1', [observation('persist-migration')]);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8'));
    assert.equal(saved.projects['alice:p1'].config.enabled, true);
    assert.equal(saved.projects['alice:p2'].config.enabled, false);
  } finally { await reopened.close(); }
}));
test('observations deduplicate exact source revisions but preserve corroborating channels and unknown outcomes', async () => fixture(async ({ engine }) => {
  const a = observation('fact'); const first = await engine.observe('p1', [a]); assert.equal(first.length, 1);
  assert.deepEqual(await engine.observe('p1', [a]), []);
  await engine.observe('p1', [{ ...a, source: 'execution', sourceId: 'tool', assertion: 'observed' }]);
  const view = await engine.view('p1'); assert.equal(view.evidence.length, 2); assert.equal(new Set(view.evidence.map(item => item.factKey)).size, 1); assert.equal(view.events.length, 0);
}));

test('recommendations accept or reject without mandatory feedback; close is independent and retry is idempotent', async () => fixture(async ({ engine, calls }) => {
  const view = await recommend(engine), suggestionId = view.suggestions[0].id;
  const initial = structuredClone((await engine.inbox('p1')).items[0]);
  const reaction = { suggestionId, kind: 'accepted', requestId: 'accept' };
  await engine.feedback('p1', reaction); await engine.feedback('p1', reaction);
  assert.equal((await engine.view('p1')).events.length, 1);
  await engine.feedback('p1', { suggestionId, kind: 'supplement', requestId: 'empty', text: '', linkedSessionId: null });
  await engine.feedback('p1', { suggestionId, kind: 'dismissed', requestId: 'close' });
  let state = rsiReview(suggestionId, (await engine.view('p1')).events);
  assert.equal(state.decision, 'accepted'); assert.equal(state.closed, true);
  await engine.feedback('p1', { suggestionId, kind: 'reopened', requestId: 'open' });
  state = rsiReview(suggestionId, (await engine.view('p1')).events);
  assert.equal(state.decision, 'accepted'); assert.equal(state.closed, false);
  await engine.feedback('p1', { suggestionId, kind: 'rejected', requestId: 'reject' });
  await engine.feedback('p1', { suggestionId, kind: 'supplement', requestId: 'reject-empty' });
  assert.equal(rsiReview(suggestionId, (await engine.view('p1')).events).decision, 'rejected');
  await assert.rejects(engine.feedback('p1', { ...reaction, text: 'changed payload' }), /重复请求/);
  assert.equal(calls.length, 1); assert.equal((await engine.view('p1')).events.some(event => event.kind === 'outcome'), false);
  const final = (await engine.inbox('p1')).items[0]; assert.equal(final.action, initial.action); assert.equal(final.evidence.length, initial.evidence.length);
}));

test('session associations validate live eligibility, survive closure, and never change conversation contents', async () => fixture(async ({ engine, session }) => {
  const view = await recommend(engine), suggestionId = view.suggestions[0].id;
  await assert.rejects(engine.feedback('p1', { suggestionId, kind: 'supplement', linkedSessionId: session.id, requestId: 'too-soon' }), /先接受/);
  await engine.feedback('p1', { suggestionId, kind: 'accepted', requestId: 'accept' });
  await assert.rejects(engine.feedback('p1', { suggestionId, kind: 'supplement', linkedSessionId: 'foreign', requestId: 'foreign' }), /当前账号/);
  session.closedAt = new Date().toISOString();
  await assert.rejects(engine.feedback('p1', { suggestionId, kind: 'supplement', linkedSessionId: session.id, requestId: 'closed' }), /开放/);
  delete session.closedAt;
  const before = structuredClone(session);
  await engine.feedback('p1', { suggestionId, kind: 'supplement', linkedSessionId: session.id, text: '先看边界样本', requestId: 'link' });
  assert.deepEqual(session, before);
  session.closedAt = new Date().toISOString();
  await engine.feedback('p1', { suggestionId, kind: 'supplement', linkedSessionId: session.id, text: '会话完成后补充反馈', requestId: 'after-close' });
  assert.equal((await engine.inbox('p1')).sessions.length, 0);
  assert.equal((await engine.inbox('p1')).items[0].review.linkedSessionId, session.id);
  await engine.feedback('p1', { suggestionId, kind: 'supplement', linkedSessionId: null, requestId: 'unlink' });
  assert.equal((await engine.inbox('p1')).items[0].review.linkedSessionId, undefined);
  await assert.rejects(engine.feedback('p2', { suggestionId, kind: 'accepted', requestId: 'other-project' }), /不属于/);
}));

test('blank rejection alone cannot trigger strategy learning', async () => fixture(async ({ engine, calls }) => {
  await engine.configure('p1', { autoLearn: true });
  const view = await recommend(engine);
  await engine.feedback('p1', { suggestionId: view.suggestions[0].id, kind: 'rejected', requestId: 'blank' });
  assert.equal((await engine.view('p1')).queued, false);
  await engine.start('p1', 'learn'); await engine.settled();
  assert.match((await engine.view('p1')).lastError!, /明确反馈/); assert.equal(calls.length, 1);
}));

test('recommendation feedback retains its evaluation target without becoming a project task or execution result', async () => fixture(async ({ engine, session, calls, root }) => {
  const initial = await recommend(engine), suggestionId = initial.suggestions[0].id;
  const beforeSession = structuredClone(session), beforeConfig = structuredClone(initial.config);
  await engine.feedback('p1', { suggestionId, kind: 'accepted', requestId: 'accept-quality' });
  const legacy = await engine.feedback('p1', { suggestionId, kind: 'supplement', text: '下一轮先检查开发集', requestId: 'old-project-note' });
  assert.equal(legacy.feedbackTarget, undefined);
  const reaction = { suggestionId, kind: 'supplement', feedbackTarget: 'recommendation', text: '请补充推荐的背景，并解释它会影响哪项项目判断。只提醒检查记录，关注点偏低。', requestId: 'quality' };
  const event = await engine.feedback('p1', reaction);
  assert.equal((await engine.feedback('p1', reaction)).id, event.id);
  await assert.rejects(engine.feedback('p1', { ...reaction, feedbackTarget: undefined }), /重复请求/);
  await assert.rejects(engine.feedback('p1', { ...reaction, kind: 'outcome', outcome: 'success', requestId: 'false-outcome' }), /推荐评价/);
  const view = await engine.view('p1');
  assert.deepEqual(view.config, beforeConfig); assert.deepEqual(session, beforeSession);
  assert.equal(view.events.some(item => ['outcome', 'action'].includes(item.kind)), false);
  assert.equal(JSON.parse(view.evidence.find(item => item.id === event.evidenceId)!.text).feedbackTarget, 'recommendation');
  assert.equal((await engine.inbox('p1')).items[0].review.feedback, reaction.text);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8'));
  assert.equal(saved.projects['alice:p1'].events.find((item: any) => item.id === event.id).feedbackTarget, 'recommendation');
  await engine.start('p1', 'learn'); await engine.settled();
  const prompt = calls.find(item => item.startsWith('RSI_PROTOCOL_V2:learn'))!;
  assert(prompt); assert.equal((await engine.view('p1')).lastError, undefined);
  const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
  const quality = data.examples.find((item: any) => item.feedback.evidenceId === event.evidenceId);
  assert.equal(quality.feedback.feedbackTarget, 'recommendation'); assert.equal(quality.outcome, undefined);
  assert.equal(quality.decision.kind, 'accepted');
  assert.equal(data.evidence.find((item: any) => item.id === event.evidenceId).text, reaction.text);
  assert.equal(data.evidence.some((item: any) => item.id === legacy.evidenceId), false);
  assert.equal((await engine.view('p1')).activePolicyId, initial.activePolicyId);
}));

test('shadow controls preserve project configuration, resume a paused project, and remove the former daily limit', async () => fixture(async ({ engine, session, calls }) => {
  await engine.configureShadow('p2', { enabled: false });
  await engine.configure('p1', { enabled: true, quiet: true, autoLearn: true, goals: '研究实体边界', acceptance: '保留集独立验证', role: '算法研究', preference: '先看反例', contextChars: 6000 });
  await engine.configureShadow('p1', { enabled: true });
  assert.equal((await engine.view('p2')).config.enabled, false);
  const config = (await engine.view('p1')).config;
  assert.equal(config.quiet, false); assert.equal(config.autoLearn, true);
  assert.equal(config.goals, '研究实体边界'); assert.equal(config.acceptance, '保留集独立验证');
  assert.equal(config.role, '算法研究'); assert.equal(config.preference, '先看反例'); assert.equal(config.contextChars, 6000);
  const before = structuredClone(session);
  await recommend(engine); await recommend(engine);
  assert.equal(calls.length, 2); assert.equal((await engine.view('p1')).lastError, undefined);
  assert.deepEqual(session, before);
  await assert.rejects(engine.configureShadow('p1', { enabled: true, dailyCalls: 24 }));
  await assert.rejects(engine.configureShadow('p1', { enabled: true, goals: 'unexpected' }));
  assert(!('dailyCalls' in (await engine.view('p1')).config));
  await engine.configureShadow('p1', { enabled: false });
  await engine.completed('p1'); await engine.settled(); assert.equal(calls.length, 2);
}));
test('display, visibility and acceptance remain distinct from execution and success', async () => fixture(async ({ engine }) => {
  await engine.configure('p1', { enabled: true }); let view = await recommend(engine); const suggestion = view.suggestions[0];
  for (const kind of ['presented', 'visible', 'accepted'] as const) { await engine.feedback('p1', { suggestionId: suggestion.id, kind, requestId: kind }); await engine.feedback('p1', { suggestionId: suggestion.id, kind, requestId: kind }); }
  view = await engine.view('p1'); assert.equal(view.events.length, 3); assert.equal(rsiSuggestionState(suggestion, view.events), '已接受，效果待验证');
  await engine.start('p1', 'learn'); await engine.settled(); assert.match((await engine.view('p1')).lastError!, /不能仅凭点击/);
  await assert.rejects(engine.feedback('p2', { suggestionId: suggestion.id, kind: 'outcome', text: 'passed', requestId: 'o', outcome: 'success' }), /不属于/);
}));
test('independent heldout comparison gates publishing and rollback restores the exact prior rules', async () => fixture(async ({ engine, calls }) => {
  const candidate = await prepareLearning(engine), before = await engine.view('p1');
  await assert.rejects(engine.publish('p1', candidate.id), /尚未通过/);
  const learningPrompt = calls.find(item => item.startsWith('RSI_PROTOCOL_V2:learn'))!; assert(!learningPrompt.includes('heldout-'));
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); const evaluated = await engine.view('p1');
  assert.equal(evaluated.lastError, undefined); assert.equal(evaluated.evaluations[0].passed, true); assert.equal(evaluated.evaluations[0].candidate.interruptions, 0);
  for (const prompt of calls.filter(item => item.startsWith('RSI_PROTOCOL_V2:recommend'))) assert(!prompt.includes('"required"'));
  await assert.rejects(engine.publish('p1', candidate.id), /人工质量评审/);
  await approveQuality(engine);
  await engine.publish('p1', candidate.id); assert.equal((await engine.view('p1')).activePolicyId, candidate.id);
  await engine.rollback('p1'); assert.equal((await engine.view('p1')).activePolicyId, before.activePolicyId);
}));
test('unsafe replay never passes, and model or project changes invalidate an otherwise passed evaluation', async () => fixture(async ({ engine, session }) => {
  const candidate = await prepareLearning(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); session.model = 'other';
  await assert.rejects(engine.publish('p1', candidate.id), /模型配置/); session.model = 'fixed-test-model';
  await engine.configure('p1', { enabled: true, goals: '新的验收目标' }); await assert.rejects(engine.publish('p1', candidate.id), /已变化/);
  engine.runText = async (_s, prompt) => JSON.stringify(answer(JSON.parse(prompt.split('REFERENCE_DATA=')[1]).evidence, '先检查开发集'));
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  const evaluation = (await engine.view('p1')).evaluations.at(-1)!; assert.equal(evaluation.passed, false); assert(evaluation.reasons.some(item => item.includes('不应打扰')));
}));
test('future evidence, post-learning cases and duplicated heldouts cannot manufacture passing evaluation', async () => fixture(async ({ engine }) => {
  await engine.configure('p1', { enabled: true });
  const ids = await engine.observe('p1', [{ ...observation('future'), eventAt: '2099-01-01T00:00:00.000Z' }]);
  await assert.rejects(engine.addCase('p1', { name: 'future', evidenceIds: ids, cutoff: new Date().toISOString(), shouldSuggest: false, required: [], forbidden: [] }), /未来/);
  const view = await recommend(engine); assert(!view.runs.at(-1)!.evidenceIds.includes(ids[0]));
  const candidate = await prepareLearning(engine); const casesBefore = (await engine.view('p1')).cases.length;
  await engine.addCase('p1', { name: 'late', evidenceIds: [view.evidence.find(item => item.source === 'session' && item.sourceId === 'train')!.id], cutoff: new Date().toISOString(), shouldSuggest: true, required: ['审计'], forbidden: [] });
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); assert.equal((await engine.view('p1')).evaluations.at(-1)!.caseIds.length, casesBefore);
}));
test('quiet mode pauses background work without a daily cap without touching normal session status', async () => fixture(async ({ engine, session, calls }) => {
  await engine.configure('p1', { enabled: true, quiet: true }); await recommend(engine); assert.equal(calls.length, 0);
  await engine.configure('p1', { enabled: true, quiet: false }); await recommend(engine); await recommend(engine);
  assert.equal(calls.length, 2); assert.equal((await engine.view('p1')).lastError, undefined); assert.equal(session.status, 'idle');
}));
test('generation freezes inputs, rejects hallucinated evidence and accepts unrelated concurrent changes', async () => fixture(async ({ engine }) => {
  await engine.configure('p1', { enabled: true });
  engine.runText = async () => JSON.stringify(answer([{ id: 'fabricated', text: '' }])); await recommend(engine);
  assert.match((await engine.view('p1')).lastError!, /输入之外/); assert.equal((await engine.view('p1')).suggestions.length, 0);
  engine.runText = async (_s, prompt) => { await engine.observe('p1', [observation('new-state')]); return JSON.stringify(answer(JSON.parse(prompt.split('REFERENCE_DATA=')[1]).evidence)); };
  const view = await recommend(engine); assert.equal(view.suggestions.length, 1); assert(view.pending?.recommendation);
}));
test('restart retains immutable evidence and published versions; context stays bounded and time-correct', async () => fixture(async ({ engine, root }) => {
  await engine.configure('p1', { enabled: true }); await recommend(engine); const saved = JSON.parse(await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8')); assert.equal(saved.version, 3);
  const evidence = (await engine.view('p1')).evidence;
  const many = Array.from({ length: 100 }, (_, index) => ({ ...evidence[0], id: String(index), sourceId: String(index), text: 'x'.repeat(4000) }));
  const context = rsiContext(many, rsiConfigSchema.parse({ contextChars: 2000 }), rsiDefaultRules); assert(JSON.stringify(context).length < 2000);
  assert.deepEqual(rsiContext(evidence, rsiConfigSchema.parse({}), rsiDefaultRules, '2000-01-01T00:00:00.000Z'), []);
  assert.throws(() => validateRsiAnswer(answer([{ id: 'foreign', text: '' }]), evidence, 2), /输入之外/);
}));

test('explicit personal preferences are shared only across the same account and invalidate stale evaluation', async () => fixture(async ({ engine, owner }) => {
  const candidate = await prepareLearning(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  await engine.personalPreference('p1', '优先解释实验的不确定性');
  assert.equal((await engine.view('p2')).personalPreference, '优先解释实验的不确定性');
  await assert.rejects(engine.publish('p1', candidate.id), /已变化/);
  owner.name = 'bob'; assert.equal((await engine.view('p1')).personalPreference, '');
}));

test('cross-project reuse remains a candidate until independent target-project validation', async () => fixture(async ({ engine, owner }) => {
  const candidate = await prepareLearning(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); await approveQuality(engine); await engine.publish('p1', candidate.id);
  await engine.configure('p2', { enabled: true });
  for (let i = 0; i < 3; i++) {
    const ids = await engine.observe('p2', [observation('target-' + i, i === 2 ? '等待评审' : '新的独立边界问题 ' + i)]);
    await engine.addCase('p2', { name: '独立项目 ' + i, evidenceIds: ids, cutoff: new Date().toISOString(), shouldSuggest: i !== 2, required: i === 2 ? [] : ['边界审计'], forbidden: [] });
  }
  await pause(); const before = (await engine.view('p2')).activePolicyId;
  const copy = await engine.reuse('p2', 'p1', candidate.id);
  assert.equal((await engine.view('p2')).activePolicyId, before); assert.equal(copy.scope, 'user-project');
  await assert.rejects(engine.publish('p2', copy.id), /尚未通过/);
  await engine.start('p2', 'evaluate', 'manual', copy.id); await engine.settled(); await approveQuality(engine, 'p2'); await engine.publish('p2', copy.id);
  assert.equal((await engine.view('p2')).policies.find(item => item.id === copy.id)!.scope, 'general');
  assert.equal((await engine.view('p2')).reusablePolicies[0].validatedProjects, 2);
  owner.name = 'bob'; assert.equal((await engine.view('p2')).reusablePolicies.length, 0);
  await assert.rejects(engine.reuse('p2', 'p1', candidate.id), /只能复用/);
}));

test('an identity change during a model call cannot publish into the next account', async () => fixture(async ({ engine, owner }) => {
  await engine.configure('p1', { enabled: true });
  engine.runText = async (_s, prompt) => { owner.name = 'bob'; return JSON.stringify(answer(JSON.parse(prompt.split('REFERENCE_DATA=')[1]).evidence)); };
  await recommend(engine); const bob = await engine.view('p1');
  assert.equal(bob.runs.length, 0); assert.equal(bob.suggestions.length, 0); assert.equal(bob.lastError, undefined);
  owner.name = 'alice'; assert.equal((await engine.view('p1')).suggestions.length, 0);
}));

test('fixed-model comparisons include reasoning effort and never learn unverified timing changes', async () => fixture(async ({ engine, session }) => {
  const baseRun = engine.runText;
  engine.runText = async (s, prompt, signal) => {
    const output = JSON.parse(await baseRun(s, prompt, signal));
    if (output.rules) { output.rules.cooldownMinutes = 0; output.rules.maxSuggestions = 3; }
    return JSON.stringify(output);
  };
  const candidate = await prepareLearning(engine);
  assert.equal(candidate.rules.cooldownMinutes, 10); assert.equal(candidate.rules.maxSuggestions, 2);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  session.reasoningEffort = 'high'; await assert.rejects(engine.publish('p1', candidate.id), /模型配置/);
}));

test('queued analysis waits for the user turn and disabling aborts the background call only', async () => fixture(async ({ engine, session }) => {
  await engine.configure('p1', { enabled: true }); session.status = 'running';
  await engine.start('p1', 'recommend'); assert.equal((await engine.view('p1')).queued, true); assert.equal(engine.busy, false);
  let entered = false;
  engine.runText = async (_s, _prompt, signal) => new Promise((_, reject) => { entered = true; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
  session.status = 'idle';
  for (let i = 0; i < 150 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(entered); await engine.configure('p1', { enabled: false }); await engine.settled();
  assert.equal(session.status, 'idle'); assert.equal((await engine.view('p1')).runs.at(-1)!.status, 'interrupted');
}));

test('deleting a session removes its evidence, derived recommendations and frozen copies', async () => fixture(async ({ engine, observations }) => {
  observations[0].sessionId = 's1';
  const original = engine.runText;
  engine.runText = async (session, prompt, signal) => {
    const output = JSON.parse(await original(session, prompt, signal));
    if (prompt.startsWith('RSI_PROTOCOL_V2:recommend')) {
      const source = JSON.parse(prompt.split('REFERENCE_DATA=')[1]).evidence.find((item: any) => item.sessionId === 's1');
      if (source) for (const item of output.suggestions) item.evidenceIds = [source.id];
    }
    return JSON.stringify(output);
  };
  const candidate = await prepareLearning(engine);
  await engine.forgetSession('p1', 's1'); const view = await engine.view('p1');
  assert(!view.evidence.some(item => item.sessionId === 's1')); assert.equal(view.suggestions.length, 0);
  assert(!view.policies.some(item => item.id === candidate.id)); assert.equal(view.events.length, 0);
  assert(!JSON.stringify(view).includes('必须先做边界审计'));
}));

test('a restart recovers published strategy and marks unfinished work interrupted without calling a model', async () => fixture(async ({ engine, root, session }) => {
  const candidate = await prepareLearning(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); await approveQuality(engine); await engine.publish('p1', candidate.id); await engine.close();
  const file = path.join(root, 'rsi-v2.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.projects['alice:p1'].runs[0].status = 'running'; await fs.writeFile(file, JSON.stringify(saved));
  const restored = new RsiEngine(root, { scope: projectId => ({ key: 'alice:' + projectId, account: 'alice', user: 'alice', projectId }), session: () => session, collect: async () => [], changed: () => {} }, async () => { throw new Error('must not run on restart'); });
  try { const view = await restored.view('p1'); assert.equal(view.activePolicyId, candidate.id); assert.equal(view.runs[0].status, 'interrupted'); assert.equal(view.busy, false); }
  finally { await restored.close(); }
}));

test('large project settings and sources fit the reference budget', () => {
  const config = rsiConfigSchema.parse({ goals: 'g'.repeat(6000), acceptance: 'a'.repeat(6000), preference: 'p'.repeat(2000), role: 'r'.repeat(2000), contextChars: 2000 });
  const evidence = [{ ...observation('a', 'x'.repeat(8000)), id: 'a', hash: 'a', scope: 's', observedAt: new Date().toISOString() }] as RsiEvidence[];
  const selected = rsiContext(evidence, config, rsiDefaultRules), prompt = rsiPrompt(selected, config, rsiDefaultRules);
  assert(prompt.split('REFERENCE_DATA=')[1].length <= config.contextChars);
});

test('duplicate facts cannot overweight a comparison even alongside three distinct cases', async () => fixture(async ({ engine }) => {
  await prepareLearning(engine);
  const view = await engine.view('p1'), original = view.cases[0];
  await engine.addCase('p1', { name: '重复反例', evidenceIds: [...original.evidenceIds, ...original.evidenceIds], cutoff: new Date().toISOString(), shouldSuggest: original.shouldSuggest, required: original.required, forbidden: original.forbidden });
  await engine.start('p1', 'learn'); await engine.settled();
  const next = (await engine.view('p1')).policies.at(-1)!;
  await engine.start('p1', 'evaluate', 'manual', next.id); await engine.settled();
  assert.match((await engine.view('p1')).lastError!, /不能重复计算/);
}));

test('evaluation no longer has a daily call quota', async () => fixture(async ({ engine, calls }) => {
  const candidate = await prepareLearning(engine); const count = calls.length;
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  assert.equal((await engine.view('p1')).lastError, undefined); assert.equal(calls.length, count + 6);
}));

test('suppressed automatic checks do not restart the cooldown indefinitely', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await fixture(async ({ engine, calls, observations }) => {
    await engine.configure('p1', { enabled: true }); await recommend(engine); assert.equal(calls.length, 1);
    observations.push(observation('next', '新的实验结果'));
    context.mock.timers.tick(5 * 60000);
    await engine.start('p1', 'recommend', 'turn'); await engine.settled(); assert.equal(calls.length, 1);
    context.mock.timers.tick(6 * 60000);
    await engine.start('p1', 'recommend', 'turn'); await engine.settled(); assert.equal(calls.length, 2);
  });
});

test('replay compares actual instants across server timestamp offsets, excluding future and invalid dates', () => {
  const evidence = ['2026-10-19T17:30:00+08:00', '2026-10-19T05:00:00-06:00', 'not-a-date'].map((eventAt, index) => ({ ...observation(String(index)), eventAt, id: String(index), hash: String(index), scope: 's', observedAt: '2026-10-19T09:00:00.000Z' }));
  assert.deepEqual(rsiContext(evidence, rsiConfigSchema.parse({}), rsiDefaultRules, '2026-10-19T10:00:00.000Z').map(item => item.id), ['0']);
});

test('partial settings preserve project intent and user feedback cannot impersonate an execution result', async () => fixture(async ({ engine }) => {
  await engine.configure('p1', { goals: '交付可复用工具', acceptance: '固定场景验收', preference: '说明依据', contextChars: 8000 });
  await engine.configure('p1', { quiet: true });
  const config = (await engine.view('p1')).config;
  assert.equal(config.goals, '交付可复用工具'); assert.equal(config.acceptance, '固定场景验收');
  assert.equal(config.preference, '说明依据'); assert.equal(config.contextChars, 8000);
  await engine.configure('p1', { quiet: false }); const view = await recommend(engine);
  await assert.rejects(engine.feedback('p1', { suggestionId: view.suggestions[0].id, kind: 'accepted', outcome: 'success', requestId: 'mixed' }), /单独记录/);
}));

test('revised decisions reset current supplements, keep history, and reject stale-window feedback', async () => fixture(async ({ engine }) => {
  const suggestionId = (await recommend(engine)).suggestions[0].id;
  const accepted = await engine.feedback('p1', { suggestionId, kind: 'accepted', expectedDecisionId: null, requestId: 'accept' });
  await engine.feedback('p1', { suggestionId, kind: 'supplement', expectedDecisionId: accepted.id, linkedSessionId: 's1', text: '主要判断有帮助，请补充背景', feedbackTarget: 'recommendation', requestId: 'first' });
  const rejected = await engine.feedback('p1', { suggestionId, kind: 'rejected', expectedDecisionId: accepted.id, requestId: 'reject' });
  let review = (await engine.inbox('p1')).items[0].review;
  assert.equal(review.decision, 'rejected'); assert.equal(review.feedback, ''); assert.equal(review.linkedSessionId, undefined);
  await assert.rejects(engine.feedback('p1', { suggestionId, kind: 'supplement', expectedDecisionId: accepted.id, text: '迟到的认可说明', requestId: 'late' }), /处理已更新/);
  await engine.feedback('p1', { suggestionId, kind: 'supplement', expectedDecisionId: rejected.id, text: '推荐重点偏离当前问题', feedbackTarget: 'recommendation', requestId: 'correct' });
  review = (await engine.inbox('p1')).items[0].review;
  assert.equal(review.feedback, '推荐重点偏离当前问题');
  assert((await engine.view('p1')).events.some(event => event.text === '主要判断有帮助，请补充背景'));
  await engine.start('p1', 'learn'); await engine.settled();
  const learned = await engine.view('p1'), data = JSON.parse(learned.learningRuns![0].prompt.split('REFERENCE_DATA=')[1]);
  assert.equal(data.examples.length, 1); assert.equal(data.examples[0].decision.kind, 'rejected');
  assert.equal(data.examples[0].feedback.decisionEventId, rejected.id);
  assert(!JSON.stringify(data).includes('主要判断有帮助'));
}));

test('learning keeps complete opinions, deduplicates unchanged input, and records no-change without creating a candidate', async () => fixture(async ({ engine, calls }) => {
  const suggestionId = (await recommend(engine)).suggestions[0].id;
  await engine.feedback('p1', { suggestionId, kind: 'rejected', requestId: 'reject' });
  const text = '需要补充背景。'.repeat(160) + '但不要增加无关细节，只解释影响当前判断的差异。';
  await engine.feedback('p1', { suggestionId, kind: 'supplement', text, feedbackTarget: 'recommendation', requestId: 'long-feedback' });
  const original = engine.runText;
  engine.runText = async (session, prompt, signal) => {
    if (!prompt.startsWith('RSI_PROTOCOL_V2:learn')) return original(session, prompt, signal);
    calls.push(prompt); const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    assert(data.evidence.some((item: any) => item.text === text)); assert(data.examples[0].feedback.evidenceId);
    return JSON.stringify({ decision: 'keep', hypothesis: '现行策略已覆盖该评价，暂缺额外改进依据', evidenceIds: [data.examples[0].feedback.evidenceId], rules: data.base });
  };
  await engine.start('p1', 'learn'); await engine.settled(); const count = calls.length;
  await engine.start('p1', 'learn'); await engine.settled();
  assert.equal(calls.length, count);
  const view = await engine.view('p1'); assert.equal(view.policies.length, 1); assert.equal(view.learningRuns!.length, 1); assert.equal(view.learningRuns![0].outcome, 'unchanged');
  await engine.configure('p1', { contextChars: 2000 });
  await engine.feedback('p1', { suggestionId, kind: 'supplement', text: '过长的完整意见'.repeat(500), feedbackTarget: 'recommendation', requestId: 'too-long' });
  await engine.start('p1', 'learn'); await engine.settled();
  assert.equal(calls.length, count); assert.match((await engine.view('p1')).lastError!, /完整容纳/);
}));

test('reviews derived from held-out sources cannot leak into learning under another interface fact key', async () => fixture(async ({ engine, calls }) => {
  const view = await recommend(engine), suggestion = view.suggestions[0];
  await engine.addCase('p1', { name: '保留原场景', evidenceIds: suggestion.evidenceIds, cutoff: new Date().toISOString(), shouldSuggest: true, required: ['开发集'], forbidden: [] });
  await engine.feedback('p1', { suggestionId: suggestion.id, kind: 'rejected', text: '这个保留案例的预期答案是边界审计', requestId: 'unrelated-feedback-key' });
  await engine.start('p1', 'learn'); await engine.settled();
  assert.equal(calls.length, 1); assert.match((await engine.view('p1')).lastError!, /保留案例/);
}));

test('learning follows sources in remembered context even when only another source was in the raw delta', async () => fixture(async ({ engine, observations }) => {
  observations[0].sessionId = 'A'; observations.push({ ...observation('B-source', 'B 的近期进展'), sessionId: 'B' });
  let view = await recommend(engine); const suggestionId = view.suggestions[0].id;
  await engine.feedback('p1', { suggestionId, kind: 'rejected', text: '建议缺少项目背景', requestId: 'memory-feedback' });
  view = await engine.view('p1');
  const run = view.runs[0], a = view.evidence.find(item => item.sessionId === 'A')!, b = view.evidence.find(item => item.sessionId === 'B')!;
  run.evidenceIds = [b.id]; run.snapshot!.evidence = [b];
  run.snapshot!.reference = JSON.stringify({ evidence: [b], sessions: [{ sessionId: 'A', evidenceIds: [a.id], summary: '更早的约束' }], priorRecommendations: [] });
  const base = view.policies[0];
  assert(learningReference(view, base).inputEvidence.some(item => item.id === a.id));
  view.cases.push({ id: 'held-memory', name: '记忆中的保留案例', createdAt: new Date().toISOString(), cutoff: new Date().toISOString(), shouldSuggest: true,
    required: ['检查'], forbidden: [], evidenceIds: [a.id], evidence: [a], config: view.config, author: 'alice' });
  assert.throws(() => learningReference(view, base), /保留案例/);
}));

test('changing or clearing feedback invalidates a learned candidate, including outcome-only decision context', async () => fixture(async ({ engine }) => {
  const candidate = await prepareLearning(engine), view = await engine.view('p1'), suggestionId = view.suggestions[0].id;
  await engine.feedback('p1', { suggestionId, kind: 'supplement', text: '', requestId: 'clear' });
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  assert.match((await engine.view('p1')).lastError!, /反馈或来源已更新/);
  const accepted = await engine.feedback('p1', { suggestionId, kind: 'accepted', requestId: 'accept-result' });
  await engine.feedback('p1', { suggestionId, kind: 'outcome', text: '实际执行失败，需要核对边界前提', outcome: 'failure', requestId: 'result' });
  await engine.start('p1', 'learn'); await engine.settled();
  const after = await engine.view('p1'), next = after.policies.at(-1)!;
  const data = JSON.parse(after.learningRuns!.at(-1)!.prompt.split('REFERENCE_DATA=')[1]);
  assert.equal(data.examples[0].outcome.decisionEventId, accepted.id);
  assert.equal(data.examples[0].outcome.decision, 'accepted');
  await engine.feedback('p1', { suggestionId, kind: 'rejected', requestId: 'reject-result' });
  await engine.start('p1', 'evaluate', 'manual', next.id); await engine.settled();
  assert.match((await engine.view('p1')).lastError!, /反馈或来源已更新/);
}));

test('equal keyword scores allow quality review but cannot publish without it; reruns invalidate review', async () => fixture(async ({ engine }) => {
  const candidate = await prepareLearning(engine), original = engine.runText;
  engine.runText = async (session, prompt, signal) => {
    if (prompt.startsWith('RSI_PROTOCOL_V2:learn')) return original(session, prompt, signal);
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    return JSON.stringify(answer(data.evidence, data.evidence.some((item: any) => item.text.includes('等待评审')) ? '' : '先做边界审计，并说明它如何影响本次验收'));
  };
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  let evaluation = (await engine.view('p1')).evaluations.at(-1)!;
  assert.equal(evaluation.passed, true); assert.equal(evaluation.baseline.quality, 1); assert.equal(evaluation.candidate.quality, 1);
  await assert.rejects(engine.publish('p1', candidate.id), /人工质量评审/);
  await engine.reviewEvaluation('p1', evaluation.id, { approved: false, reason: '输出相同，没有观察到推荐质量改善' });
  await assert.rejects(engine.publish('p1', candidate.id), /人工质量评审/);
  await approveQuality(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  assert.equal((await engine.view('p1')).evaluations.at(-1)!.qualityReview, undefined);
  await assert.rejects(engine.reviewEvaluation('p1', evaluation.id, { approved: true, reason: '旧评估' }), /基础回归/);
  await assert.rejects(engine.publish('p1', candidate.id), /人工质量评审/);
}));

test('suggestion ownership follows its cited sessions; deletion clears all learning provenance, not just model citations', async () => fixture(async ({ engine, observations }) => {
  observations[0].sessionId = 'A';
  observations.push({ ...observation('B-evidence', 'B 的开发集需要边界审计'), sessionId: 'B' });
  const original = engine.runText;
  engine.runText = async (session, prompt, signal) => {
    if (prompt.startsWith('RSI_PROTOCOL_V2:learn')) return original(session, prompt, signal);
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    return JSON.stringify(answer([data.evidence.find((item: any) => item.sessionId === 'B')]));
  };
  const view = await recommend(engine), suggestion = view.suggestions[0];
  assert.equal(suggestion.sessionId, 'B');
  await engine.feedback('p1', { suggestionId: suggestion.id, kind: 'rejected', text: '缺少背景与判断依据', requestId: 'quality' });
  await engine.start('p1', 'learn'); await engine.settled();
  const candidate = (await engine.view('p1')).policies.at(-1)!;
  assert(candidate.sourceEvidenceIds!.includes(view.evidence.find(item => item.sessionId === 'A')!.id));
  await engine.forgetSession('p1', 'A');
  const after = await engine.view('p1');
  assert(after.suggestions.some(item => item.id === suggestion.id));
  assert(!after.policies.some(item => item.id === candidate.id));
  assert.equal(after.learningRuns?.length, 0);
}));
