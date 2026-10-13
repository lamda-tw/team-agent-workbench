import type { Message } from '../shared/types';

const key = (message: Message) => message.nativeItemId || message.id.replace(/^native:/, '');
/** Merge authoritative items without deleting local input receipts or newer streamed text. */
export function mergeSharedThread(existing: Message[], thread: any): Message[] {
  const items = (Array.isArray(thread?.turns) ? thread.turns : []).flatMap((turn: any) => Array.isArray(turn.items) ? turn.items : []).slice(-300);
  const used = new Set<Message>(), merged: Message[] = [];
  const byId = new Map(existing.map(message => [key(message), message]));
  const reserved = new Set(items.map((item: any) => byId.get(String(item.id))).filter(Boolean));
  for (const item of items) {
    if (!item?.id) continue;
    let role: Message['role'], text: string;
    if (item.type === 'userMessage') { role = 'user'; text = (item.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text || '').join('\n'); }
    else if (item.type === 'agentMessage' || item.type === 'plan') { role = 'assistant'; text = item.text || ''; }
    else if (item.type === 'commandExecution') { role = 'tool'; text = '$ ' + item.command + '\n' + (item.aggregatedOutput || ''); }
    else continue;
    const previous = byId.get(String(item.id)) || (role === 'user' ? existing.find(message => message.role === 'user' && !used.has(message) && !reserved.has(message) && message.text === text) : undefined);
    if (previous) used.add(previous);
    const keepNewer = previous && role !== 'user' && item.status !== 'completed' && previous.text.length > text.length;
    merged.push({ ...previous, id: previous?.id || String(item.id), nativeItemId: String(item.id), role, text: keepNewer ? previous.text : text, createdAt: previous?.createdAt || new Date().toISOString(), ...(item.type === 'plan' ? { kind: 'plan' as const } : {}) });
  }
  const ids = new Set(merged.map(key));
  return [...merged, ...existing.filter(message => !used.has(message) && !ids.has(key(message)))];
}
