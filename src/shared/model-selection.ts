import type { ProviderCatalog } from './types';

/** The catalog recommendation is not necessarily the user's configured default. */
export function codexDefaultModel(config: { model?: unknown } | undefined, catalog: ProviderCatalog): string | undefined {
  return typeof config?.model === 'string' && config.model.trim() ? config.model.trim() : catalog.models.find(model => model.isDefault)?.id;
}
export function defaultModelLabel(catalog?: ProviderCatalog) {
  return catalog?.defaultModel ? '沿用 CLI 默认模型：' + (catalog.models.find(model => model.id === catalog.defaultModel)?.name || catalog.defaultModel) : '沿用 CLI 默认模型';
}
export function codexModelUnavailableMessage(error: unknown, selectedModel?: string): string | undefined {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!/model_not_found|(?:\bmodel\s[^\n]{0,180}(?:does not exist|not found|not available|not supported|unsupported|do not have access))|(?:\b(?:unsupported|unknown)\s+model\b)|模型[^\n]{0,100}(?:不存在|不可用|不支持)/i.test(text)) return;
  const reported = text.match(/\bmodel\s+[`'"]?([a-z0-9][a-z0-9._/-]{1,100})[`'"]?\s+(?:does|is|was)/i)?.[1];
  const model = reported || selectedModel;
  return `当前 Codex 服务无法使用${model ? '模型「' + model + '」' : '所选模型'}，本轮未完成。请点击输入框下方“选择模型”，刷新列表后选择可用模型，再发送。已有对话保留。`;
}
