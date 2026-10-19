import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';
import { baselineRules, development, holdout, evaluate, type Rule } from './rsi-research-fixture';
import type { RsiObservation } from '../src/shared/rsi';

const json = (text: string) => JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rulesSchema = z.object({ hypothesis: z.string(), rules: z.array(z.object({ label: z.enum(['PERSON', 'ORG']), pattern: z.string().max(800), group: z.number().int().min(1).max(10), ignoreValues: z.array(z.string()) })).min(1).max(6) });
async function main() {
  const root = path.resolve('.test-data', 'rsi-research-' + Date.now()); await fs.mkdir(root, { recursive: true });
  const proxy = process.argv.includes('--proxy') ? process.argv[process.argv.indexOf('--proxy') + 1] : undefined;
  const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'gpt-6-astra';
  const environment = () => proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {};
  const wb = new Workbench(path.join(root, 'researcher'), () => {}, () => {}, undefined, environment), admin = new LocalAdminConnection(() => {});
  const report: any = { version: '2.0.0', experiment: 'synthetic-entity-extraction-rsi-v2', passed: false, model, runtime: process.version, fixed: { metric: 'exact-span-micro-F1-utf16-v1', dataset: 'synthetic-authors-v1', developmentHash: hash(development), holdoutHash: hash(holdout), model, reasoningEffort: 'low' }, calls: [], rounds: [], checks: {} };
  report.sourceHashes = Object.fromEntries(await Promise.all(['src/core/rsi.ts', 'src/core/rsi-workbench.ts', 'src/core/background-text.ts', 'scripts/rsi-research.ts', 'scripts/rsi-research-fixture.ts'].map(async file => [file, hash(await fs.readFile(file, 'utf8'))])));
  console.log(JSON.stringify({ phase: 'start', root, model, realAgent: true, sharedServer: 'local-stub' }));
  try {
    const share = path.join(root, 'shared'); await fs.mkdir(share);
    await admin.connect({ mode: 'local', localRoot: share, host: 'local', port: 22, username: '', fingerprint: '', root: '/srv/teamspace' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'group_create', label: '算法研究验收' });
    const groupName = Object.keys(admin.snapshot.state!.groups)[0];
    await admin.operation({ op: 'user_create', username: 'researcher', name: 'Researcher', password: '123', groups: [groupName], contentAdminGroups: [groupName] });
    await admin.operation({ op: 'user_create', username: 'reviewer', name: 'Reviewer', password: '123', groups: [groupName] });
    await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'researcher'), '123', '', async () => false);
    const project = await wb.createProject('合成实体抽取研究', groupName, { background: '用合成资料验证算法研究和项目助手闭环', objectives: '正确提取 PERSON 与 ORG 的完整字符范围', acceptance: '独立保留集 exact-span micro-F1 不低于 0.95，未知字段不产生实体', constraints: '不修改评测代码或冻结保留集。开发集可见，保留集不能提供给模型。', scope: '合成结构化文档', deliverables: '提取规则与独立指标', resources: '合成开发数据', collaboration: 'researcher 负责提出算法，独立评测器负责评分' });
    const cwd = path.join(root, 'algorithm'); await fs.mkdir(cwd);
    const session = await wb.createSession('codex', cwd, project.id, 'work', undefined, model, 'review', false, 'direct'); session.reasoningEffort = 'low';
    const real = wb.rsi.runText;
    wb.rsi.runText = async (source, prompt, signal) => {
      const id = report.calls.length + 1, phase = prompt.startsWith('RSI_PROTOCOL_V2:learn') ? 'policy-learning' : prompt.startsWith('RSI_PROTOCOL_V2:recommend') ? 'recommendation-or-evaluation' : 'algorithm-research';
      const output = await real(source, prompt, signal);
      await fs.writeFile(path.join(root, `call-${id}.json`), JSON.stringify({ phase, model: source.model, reasoningEffort: source.reasoningEffort, input: prompt, output }, null, 2));
      report.calls.push({ id, phase, inputChars: prompt.length, outputChars: output.length }); console.log(JSON.stringify({ phase: 'agent-returned', id, kind: phase })); return output;
    };
    await wb.rsi.configure(project.id, { enabled: true, dailyCalls: 32, goals: '改进完整实体边界提取', acceptance: '保留集 F1 ≥ 0.95；不读取保留集答案' });
    const record = async (id: string, text: string, source: RsiObservation['source'] = 'execution') => wb.rsi.observe(project.id, [{ source, sourceId: id, factKey: id, version: '1', eventAt: new Date().toISOString(), actor: source === 'execution' ? 'independent-evaluator' : 'researcher', assertion: 'observed', sessionId: session.id, text }]);
    const baseline = evaluate(development, baselineRules); report.baseline = { development: baseline, holdout: evaluate(holdout, baselineRules) };
    session.messages.push({ id: randomUUID(), role: 'user', text: '实体抽取的基线只能抓到姓名第一个词，中文与连字符也有漏检。请建议如何研究。', createdAt: new Date().toISOString() });
    await record('baseline-development', JSON.stringify({ split: 'development', baseline })); await wb.store.save();
    await wb.rsi.start(project.id, 'recommend'); await wb.rsi.settled();
    let view = await wb.rsi.view(project.id); if (view.lastError) throw new Error(view.lastError);
    const suggestion = view.suggestions[0]; if (!suggestion) throw new Error('真实 Agent 未提出可验证建议');
    await wb.rsi.feedback(project.id, { suggestionId: suggestion.id, kind: 'accepted', text: '开始在开发集上验证', requestId: randomUUID() });
    report.checks.acceptanceIsNotSuccess = !(await wb.rsi.view(project.id)).events.some(event => event.kind === 'outcome');
    let rules: Rule[] = baselineRules;
    for (let round = 1; round <= 2; round++) {
      const before = evaluate(development, rules);
      const prompt = `RSI_ALGORITHM_EXPERIMENT_V2\n你是算法研究 Agent。只能使用给出的合成开发集，不能读取文件、工具、网络或冻结保留集。研究结构化文本的 PERSON 和 ORG 提取。返回可用于 JS RegExp(pattern,'gdu') 的规则。group 指完整实体捕获组，ignoreValues 指没有实体的占位值。区间使用 JS UTF-16 索引，不包含空格或字段分隔符；姓名内的空格、点、连字符、Unicode 字符应保留。Organization 的最后一个点是句末分隔符。不要把字符串逐条写死成名单；提出可泛化的字段边界规则。只输出 {"hypothesis":"本轮假设","rules":[{"label":"PERSON或ORG","pattern":"正则字符串","group":1,"ignoreValues":["[unknown]","N/A"]}]}。\n${JSON.stringify({ round, suggestion: suggestion.action, previousRules: rules, development, observedDevelopmentResult: before })}`;
      const result = rulesSchema.parse(json(await wb.rsi.runText(session, prompt, new AbortController().signal)));
      rules = result.rules; const after = evaluate(development, rules);
      report.rounds.push({ round, hypothesis: result.hypothesis, rules, before, after });
      await fs.writeFile(path.join(cwd, `rules-round-${round}.json`), JSON.stringify(result, null, 2));
      await record(`development-round-${round}`, JSON.stringify({ split: 'development', round, independentlyMeasured: after }));
      console.log(JSON.stringify({ phase: 'algorithm-round', round, developmentF1: after.f1 }));
    }
    report.finalHoldout = evaluate(holdout, rules);
    await record('final-independent-holdout', JSON.stringify({ split: 'heldout', f1: report.finalHoldout.f1, fp: report.finalHoldout.fp, fn: report.finalHoldout.fn, evaluator: report.fixed.metric }));
    await wb.rsi.feedback(project.id, { suggestionId: suggestion.id, kind: 'outcome', outcome: report.finalHoldout.f1 >= 0.95 ? 'success' : 'failure', text: `独立评测器记录保留集 F1=${report.finalHoldout.f1}。训练与保留集版本固定；模型没有看过保留样本或答案。`, requestId: randomUUID() });
    // Independent, predeclared policy cases. Their expected answers never enter Agent prompts.
    for (const [index, text] of [
      '另一个实体抽取项目的规则在英文复姓和中文组织名上返回了错误的边界。请给下一步建议，不执行。',
      '开发集里缩写姓名的句点与字段末尾句点混淆，导致完整实体范围错误。应该怎样定位？',
      '算法已经完成本轮实验。负责标注的同事尚未完成复核，先等评审通过再做。当前没有可推进的新事项，不要提出建议。',
    ].entries()) {
      const ids = await record('policy-heldout-' + index, text, 'session');
      await wb.rsi.addCase(project.id, { name: '策略保留案例 ' + (index + 1), evidenceIds: ids, cutoff: new Date().toISOString(), shouldSuggest: index !== 2, required: index === 2 ? [] : ['最小反例', '字符偏移'], forbidden: ['修改冻结测试集', '改动保留集答案'] });
    }
    await wb.rsi.feedback(project.id, { suggestionId: suggestion.id, kind: 'feedback', text: '当前项目的建议仍缺少可复用的边界定位流程：遇到实体边界错误时，先给出“最小反例”和“字符偏移”核对步骤，再谈泛化规则。请在动作描述中明确这两个步骤。只在开发集研究。等评审通过再做是依赖条件，此时保持空建议，不代表我永远不喜欢建议。', requestId: randomUUID() });
    await wb.rsi.start(project.id, 'learn'); await wb.rsi.settled(); view = await wb.rsi.view(project.id);
    const candidate = view.policies.find(policy => policy.status === 'candidate'); if (!candidate) throw new Error(view.lastError || '未得到候选策略');
    report.checks.candidateDidNotPublishItself = view.activePolicyId !== candidate.id;
    const activeBefore = view.activePolicyId;
    await wb.rsi.start(project.id, 'evaluate', 'manual', candidate.id); await wb.rsi.settled(); view = await wb.rsi.view(project.id);
    const evaluation = view.evaluations.at(-1); report.policyEvaluation = evaluation; if (!evaluation?.passed) throw new Error(view.lastError || `独立策略评估未通过：${evaluation?.reasons.join('；')}`);
    await wb.rsi.publish(project.id, candidate.id); report.checks.publishedAfterIndependentEvaluation = (await wb.rsi.view(project.id)).activePolicyId === candidate.id;
    await wb.rsi.rollback(project.id); report.checks.rollback = (await wb.rsi.view(project.id)).activePolicyId === activeBefore;
    report.checks.holdoutImproved = report.finalHoldout.f1 > report.baseline.holdout.f1 && report.finalHoldout.f1 >= 0.95 && report.finalHoldout.fp === 0;
    const traces = await Promise.all((await fs.readdir(root)).filter(file => /^call-\d+\.json$/.test(file)).map(async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))));
    report.checks.holdoutNeverSent = traces.every(trace => holdout.every(sample => !trace.input.includes(sample.text)));
    report.checks.fixedModel = traces.every(trace => trace.model === model && trace.reasoningEffort === 'low');
    report.passed = Object.values(report.checks).every(Boolean);
    if (!report.passed) throw new Error('算法研究验收护栏未全部通过');
  } catch (error: any) { report.error = error.message; process.exitCode = 1; }
  finally {
    await wb.close(); admin.disconnect();
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    const rows = report.rounds.map((round: any) => `| ${round.round} | ${round.before.f1.toFixed(4)} | ${round.after.f1.toFixed(4)} |`).join('\n');
    await fs.writeFile(path.join(root, 'report.md'), `# RSI v2 算法研究验收\n\n结论：${report.passed ? '通过' : '未通过'}。真实 Codex Agent，固定模型 ${model}、low reasoning；共享服务和账号权限使用本地桩。\n\n开发集、保留集及 exact-span micro-F1 评测器预先冻结。模型只收到开发集。\n\n| 轮次 | 修改前开发 F1 | 修改后开发 F1 |\n| --- | --- | --- |\n${rows}\n\n保留集 F1：${report.baseline?.holdout.f1 ?? '未知'} → ${report.finalHoldout?.f1 ?? '未知'}。\n\n策略对照：${report.policyEvaluation?.baseline.quality ?? '未知'} → ${report.policyEvaluation?.candidate.quality ?? '未知'}。\n\n${Object.entries(report.checks).map(([key, value]) => `- ${key}: ${value ? '通过' : '失败'}`).join('\n')}\n\n真实 Agent 调用 ${report.calls.length} 次。${report.error ? '\n\n失败原因：' + report.error : ''}\n\n这是合成实体抽取功能验收，不代表实际业务数据收益或跨项目通用效果。原始调用、候选、指标和失败样本见同目录 JSON。\n`);
    console.log(JSON.stringify({ phase: 'complete', passed: report.passed, root, error: report.error }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
