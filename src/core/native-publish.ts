import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentSession } from '../shared/types';
import { findCodexRollout } from './codex-storage';
import { sameNativePath } from './native-transcript';
import { readCodexRollout } from './codex-rollout';

const inside = (root: string, file: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

/** Keep tools and compaction intact. The shared App Server registers this
 * through thread/resume, never a handwritten database row or text-only history. */
export async function prepareDesktopRollout(session: AgentSession, privateHome: string, desktopHome: string) {
  if (session.provider !== 'codex' || session.purpose !== 'work') throw new Error('只有 Codex 工作会话可以同步到桌面版');
  if (!session.nativeId) {
    if (session.messages.some(message => ['user', 'assistant', 'tool'].includes(message.role))) throw new Error('缺少完整的 Codex 会话记录，暂不能同步；原有对话已保留');
    return {};
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.nativeId)) throw new Error('原 Codex 会话标识无效，未同步');
  const privateRecord = session.codexStorage === 'workbench' || session.codexPrivateFork || session.nativePath && inside(privateHome, session.nativePath);
  const sourceHome = privateRecord ? privateHome : desktopHome;
  const source = await findCodexRollout(sourceHome, session.nativeId);
  if (!source) throw new Error('找不到完整的 Codex 会话记录，请恢复原记录后重试；不会用聊天文字替代执行上下文');
  const realRoot = await fs.realpath(sourceHome), realSource = await fs.realpath(source);
  if (!inside(realRoot, realSource)) throw new Error('原会话记录不在对应的 Codex 目录内，未同步');
  const content = await readCodexRollout(source);
  let meta: any;
  try { meta = JSON.parse(content.toString('utf8').split(/\r?\n/).find(line => line.trim()) || ''); } catch {}
  if (meta?.type !== 'session_meta' || meta.payload?.id !== session.nativeId) throw new Error('原会话记录与会话标识不一致，未同步');
  if (sameNativePath(sourceHome, desktopHome)) return { nativeId: session.nativeId, nativePath: source };
  const existing = await findCodexRollout(desktopHome, session.nativeId);
  if (existing) {
    if (!(await readCodexRollout(existing)).equals(content)) throw new Error('Codex 中已有同标识但内容不同的会话，未覆盖；请先核对两端记录');
    return { nativeId: session.nativeId, nativePath: existing };
  }
  const directory = path.join(desktopHome, 'sessions');
  await fs.mkdir(directory, { recursive: true });
  if (!inside(await fs.realpath(desktopHome), await fs.realpath(directory))) throw new Error('Codex 会话目录指向其他位置，未同步');
  const destination = path.join(directory, path.basename(source).replace(/\.jsonl\.zst$/, '.jsonl'));
  // Exclusive creation preserves the exact validated snapshot and prevents
  // simultaneous windows from replacing another record.
  try { await fs.writeFile(destination, content, { flag: 'wx', mode: 0o600 }); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await fs.readFile(destination)).equals(content)) throw new Error('Codex 会话记录已改变，未覆盖；请重新核对');
  }
  return { nativeId: session.nativeId, nativePath: destination };
}
