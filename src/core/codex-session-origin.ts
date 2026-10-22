import type { DatabaseSync } from 'node:sqlite';

export const codexAgentSources = ['agent', 'subagent', 'agent_created_thread'];
export const codexOriginFields = ['source', 'thread_source', 'agent_role', 'agent_nickname', 'agent_path'] as const;

export type CodexSessionOrigin = {
  source?: string | null;
  thread_source?: string | null;
  agent_role?: string | null;
  agent_nickname?: string | null;
  agent_path?: string | null;
  spawned_agent?: number;
};

export function codexOriginColumns(db: DatabaseSync) {
  const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map(row => row.name));
  const edges = db.prepare('PRAGMA table_info(thread_spawn_edges)').all() as { name: string }[];
  const spawned = edges.some(column => column.name === 'child_thread_id')
    ? 'EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id)'
    : '0';
  return [...codexOriginFields.map(field => columns.has(field) ? field : `NULL AS ${field}`), `${spawned} AS spawned_agent`].join(', ');
}

function agentSource(value: string | null | undefined) {
  if (!value) return false;
  if (codexAgentSources.includes(value.trim().toLowerCase())) return true;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return codexAgentSources.includes(parsed.trim().toLowerCase());
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && codexAgentSources.some(source => Object.hasOwn(parsed, source));
  } catch { return false; }
}

export function isCodexAgentThread(thread: CodexSessionOrigin) {
  // Spawn edges describe agent tasks, unlike user-created forks. Closed agents
  // remain internal even if their source column is missing or was rewritten.
  const agentPath = thread.agent_path?.trim();
  return !!thread.spawned_agent || agentSource(thread.source) || agentSource(thread.thread_source)
    || !!thread.agent_role?.trim() || !!thread.agent_nickname?.trim()
    || !!agentPath && agentPath !== '/root';
}
