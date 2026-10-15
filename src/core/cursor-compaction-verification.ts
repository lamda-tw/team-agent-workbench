import type { CursorDesktopHistory } from './cursor-desktop-history';
import { sameNativePath } from './native-transcript';
import { isDeepStrictEqual } from 'node:util';

type Frame = Pick<CursorDesktopHistory, 'nativeId' | 'cwd' | 'settled' | 'bubbles' | 'promptMessages' | 'archivedMessages' | 'toolArtifacts' | 'summaryArchiveCount' | 'checkpointSha256'>;

/** Compare actual read-only snapshots. A UI marker or successful recall cannot
 * establish that the resumed native session still uses its compacted state. */
export function verifyCursorCompaction(before: Frame, compacted: Frame, resumed: Frame) {
  for (const frame of [compacted, resumed]) {
    if (frame.nativeId !== before.nativeId || !sameNativePath(frame.cwd, before.cwd)) throw new Error('压缩验证的原生会话或目录不一致');
  }
  const summaries = (frame: Frame) => frame.promptMessages.filter(message => message.providerOptions?.cursor?.isSummary === true);
  const messages = (frame: Frame) => [...frame.promptMessages, ...frame.archivedMessages];
  const allSettled = [before, compacted, resumed].every(frame => frame.settled);
  const compactedSummaries = summaries(compacted);
  const compressionObserved = compactedSummaries.some(summary => !messages(before).some(message => message.blobId === summary.blobId)) && compacted.summaryArchiveCount > 0
    && compacted.checkpointSha256 !== before.checkpointSha256 && compacted.promptMessages.length < before.promptMessages.length;
  // Cursor may consolidate archive containers. The exact compacted summary must
  // remain in the current prompt: retaining it only in history is not recovery.
  const compressedStateRetained = summaries(resumed).length > 0 && compactedSummaries.length > 0
    && compactedSummaries.every(summary => summaries(resumed).some(message => message.blobId === summary.blobId && isDeepStrictEqual(message, summary)));
  const historyPreserved = [compacted, resumed].every(frame => {
    let offset = 0;
    return before.bubbles.every(bubble => {
      const index = frame.bubbles.findIndex((other, at) => at >= offset && other.bubbleId === bubble.bubbleId
        && ['type', 'text', 'thinking', 'errorDetails', 'unifiedMode', 'agentMode', 'modelInfo'].every(key => isDeepStrictEqual(other[key], bubble[key])));
      if (index < 0) return false;
      offset = index + 1; return true;
    });
  });
  const expectedCalls = before.bubbles.flatMap(bubble => ['completed', 'error'].includes(bubble.toolFormerData?.status) && typeof bubble.toolFormerData?.toolCallId === 'string' ? [bubble.toolFormerData.toolCallId as string] : []);
  const results = (frame: Frame, callId: string) => messages(frame).filter(message => message.role === 'tool' && Array.isArray(message.content))
    .flatMap(message => (message.content as any[]).filter(part => part?.type === 'tool-result' && part.toolCallId === callId)
      .map(part => ({ part, nativeResult: message.providerOptions?.cursor?.highLevelToolCallResult })));
  const uncoveredTools = [compacted, resumed].flatMap((frame, index) => expectedCalls.filter(callId =>
    results(frame, callId).length === 0)
    .map(callId => ({ stage: index === 0 ? 'compacted' : 'resumed', callId })));
  const toolResultsPreserved = expectedCalls.every(callId => {
    const original = results(before, callId);
    return original.length > 0 && [compacted, resumed].every(frame => original.every(part => results(frame, callId).some(other => isDeepStrictEqual(part, other))));
  });
  const toolArtifactsPreserved = [compacted, resumed].every(frame => before.toolArtifacts.every(artifact =>
    frame.toolArtifacts.some(other => isDeepStrictEqual(artifact, other))));
  const result = !allSettled || !compressionObserved ? 'unverified' : compressedStateRetained && historyPreserved && uncoveredTools.length === 0 && toolResultsPreserved && toolArtifactsPreserved ? 'passed' : 'failed';
  return { result, allSettled, compressionObserved, compressedStateRetained, historyPreserved, uncoveredTools, toolResultsPreserved, toolArtifactsPreserved } as const;
}
