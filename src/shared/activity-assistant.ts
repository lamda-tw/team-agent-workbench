import type { ContentUpdate } from './types';

export interface ActivityJob {
  id: string; owner: string; sessionId: string; event: ContentUpdate;
  status: 'pending' | 'matched' | 'unrelated' | 'obsolete';
  attempts: number; retryAt?: number; error?: string;
  reason?: string; excerpt?: string; body?: string; summaryHash?: string;
  presentedAt?: string; ignoredAt?: string; attachedSourceId?: string; savedConclusionId?: string;
  availableConclusionId?: string;
}
export interface ActivityAssistantState { baselines: Record<string, boolean>; jobs: ActivityJob[] }
export interface HandoffState { messageCount: number; hash: string; version: number; error?: string; retryAt?: number }
export interface ActivityChoice { jobId: string; attach: boolean; save: boolean }
export interface ActivityActionResult { jobId: string; sourceId?: string; conclusionId?: string; error?: string }
export interface ActivityAssistantView { jobs: ActivityJob[]; busy: boolean; error?: string }
export const activityPending = (job: ActivityJob) => job.status === 'matched' && !job.ignoredAt && !job.attachedSourceId && !job.savedConclusionId;
export const activityOpen = (job: ActivityJob) => job.status === 'matched' && !job.ignoredAt;
export const activityKey = (owner: string, projectId: string) => JSON.stringify([owner, projectId]);
