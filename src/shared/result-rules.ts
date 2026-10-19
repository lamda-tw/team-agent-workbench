import { z } from 'zod';
import { contributionCategoryInfo, materialCategories, legacyMaterialCategories, type ContributionCategory } from './content';

export type MaterialCategory = typeof materialCategories[number] | typeof legacyMaterialCategories[number];
export const materialCategorySchema = z.enum([...materialCategories, ...legacyMaterialCategories]);
export const resultCategoryBoundaries: Record<MaterialCategory, { question: string; include: string; exclude: string }> = {
  project_goal: { question: '要做到什么，怎样算达标？', include: '目标、验收标准、范围及约束；保留确认状态。', exclude: '参考资料、文档、样例和协作文本链接归项目资料。AI 的建议不能自动变成已确认目标。' },
  project_material: { question: '要查阅哪些资料或链接？', include: '参考资料、项目文档、样例、数据入口和协作文本链接，写清位置、用途和适用范围。', exclude: '不写成项目目标、验收标准或已实现能力；链接本身不是待办。' },
  capability: { question: '现在已经能做什么？', include: '已实现能力、使用条件、验证范围和限制。', exclude: '计划与候选方案不能写成已有能力；不同环境的能力不能按时间合并。' },
  exploration: { question: '尝试了什么，发现了什么？', include: '方案、取舍、观察和依据，包括失败尝试。', exclude: '不冒充最终定论；可执行的后续动作单独列待办。' },
  todo: { question: '还有什么要做或解决？', include: '可独立推进的任务、缺陷、风险和待确认问题。', exclude: '独立事项逐条保留，不把任务清单压缩成一个摘要。' },
  finding: { question: '这次实践有哪些值得复用的经验，适用于什么条件？', include: '基于项目实际尝试与观察提炼的做法、取舍和教训，写清当时条件、依据和适用边界；包括有依据的失败经验。', exclude: '只报告一次测试的数据归验证结果；尚无实践或观察依据的设想归方法探索；不能把局部经验推广为普遍规律、最终定论或项目强制标准。' },
  project_standard: { question: '哪些规则必须遵守？', include: '人明确确认的规范、约束、验收阈值和判定口径。', exclude: 'AI 建议不能升为标准；要做的功能归需求说明；怎么实现归设计方案。' },
  requirement: { question: '需要做什么、不做什么？', include: '有明确来源的用户/业务目标、行为、范围和非目标；未确认的需求必须说明待确认。', exclude: '实现结构归设计方案；强制规范和已确认验收阈值归项目标准；模型自行提出的优化归改进建议。' },
  design: { question: '为具体需求准备怎样实现？', include: '可实施的结构、流程、接口和关键取舍；写明已采纳或待确认。', exclude: '仅有可行性假设归方法探索；多个选择尚未取舍归方案对比；已完成不等于已验证有效。' },
  method_exploration: { question: '哪种方法值得继续验证？', include: '具有项目依据但可行性或收益尚未证实的假设、思路和候选实现。', exclude: '不能写成已验证结论；单次实测事实归验证结果；完整实现安排归设计方案。' },
  verification: { question: '这次验证观察到了什么，覆盖哪些条件？', include: '明确对象、方法下的观察结果及覆盖范围，保留未测部分。', exclude: '同一主题已提炼出有实践依据的可复用经验时，作为依据并入项目经验，不另生成一条；环境未就绪不算验证结果。' },
  issue: { question: '哪些项目问题或风险尚未解决？', include: '项目本身尚未关闭的问题、触发条件、影响与待验证风险。', exclude: '已确认原因且修复验证通过归排障经验；本机依赖、登录、权限、网络等故障一律排除。' },
  troubleshooting: { question: '项目缺陷为何发生、怎样有效解决？', include: '项目代码、设计或数据缺陷的确认根因及已验证修复，保留复现条件。', exclude: '仅有猜测或修复未验证归问题与风险；本机环境故障和修复流水账一律排除。' },
  guide: { question: '后续怎样重复执行这项项目操作？', include: '有依据的业务、交付操作步骤，保留必要前提和完成检查点。', exclude: '一次性执行日志不保留；本机安装、配置、联网和工具启动修复不保留；实施结构归设计方案。' },
  research: { question: '外部资料提供了什么重要事实？', include: '有可追溯资料来源的外部事实及适用范围，区分事实与推测。', exclude: '自己的实测归验证结果；多个选择的同维度比较归方案对比；已结合项目实践提炼的经验可纳入项目经验，单纯摘录外部观点不算项目经验。' },
  comparison: { question: '不同选择有什么关键差异？', include: '至少两个方案围绕同一目标的同维度差异、代价和适用条件。', exclude: '只有一个方案归设计方案或方法探索；已结合实际取舍提炼出可复用经验时，把必要对比依据并入项目经验。' },
  baseline_change_proposal: { question: '已有做法值得怎样改进？', include: '针对现有做法、带依据但尚未采纳的改进建议，写清预期作用和待验证项。', exclude: '已确认的规则归项目标准；明确的实现安排归设计方案；没有项目依据的通用建议不保留。' }
};

export const preparationCategories = ['capability', 'exploration', 'todo'] as const;
export type PreparationCategory = typeof preparationCategories[number];
export const preparationCategorySchema = z.enum(preparationCategories, { error: '整理方面仅支持已有能力、探索记录、待办事项，请重新选择' });
export const preparationCategoriesSchema = z.array(preparationCategorySchema).min(1, '请至少选择一个整理方面').max(3).refine(values => new Set(values).size === values.length, '整理方面不能重复');
// Older contracts are retained for reading previously reviewed results.
export interface ResultRuleSnapshot { contract: 2 | 3 | 4; categories: ContributionCategory[] }
export function preparationRuleSnapshot(categories: unknown = preparationCategories): ResultRuleSnapshot {
  const selection = preparationCategoriesSchema.safeParse(categories);
  if (!selection.success) throw new Error(selection.error.issues[0].message);
  return { contract: 4, categories: selection.data };
}
export function resultRulesPrompt(categories: readonly ContributionCategory[]) {
  const definitions = categories.map(category => {
    const boundary = resultCategoryBoundaries[category as MaterialCategory];
    return { category, name: contributionCategoryInfo[category].label, ...(boundary || { include: contributionCategoryInfo[category].description }) };
  });
  if (categories.every(category => materialCategories.includes(category as any))) return `先识别内容的用途，再按启用类别分别提炼。类别边界：${JSON.stringify(definitions)}。
允许同一主题在用户选中的类别分别形成成果，但各自回答不同问题，不能复制相同正文。已有能力描述当前实现，探索记录描述尝试及依据，待办事项描述独立后续动作；跨类引用不等于跨类合并。
独立待办逐条输出；只有确属同一事项的重复描述才合并。最多 50 条，超过时返回 sourceReview.status="incomplete" 并说明需缩小范围，不得静默截断。允许 0 条，不凑齐分类。
已有能力写清已经实现的部分和仍然受限的部分，不把测试通过扩大为整体可用；探索记录保留失败和相互矛盾的证据；待办默认待处理，不能由模型宣称已完成。显式处理项目目标时保持待确认，不能据 AI 建议自动确认；项目资料保持参考性质，不能写成目标。
过滤与项目无关的操作流水、凭据和本机临时故障。项目自身的缺陷、交付环境限制和网络适配任务可以保留。不要因正文出现权限或网络就过滤整个项目任务。只从启用类别选择，不为迁就分类夸大事实。`;
  return `整理顺序：先过滤不应保留的信息，再按独立主题提炼和合并，最后为每个主题选择一个主类别。禁止按类别逐个生成，禁止同一主题换类别重复输出。总计最多 5 条，允许 0 条，不凑类别或数量；多个独立主题可以使用相同类别。
类别边界：${JSON.stringify(definitions)}
优先规则：先按主要用途区分需求、标准、设计、操作及问题处理，不因它们也可复用就一律归项目经验。finding 表示项目经验：从实际尝试、观察及取舍中提炼值得后续参考的做法或教训，说明当时条件、证据、适用边界和未验证范围，不要求形成最终定论；相关验证和对比依据放在同一条。只报告实测数据用 verification、摘录外部事实用 research、尚未结合实践的方案比较用 comparison。尚无实践或观察依据的设想用 method_exploration，不能仅加“可能”就包装成经验。未解决项目缺陷用 issue，根因和修复均确认后用 troubleshooting。requirement 描述做什么，project_standard 描述人确认的必须遵守事项，design 描述如何实现，baseline_change_proposal 描述尚未采纳的改进。只能从启用类别选择；没有合适类别且无法如实表达时省略，不夸大事实迁就分类。
示例：单次测试中延迟降低 8% 属于 verification；结合实际尝试提炼“当前负载下缓存命中可减少重复计算，换负载后仍需验证”的做法与边界，属于 finding，必要测试数据作为依据放在同一条。不能写成“缓存必然提升性能”。失败经验同样注明当时配置与观察，不能因一次未奏效就判定某方法永远无效。只有静态检查通过的候选实现通常是 method_exploration，不能写成已验证有效。
硬排除：本机依赖缺失或版本冲突、安装配置、路径权限、账号登录凭证、代理联网、工具启动、资源不足引起的故障及排查修复日志，不论看起来多重要，一律不输出为成果，也不塞入来源详情。只有环境故障时返回空成果。若这些故障限制了有价值的项目方法验证，只保留“尚未完成运行验证，不能确认精度或性能收益”等判断边界，不描述环境错误。区分这些故障与项目代码、设计、数据自身的真实缺陷。`;
}
