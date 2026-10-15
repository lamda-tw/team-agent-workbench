import { z } from 'zod';
import { assertReadableResultText } from './result-reading';

const sentences = new Intl.Segmenter('zh-CN', { granularity: 'sentence' });
const prose = (maximum: number, label: string) => z.string().trim().min(1, `请填写${label}`).max(maximum, `${label}不超过 ${maximum} 字`);

export const projectOrganizationFields = [
  { key: 'sentence', label: '项目是什么', max: 200, rows: 2, hint: '恰好一句话，说明这是个什么项目。' },
  { key: 'technologies', label: '使用的技术', max: 2000, rows: 4, hint: '使用了哪些技术，各自用在项目的哪一部分。' },
  { key: 'achievements', label: '已经达到的成果', max: 2000, rows: 4, hint: '已经达到的成果。' },
  { key: 'criteria', label: '达标标准', max: 2000, rows: 4, hint: '用什么标准判断这些成果算达到。' },
] as const;
export type ProjectOrganizationKey = typeof projectOrganizationFields[number]['key'];

export const projectOrganizationSchema = z.object({
  sentence: prose(200, '项目说明'),
  technologies: prose(2000, '使用的技术'),
  achievements: prose(2000, '已经达到的成果'),
  criteria: prose(2000, '达标标准'),
});
export type ProjectOrganization = z.infer<typeof projectOrganizationSchema>;

export const organizationEditedMessage = '这个项目的整理结果已经由人改过，不能再自动整理。';
export const organizationExistsMessage = '这个项目已经整理出一条结果。人还没改过时，请在那一条上再次整理。';

export function assertOneProjectSentence(value: string) {
  const text = value.trim();
  if (/[\u0000-\u001f]/.test(text)) throw new Error('项目说明不能包含控制字符');
  const parts = [...sentences.segment(text)].map(item => item.segment.trim()).filter(Boolean);
  if (parts.length !== 1) throw new Error('项目说明必须恰好是一句话');
  return text;
}

export function parseProjectOrganizationAnswer(draft: { snapshot?: { messageCount: number; conversationHash: string }; mergeSources?: readonly unknown[] }, raw: unknown): ProjectOrganization {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请按每个项目一条的格式返回 sentence、technologies、achievements、criteria。');
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.artifacts)) throw new Error('每个项目只整理一条，不要返回多条成果。');
  const review = z.object({
    status: z.enum(['complete', 'incomplete']),
    inputCount: z.number().int().nonnegative().optional(),
    conversationHash: z.string().optional(),
    explanation: z.string().max(600).optional(),
  }).safeParse(record.sourceReview);
  if (!review.success || review.data.status !== 'complete') throw new Error('未能完整读取本次材料，不能判断是否有新成果。' + (review.success ? review.data.explanation || '请重试整理。' : '请重试整理。'));
  const inputCount = draft.snapshot?.messageCount ?? draft.mergeSources?.length ?? 0;
  if (review.data.inputCount !== inputCount || draft.snapshot && review.data.conversationHash !== draft.snapshot.conversationHash) throw new Error('AI 读取的材料范围与本次快照不一致，请重试整理，不能将此结果视为没有新内容');
  return prepareProjectOrganization(record);
}

export function prepareProjectOrganization(raw: unknown): ProjectOrganization {
  const parsed = projectOrganizationSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const profile = parsed.data;
  profile.sentence = assertOneProjectSentence(profile.sentence);
  for (const field of projectOrganizationFields) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(profile[field.key])) throw new Error(`${field.label}不能包含控制字符`);
    assertReadableResultText(profile[field.key], field.label);
  }
  return profile;
}

export function projectOrganizationBody(profile: ProjectOrganization) {
  return projectOrganizationFields.map(field => `## ${field.label}\n\n${profile[field.key]}`).join('\n\n');
}

export function projectOrganizationValues(fields?: Record<string, string>): ProjectOrganization {
  return {
    sentence: fields?.sentence || '',
    technologies: fields?.technologies || '',
    achievements: fields?.achievements || '',
    criteria: fields?.criteria || '',
  };
}

export function organizationTags(text: string, limit = 6): string[] {
  const cleaned = text.replace(/材料未说明/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/[、，,；;\n]/).map(item => item.replace(/[。！？!?]+$/g, '').trim()).filter(Boolean);
  const tags = (parts.length > 1 ? parts : [cleaned.replace(/[。！？!?]+$/g, '')]).map(item => {
    const label = item.split(/[：:]/)[0].trim();
    return label.length > 14 ? label.slice(0, 14) : label;
  }).filter(item => item.length >= 2);
  return [...new Set(tags)].slice(0, limit);
}

export function sameProjectOrganization(left: Record<string, string> | undefined, right: ProjectOrganization) {
  return projectOrganizationFields.every(field => (left?.[field.key] || '') === right[field.key]);
}

export interface OrganizationDraftRef {
  organizationFormat?: 'project-profile-v1';
  artifacts?: readonly { fields?: Record<string, string> }[];
  id: string;
  binding?: { project: { id: string } };
  resultRules?: { contract?: number };
  mergeSources?: readonly unknown[];
  organizationEdited?: boolean;
  submitted?: string;
  generation?: string;
}

export function isProjectOrganizationDraft(draft: { organizationFormat?: string; artifacts?: readonly { fields?: Record<string, string> }[]; resultRules?: { contract?: number }; mergeSources?: readonly unknown[] }) {
  if (draft.mergeSources?.length) return false;
  if (draft.organizationFormat === 'project-profile-v1') return true;
  // Contract 4 was already used by category-based drafts. Recognize earlier
  // project profiles by their actual fields, never by that shared version alone.
  const fields=draft.artifacts?.length===1?draft.artifacts[0].fields:undefined;
  return draft.resultRules?.contract===4 && !!fields && projectOrganizationFields.every(field=>typeof fields[field.key]==='string');
}

export function organizationRefusal(drafts: readonly OrganizationDraftRef[], projectId: string, resumeId?: string) {
  const related = drafts.filter(item => item.binding?.project.id === projectId && isProjectOrganizationDraft(item));
  if (related.some(item => item.organizationEdited)) return organizationEditedMessage;
  if (!resumeId && related.some(item => !item.submitted && item.generation !== 'canceled' && item.generation !== 'error')) return organizationExistsMessage;
}
