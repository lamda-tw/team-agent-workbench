import type { AgentSession } from './types';

export function subsessionParentId(session: AgentSession) {
  return session.fork && !session.fork.promotedAt ? session.parentId || session.fork.parentId : undefined;
}

export function subsessionFamily(sessions: AgentSession[], id: string): AgentSession[] {
  const result: AgentSession[] = [], seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const session = sessions.find(value => value.id === key);
    if (!session) return;
    result.push(session);
    sessions.filter(value => subsessionParentId(value) === key).forEach(value => visit(value.id));
  };
  visit(id);
  return result;
}

export function quoteSessionText(text: string) {
  return text.trim().split(/\r?\n/).map(line => '> ' + line).join('\n') + '\n\n';
}
