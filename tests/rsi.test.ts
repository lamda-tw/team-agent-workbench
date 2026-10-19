import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RsiEngine, rsiContext, rsiPrompt, validateRsiAnswer } from '../src/core/rsi';
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
    const improved = prompt.includes('策略：先做边界审计');
    const quiet = data.evidence.some((item: any) => item.text.includes('等待评审'));
    return JSON.stringify(answer(data.evidence, quiet && improved ? '' : improved ? '先做边界审计，使用开发集验证' : '先检查开发集'));
  });
  try { await run({ engine, root, session, calls, observations, owner }); }
  finally { await engine.close(); await fs.rm(root, { recursive: true, force: true }); }
}
async function recommend(engine: RsiEngine) { await engine.start('p1', 'recommend'); await engine.settled(); return engine.view('p1'); }
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
  await engine.configureShadow('p1', { enabled: false, dailyCalls: 24 });
  await engine.completed('p1'); assert.equal((await engine.view('p1')).queued, false);
  await assert.rejects(engine.start('p1', 'recommend'), /开启/); assert.equal(calls.length, 0);
  await engine.observe('p1', [observation('a')]); assert.equal((await engine.view('p2')).evidence.length, 0);
  assert.equal((await engine.view('p2')).config.enabled, true);
  owner.name = 'bob'; assert.equal((await engine.view('p1')).evidence.length, 0); assert.equal((await engine.view('p1')).config.enabled, true);
  await assert.rejects(engine.view('forbidden'), /不可访问/);
}));

test('restart upgrades untouched legacy defaults but preserves explicit disable and quiet mode', async () => fixture(async ({ engine, root, session }) => {
  const untouched = structuredClone(await engine.view('p1')); untouched.config.enabled = false;
  await engine.configureShadow('p2', { enabled: false, dailyCalls: 7 });
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
    assert.equal((await reopened.view('p2')).config.dailyCalls, 7);
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

test('shadow controls preserve project configuration, resume a paused project, and enforce the call budget', async () => fixture(async ({ engine, session, calls }) => {
  await engine.configureShadow('p2', { enabled: false, dailyCalls: 24 });
  await engine.configure('p1', { enabled: true, quiet: true, autoLearn: true, goals: '研究实体边界', acceptance: '保留集独立验证', role: '算法研究', preference: '先看反例', contextChars: 6000 });
  await engine.configureShadow('p1', { enabled: true, dailyCalls: 1 });
  assert.equal((await engine.view('p2')).config.enabled, false);
  const config = (await engine.view('p1')).config;
  assert.equal(config.quiet, false); assert.equal(config.autoLearn, true);
  assert.equal(config.goals, '研究实体边界'); assert.equal(config.acceptance, '保留集独立验证');
  assert.equal(config.role, '算法研究'); assert.equal(config.preference, '先看反例'); assert.equal(config.contextChars, 6000);
  const before = structuredClone(session);
  await recommend(engine); await recommend(engine);
  assert.equal(calls.length, 1); assert.match((await engine.view('p1')).lastError!, /预算/);
  assert.deepEqual(session, before);
  await assert.rejects(engine.configureShadow('p1', { enabled: true, dailyCalls: 0 }));
  await assert.rejects(engine.configureShadow('p1', { enabled: true, dailyCalls: 2, goals: 'unexpected' }));
  assert.equal((await engine.view('p1')).config.dailyCalls, 1);
  await engine.configureShadow('p1', { enabled: false, dailyCalls: 1 });
  await engine.completed('p1'); await engine.settled(); assert.equal(calls.length, 1);
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
  await engine.publish('p1', candidate.id); assert.equal((await engine.view('p1')).activePolicyId, candidate.id);
  await engine.rollback('p1'); assert.equal((await engine.view('p1')).activePolicyId, before.activePolicyId);
}));
test('unchanged quality never passes, and model or project changes invalidate an otherwise passed evaluation', async () => fixture(async ({ engine, session }) => {
  const candidate = await prepareLearning(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); session.model = 'other';
  await assert.rejects(engine.publish('p1', candidate.id), /模型配置/); session.model = 'fixed-test-model';
  await engine.configure('p1', { enabled: true, goals: '新的验收目标' }); await assert.rejects(engine.publish('p1', candidate.id), /已变化/);
  engine.runText = async (_s, prompt) => JSON.stringify(answer(JSON.parse(prompt.split('REFERENCE_DATA=')[1]).evidence, '先检查开发集'));
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  const evaluation = (await engine.view('p1')).evaluations.at(-1)!; assert.equal(evaluation.passed, false); assert(evaluation.reasons.some(item => item.includes('得分')));
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
test('budget and quiet mode limit background work without touching normal session status', async () => fixture(async ({ engine, session, calls }) => {
  await engine.configure('p1', { enabled: true, quiet: true, dailyCalls: 1 }); await recommend(engine); assert.equal(calls.length, 0);
  await engine.configure('p1', { enabled: true, dailyCalls: 1 }); await recommend(engine); await recommend(engine);
  assert.equal(calls.length, 1); assert.match((await engine.view('p1')).lastError!, /预算/); assert.equal(session.status, 'idle');
}));
test('generation freezes inputs, rejects hallucinated evidence and discards output after project changes', async () => fixture(async ({ engine }) => {
  await engine.configure('p1', { enabled: true });
  engine.runText = async () => JSON.stringify(answer([{ id: 'fabricated', text: '' }])); await recommend(engine);
  assert.match((await engine.view('p1')).lastError!, /输入之外/); assert.equal((await engine.view('p1')).suggestions.length, 0);
  engine.runText = async (_s, prompt) => { await engine.observe('p1', [observation('new-state')]); return JSON.stringify(answer(JSON.parse(prompt.split('REFERENCE_DATA=')[1]).evidence)); };
  const view = await recommend(engine); assert.equal(view.suggestions.length, 0); assert.match(view.runs.at(-1)!.decision!, /已变化/);
}));
test('restart retains immutable evidence and published versions; context stays bounded and time-correct', async () => fixture(async ({ engine, root }) => {
  await engine.configure('p1', { enabled: true }); await recommend(engine); const saved = JSON.parse(await fs.readFile(path.join(root, 'rsi-v2.json'), 'utf8')); assert.equal(saved.version, 2);
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
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); await engine.publish('p1', candidate.id);
  await engine.configure('p2', { enabled: true });
  for (let i = 0; i < 3; i++) {
    const ids = await engine.observe('p2', [observation('target-' + i, i === 2 ? '等待评审' : '新的独立边界问题 ' + i)]);
    await engine.addCase('p2', { name: '独立项目 ' + i, evidenceIds: ids, cutoff: new Date().toISOString(), shouldSuggest: i !== 2, required: i === 2 ? [] : ['边界审计'], forbidden: [] });
  }
  await pause(); const before = (await engine.view('p2')).activePolicyId;
  const copy = await engine.reuse('p2', 'p1', candidate.id);
  assert.equal((await engine.view('p2')).activePolicyId, before); assert.equal(copy.scope, 'user-project');
  await assert.rejects(engine.publish('p2', copy.id), /尚未通过/);
  await engine.start('p2', 'evaluate', 'manual', copy.id); await engine.settled(); await engine.publish('p2', copy.id);
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
  observations[0].sessionId = 's1'; const candidate = await prepareLearning(engine);
  await engine.forgetSession('p1', 's1'); const view = await engine.view('p1');
  assert(!view.evidence.some(item => item.sessionId === 's1')); assert.equal(view.suggestions.length, 0);
  assert(!view.policies.some(item => item.id === candidate.id)); assert.equal(view.events.length, 0);
  assert(!JSON.stringify(view).includes('必须先做边界审计'));
}));

test('a restart recovers published strategy and marks unfinished work interrupted without calling a model', async () => fixture(async ({ engine, root, session }) => {
  const candidate = await prepareLearning(engine);
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled(); await engine.publish('p1', candidate.id); await engine.close();
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

test('comparison preflights remaining budget before consuming partial model calls', async () => fixture(async ({ engine, calls }) => {
  const candidate = await prepareLearning(engine);
  await engine.configure('p1', { enabled: true, dailyCalls: 5 }); const count = calls.length;
  await engine.start('p1', 'evaluate', 'manual', candidate.id); await engine.settled();
  assert.match((await engine.view('p1')).lastError!, /剩余预算不足/); assert.equal(calls.length, count);
}));

test('suppressed automatic checks do not restart the cooldown indefinitely', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await fixture(async ({ engine, calls }) => {
    await engine.configure('p1', { enabled: true }); await recommend(engine); assert.equal(calls.length, 1);
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
