import type { AgentRpc } from './rpc';

type ForkStage = 'storage' | 'resume' | 'history' | 'fork';
const labels: Record<ForkStage, string> = { storage: '准备原会话记录', resume: '恢复父会话', history: '准备历史索引', fork: '创建原生分支' };
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);

export class CodexForkError extends Error {
  readonly code?: number | string;
  constructor(readonly stage: ForkStage, cause: unknown, readonly originalMessage = detail(cause)) {
    const hint = /missing projection state|failed to prepare paginated fork/i.test(originalMessage)
      ? 'Codex 未能准备分页历史；原始错误见下方。'
      : /ENOENT|no rollout found|not found|找不到|未找到/i.test(originalMessage)
        ? '请核对原会话记录及工作目录是否仍在本机。' : '';
    super(`创建子会话失败（${labels[stage]}）。${hint}\n原始错误：${originalMessage}`, { cause });
    this.name = 'CodexForkError';
    this.code = (cause as { code?: number | string } | undefined)?.code;
  }
}

export const codexForkError = (stage: ForkStage, error: unknown) => error instanceof CodexForkError ? error : new CodexForkError(stage, error);

/** Only this explicit pre-creation failure is safe to retry. A timeout or an
 * arbitrary fork error can already have created a child, so never replay it. */
export async function forkCodexHistory(rpc: Pick<AgentRpc, 'request'>, params: { threadId: string; [key: string]: unknown }, options: {
  canRepair: () => boolean;
  recovered?: () => void;
}) {
  const request = () => rpc.request('thread/fork', { ...params, excludeTurns: true });
  try { return await request(); }
  catch (error) {
    const original = detail(error);
    if (!/^failed to prepare paginated fork:/i.test(original) || !/missing projection state/i.test(original) || !options.canRepair()) throw codexForkError('fork', error);
    try {
      // Give the native history reader a chance to materialize the projection
      // from its rollout, without generating a turn or compacting context.
      const page = await rpc.request('thread/turns/list', { threadId: params.threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, 15000);
      if (!Array.isArray(page?.data)) throw new Error('Codex 未返回有效的历史索引检查结果');
      if (page.data.some((turn: any) => turn.status === 'inProgress') || !options.canRepair()) throw new Error('父会话状态已改变；为保留原分叉时点，本次未自动重试');
    } catch (preparationError) {
      throw new CodexForkError('history', preparationError, `${original}\n检查历史索引：${detail(preparationError)}`);
    }
    try {
      const result = await request();
      options.recovered?.();
      return result;
    } catch (retryError) { throw new CodexForkError('fork', retryError, `${original}\n准备索引后重试：${detail(retryError)}`); }
  }
}
