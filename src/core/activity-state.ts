import { z } from 'zod';
import { contentUpdateSchema } from './config';

export const activityStateSchema = z.object({
  baselines: z.record(z.string(), z.boolean()),
  jobs: z.array(z.object({
    id: z.string(), owner: z.string(), sessionId: z.string(), event: contentUpdateSchema,
    status: z.enum(['pending', 'matched', 'unrelated', 'obsolete']), attempts: z.number().int().nonnegative(),
    retryAt: z.number().optional(), error: z.string().optional(), reason: z.string().optional(), excerpt: z.string().optional(),
    body: z.string().optional(), summaryHash: z.string().optional(), presentedAt: z.string().optional(),
    ignoredAt: z.string().optional(), attachedSourceId: z.string().optional(), savedConclusionId: z.string().optional(),
  })),
});
