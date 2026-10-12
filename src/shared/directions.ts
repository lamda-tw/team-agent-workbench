import { z } from 'zod';

export const directionLimit = 12;
export const directionTitleLimit = 40;
export const directionSummaryLimit = 160;
const directionId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '工作方向编号无效');

export const directionDraftSchema = z.object({
  id: directionId,
  title: z.string().trim().min(1, '请填写方向名称').max(directionTitleLimit, `方向名称不超过 ${directionTitleLimit} 字`),
  summary: z.string().trim().max(directionSummaryLimit, `方向说明不超过 ${directionSummaryLimit} 字`).default(''),
});
export type DirectionDraft = z.infer<typeof directionDraftSchema>;
export const directionRecordSchema = directionDraftSchema.extend({ updatedAt: z.string().min(1).max(40) });
export type DirectionRecord = z.infer<typeof directionRecordSchema>;
export const memberDirectionsSchema = z.object({
  username: z.string().min(1).max(64),
  updatedAt: z.string().max(40).default(''),
  directions: z.array(directionRecordSchema).max(directionLimit),
});
export type MemberDirections = z.infer<typeof memberDirectionsSchema>;
export const directionDirectorySchema = z.object({ version: z.literal(1), members: z.array(memberDirectionsSchema).max(5000) });
export type DirectionDirectory = z.infer<typeof directionDirectorySchema>;
export const savedDirectionsSchema = z.object({
  version: z.literal(1), username: z.string().min(1).max(64), updatedAt: z.string().min(1).max(40), directions: z.array(directionRecordSchema).max(directionLimit),
});

export function prepareDirectionSave(raw: unknown): DirectionDraft[] {
  const parsed = z.array(directionDraftSchema).max(directionLimit, `每人最多登记 ${directionLimit} 条工作方向`).safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const titles = new Set<string>(), ids = new Set<string>();
  for (const item of parsed.data) {
    const id = item.id.toLowerCase();
    if (ids.has(id)) throw new Error('工作方向编号重复');
    ids.add(id);
    const title = item.title.toLocaleLowerCase();
    if (titles.has(title)) throw new Error('同一人的方向名称不能重复');
    titles.add(title);
  }
  return parsed.data.map(item => ({ ...item, id: item.id.toLowerCase() }));
}

export function mergeDirectionUpdates(previous: DirectionRecord[], drafts: DirectionDraft[], now: string): DirectionRecord[] {
  const prior = new Map(previous.map(item => [item.id, item]));
  return prepareDirectionSave(drafts).map(item => {
    const old = prior.get(item.id);
    const same = !!old && old.title === item.title && old.summary === item.summary;
    return { ...item, updatedAt: same ? old!.updatedAt : now };
  });
}

export interface DirectionGroup { title: string; people: { username: string; summary: string; updatedAt: string }[] }

export function directionGroups(members: readonly MemberDirections[], query: string): DirectionGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, DirectionGroup>();
  for (const member of members) {
    for (const direction of member.directions) {
      const haystack = `${member.username}\n${direction.title}\n${direction.summary}`.toLocaleLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      const key = direction.title.toLocaleLowerCase();
      const group = groups.get(key) || { title: direction.title, people: [] };
      group.people.push({ username: member.username, summary: direction.summary, updatedAt: direction.updatedAt });
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => b.people.length - a.people.length || a.title.localeCompare(b.title, 'zh'));
}

export function matchingMembers(members: readonly MemberDirections[], query: string): MemberDirections[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...members];
  return members.filter(member => `${member.username}\n${member.directions.map(item => `${item.title}\n${item.summary}`).join('\n')}`.toLocaleLowerCase().includes(needle));
}

export function sortMembers(members: readonly MemberDirections[], self: string): MemberDirections[] {
  return [...members].sort((a, b) => (a.username === self ? -1 : b.username === self ? 1 : a.username.localeCompare(b.username, 'zh')));
}
