// Native desktop control currently exposes only loaded view messages. Cursor CLI
// owns a separate session store/runtime. Neither proves the two user invariants.
// Keep this gate closed until an implemented native shared-session transport is
// verified with full history, tool state and compaction; matching text is insufficient.
export const cursorSharedSessionUnavailable = '当前 Cursor 无法让 CLI 与 Agents 共用完整历史和上下文。请在 Cursor Agents 中继续这条对话。';
export function assertCursorSharedSessionAvailable(): never {
  throw Object.assign(new Error(cursorSharedSessionUnavailable), { code: 'CURSOR_SHARED_SESSION_UNAVAILABLE' });
}
