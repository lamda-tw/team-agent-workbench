export interface TaskbarAttention {
  dynamics: number;
  completions: string[];
}

export function taskbarAttention(
  questions: { items: { id: string; activityRevision: number }[]; read: Record<string, number> } | undefined,
  updates: { readAt?: string }[],
  sessions: { purpose: string; closedAt?: string; stoppedAt?: string; status: string; error?: string; completion?: { id: string; readAt?: string } }[],
): TaskbarAttention {
  const unreadQuestions = questions?.items.filter(item => (questions.read[item.id] || 0) < item.activityRevision).length || 0;
  const completions = sessions.filter(session => session.purpose === 'work' && !session.closedAt && !session.stoppedAt && session.status === 'idle' && !session.error && session.completion && !session.completion.readAt).map(session => session.completion!.id).sort();
  return { dynamics: unreadQuestions + updates.filter(item => !item.readAt).length, completions };
}

/** Alert only after the first snapshot, and only when something new arrives. */
export function taskbarShouldAlert(previous: TaskbarAttention | undefined, next: TaskbarAttention) {
  if (!previous) return false;
  if (next.dynamics > previous.dynamics) return true;
  const seen = new Set(previous.completions);
  return next.completions.some(id => !seen.has(id));
}
