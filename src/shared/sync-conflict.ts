export interface SyncFieldConflict { path: string[]; base: unknown; local: unknown; remote: unknown }
export interface SyncSuggestion { status: 'queued' | 'running' | 'ready' | 'error'; summary?: string; fields?: { path: string[]; text: string; reason: string }[]; unresolved?: string[]; error?: string }
export interface SyncConflict { key: string; token: string; base: unknown; local: unknown; remote: unknown; merged: unknown; fields: SyncFieldConflict[]; ai?: SyncSuggestion }
export type SyncChoice = 'local' | 'remote' | 'merged' | 'both';
export const canonicalSync = (value: unknown): string => JSON.stringify(value === undefined ? null : value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function mergeSyncValue(base: unknown, local: unknown, remote: unknown, path: string[] = []): { value: unknown; fields: SyncFieldConflict[] } {
  if (canonicalSync(local) === canonicalSync(remote) || canonicalSync(base) === canonicalSync(remote)) return { value: local, fields: [] };
  if (canonicalSync(base) === canonicalSync(local)) return { value: remote, fields: [] };
  if ((object(base) || base == null) && object(local) && object(remote)) {
    const previous = object(base) ? base : {};
    const value: Record<string, unknown> = {}, fields: SyncFieldConflict[] = [];
    for (const key of new Set([...Object.keys(previous), ...Object.keys(local), ...Object.keys(remote)])) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const result = mergeSyncValue(previous[key], local[key], remote[key], [...path, key]);
      if (result.value !== undefined) value[key] = result.value;
      fields.push(...result.fields);
    }
    return { value, fields };
  }
  return { value: local, fields: [{ path, base, local, remote }] };
}

export function applyConflictVersion(conflict: SyncConflict, side: 'local' | 'remote') {
  let value = structuredClone(conflict.merged);
  for (const field of conflict.fields) {
    if (!field.path.length) value = structuredClone(field[side]);
    else {
      let parent = value as Record<string, unknown>;
      for (const part of field.path.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
      const key = field.path.at(-1)!;
      if (field[side] === undefined) delete parent[key]; else parent[key] = structuredClone(field[side]);
    }
  }
  return value;
}

// Only the text fields shown in the conflict can be edited by an AI proposal or the user.
export function applyConflictText(conflict: SyncConflict, changes: { path: string[]; text: string }[]) {
  let value = structuredClone(conflict.merged);
  const seen = new Set<string>();
  for (const change of changes) {
    const key = JSON.stringify(change.path), field = conflict.fields.find(field => JSON.stringify(field.path) === key);
    if (!field || typeof field.local !== 'string' || typeof field.remote !== 'string' || seen.has(key) || change.text.length > 200000) throw new Error('合并内容或字段无效');
    seen.add(key);
    if (!change.path.length) value = change.text;
    else {
      let parent = value as Record<string, unknown>;
      for (const part of change.path.slice(0, -1)) { if (!object(parent[part])) throw new Error('合并字段已改变'); parent = parent[part]; }
      parent[change.path.at(-1)!] = change.text;
    }
  }
  if (seen.size !== conflict.fields.length) throw new Error('仍有删除、归属或其他分歧，请选择本机或中央版本');
  return value;
}

export function verifiableTextMerge(conflict: SyncConflict, changes: { path: string[]; text: string }[]) {
  const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return conflict.fields.length > 0 && conflict.fields.every(field => {
    const proposed = changes.find(item => JSON.stringify(item.path) === JSON.stringify(field.path));
    return typeof field.local === 'string' && typeof field.remote === 'string' && !!proposed
      && normalize(field.local) === normalize(field.remote) && normalize(proposed.text) === normalize(field.local);
  });
}
