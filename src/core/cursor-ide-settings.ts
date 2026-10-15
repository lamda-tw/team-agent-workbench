import type { CursorNativeSettings } from '../shared/cursor-native-settings';

/** Serialized into the IDE renderer alongside cursorIdePage. Uses the current
 * native UI's own choices and handlers, including its confirmation/policy flow.
 * No private service mutation, CLI config writes or native storage writes. */
export function cursorIdeSettings(root: HTMLElement, arg: { operation?: string; id?: string; kind?: string; value?: string; revision?: string }): CursorNativeSettings | any {
  const visible = (node: Element) => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const clean = (value: string) => value.replace(/[\u200b\ufeff\ue000-\uf8ff]/g, '').replace(/\s+/g, ' ').trim();
  const unique = <T,>(values: T[]) => [...new Set(values)];
  // A DOM node's fiber may point to the previous render. Resolve the committed
  // HostRoot and find this exact node there; never call an alternate's handler.
  const propsFor = (node: Element): any[] => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
      if (!key) continue;
      let fiber = (element as any)[key], hops = 0;
      while (fiber?.return && hops++ < 150) fiber = fiber.return;
      const committed = fiber?.stateNode?.current;
      if (!committed) continue;
      const stack = [committed]; let count = 0, match: any;
      while (stack.length && count++ < 30000) {
        const next = stack.pop();
        if (next.stateNode === element) { match = next; break; }
        if (next.sibling) stack.push(next.sibling);
        if (next.child) stack.push(next.child);
      }
      const result: any[] = [];
      for (let cursor = match, depth = 0; cursor && depth++ < 150; cursor = cursor.return) if (cursor.memoizedProps) result.push(cursor.memoizedProps);
      return result;
    }
    return [];
  };
  const buttons = [...root.querySelectorAll<HTMLElement>('.vscode-model-picker__trigger, .ui-model-picker__trigger')].filter(visible);
  const modelButton = buttons.length === 1 ? buttons[0] : undefined;
  const modelProps = modelButton ? propsFor(modelButton) : [];
  const contexts = unique(modelProps.map(props => props.value).filter(value => value && Array.isArray(value.models) && Array.isArray(value.state?.selections) && typeof value.selectModel === 'function' && typeof value.setAutoMode === 'function'));
  const modelContext = contexts.length === 1 ? contexts[0] : undefined;
  // Native transcript rows carry the effective approval context for this chat.
  // The caller has already required one visible composer and its exact ID.
  const anchors = [...document.querySelectorAll<HTMLElement>('[data-message-id], [id^="bubble-"]')].filter(node => visible(node) && (node.hasAttribute('data-message-id') || node.id.startsWith('bubble-' + arg.id + '-')));
  const approvals: any[] = [];
  for (const node of anchors.slice(-12)) {
    for (const props of propsFor(node)) {
      const value = props.toolApprovalContext || props.value?.toolApprovalContext;
      if (value && Array.isArray(value.availableAutorunModes) && typeof value.autorunMode === 'string' && typeof value.onSetAutorunMode === 'function') approvals.push(value);
    }
  }
  const approvalContexts = unique(approvals), approval = approvalContexts.length === 1 ? approvalContexts[0] : undefined;
  const modeButtons = [...root.querySelectorAll<HTMLElement>('.composer-unified-dropdown[data-mode]')].filter(visible);
  const modeButton = modeButtons.length === 1 ? modeButtons[0] : undefined;
  const menuPrefix = modeButton ? 'composer-mode-' + modeButton.id + '-' : '';
  const modeRows = menuPrefix ? [...document.querySelectorAll<HTMLElement>('[id]')].filter(node => node.id.startsWith(menuPrefix) && visible(node)) : [];
  const modes = modeRows.map(node => ({ id: node.id.slice(menuPrefix.length), label: clean(node.innerText), disabled: node.id.slice(menuPrefix.length) === 'multitask' || node.getAttribute('aria-disabled') === 'true' || node.classList.contains('disabled') || getComputedStyle(node).cursor === 'not-allowed', ...(node.id.slice(menuPrefix.length) === 'multitask' ? { description: '关联会话暂不支持同时运行多个 Agent' } : {}) }));
  const permissionId = (value: any) => String(value.mode) + (typeof value.sandboxBacked === 'boolean' ? value.sandboxBacked ? ':sandbox' : ':no-sandbox' : '');
  const permissionOptions = approval?.availableAutorunModes.map((value: any) => ({ id: permissionId(value), label: value.label, description: value.description, disabled: !!value.disabled })) || [];
  const selectedPermission = approval?.availableAutorunModes.find((value: any) => value.mode === approval.autorunMode && (typeof value.sandboxBacked !== 'boolean' || value.sandboxBacked === approval.sandboxAutoRunSettingEnabled));
  const selections = modelContext?.state.selections, selected = selections?.length === 1 && (selections[0].count ?? 1) === 1 ? selections[0] : undefined;
  const modelOptions = modelContext ? modelContext.models.filter((value: any) => value.defaultOn !== false || modelContext.additionalVisibleModelIds?.includes(value.name) || selected?.modelId === value.name).map((value: any) => ({ id: value.name, label: value.displayName || value.clientDisplayName || value.name, disabled: !!modelContext.areNamedModelsDisabled })) : [];
  if (modelContext && !modelOptions.some((value: any) => value.id === 'default')) modelOptions.unshift({ id: 'default', label: 'Auto', disabled: false });
  const result: CursorNativeSettings = {
    state: 'unavailable', revision: '',
    ...(selected && modelButton ? { model: { id: selected.modelId, label: clean(modelButton.innerText), options: modelOptions } } : {}),
    ...(modeButton ? { mode: { id: modeButton.dataset.mode!, label: clean(modeButton.innerText), options: modes } } : {}),
    ...(selectedPermission ? { permission: { id: permissionId(selectedPermission), label: selectedPermission.label, description: selectedPermission.description, options: permissionOptions } } : {}),
  };
  if (result.model && result.mode && result.mode.id !== 'multitask' && result.permission && !modelContext?.state.multiModelMode && modelButton?.getAttribute('aria-busy') !== 'true') {
    result.state = 'ready';
    result.revision = JSON.stringify([selections, !!modelContext.state.maxMode, result.mode.id, result.permission.id, permissionOptions]);
  } else result.error = '暂时无法确认 Cursor 的模型、模式或权限，请在原生会话中检查后刷新';
  if (arg.operation === 'settingsOpenMode') {
    if (!modeButton || modeButton.classList.contains('disabled')) throw Error('Cursor 当前不能切换模式');
    if (!modeRows.length) modeButton.click();
    return { ...result, modeMenuOpened: !modeRows.length };
  }
  if (arg.operation === 'settingsCloseMode') { if (modeRows.length && modeButton) modeButton.click(); return result; }
  if (arg.operation !== 'settingsChange') return result;
  if (result.state !== 'ready' || result.revision !== arg.revision) throw Error('Cursor 设置已经变化，请刷新后重新选择');
  if (arg.kind === 'model') {
    const option = modelOptions.find((value: any) => value.id === arg.value);
    if (!option || option.disabled || (modelButton as HTMLButtonElement).disabled || modelContext.pendingMaxModeAction?.status === 'pending') throw Error('当前原生设置不允许选择此模型，请在 Cursor 中处理');
    if (result.model!.id !== arg.value) { if (arg.value === 'default') modelContext.setAutoMode(true); else modelContext.selectModel(arg.value); }
  } else if (arg.kind === 'permission') {
    const option = approval.availableAutorunModes.find((value: any) => permissionId(value) === arg.value);
    if (!option || option.disabled) throw Error('Cursor 当前策略不允许选择此权限');
    if (result.permission!.id !== arg.value) approval.onSetAutorunMode(option.mode, option.sandboxBacked);
  } else if (arg.kind === 'mode') {
    const option = modes.find(value => value.id === arg.value), node = modeRows.find(node => node.id === menuPrefix + arg.value);
    if (!option || option.disabled || !node) throw Error('Cursor 当前不能选择此模式');
    if (result.mode!.id !== arg.value) node.click();
  } else throw Error('原生设置类型无效');
  return result;
}
