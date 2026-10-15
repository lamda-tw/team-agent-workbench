import type { Message } from '../shared/types';
import type { CursorDesktopHistory } from './cursor-desktop-history';

/** A display projection only. These records are never fed back as model context.
 * The native header order and native IDs remain authoritative, including errors,
 * tool results retained in compaction archives and separately stored Read blobs. */
export function cursorHistoryMessages(history: CursorDesktopHistory): Message[] {
  const present = (value: unknown) => value !== undefined && value !== null && (Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? !!value.trim() : typeof value === 'object' ? Object.keys(value).length > 0 : true);
  const toolResults = new Map<string, unknown[]>();
  for (const message of [...history.archivedMessages, ...history.promptMessages]) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (part?.type === 'tool-result' && typeof part.toolCallId === 'string') {
      const values = toolResults.get(part.toolCallId) || [];
      if (!values.some(value => JSON.stringify(value) === JSON.stringify(part))) values.push(part);
      toolResults.set(part.toolCallId, values);
    }
  }
  return history.bubbles.map(bubble => {
    const callId = bubble.toolFormerData?.toolCallId;
    const nativeDetails: NonNullable<Message['nativeDetails']> = {};
    if (present(bubble.thinking)) nativeDetails.thinking = bubble.thinking;
    if (present(bubble.allThinkingBlocks)) nativeDetails.allThinkingBlocks = bubble.allThinkingBlocks;
    if (bubble.toolFormerData !== undefined) nativeDetails.toolCall = bubble.toolFormerData;
    if (bubble.errorDetails !== undefined) nativeDetails.error = bubble.errorDetails;
    const fullResults = callId ? toolResults.get(callId) : undefined;
    if (fullResults || present(bubble.toolResults)) nativeDetails.toolResults = fullResults || bubble.toolResults;
    const artifacts = callId ? history.toolArtifacts.filter(artifact => artifact.toolCallId === callId) : [];
    if (artifacts.length) nativeDetails.artifacts = artifacts.map(({ content, blobId }) => ({ content, blobId }));
    const timestamp = typeof bubble.createdAt === 'string' && Number.isFinite(Date.parse(bubble.createdAt)) ? bubble.createdAt : new Date(0).toISOString();
    const text = typeof bubble.text === 'string' && bubble.text ? bubble.text : bubble.toolFormerData?.name || (bubble.capabilityType === 22 ? bubble.summarizationAborted ? '上下文压缩已停止' : bubble === history.bubbles.at(-1) && !history.settled ? '正在压缩上下文…' : '上下文已压缩' : '');
    return { id: 'cursor-native:' + bubble.bubbleId, nativeItemId: bubble.bubbleId, role: bubble.type === 1 ? 'user' : bubble.toolFormerData ? 'tool' : 'assistant', text, createdAt: timestamp, ...(Object.keys(nativeDetails).length ? { nativeDetails } : {}) };
  });
}
