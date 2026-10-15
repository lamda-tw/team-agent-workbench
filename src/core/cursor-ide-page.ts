/** Scoped adapter for the ordinary Cursor IDE. Native UI controls execute the
 * turn; this adapter never imports a CLI history or rewrites an Agent checkpoint. */
export async function cursorIdePage(arg: { operation?: string; id?: string; cwd?: string; token?: string; text?: string; kind?: string; value?: string; revision?: string } = {}, settingsReader?: (root: HTMLElement, arg: any) => any) {
  const visible = (node: Element) => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1').replace(/\/$/, '').toLowerCase();
  const configuration = await (window as any).vscode?.context?.resolveConfiguration();
  if (!configuration || configuration.glass === true) throw new Error('需要在 Cursor 普通 IDE 窗口中打开原会话');
  const workspace = configuration.workspace;
  const uri = workspace?.uri;
  if (!uri || uri.scheme !== 'file' || uri.authority || workspace.configPath || typeof uri.path !== 'string') throw new Error('Cursor 原生工作目录无法确认');
  const cwd = uri.path.replace(/^\/([a-z]:\/)/i, '$1');
  if (arg.cwd && normalize(arg.cwd) !== normalize(cwd)) throw new Error('Cursor 原生工作目录与关联会话不一致');
  const roots = () => [...document.querySelectorAll<HTMLElement>('[data-composer-id]')].filter(visible);
  const nativeId = (root: HTMLElement) => root.getAttribute('data-composer-id') || '';
  const title = (id: string) => {
    const bubble = document.querySelector('[id^="bubble-' + id + '-"]');
    return bubble?.closest('[role="tabpanel"]')?.getAttribute('aria-label') || document.title || 'Cursor 会话';
  };
  if (arg.operation === 'catalog') return { chats: roots().map(root => ({ nativeId: nativeId(root), cwd, title: title(nativeId(root)) })), workspaces: [cwd] };
  const target = () => {
    const all = roots(), matches = all.filter(root => nativeId(root) === arg.id);
    if (all.length !== 1 || matches.length !== 1) throw new Error('请在 Cursor 中只显示关联会话，再继续操作');
    return matches[0];
  };
  const state = () => {
    const root = target(), inputs = [...root.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"]')].filter(visible);
    if (inputs.length !== 1) throw new Error('Cursor 原生输入框不可用');
    const messages = [...document.querySelectorAll<HTMLElement>('[data-message-id][data-message-kind="human"], [data-message-id][data-message-kind="assistant"]')].filter(visible).map(node => ({ id: node.getAttribute('data-message-id')!, role: node.getAttribute('data-message-kind') === 'human' ? 'user' as const : 'assistant' as const, text: (node.querySelector<HTMLElement>('.aislash-editor-input-readonly') || node).innerText }));
    // VS Code also gives nonmodal notification toasts role=dialog. They must
    // not hold a chat queue; real modal confirmations still block dispatch.
    const modal = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .monaco-dialog-box')].some(node => visible(node)
      && (node.getAttribute('aria-modal') === 'true' || !node.closest('.notifications-toasts, .notifications-center, .notification-toast-container')));
    return { root, input: inputs[0], modal, sessionId: arg.id!, status: modal ? 'approval' : root.getAttribute('data-composer-status') || 'unknown', messages: messages.filter((message, index) => messages.findIndex(other => other.id === message.id) === index), draft: (inputs[0].innerText || '').replace(/[\u200b\ufeff]/g, '') };
  };
  const anchors: Map<string, any> = (window as any).__teamWorkbenchCursorIdeAnchors ||= new Map();
  if (arg.operation === 'release') { anchors.delete(arg.token!); return {}; }
  const current = state();
  const settings = settingsReader?.(current.root, { ...arg, operation: 'settings' });
  if (arg.operation === 'snapshot') return { sessionId: current.sessionId, status: current.status, messages: current.messages, ...(settings ? { settings } : {}) };
  if (arg.operation?.startsWith('settings')) {
    if (!settingsReader) throw new Error('当前 Cursor 设置接口不可用');
    if (arg.operation !== 'settings' && (current.modal || ['generating','applying'].includes(current.status))) throw new Error('请等待当前回复或原生确认结束');
    return settingsReader(current.root, arg);
  }
  if (arg.operation === 'reveal') return {};
  if (arg.operation === 'focus') { if(current.modal)throw new Error('请先在 Cursor 原生窗口处理弹窗');current.input.focus(); return {}; }
  if (arg.operation === 'prepareSend') {
    if (settings && settings.state !== 'ready') throw new Error('正在确认 Cursor 设置，消息尚未发送');
    if (current.modal || ['generating','applying'].includes(current.status) || current.draft.trim()) throw new Error('Cursor 正在处理弹窗、回复或已有输入草稿，待当前操作结束后再发送');
    for(const [token,anchor]of anchors)if(Date.now()-anchor.at>60000)anchors.delete(token);
    anchors.set(arg.token!, { id: arg.id, cwd, priorIds: current.messages.map(message => message.id), input: current.input, at: Date.now(), settingsRevision: settings?.revision });
    current.input.focus(); return {};
  }
  if (arg.operation === 'checkSend' || arg.operation === 'submit') {
    const anchor=anchors.get(arg.token!);
    if (settings && (settings.state !== 'ready' || settings.revision !== anchor?.settingsRevision)) throw new Error('Cursor 设置在发送前发生变化，输入已保留，请核对后发送');
    if (!anchor || anchor.id!==arg.id || anchor.input!==current.input || normalize(anchor.cwd)!==normalize(cwd) || current.modal || ['generating','applying'].includes(current.status) || current.draft.trim() !== arg.text?.trim() || document.activeElement !== current.input) throw new Error('Cursor 输入状态已改变，未发送；请保留并核对原生草稿');
    if (arg.operation === 'submit') {
      // Cursor's ordinary Enter path applies its native message queue policy.
      // Identity, draft and focus are checked in the same renderer task.
      current.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return {};
  }
  if (arg.operation === 'receipt') {
    const anchor = anchors.get(arg.token!);
    if (!anchor || anchor.id !== arg.id || normalize(anchor.cwd) !== normalize(cwd)) throw new Error('Cursor 送达范围无法确认');
    const matches = current.messages.filter(message => message.role === 'user' && !anchor.priorIds.includes(message.id) && message.text.trim() === arg.text?.trim());
    if (matches.length > 1) throw new Error('Cursor 出现多条相同的新消息，送达状态未确认；不会重发');
    return { received: matches.length === 1, state: { sessionId: current.sessionId }, nativeMessageId: matches[0]?.id };
  }
  if (arg.operation === 'stop') {
    if(current.modal)throw new Error('请先在 Cursor 原生窗口处理弹窗，再停止任务');
    if (current.status !== 'generating') return {};
    const buttons = [...current.root.querySelectorAll<HTMLElement>('button[aria-label="Stop generation"], button[aria-label="Stop Agent"], [data-stop-button="true"]:not([data-disabled="true"])')].filter(visible);
    if (buttons.length !== 1) throw new Error('请在 Cursor 原生窗口停止当前回复');
    buttons[0].click(); return {};
  }
  throw new Error('此 Cursor 原生操作尚未接入');
}
