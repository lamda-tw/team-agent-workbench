/** Cursor 3.21 Agents Window adapter. Executed inside the renderer, without imports.
 * Read only React view props supply each card's native header/workspace identity;
 * actions use that card's DOM controls. No repository-service calls, gate changes,
 * database writes or hidden desktopBridge commands are used.
 */
export function cursorAgentsPage(arg: { operation?: string; id?: string; cwd?: string; token?: string; text?: string } = {}) {
  const panelSelector = '[data-agent-panel-conversation-shell][data-glass-agent-id]';
  const visible = (element: Element) => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1').replace(/\/$/, '').toLowerCase();
  const value = (item: any) => item && typeof item === 'object' && 'value' in item ? item.value : item;
  const localPath = (workspace: any): string | undefined => {
    if (!workspace || workspace.remoteAuthority || workspace.configPath) return;
    const uri = workspace.uri;
    if (!uri || uri.scheme !== 'file' || uri.authority || typeof uri.path !== 'string') return;
    return uri.path.replace(/^\/([a-z]:\/)/i, '$1');
  };
  // Bounded traversal of the rendered component's props, not a scan of app state.
  const props = (element: Element) => {
    const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? (element as any)[key] : undefined;
    const result: any[] = [];
    for (let i = 0; fiber && i < 40; i++, fiber = fiber.return) if (fiber.memoizedProps) result.push(fiber.memoizedProps);
    return result;
  };
  const headerInfo = (header: any) => {
    if (!header || !/^[0-9a-f-]{36}$/i.test(header.id) || !['local', 'draft'].includes(header.source) || value(header.isArchived)) return;
    const cwd = localPath(value(header.environment));
    if (!cwd) return;
    if (header.source === 'draft') {
      const target = header.targetEnvironment;
      const targetPath = target?.type === 'existing' ? localPath(target.environment) : undefined;
      // Cloud/private-worker and fresh-worktree drafts can change execution directory on first send.
      if (!targetPath || normalize(targetPath) !== normalize(cwd) || target.glassWorktreePicker?.mode === 'fresh') return;
    }
    const status = value(header.status);
    return { nativeId: header.id as string, cwd, title: String(value(header.name) || 'New Agent'), source: header.source as string, status: status === 'in_progress' ? 'generating' : status === 'error' ? 'error' : 'completed' };
  };
  const roots = [...document.querySelectorAll<HTMLElement>(panelSelector)].filter(visible);
  const panelInfo = (root: HTMLElement) => {
    const id = root.getAttribute('data-glass-agent-id');
    const candidates = props(root).flatMap(p => [p.agentReference?.header, p.header]).filter(h => h?.id === id);
    const infos = candidates.map(headerInfo).filter(Boolean) as NonNullable<ReturnType<typeof headerInfo>>[];
    if (!infos.length || infos.some(info => normalize(info.cwd) !== normalize(infos[0].cwd) || info.source !== infos[0].source)) throw new Error('无法核对 Cursor Agents 会话目录，请更新适配后重试');
    return infos[0];
  };
  const sections = [...document.querySelectorAll<HTMLElement>('[data-sidebar-workspace-section-root]')].map(element => ({ element, section: props(element).map(p => p.section).find(section => section && Array.isArray(section.projects) && Array.isArray(section.headers)) })).filter(item => item.section);
  const sectionPaths = (section: any): string[] => [...new Set<string>(section.projects.map((project: any) => project.remoteAuthority ? undefined : project.worktreePath || localPath(project.workspaceIdentifier)).filter((cwd: any) => typeof cwd === 'string' && (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('/'))))];
  const catalog = () => {
    const items = new Map<string, NonNullable<ReturnType<typeof headerInfo>>>();
    const conflicts = new Set<string>();
    const add = (info: ReturnType<typeof headerInfo>) => { if (!info) return; const old=items.get(info.nativeId);if(old && normalize(old.cwd)!==normalize(info.cwd))conflicts.add(info.nativeId);else items.set(info.nativeId,info); };
    for (const { section } of sections) for (const header of section.headers) add(headerInfo(header));
    for (const row of document.querySelectorAll('[data-sidebar-item-key]')) for (const p of props(row)) if (p.header) add(headerInfo(p.header));
    for (const root of roots) { try { add(panelInfo(root)); } catch { /* Unknown cards are never targets. */ } }
    for(const id of conflicts)items.delete(id);
    return [...items.values()];
  };
  const owned = (root: HTMLElement, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].filter(element => visible(element) && element.closest(panelSelector) === root);
  const state = (root: HTMLElement) => {
    const info = panelInfo(root);
    const inputs = owned(root, '[contenteditable="true"][role="textbox"], [contenteditable="true"].tiptap');
    const input = inputs.length === 1 ? inputs[0] : undefined;
    const bars = owned(root, '[data-component="agent-conversation-composer"]');
    const nativeStatus = bars.length === 1 ? bars[0].getAttribute('data-composer-status') : undefined;
    const messages = owned(root, '[data-message-id][data-message-kind="human"], [data-message-id][data-message-kind="assistant"]').map(element => ({ id: element.getAttribute('data-message-id')!, role: element.getAttribute('data-message-kind') === 'human' ? 'user' as const : 'assistant' as const, text: element.innerText }));
    return { ...info, sessionId: info.nativeId, status: nativeStatus === 'generating' || info.status === 'generating' ? 'generating' : ['error','aborted'].includes(nativeStatus || '') ? nativeStatus! : info.status, messages: messages.filter((m,i)=>messages.findIndex(n=>n.id===m.id)===i), draft: (input?.innerText || '').replace(/[\u200b\ufeff]/g,''), input: !!input };
  };
  const checkDirectory = (info: { cwd: string }) => { if (!arg.cwd || normalize(info.cwd) !== normalize(arg.cwd)) throw new Error('Cursor Agents 会话的原工作目录已改变，未操作此会话'); };
  const target = () => {
    const matches = roots.filter(root => root.getAttribute('data-glass-agent-id') === arg.id);
    if (matches.length !== 1) throw new Error('请在 Cursor Agents 中打开关联会话；同一会话只能显示在一个面板中');
    checkDirectory(panelInfo(matches[0])); return matches[0];
  };
  if (arg.operation === 'catalog') return { chats: catalog(), workspaces: [...new Set(sections.flatMap(item => sectionPaths(item.section)).concat(catalog().map(item => item.cwd)))] };
  if (arg.operation === 'create' || arg.operation === 'canCreate') {
    const candidates = sections.filter(item => visible(item.element) && sectionPaths(item.section).length === 1 && normalize(sectionPaths(item.section)[0]) === normalize(arg.cwd || ''));
    if (candidates.length !== 1) throw new Error('请在 Cursor Agents 侧栏添加并展开对应的本地项目目录');
    const buttons = [...candidates[0].element.querySelectorAll<HTMLElement>('[data-sidebar-group-label-new-agent-action] button, button[aria-label="New Agent"]')].filter(visible);
    if (buttons.length !== 1 || (buttons[0] as HTMLButtonElement).disabled) throw new Error('Cursor Agents 项目的新建入口不可用');
    if (roots.some(root => state(root).draft.trim())) throw new Error('请先保存 Cursor Agents 面板中的输入草稿，再新建会话');
    const ids = catalog().map(info=>info.nativeId);
    if(arg.operation === 'create')buttons[0].click(); return { previousIds: ids };
  }
  if (arg.operation === 'reveal') {
    if (roots.some(root=>root.getAttribute('data-glass-agent-id')===arg.id)) { target(); return {}; }
    const rows = [...document.querySelectorAll<HTMLElement>('[data-sidebar-item-key]')].filter(element=>visible(element)&&props(element).some(p=>p.header?.id===arg.id));
    const unique = rows.filter(row=>!rows.some(other=>other!==row&&row.contains(other)));
    if(unique.length!==1)throw new Error('请在 Cursor Agents 侧栏找到并打开关联会话');
    const info = catalog().find(info=>info.nativeId===arg.id);if(!info)throw new Error('Cursor Agents 会话已不可用');checkDirectory(info);
    unique[0].click();return {};
  }
  const anchors: Map<string, any> = (window as any).__teamWorkbenchCursorAnchors ||= new Map();
  if (arg.operation === 'release') { anchors.delete(arg.token!); return {}; }
  if (arg.operation === 'receipt') {
    const anchor = arg.token ? anchors.get(arg.token) : undefined;
    if (!anchor || !anchor.element.isConnected) throw new Error('Cursor Agents 面板已切换，送达状态未确认');
    const candidates = [...anchor.element.querySelectorAll(panelSelector)].filter(visible) as HTMLElement[];
    if (!candidates.length) return { received: false }; // Draft promotion can briefly remount the conversation.
    if (candidates.length !== 1) throw new Error('Cursor Agents 送达面板不明确');
    const result = state(candidates[0]); checkDirectory(result);
    if (result.nativeId !== anchor.id && (!anchor.draft || anchor.previousIds.includes(result.nativeId) || result.source !== 'local')) throw new Error('Cursor Agents 已切换到其他会话，送达状态未确认');
    const received = result.messages.some(m=>m.role==='user'&&m.text.trim()===arg.text?.trim()&&!anchor.messages.includes(m.id));
    return { received, state: result };
  }
  const root = target(), result = state(root);
  if (arg.operation === 'snapshot') { const {draft, input, source, nativeId, cwd, ...snapshot}=result; return snapshot; }
  if (arg.operation === 'focus' || arg.operation === 'prepareSend') {
    const inputs=owned(root,'[contenteditable="true"][role="textbox"], [contenteditable="true"].tiptap');
    if(inputs.length!==1)throw new Error('Cursor Agents 输入框不可用');
    if(arg.operation==='prepareSend') {
      if(result.status==='generating'||result.draft.trim())throw new Error('Cursor Agents 正在回复或已有输入草稿，请先在原生面板处理');
      const parent=root.closest<HTMLElement>('.ui-tiling-panel-content') || root.closest<HTMLElement>('[data-component="agent-panel"]');
      if(!parent || parent.querySelectorAll(panelSelector).length!==1)throw new Error('无法固定 Cursor Agents 送达面板');
      for(const [key,entry] of anchors)if(Date.now()-entry.at>60000)anchors.delete(key);
      anchors.set(arg.token!,{element:parent,id:result.nativeId,draft:result.source==='draft',previousIds:catalog().map(info=>info.nativeId),messages:result.messages.map(m=>m.id),at:Date.now()});
    }
    inputs[0].focus();return result;
  }
  if(arg.operation==='checkSend' || arg.operation==='submit') {
    if(result.status==='generating'||result.draft.trim()!==arg.text?.trim() || document.activeElement?.closest(panelSelector)!==root)throw new Error('Cursor Agents 输入状态已改变，草稿已保留；未发送');
    if(arg.operation==='submit') {
      const buttons=owned(root,'button.ui-prompt-input-submit-button[aria-label="Send message"]');
      if(buttons.length!==1 || (buttons[0] as HTMLButtonElement).disabled)throw new Error('Cursor Agents 发送入口不可用，草稿已保留');
      buttons[0].click();
    }
    return result;
  }
  if(arg.operation==='stop') {
    if(result.status!=='generating')return {};
    const buttons=owned(root,'button[aria-label="Stop generation"], button[aria-label="Stop Agent"], [data-stop-button="true"]');
    if(buttons.length!==1)throw new Error('请在 Cursor Agents 的关联面板中停止任务');
    buttons[0].click();return {};
  }
  throw new Error('不支持的 Cursor Agents 操作');
}
