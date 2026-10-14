import type { ModelOption, Provider, ProviderCatalog, QuotaWindow } from '../shared/types';
import { JsonRpc, spawnCLI, stopCLI } from './rpc';

// Return only display fields. CLI diagnostics and authentication data never reach the renderer.
const reasoningEffortId = /^[A-Za-z0-9_-]{1,32}$/;
export function codexReasoningEfforts(model: any): Pick<ModelOption, 'reasoningEfforts' | 'defaultReasoningEffort'> {
  if (!Array.isArray(model?.supportedReasoningEfforts)) return {};
  const efforts: { id: string; description?: string }[] = [];
  const seen = new Set<string>();
  for (const item of model.supportedReasoningEfforts) {
    const id = typeof item === 'string' ? item : item?.reasoningEffort;
    if (typeof id !== 'string' || !reasoningEffortId.test(id) || seen.has(id)) continue;
    seen.add(id);
    const description = typeof item?.description === 'string' && item.description.trim() ? item.description.trim().slice(0, 200) : undefined;
    efforts.push({ id, ...(description ? { description } : {}) });
  }
  const fallback = typeof model.defaultReasoningEffort === 'string' && seen.has(model.defaultReasoningEffort) ? model.defaultReasoningEffort : undefined;
  return { reasoningEfforts: efforts, ...(fallback ? { defaultReasoningEffort: fallback } : {}) };
}
export function codexModels(result: any): ModelOption[] {
  if (!Array.isArray(result?.data)) throw new Error('无法识别模型列表');
  return result.data.filter((m: any) => !m.hidden && typeof m.model === 'string' && m.model.length > 0)
    .map((m: any) => ({ id: m.model, name: typeof m.displayName === 'string' ? m.displayName : m.model, isDefault: m.isDefault === true, ...codexReasoningEfforts(m) }));
}
export function cursorModels(output: string): ModelOption[] {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const start = clean.indexOf('Available models');
  if (start < 0) throw new Error('无法识别模型列表');
  const rows = clean.slice(start + 'Available models'.length).split(/\r?\n/);
  const models: ModelOption[] = [];
  for (const row of rows) {
    if (/^Tip:/.test(row.trim())) break;
    const match = row.trim().match(/^([\w.:[\],=/-]+)\s+-\s+(.+?)(?:\s+\((current|default|current, default)\))?$/);
    if (match) models.push({ id: match[1], name: match[2], isDefault: !!match[3]?.includes('default') });
  }
  if (!models.length) throw new Error('没有可用模型');
  return models;
}
export function codexQuota(result: any): QuotaWindow[] {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length ? Object.entries(result.rateLimitsByLimitId) : result?.rateLimits ? [['codex', result.rateLimits]] : [];
  const windows: QuotaWindow[] = [];
  for (const [key, raw] of buckets) {
    const bucket = raw as any;
    for (const field of ['primary', 'secondary']) {
      const w = bucket?.[field];
      if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      windows.push({ name: `${typeof bucket.limitName === 'string' ? bucket.limitName : key} · ${field === 'primary' ? '主额度' : '次额度'}`, usedPercent: Math.min(100, Math.max(0, w.usedPercent)), windowMinutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : undefined, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : undefined });
    }
  }
  return windows;
}
export const quotaUrl = (provider: Provider) => provider === 'codex' ? 'https://chatgpt.com/codex/settings/usage' : provider === 'claude' ? 'https://claude.ai/settings/usage' : 'https://cursor.com/dashboard/spending';
export async function inspectCatalog(provider: Provider, executable: string, cwd: string, signal?: AbortSignal, timeout = 20000, env: NodeJS.ProcessEnv = {}): Promise<ProviderCatalog> {
  const result: ProviderCatalog = { models: [], quota: { windows: [], detail: provider === 'cursor' ? '当前 Cursor CLI 未提供个人套餐额度查询。请打开官方额度页查看各用量池的余额和重置日期。' : provider === 'claude' ? 'Claude Code CLI 未提供可靠的套餐额度接口，请在官方额度页查看。' : '额度暂不可用；这不代表额度为零。可重试或打开官方额度页。', url: quotaUrl(provider) }, checkedAt: new Date().toISOString() };
  if (signal?.aborted) throw new Error('查询已取消');
  if (provider === 'claude') {
    result.models = [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }, { id: 'haiku', name: 'Haiku' }];
    return result;
  }
  if (provider === 'cursor') {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawnCLI(executable, ['models'], cwd, env); let output = '', settled = false;
        const finish = (ok: boolean) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          void stopCLI(child).then(() => ok ? resolve(output) : reject(new Error('模型查询失败')));
        };
        const abort = () => finish(false), timer = setTimeout(abort, timeout);
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', data => { output += data.toString(); if (output.length > 1024 * 1024) finish(false); });
        child.stderr.resume(); child.on('error', abort); child.on('close', code => finish(code === 0));
      });
      result.models = cursorModels(output);
    } catch { result.modelError = '模型列表读取失败，请检查 Cursor 登录状态、网络和 CLI 版本后重试。也可沿用 CLI 默认模型。'; }
    return result;
  }
  const rpc = new JsonRpc(executable, ['app-server'], cwd, false, env);
  const abort = () => { void rpc.close(); }, timer = setTimeout(abort, timeout);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench_catalog', version: '0.5.0' } }, timeout);
    rpc.notify('initialized');
    await Promise.all([
      (async () => {
        try {
          let cursor: string | undefined; const seen = new Set<string>(); const models: ModelOption[] = [];
          do {
            const page = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, timeout);
            models.push(...codexModels(page)); cursor = page.nextCursor || undefined;
            if (cursor && seen.has(cursor)) throw new Error('分页错误');
            if (cursor) seen.add(cursor);
          } while (cursor);
          result.models = [...new Map(models.map(m => [m.id, m])).values()];
          if (!result.models.length) result.modelError = 'CLI 未返回可选模型，可沿用默认模型。';
        } catch { result.modelError = '模型列表读取失败，请检查网络和 CLI 版本后重试。也可沿用 CLI 默认模型。'; }
      })(),
      (async () => {
        try {
          // A slow optional quota response must not hold a ready model list for 20 seconds.
          result.quota.windows = codexQuota(await rpc.request('account/rateLimits/read', {}, Math.min(timeout, 3000)));
          if (result.quota.windows.length) result.quota.detail = '这是账号共享额度，按服务端返回的用量池展示；不是当前会话或单个模型的独立额度。';
        } catch { /* Quota availability must not invalidate a usable model list or login. */ }
      })(),
    ]);
  } catch { result.modelError = '无法连接 Codex CLI，请检查程序路径、版本和网络后重试。'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await rpc.close(); }
  return result;
}
