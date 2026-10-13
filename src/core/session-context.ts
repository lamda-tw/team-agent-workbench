import type { AgentSession, MessageContext } from '../shared/types';
import { isConclusionSource } from '../shared/conclusion-context';
import { acceptedSessionContext, uniqueSources } from '../shared/session-context';
import { managedHandoffNotice, recoverSessionContext, sourceHeader, sourceText, workRecordInstructions } from '../shared/session-context-text';
export { workRecordInstructions } from '../shared/session-context-text';

export function migrateSessionContext(s: AgentSession) {
  let hasResponse = false;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'assistant' || m.role === 'tool') { hasResponse = true; continue; }
    if (m.role !== 'user') continue;
    const legacy = recoverSessionContext(s, m.text);
    // The raw prompt is retained in text for trajectory export.
    if (legacy.userText !== m.text && m.userText === undefined) m.userText = legacy.userText;
    if (!m.context && s.nativeId && (legacy.workRecord || legacy.sources.length)) m.context = {
      nativeId: s.nativeId, accepted: hasResponse, workRecord: legacy.workRecord,
      sourceHashes: Object.fromEntries(legacy.sources.map(f => [f.id, f.sha256])),
    };
  }
}

export function sessionContext(s: AgentSession, userText: string, sourceIds: string[], journal?: import('../shared/project-journal').JournalContext) {
  const { sourceHashes: known, workRecord: hasWorkRecord } = acceptedSessionContext(s);
  const selected = [...new Set([...sourceIds, ...(s.projectBrief ? [s.projectBrief.sourceId] : []), ...(s.assignment?.sourceIds || []), ...(s.fork ? [s.fork.sourceId, ...s.fork.inheritedSourceIds] : []), ...s.sources.filter(isConclusionSource).map(source => source.id)])].map(id => {
    const source = s.sources.find(f => f.id === id);
    if (!source) throw new Error('引用不属于当前会话');
    return source;
  });
  const sources = uniqueSources(selected).filter(f => known[f.id] !== f.sha256);
  const managed = s.messages.some(m => m.context?.accepted && m.context.nativeId === s.nativeId && m.text.includes(managedHandoffNotice));
  const workRecord = s.purpose === 'work' && (!hasWorkRecord || !managed);
  const text = userText + (workRecord ? workRecordInstructions(s) : '') + (sources.length ? sourceHeader + sources.map(sourceText).join('\n\n') : '') + (journal?.text || '');
  const context: Omit<MessageContext, 'nativeId' | 'accepted'> = { workRecord, sourceHashes: Object.fromEntries(sources.map(f => [f.id, f.sha256])), ...(journal ? { projectJournal: journal.receipt } : {}) };
  return { text, sources, context };
}
