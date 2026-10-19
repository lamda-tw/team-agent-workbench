import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, Store } from './store';
import type { AgentSession, Draft, ProjectConclusion, SessionInput } from '../shared/types';

export interface PersonalMove {
  version: 1; targetRoot: string; groupId?: string; retainedConclusions?: ProjectConclusion[];
  sessions: AgentSession[]; drafts: Draft[]; conclusions: ProjectConclusion[]; inputs: Record<string, SessionInput>;
}
const journal = (root: string) => path.join(root, 'pending-personal-move.json');
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
  applyPersonalMove(target, move, true); applyPersonalMove(source, move, false);
  try { await target.save(); await source.save(); }
  catch { // The journal makes a partially written pair recoverable, including app/OS interruption.
    try { await target.save(); await source.save(); }
    catch { throw new Error('迁移记录已保留，磁盘保存尚未完成；请检查磁盘后重启工作台恢复迁移，勿重复操作'); }
  }
  await fs.rm(journal(source.root), { force: true });
}
export async function recoverPersonalMove(sourceRoot: string) {
  let move: PersonalMove;
  try { move = JSON.parse(await fs.readFile(journal(sourceRoot), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const base = path.dirname(sourceRoot), relative = path.relative(base, move.targetRoot);
  if (move.version !== 1 || !relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) || path.resolve(move.targetRoot) === path.resolve(sourceRoot)) throw new Error('待恢复迁移的目标目录无效');
  const source = new Store(sourceRoot), target = new Store(move.targetRoot);
  await source.init(); await target.init();
  await persistPersonalMove(source, target, move);
}
