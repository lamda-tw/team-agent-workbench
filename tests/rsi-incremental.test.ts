import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RsiEngine, type RsiHost } from '../src/core/rsi';
import { applyMemory, evidenceKey, latestProjectEvidence, pendingEvidence, projectContext } from '../src/core/rsi-context';
import { rsiDefaultRules, type RsiObservation, type RsiAnswer } from '../src/shared/rsi';
import type { AgentSession } from '../src/shared/types';

const observation = (id: string, sessionId = 'A', text = id): RsiObservation => ({ source: 'session', sourceId: id, factKey: id, sessionId, sessionTitle: sessionId, messageId: id, turnId: id, sequence: 1, eventAt: new Date().toISOString(), version: text, actor: 'alice', assertion: 'explicit', text });
const response = (data: any): RsiAnswer => ({ state: { progress: '核对当前项目进展', blockers: [], unknowns: [], evidenceIds: data.evidence.map((item: any) => item.id) }, suggestions: [], sessionStates: [...new Set<string>(data.evidence.map((item: any) => item.sessionId).filter(Boolean))].map(sessionId => ({ sessionId, summary: `${sessionId} 的当前进展`, evidenceIds: data.evidence.filter((item: any) => item.sessionId === sessionId).map((item: any) => item.id) })) });
async function fixture(run: (value: { engine: RsiEngine; host: RsiHost; root: string; observations: RsiObservation[]; calls: any[] }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rsi-incremental-')), observations: RsiObservation[] = [], calls: any[] = [];
  const host: RsiHost = {
    scope: projectId => ({ key: projectId, account: 'alice', projectId, user: 'alice' }), session: () => undefined,
    execution: (projectId, config) => ({ id: 'background:' + projectId, title: '', purpose: 'background', provider: config.execution?.provider || 'codex', model: config.execution?.model || 'model-1', networkRoute: config.execution?.networkRoute || 'direct', status: 'idle', cwd: root, messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '', createdAt: '' }),
    collect: async () => structuredClone(observations), changed() {},
  };
  const engine = new RsiEngine(root, host, async (_session, prompt) => { const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]); calls.push(data); return JSON.stringify(response(data)); }, { debounceMs: 25, retryMs: 1000 });
  try { await run({ engine, host, root, observations, calls }); }
  finally { await engine.close(); await fs.rm(root, { recursive: true, force: true }); }
}
async function recommend(engine: RsiEngine) { await engine.start('p', 'recommend'); await engine.settled(); return engine.view('p'); }
async function pump(engine: RsiEngine) { await engine.settled(); await (engine as any).drain(); await engine.settled(); }

test('independent runs retain project/session memory, use per-source deltas, and still retrieve older related evidence', async () => fixture(async ({ engine, observations, calls }) => {
  observations.push(observation('A7', 'A', '量化精度约束'), observation('B4', 'B', '分块性能测试'));
  let view = await recommend(engine);
  assert.equal(calls.length, 1); assert.equal(pendingEvidence(view).length, 0);
  assert(view.memory?.sessions.A); assert(view.memory?.sessions.B);
  observations.push(observation('A8', 'A', '量化精度不达标'), observation('B5', 'B', '分块性能提升'));
  view = await recommend(engine);
  const data = calls[1];
  assert.deepEqual(data.deltaIds.map((id: string) => data.evidence.find((item: any) => item.id === id).sourceId), ['A8', 'B5']);
  assert(data.overview); assert.equal(data.sessions.length, 2); assert(data.relatedIds.length > 0);
  assert.equal(view.memory?.analyzed['session:A8'].offset, observations[2].text.length);
  assert.equal(view.runs[1].snapshot?.reference, JSON.stringify(data));
}));

test('long original messages are consumed in bounded fragments without losing the tail or marking unseen data analyzed', async () => fixture(async ({ engine, observations, calls }) => {
  observations.push(observation('large', 'A', '中文上下文'.repeat(2500) + 'FINAL_TAIL'));
  await engine.configure('p', { contextChars: 2000 });
  let view = await recommend(engine);
  assert(view.memory!.analyzed['session:large'].offset < observations[0].text.length);
  for (let i = 0; i < 90 && pendingEvidence(view).length; i++) view = await recommend(engine);
  assert.equal(pendingEvidence(view).length, 0);
  const fragments = calls.flatMap(data => data.evidence.filter((item: any) => data.deltaIds.includes(item.id) && item.sourceId === 'large'));
  assert.equal(fragments.map(item => item.text).join(''), observations[0].text);
  assert(calls.every(data => JSON.stringify(data).length <= 2000));
}));

test('completed empty recommendations advance coverage; failed calls retain it for retry', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('A1'));
  const original = engine.runText; engine.runText = async () => { throw Error('network down'); };
  let view = await recommend(engine);
  assert.equal(Object.keys(view.memory!.analyzed).length, 0); assert(view.pending?.recommendation);
  engine.runText = original; view = await recommend(engine);
  assert.equal(view.suggestions.length, 0); assert.equal(pendingEvidence(view).length, 0);
}));

test('new concurrent turns remain pending and do not invalidate a completed snapshot', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('A1')); const original = engine.runText;
  engine.runText = async (...args) => { observations.push(observation('B1', 'B')); return original(...args); };
  const view = await recommend(engine);
  assert(view.runs[0].state); assert.equal(view.memory!.analyzed['session:B1'], undefined);
  assert.deepEqual(pendingEvidence(view).map(item => item.sourceId), ['B1']);
}));

test('correction of a cited source prevents publication and leaves its changed version pending, including a revert', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('A1', 'A', '精度合格')); const original = engine.runText;
  engine.runText = async (...args) => { observations[0] = observation('A1', 'A', '精度不合格'); return original(...args); };
  let view = await recommend(engine);
  assert.match(view.runs[0].decision!, /依据已变化/); assert(!view.runs[0].state); assert.equal(Object.keys(view.memory!.analyzed).length, 0);
  engine.runText = original; await recommend(engine);
  observations[0] = observation('A1', 'A', '精度合格'); await engine.collect('p'); view = await engine.view('p');
  assert.equal(pendingEvidence(view)[0].text, '精度合格'); assert.equal(view.evidence.filter(item => item.sourceId === 'A1').length, 3);
}));

test('many sessions are covered in successive bounded batches, including small budgets', async () => fixture(async ({ engine, observations }) => {
  for (let i = 0; i < 48; i++) observations.push(observation('message-' + i, 'session-' + i, '项目任务进展 '.repeat(40)));
  await engine.configure('p', { contextChars: 2000, goals: '目'.repeat(6000), acceptance: '验'.repeat(6000), role: '角'.repeat(2000), preference: '偏'.repeat(2000) });
  let view = await recommend(engine);
  for (let i = 0; i < 220 && pendingEvidence(view).length; i++) view = await recommend(engine);
  assert.equal(pendingEvidence(view).length, 0);
  assert.equal(Object.keys(view.memory!.sessions).length, 48);
  assert(view.runs.every(run => !run.snapshot || run.snapshot.reference.length <= 2000));
}));

test('cooldown expires without another foreground message; no-change events do not call the model', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await fixture(async ({ engine, observations, calls }) => {
    observations.push(observation('A1')); await recommend(engine);
    observations.push(observation('A2')); await engine.completed('p');
    t.mock.timers.tick(30); await pump(engine); assert.equal(calls.length, 1);
    assert((await engine.view('p')).pending?.recommendation);
    t.mock.timers.tick(10 * 60000); await pump(engine); assert.equal(calls.length, 2);
    await engine.completed('p'); t.mock.timers.tick(10 * 60000); await pump(engine); assert.equal(calls.length, 2);
  });
});

test('project configuration changes do not touch foreground sessions; different projects can analyze concurrently', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('A1')); await engine.configureShadow('p', { execution: { provider: 'cursor', model: 'cursor-test', networkRoute: 'direct' } });
  const models: string[] = []; let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  engine.runText = async (session, prompt) => { models.push(session.provider + '/' + session.model); await wait; return JSON.stringify(response(JSON.parse(prompt.split('REFERENCE_DATA=')[1]))); };
  await engine.start('p', 'recommend'); await engine.start('other', 'recommend');
  for (let i = 0; i < 100 && models.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  release(); await engine.settled(); assert.deepEqual(new Set(models), new Set(['cursor/cursor-test', 'codex/model-1']));
}));

test('restart keeps analysis progress and the exact active strategy snapshot despite changed installation defaults', async () => fixture(async ({ engine, root, host, observations }) => {
  observations.push(observation('A1')); const before = await recommend(engine); await engine.close();
  const old = rsiDefaultRules.guidance; rsiDefaultRules.guidance = 'new installation default';
  const restored = new RsiEngine(root, host, async () => { throw Error('do not run'); });
  try {
    const view = await restored.view('p'); assert.deepEqual(view.memory, before.memory); assert.equal(view.activePolicyId, before.activePolicyId);
    assert.deepEqual(view.policies, before.policies); assert.equal(pendingEvidence(view).length, 0);
    const context = projectContext(view, view.config); assert.equal(context.coverage.length, 0);
    assert.equal(view.memory!.analyzed[evidenceKey(view.evidence[0])].evidenceId, before.evidence[0].id);
  } finally { rsiDefaultRules.guidance = old; await restored.close(); }
}));

test('invalid cross-session summaries fail atomically without advancing any cursor', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('A1'), observation('B1', 'B'));
  engine.runText = async (_session, prompt) => { const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]), value = response(data); value.sessionStates = [{ sessionId: 'A', summary: '错误混入 B', evidenceIds: [data.evidence.find((item: any) => item.sessionId === 'B').id] }]; return JSON.stringify(value); };
  const view = await recommend(engine); assert.match(view.lastError!, /其他会话/); assert.equal(Object.keys(view.memory!.analyzed).length, 0);
}));

test('structured memory and feedback survive persistence and arrive as objects in the next recommendation', async () => fixture(async ({ engine, observations, calls, root, host }) => {
  observations.push(observation('A1', 'A', '原型已运行，下一步验证边界'));
  engine.runText = async (_session, prompt) => {
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]); calls.push(data);
    const value = response(data), id = data.evidence.find((item: any) => item.sessionId === 'A').id;
    value.sessionStates = [{ sessionId: 'A', summary: { constraints: [], observations: ['原型已运行'], decisions: ['下一步验证边界'], openQuestions: ['边界表现未知'] }, evidenceIds: [id] }];
    value.suggestions = [{ title: '原型的边界表现尚未验证', action: '补充边界用例，判断能否满足验收要求。', reason: '目前只运行了原型。', conditions: [], uncertainty: '边界表现未知', evidenceIds: [id], priority: .7 }];
    return JSON.stringify(value);
  };
  const before = await recommend(engine), suggestion = before.suggestions[0];
  await engine.feedback('p', { suggestionId: suggestion.id, kind: 'accepted', requestId: 'accept' });
  await engine.feedback('p', { suggestionId: suggestion.id, kind: 'outcome', text: '边界失败，继续修正', outcome: 'failure', requestId: 'outcome' });
  await engine.feedback('p', { suggestionId: suggestion.id, kind: 'supplement', text: '推荐缺少边界样本的背景，请说明为什么影响验收。', feedbackTarget: 'recommendation', requestId: 'quality' });
  await engine.close();
  const restored = new RsiEngine(root, host, async (_session, prompt) => { const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]); calls.push(data); return JSON.stringify(response(data)); });
  try {
    observations.push(observation('A2', 'A', '已定位边界处理问题'));
    const loaded = await restored.view('p');
    assert.deepEqual(loaded.memory, before.memory);
    await recommend(restored);
    const data = calls.at(-1), summary = data.sessions.find((item: any) => item.sessionId === 'A').summary;
    assert.equal(typeof data.overview, 'object'); assert(Array.isArray(data.overview.unknowns));
    assert.deepEqual(summary.observations, ['原型已运行']);
    const feedback = data.priorRecommendations[0].feedback;
    assert.equal(feedback.find((item: any) => item.kind === 'outcome').outcome, 'failure');
    assert.equal(feedback.find((item: any) => item.kind === 'accepted').outcome, undefined);
    assert.equal(feedback.find((item: any) => item.kind === 'supplement').feedbackTarget, 'recommendation');
    assert.equal(feedback.find((item: any) => item.kind === 'supplement').outcome, undefined);
    assert(JSON.stringify(data).length <= loaded.config.contextChars);
  } finally { await restored.close(); }
}));

test('new session fragments retain earlier constraints even when their original source no longer fits this batch', async () => fixture(async ({ engine, observations, calls }) => {
  await engine.configure('p', { contextChars: 5000 });
  observations.push(observation('constraint', 'A', '不可改动原始数据。' + '背景'.repeat(900)));
  engine.runText = async (_session, prompt) => {
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]); calls.push(data);
    const answer = response({ ...data, evidence: data.evidence.filter((item: any) => data.deltaIds.includes(item.id)) });
    answer.sessionStates = answer.sessionStates.map(state => ({ ...state, summary: {
      constraints: calls.length === 1 ? ['不可改动原始数据'] : [], observations: calls.length === 1 ? [] : ['新的实验完成'],
      decisions: [], openQuestions: [],
    } }));
    return JSON.stringify(answer);
  };
  const before = await recommend(engine), old = before.memory!.sessions.A.entries![0];
  for (let i = 0; i < 6; i++) observations.push(observation('new-' + i, 'A', '独立新增实验进展'.repeat(900)));
  let view = await recommend(engine);
  for (let i = 0; i < 8; i++) view = await recommend(engine);
  assert.deepEqual(view.memory!.sessions.A.entries!.find(entry => entry.id === old.id), old);
  assert(view.memory!.sessions.A.entries!.length > 1);
  assert(calls.slice(1).some(data => data.sessions.some((entry: any) => entry.id === old.id)
    && !data.evidence.some((item: any) => item.id === old.evidenceIds[0])));
  assert(calls.every(data => JSON.stringify(data).length <= 5000));
}));

test('first and tail summaries of one long source coexist with exact span identities and survive restart', async () => fixture(async ({ engine, observations, root, host }) => {
  const text = '不可覆盖原始数据。' + '中间数据'.repeat(1100) + '尾部任务：独立测量速度';
  observations.push(observation('long', 'A', text));
  await engine.configure('p', { contextChars: 3000 });
  engine.runText = async (_session, prompt) => {
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    const answer = response({ ...data, evidence: data.evidence.filter((item: any) => data.deltaIds.includes(item.id)) });
    answer.sessionStates = answer.sessionStates.map(state => ({ ...state, summary: {
      constraints: data.evidence.some((item: any) => item.text.includes('不可覆盖原始数据')) ? ['不可覆盖原始数据'] : [],
      observations: [], decisions: data.evidence.some((item: any) => item.text.includes('独立测量速度')) ? ['独立测量速度'] : [], openQuestions: [],
    } }));
    return JSON.stringify(answer);
  };
  let before = await recommend(engine);
  for (let i = 0; i < 60 && pendingEvidence(before).length; i++) before = await recommend(engine);
  assert.equal(pendingEvidence(before).length, 0);
  const entries = before.memory!.sessions.A.entries!;
  assert(entries.length > 1);
  assert(entries.some(entry => typeof entry.summary === 'object' && entry.summary.constraints.includes('不可覆盖原始数据')));
  assert(entries.some(entry => typeof entry.summary === 'object' && entry.summary.decisions.includes('独立测量速度')));
  const spans = entries.flatMap(entry => entry.fragments!).sort((a, b) => a.from - b.from);
  assert.equal(new Set(spans.map(span => span.evidenceId)).size, 1);
  assert.equal(spans[0].from, 0); assert.equal(spans.at(-1)!.to, text.length);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i].from, spans[i - 1].to);
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  await engine.close();
  const restored = new RsiEngine(root, host, async () => { throw Error('do not run'); });
  try {
    const view = await restored.view('p');
    assert.deepEqual(view.memory, before.memory);
    assert(projectContext(view, view.config).reference.length <= 3000);
  } finally { await restored.close(); }
}));

test('only summaries depending on a revised or removed source become invalid; unrelated memories remain', async () => fixture(async ({ engine, observations }) => {
  engine.runText = async (_session, prompt) => {
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    const selected = { ...data, evidence: data.evidence.filter((item: any) => data.deltaIds.includes(item.id)) };
    const answer = response(selected);
    answer.sessionStates.forEach(state => { state.summary = selected.evidence.map((item: any) => item.text).join('；').slice(0, 1100); });
    return JSON.stringify(answer);
  };
  observations.push(observation('accuracy', 'A', '精度上限为 0.08'));
  const first = await recommend(engine), obsolete = first.memory!.sessions.A.entries![0];
  observations.push(observation('dataset', 'A', '不得修改参考数据集'));
  const second = await recommend(engine), unaffected = second.memory!.sessions.A.entries!.find(entry => entry.id !== obsolete.id)!;
  observations[0] = observation('accuracy', 'A', '精度上限修正为 0.06');
  await engine.collect('p');
  const pending = await engine.view('p'), input = JSON.parse(projectContext(pending, pending.config).reference);
  assert(!input.sessions.some((entry: any) => entry.id === obsolete.id));
  assert(input.sessions.some((entry: any) => entry.id === unaffected.id));
  const view = await recommend(engine), entries = view.memory!.sessions.A.entries!;
  assert(!entries.some(entry => entry.id === obsolete.id));
  assert.deepEqual(entries.find(entry => entry.id === unaffected.id), unaffected);
  assert(entries.some(entry => entry.summary === '精度上限修正为 0.06'));
  // Deletion removes the source ledger; unrelated source summaries still remain eligible.
  view.evidence = view.evidence.filter(item => item.sourceId !== 'accuracy');
  applyMemory(view, [], { state: { progress: '', blockers: [], unknowns: [], evidenceIds: [] }, suggestions: [], sessionStates: [] }, [], new Date().toISOString());
  assert.deepEqual(view.memory!.sessions.A.entries, [unaffected]);
}));

test('already covered overlapping spans are deduplicated without dropping the novel part or rewriting earlier summaries', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('overlap', 'A', '0123456789'));
  const view = await engine.collect('p').then(() => engine.view('p')), source = view.evidence.find(item => item.sourceId === 'overlap')!;
  const remember = (from: number, to: number, summary: string) => {
    const item = { ...source, text: source.text.slice(from, to), fragment: { from, to, total: source.text.length } };
    applyMemory(view, [], { state: { progress: '', blockers: [], unknowns: [], evidenceIds: [] }, suggestions: [], sessionStates: [{ sessionId: 'A', summary, evidenceIds: [source.id] }] }, [item], new Date().toISOString());
  };
  remember(0, 4, '首片约束'); remember(3, 8, '中间新增信息'); remember(8, 10, '尾片决定');
  assert.equal(view.memory!.sessions.A.entries!.length, 3);
  remember(0, 10, '不应覆盖旧摘要'); // Covered by the union of three spans, not one entry.
  assert.deepEqual(view.memory!.sessions.A.entries!.map(entry => entry.summary), ['首片约束', '中间新增信息', '尾片决定']);
}));

test('legacy single-summary storage restores without inventing fragment coverage and keeps its history on the next append', async () => fixture(async ({ engine, observations, root, host }) => {
  observations.push(observation('legacy', 'A', '已有旧约束')); await recommend(engine); await engine.close();
  const file = path.join(root, 'rsi-v2.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
  delete saved.projects.p.memory.sessions.A.entries;
  await fs.writeFile(file, JSON.stringify(saved));
  const restored = new RsiEngine(root, host, async (_session, prompt) => {
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]);
    return JSON.stringify(response({ ...data, evidence: data.evidence.filter((item: any) => data.deltaIds.includes(item.id)) }));
  });
  try {
    const loaded = await restored.view('p'), input = JSON.parse(projectContext(loaded, loaded.config).reference);
    assert.equal(input.sessions[0].summary, 'A 的当前进展');
    assert.equal(input.sessions[0].fragments, undefined);
    observations.push(observation('next', 'A', '后续实验'));
    const view = await recommend(restored), entries = view.memory!.sessions.A.entries!;
    assert.equal(entries.length, 2); assert.equal(entries[0].fragments, undefined);
    assert.equal(entries[0].evidenceIds[0], loaded.memory!.sessions.A.evidenceIds[0]);
    assert(entries[1].fragments?.length);
  } finally { await restored.close(); }
}));

test('revised or cleared recommendation feedback leaves the audit ledger but is absent from future recommendation input', async () => fixture(async ({ engine, observations }) => {
  observations.push(observation('A1'));
  engine.runText = async (_session, prompt) => {
    const data = JSON.parse(prompt.split('REFERENCE_DATA=')[1]), answer = response(data);
    answer.suggestions = [{ title: '项目背景不完整', action: '补充项目判断的依据。', reason: '来源不足', conditions: [], uncertainty: '', evidenceIds: [data.evidence[0].id], priority: .5 }];
    return JSON.stringify(answer);
  };
  const initial = await recommend(engine), suggestionId = initial.suggestions[0].id;
  const accepted = await engine.feedback('p', { suggestionId, kind: 'accepted', text: '旧反馈：只关注速度', requestId: 'accept' });
  const revised = await engine.feedback('p', { suggestionId, kind: 'supplement', text: '新反馈：补充背景', feedbackTarget: 'recommendation', requestId: 'revise' });
  let view = await engine.view('p'), input = projectContext(view, view.config);
  assert(!input.reference.includes('旧反馈：只关注速度'));
  assert(input.reference.includes('新反馈：补充背景'));
  const decision = JSON.parse(input.reference).priorRecommendations[0].feedback.find((event: any) => event.kind === 'accepted');
  assert.equal(decision.eventId, accepted.id); assert.equal(decision.text, '');
  assert(!latestProjectEvidence(view).some(item => item.id === accepted.evidenceId));
  assert(latestProjectEvidence(view).some(item => item.id === revised.evidenceId));
  await engine.feedback('p', { suggestionId, kind: 'supplement', text: '', requestId: 'clear' });
  view = await engine.view('p'); input = projectContext(view, view.config);
  assert(!input.reference.includes('旧反馈：只关注速度')); assert(!input.reference.includes('新反馈：补充背景'));
  assert(view.events.some(event => event.id === accepted.id && event.text === '旧反馈：只关注速度'));
  assert(view.events.some(event => event.id === revised.id && event.text === '新反馈：补充背景'));
  assert(!pendingEvidence(view).some(item => item.id === revised.evidenceId));
  await engine.feedback('p', { suggestionId, kind: 'supplement', text: '推荐背景充分。'.repeat(50) + '但是判断层次太低。', requestId: 'long-feedback' });
  await engine.feedback('p', { suggestionId, kind: 'dismissed', requestId: 'close' });
  view = await engine.view('p');
  const displayed = JSON.parse(projectContext(view, view.config).reference).priorRecommendations[0];
  assert.equal(displayed.closed, true);
  assert.equal(displayed.feedback.find((event: any) => event.kind === 'supplement').textTruncated, true);
  assert.equal(displayed.feedback.find((event: any) => event.kind === 'accepted').textTruncated, false);
  await engine.feedback('p', { suggestionId, kind: 'reopened', requestId: 'reopen' });
  view = await engine.view('p');
  assert.equal(JSON.parse(projectContext(view, view.config).reference).priorRecommendations[0].closed, false);
}));
