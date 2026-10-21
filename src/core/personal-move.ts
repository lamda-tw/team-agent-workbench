import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, Store } from './store';
import type { AgentSession, Draft, ProjectConclusion, SessionInput } from '../shared/types';
import type { JournalRecord } from '../shared/project-journal';

export interface PersonalMove {
  version: 1; targetRoot: string; groupId?: string; retainedConclusions?: ProjectConclusion[]; journals?: JournalRecord[];
  sessions: AgentSession[]; drafts: Draft[]; conclusions: ProjectConclusion[]; inputs: Record<string, SessionInput>;
}
const journal = (root: string) => path.join(root, 'pending-personal-move.json');
export class PersonalMovePendingError extends Error {
  constructor() { super('迁移记录已保留，磁盘保存尚未完成；请检查磁盘后重启工作台恢复迁移，勿重复操作'); }
}
export function applyPersonalMove(store: Store, move: PersonalMove, target: boolean) {
  for (const key of ['sessions', 'drafts', 'conclusions'] as const) {
    const ids = new Set(move[key].map(item => item.id));
    (store[key] as any[]) = [...(target ? structuredClone(move[key]) : key === 'conclusions' ? structuredClone(move.retainedConclusions || []) : []), ...store[key].filter(item => !ids.has(item.id))];
  }
  for (const session of move.sessions) {
    if (target && move.inputs[session.id]) store.inputs[session.id] = structuredClone(move.inputs[session.id]);
    else delete store.inputs[session.id];
  }
  if (!target && move.groupId) store.settings.personalGroups = store.settings.personalGroups?.filter(group => group.id !== move.groupId);
}
export async function persistPersonalMove(source: Store, target: Store, move: PersonalMove) {
  await atomicJson(journal(source.root), move);
  applyPersonalMove(target, move, true);
  if (source !== target) applyPersonalMove(source, move, false);
  else if (move.groupId) source.settings.personalGroups = source.settings.personalGroups?.filter(group => group.id !== move.groupId);
  const save = async () => {
    await target.save(); await source.save();
    for (const record of move.journals || []) {
      if (!move.sessions.some(session => session.id === record.sessionId)) throw new Error('迁移日志与会话不一致');
      await atomicJson(path.join(target.root, 'project-journals', record.sessionId + '.json'), record);
      if (source !== target) await fs.rm(path.join(source.root, 'project-journals', record.sessionId + '.json'), { force: true });
    }
    await fs.rm(journal(source.root), { force: true });
  };
  try { await save(); }
  catch { // The journal makes a partially written pair recoverable, including app/OS interruption.
    try { await save(); }
    catch { throw new PersonalMovePendingError(); }
  }
}
export async function recoverPersonalMove(sourceRoot: string) {
  let move: PersonalMove;
  try { move = JSON.parse(await fs.readFile(journal(sourceRoot), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const base = path.dirname(sourceRoot), relative = path.relative(base, move.targetRoot);
  if (move.version !== 1 || !relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('待恢复迁移的目标目录无效');
  const source = new Store(sourceRoot), target = path.resolve(move.targetRoot) === path.resolve(sourceRoot) ? source : new Store(move.targetRoot);
  await source.init(); if (source !== target) await target.init();
  await persistPersonalMove(source, target, move);
}
