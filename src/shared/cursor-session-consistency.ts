// The IDE file transport executes only through the linked native Cursor Agent
// and reads its authoritative full history. Legacy view-only descriptors and
// independent CLI runtimes remain blocked: matching text/IDs cannot enable them.
export const cursorSharedSessionUnavailable = 'Cursor 联动尚未通过完整历史、上下文压缩与恢复的一致性验证。请在 Cursor Agents 中继续这条对话。';
export function isCursorFileSession(session?: { cursorNative?: { transport?: string } }) { return session?.cursorNative?.transport === 'ide-files-v1'; }
export function assertCursorSharedSessionAvailable(session?: { cursorNative?: { transport?: string } }): void {
  if (isCursorFileSession(session)) return;
  throw Object.assign(new Error(cursorSharedSessionUnavailable), { code: 'CURSOR_SHARED_SESSION_UNAVAILABLE' });
}
