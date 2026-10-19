import { resultDefaultStatus } from '../shared/result-model';
import { z } from 'zod';
import { contributionCategoryFields, contributionCategorySchema, contributionTitle } from '../shared/content';
import type { Draft, DraftArtifact } from '../shared/types';
import type { EmptyPreparationResult } from '../shared/preparation-review';
import { assertReadableResultText } from '../shared/result-reading';

export const preparedResultSchema = z.object({
  category: contributionCategorySchema, topic: z.string().trim().min(1).max(100),
  origin: z.enum(['project', 'local_environment']),
  title: z.string().trim().min(1).max(40), body: z.string().trim().min(1).max(500),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  updateId: z.string().max(100).optional(), sourceDetails: z.string().max(4000).optional(), attachmentIds: z.array(z.string().max(100)).max(30).optional(), repoUrl: z.string().max(2048).optional()
});

// A conservative backstop, not a claim that regex can classify arbitrary prose.
// The prompt excludes these before extraction; explicit model origin is also checked.
export function containsLocalEnvironmentError(text: string) {
  return /(?:command not found|CreateProcessAsUser failed)/i.test(text)
    || /(?:未安装|缺少|没有安装|无法导入|找不到模块|no module named)[^。\n]{0,45}(?:PyTorch|torch|python|node|npm|依赖|模块|软件包)/i.test(text)
    || /(?:PyTorch|torch|python|node|npm|依赖|模块|软件包)[^。\n]{0,30}(?:未安装|缺失|无法导入|版本冲突|版本不兼容)/i.test(text)
    || /(?:本机|本地环境|工作机|开发机|当前机器|local environment)[^。\n]{0,60}(?:失败|错误|不足|缺少|缺失|未安装|权限|断网|不通|配置|冲突)/i.test(text)
    || /(?:登录凭证|登录认证|代理连接|本地路径|工具启动|CLI 启动|依赖安装|环境配置)[^。\n]{0,30}(?:失败|错误|过期|无效|缺失|修复|排查|解决)/i.test(text);
}
const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

export function reviewPreparedResults(draft: Draft, raw: unknown) {
  const modern = draft.resultRules?.contract === 4;
  const parsed = z.object({
    artifacts: z.array(preparedResultSchema).max(modern ? 50 : 5),
    sourceReview: z.object({ status: z.enum(['complete', 'incomplete']), inputCount: z.number().int().nonnegative().optional(), conversationHash: z.string().optional(), explanation: z.string().max(600).optional() }).optional(),
    emptyReason: z.object({ code: z.enum(['already_saved', 'no_reusable_content', 'no_matching_category']), explanation: z.string().trim().min(1).max(600), existingResultIds: z.array(z.string()).max(100).default([]) }).optional()
  }).safeParse(raw);
  if (!parsed.success) throw new Error(`整理结果不符合精简规则（最多 ${modern ? 50 : 5} 条，条数超限或缺少主题、来源；每条标题不超过 40 字、正文不超过 500 字），请重试整理`);
  if ((draft.resultRules?.contract || 0) >= 3) {
    const review = parsed.data.sourceReview;
    if (!review || review.status !== 'complete') throw new Error('未能完整读取本次材料，不能判断是否有新成果。' + (review?.explanation || '请重试整理。'));
    if (review.inputCount !== (draft.snapshot?.messageCount ?? draft.mergeSources?.length ?? 0) || draft.snapshot && review.conversationHash !== draft.snapshot.conversationHash) throw new Error('AI 读取的材料范围与本次快照不一致，请重试整理，不能将此结果视为没有新内容');
    if (!parsed.data.artifacts.length && !parsed.data.emptyReason) throw new Error('AI 返回了空结果，但未说明原因，请重试整理');
  }
  const categories = new Set(draft.resultRules!.categories), evidence = new Set(draft.preparationEvidenceIds || []);
  const topics = new Set<string>(), titles = new Set<string>(), bodies = new Set<string>();
  const results: z.infer<typeof preparedResultSchema>[] = [];
  for (const item of parsed.data.artifacts) {
    if (item.origin === 'local_environment' || !modern && containsLocalEnvironmentError([item.topic, item.title, item.body, item.sourceDetails].filter(Boolean).join('\n'))) continue;
    if (!categories.has(item.category)) throw new Error('整理结果使用了本次未选择的类别，请重试整理');
    if (item.evidenceIds.some(id => !evidence.has(id))) throw new Error('整理结果引用了本次冻结材料中不存在的来源，请重试整理');
    if (item.updateId && (item.category !== 'capability' || !draft.preparationExistingResults?.some(existing => existing.id === item.updateId && existing.category === 'capability' && existing.version && existing.scope !== 'team' && existing.state !== 'history'))) throw new Error('更新建议没有对应的当前个人能力版本，请重试整理');
    if (modern && !draft.mergeSources?.length && !item.evidenceIds.some(id => /^(message:|file:)/.test(id) || id === 'handoff')) throw new Error('新成果必须有本次对话或材料的依据，不能只重写历史参考，请重试整理');
    assertReadableResultText(item.title, '标题'); assertReadableResultText(item.body);
    if (item.body.split(/\n\s*\n/).length > 3) throw new Error('成果正文超过三段，请重新精简整理');
    const topic = (modern ? item.category + ':' : '') + normalized(item.topic) + (modern && item.category === 'todo' ? ':' + normalized(item.title) : ''), title = (modern ? item.category + ':' : '') + normalized(item.title), body = normalized(item.body);
    if (!topic || topics.has(topic) || titles.has(title) || bodies.has(body)) throw new Error('同一主题被重复整理，请合为一条后重试');
    topics.add(topic); titles.add(title); bodies.add(body); results.push(item);
  }
  let emptyResult: EmptyPreparationResult | undefined;
  if (!results.length) {
    if (parsed.data.artifacts.length) emptyResult = { code: 'filtered', explanation: `模型返回了 ${parsed.data.artifacts.length} 条候选，但都被本机环境故障排除规则过滤。请核对整理范围和分类；这不代表原会话没有项目成果。` };
    else if (parsed.data.emptyReason) {
      const reason = parsed.data.emptyReason;
      assertReadableResultText(reason.explanation, '空结果说明');
      const existing = draft.preparationExistingResults || [];
      if (reason.existingResultIds.some(id => !existing.some(item => item.id === id)) || reason.code === 'already_saved' && !reason.existingResultIds.length) throw new Error('空结果未关联有效的已有成果，无法核对去重依据，请重试整理');
      emptyResult = { code: reason.code, explanation: reason.explanation, existingResults: existing.filter(item => reason.existingResultIds.includes(item.id)) };
    }
  }
  return { artifacts: results, emptyResult };
}

export function validatePreparedResults(draft: Draft, raw: unknown) {
  return reviewPreparedResults(draft, raw).artifacts;
}

export function preparedArtifact(item: z.infer<typeof preparedResultSchema>, id: string, target: string): DraftArtifact {
  return { id, category: item.category, resultStatus: resultDefaultStatus(item.category), title: contributionTitle(item.category, item.title), body: item.body,
    fields: { [contributionCategoryFields[item.category][0]]: item.body }, target, selected: true,
    topic: item.topic, evidenceIds: item.evidenceIds, sourceDetails: item.sourceDetails,
    attachments: [], repoUrl: item.repoUrl };
}
