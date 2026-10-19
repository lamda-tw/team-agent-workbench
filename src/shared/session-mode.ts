import { z } from 'zod';

export type SessionMode = 'default' | 'plan' | 'ask';
export interface SessionModeOption { id: SessionMode; name: string; description: string }
export interface SessionModeCatalog { modes: SessionModeOption[]; current: SessionMode; error?: string }
export interface PlanStep { text: string; status: 'pending' | 'inProgress' | 'completed' | 'cancelled' }
export interface ProposedPlan { messageId: string; text: string; ready: boolean; accepted?: boolean }
export const modeOption = (id: SessionMode): SessionModeOption => ({ id,
  name: id === 'default' ? 'Agent' : id === 'plan' ? 'Plan' : 'Ask',
  description: id === 'default' ? '执行任务' : id === 'plan' ? '先研究并制定计划' : '回答问题，不修改代码',
});
// Codex plan items use protocol ids such as "plan-123", not session UUIDs.
export const planMessageIdSchema = z.string().min(1).max(1000);
export const planExecuteSchema = z.object({ id: z.string().uuid(), messageId: planMessageIdSchema });
export const planReviseSchema = planExecuteSchema.extend({ text: z.string().trim().min(1).max(100000) });
export function planSteps(value: unknown): PlanStep[] {
  return (Array.isArray(value) ? value : []).flatMap(item => {
    const text = item?.step || item?.content;
    if (typeof text !== 'string' || !text.trim()) return [];
    return [{ text: text.slice(0, 4000), status: item.status === 'completed' ? 'completed' as const : item.status === 'inProgress' || item.status === 'in_progress' ? 'inProgress' as const : item.status === 'cancelled' ? 'cancelled' as const : 'pending' as const }];
  });
}
