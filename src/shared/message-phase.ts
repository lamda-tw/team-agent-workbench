import type { Message } from './types';

export function assistantMessagePhase(value: unknown): Message['phase'] {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}
