export type ComposerTrigger = { kind: 'command' | 'skill' | 'plugin'; query: string; start: number; end: number };
export function composerTrigger(text: string, caret = text.length, provider: 'codex' | 'cursor' = 'codex'): ComposerTrigger | undefined {
  const prefix = text.slice(0, caret);
  const command = /^\s*\/([^\s/]*)$/.exec(prefix);
  if (command && (!command[1] || /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(command[1]))) return { kind: 'command', query: command[1].toLowerCase(), start: prefix.indexOf('/'), end: caret };
  const mention = /(?:^|\s)([$@])([^\s$@]*)$/.exec(prefix);
  if (mention && (provider !== 'cursor' || mention[1] === '@') && (!mention[2] || /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(mention[2]))) return { kind: provider === 'cursor' || mention[1] === '$' ? 'skill' : 'plugin', query: mention[2], start: caret - mention[2].length - 1, end: caret };
}
export function removeComposerTrigger(text: string, trigger: ComposerTrigger) { return text.slice(0, trigger.start) + text.slice(trigger.end); }
