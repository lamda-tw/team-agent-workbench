import { randomUUID } from 'node:crypto';
import { modeOption, planSteps, type SessionModeCatalog } from '../shared/session-mode';
import type { AgentCapabilityCatalog, AgentCapabilityKind, AgentCapabilityOption, AgentSession, Approval, Message, MessageContext } from '../shared/types';
import { CapabilityCache } from './capability-cache';
import { JsonRpc, type RpcMessage } from './rpc';
import { codexPermissionParams, codexPermissions, cursorPermissionArgs, cursorPermissions, permissionIssue, probeCodexCommand } from './permissions';
import { refreshCodexConfiguration, validateCodexStorage, type CodexStorage } from './codex-storage';
import { CodexMcp } from './codex-mcp';
import type { McpMutation } from '../shared/mcp';
import { CodexAuthBridge } from './codex-auth-bridge';
import { permissionLabels } from '../shared/permission-presentation';
import { codexCapabilities, cursorCommandCapabilities, cursorPluginCapabilities, emptyCapabilityCatalog } from './provider-capabilities';
import { CliConnectionTracker } from './cli-connection';
import type { CliConnection } from '../shared/cli-connection';
export interface AgentHooks { changed: () => void; event: (value: unknown) => void; done: () => void; authFailed?: (error: unknown) => void; needsApproval?: (kind: 'question' | 'approval') => void; connectionChanged?: (value: CliConnection) => void; }
const now = () => new Date().toISOString();
const pretty = (x: unknown) => typeof x === 'string' ? x : JSON.stringify(x, null, 2);
export class AgentRuntime {
  rpc: JsonRpc;
  private requests = new Map<string, RpcMessage>();
  private answeringPlans = new Set<string>();
  private fileChanges = new Map<string, { turnId?: string; changes: unknown[] }>();
  private turnId?: string;
  private initialized = false;
  private cursorMessageId = '';
  private closing = false;
  private turnActive = false;
  private steering = false;
  private authBridge?: CodexAuthBridge;
  private mcp?: CodexMcp;
  private cursorCommands: any[] = [];
  private cursorCommandWaiters = new Set<() => void>();
  private cursorCommandsKnown = false;
  private capabilityCache: CapabilityCache;
  private starting?: Promise<void>;
  private codexConnected = false;
  private modePresets?: any[];
  private cursorModes: string[] = [];
  private nativeModel?: string;
  private nativeEffort?: string | null;
  private connecting?: Promise<void>;
  private connection: CliConnectionTracker;
  constructor(readonly session: AgentSession, executable: string, private hooks: AgentHooks, private storage?: CodexStorage, networkEnv: NodeJS.ProcessEnv = {}) {
    this.capabilityCache = new CapabilityCache(session.provider);
    // Preparation has its own execution policy, including helpers saved by older builds.
    if (session.purpose === 'prepare') session.permissionMode = 'full';
    this.connection = new CliConnectionTracker(session, hooks.changed, hooks.connectionChanged);
    this.rpc = new JsonRpc(executable, session.provider === 'codex' ? storage?.args || ['app-server'] : cursorPermissionArgs(session), session.cwd, session.provider === 'cursor', { ...networkEnv, ...storage?.env });
    if (session.provider === 'codex' && storage) this.authBridge = new CodexAuthBridge(executable, session.cwd, storage.sourceHome, networkEnv);
    if (storage && this.authBridge) this.mcp = new CodexMcp(this.rpc, storage, (method, params) => this.authBridge!.configuration(method, params), () => this.initialized ? session.nativeId : undefined);
    this.rpc.on('message', (m: RpcMessage) => this.onMessage(m));
    this.rpc.on('diagnostic', (value: string) => { if (!this.closing) this.connection.diagnostic(value); });
    this.rpc.on('closed', (e: Error) => { this.initialized = false; this.codexConnected = false; this.capabilityCache.invalidate(); this.fileChanges.clear(); void this.authBridge?.close(); if (!this.closing) this.finish(e.message); });
  }
  private message(id: string, role: Message['role'], text: string, append = false, metadata: Pick<Message, 'userText' | 'context'> = {}) {
    const existing = this.session.messages.find(x => x.id === id);
    if (existing) existing.text = append ? existing.text + text : text;
    else this.session.messages.push({ id, role, text, createdAt: now(), ...metadata });
    this.hooks.changed();
  }
  private async connectCodex() {
    if (this.closing) throw new Error('CLI 连接已关闭');
    if (this.codexConnected) return;
    if (this.connecting) return this.connecting;
    const job = (async () => {
      await this.rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench', title: 'Team Agent Workbench', version: '0.7.0' }, capabilities: { experimentalApi: true } });
      this.rpc.notify('initialized');
      if (this.storage) await validateCodexStorage(this.rpc, this.storage);
      await this.authBridge?.login(this.rpc);
      if (this.closing) throw new Error('CLI 连接已关闭');
      this.codexConnected = true;
    })();
    this.connecting = job;
    try { await job; }
    catch (error) { await this.rpc.close(); throw error; }
    finally { if (this.connecting === job) this.connecting = undefined; }
  }
  async start() {
    if (this.initialized) return;
    if (this.closing) throw new Error('CLI 连接已关闭');
    if (this.starting) return this.starting;
    const job = this.startSession(); this.starting = job;
    try { await job; } finally { if (this.starting === job) this.starting = undefined; }
  }
  private async startSession() {
    if (this.initialized) return;
    const s = this.session; s.status = 'starting'; s.error = undefined; this.hooks.changed();
    this.connection.begin();
    if (s.provider === 'codex') {
      await this.connectCodex();
      if (this.closing) return;
      const params = { cwd: s.cwd, ...(s.model ? { model: s.model } : {}), ...codexPermissionParams(s) };
      const result = s.nativeId ? await this.rpc.request('thread/resume', { ...params, threadId: s.nativeId, ...(this.storage?.resumePath ? { path: this.storage.resumePath } : {}) }) : await this.rpc.request('thread/start', params);
      s.nativeId = result.thread.id; s.nativePath = result.thread.path || this.storage?.resumePath || s.nativePath;
      this.nativeModel = result.model; this.nativeEffort = result.reasoningEffort;
      if (this.storage) { s.codexStorage = 'workbench'; delete s.codexNeedsRegistration; }
      s.permissions = codexPermissions(result, 'runtime');
      await probeCodexCommand(this.rpc, s.permissions, s.cwd, result.sandbox);
      if (s.permissions.execution === 'blocked') s.permissionIssue = permissionIssue(s.permissions.executionDetail) || { kind: 'sandbox', message: s.permissions.executionDetail || 'CLI 命令自检未通过', at: now() };
      if (s.purpose === 'work' && s.permissionMode && s.permissionMode !== 'inherit') {
        const expected = codexPermissionParams(s);
        // Windows may apply a narrower scope until its sandbox is configured.
        // Show that scope as a custom restriction; do not prevent read-only work.
        if (result.approvalPolicy !== expected.approvalPolicy || result.approvalsReviewer !== expected.approvalsReviewer) throw new Error(`权限策略未采用“${permissionLabels.codex[s.permissionMode]}”，请修改权限或更新 Codex 后重试`);
      }
    } else {
      s.permissions = await cursorPermissions(s.cwd);
      if (s.purpose === 'work' && s.permissionMode === 'review' && (s.permissions.approval !== 'allowlist' || s.permissions.cursorConfig?.allow.length)) throw new Error('Cursor 权限策略仍包含自动审批或允许规则。请打开执行权限，点击“配置 Cursor Allowlist”后重试。');
      await this.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'team-agent-workbench', version: '0.4.0' } });
      await this.rpc.request('authenticate', { methodId: 'cursor_login' }, 120000);
      const result = s.nativeId ? await this.rpc.request('session/load', { sessionId: s.nativeId, cwd: s.cwd, mcpServers: [] }) : await this.rpc.request('session/new', { cwd: s.cwd, mcpServers: [] });
      s.nativeId = result.sessionId || s.nativeId;
      this.cursorModes = (result.modes?.availableModes || []).map((mode: any) => mode.id);
      if (s.model) await this.rpc.request('session/set_model', { sessionId: s.nativeId, modelId: s.model });
      if (s.mode || s.permissionMode && s.permissionMode !== 'inherit') {
        const modeId = s.mode === 'plan' || s.mode === 'ask' ? s.mode : 'agent';
        if (modeId !== 'agent' && !this.cursorModes.includes(modeId)) throw new Error('当前 Cursor CLI 不支持此模式，请更新 CLI');
        await this.rpc.request('session/set_mode', { sessionId: s.nativeId, modeId });
      }
      if (s.permissionMode === 'full') s.permissions.warnings.push('本会话已请求 Run Everything；明确拒绝规则和团队策略仍由 Cursor 执行。');
      if (s.permissionMode === 'inherit' && ['ask', 'plan'].includes(result.modes?.currentModeId)) s.permissions.warnings.push('当前 Cursor 为 Ask 或 Plan 模式，无法直接修改代码。');
    }
    this.initialized = true; s.status = 'idle'; this.hooks.changed();
  }
  async ensureStarted() {
    try { await this.start(); } catch (error) { this.connection.error(error, false); const issue = permissionIssue(error); if (issue) { this.session.permissionIssue = issue; this.hooks.changed(); } else this.hooks.authFailed?.(error); throw error; }
  }
  async mcpCatalog() { await this.connectCodex(); if (!this.mcp) throw new Error('当前 CLI 不支持 MCP 管理'); return this.mcp.list(); }
  async modes(): Promise<SessionModeCatalog> {
    if (this.session.provider === 'cursor') {
      await this.ensureStarted();
      return { current: this.session.mode || 'default', modes: [modeOption('default'), ...(['plan', 'ask'] as const).filter(id => this.cursorModes.includes(id)).map(modeOption)] };
    }
    await this.connectCodex();
    try {
      this.modePresets ||= (await this.rpc.request('collaborationMode/list', {}, 10000)).data || [];
      return { current: this.session.mode || 'default', modes: [modeOption('default'), ...(this.modePresets!.some(value => value.mode === 'plan') ? [modeOption('plan')] : [])] };
    } catch { return { current: this.session.mode || 'default', modes: [modeOption('default')], error: '当前 Codex CLI 未提供 Plan 模式，请更新 CLI 后重试。' }; }
  }
  private async collaborationMode() {
    if (!this.session.mode) return undefined;
    const catalog = await this.modes();
    if (catalog.error && this.session.mode === 'default') return undefined;
    if (!catalog.modes.some(value => value.id === this.session.mode)) throw new Error(catalog.error || '当前 CLI 不支持此模式');
    const preset = this.modePresets?.find(value => value.mode === this.session.mode);
    const model = this.session.model || this.nativeModel || preset?.model;
    if (!model) throw new Error('无法确定 Plan 模式使用的模型，请先选择模型');
    return { mode: this.session.mode, settings: { model, reasoning_effort: this.nativeEffort ?? preset?.reasoning_effort ?? null, developer_instructions: null } };
  }
  async mcpLogin(name: string) { await this.connectCodex(); if (!this.mcp) throw new Error('当前 CLI 不支持 MCP 管理'); return this.mcp.login(name); }
  async mcpEditable(name: string) { await this.connectCodex(); if (!this.mcp) throw new Error('当前 CLI 不支持 MCP 管理'); return this.mcp.editable(name); }
  async configureSkill(id: string, enabled: boolean) {
    await this.connectCodex();
    const skill = (await this.capabilities(true, 'skill')).skills.find(value => value.id === id);
    if (!skill?.path || skill.source !== '个人') throw new Error('此 Skill 由项目、插件或管理员提供，请在对应配置中修改');
    await this.authBridge!.configuration('skills/config/write', { path: skill.path, enabled });
    await this.mcpReload(); this.capabilityCache.invalidate('skill');
  }
  async mcpWrite(input: McpMutation) {
    await this.connectCodex(); if (!this.mcp) throw new Error('当前 CLI 不支持 MCP 管理'); await this.mcp.write(input);
  }
  async mcpReload(sync = true) {
    await this.connectCodex();
    if (sync && this.storage) await refreshCodexConfiguration(this.storage);
    await this.rpc.request('config/mcpServer/reload', null, 20000);
  }
  async capabilities(forceRefresh = false, kind?: AgentCapabilityKind): Promise<AgentCapabilityCatalog> {
    if (this.closing) throw new Error('CLI 连接已关闭');
    if (this.session.provider === 'codex') {
      try { await this.connectCodex(); }
      catch (error) { this.connection.error(error, false); this.hooks.authFailed?.(error); throw error; }
    } else if (kind !== 'plugin') await this.ensureStarted();
    return this.capabilityCache.get(forceRefresh, kind, async section => {
      if (this.session.provider === 'cursor') {
        if (section === 'plugin') return { ...emptyCapabilityCatalog('cursor'), plugins: await cursorPluginCapabilities(this.session.cwd) };
        if (!this.cursorCommandsKnown) await new Promise<void>(resolve => {
          let timer: NodeJS.Timeout;
          const done = () => { clearTimeout(timer); this.cursorCommandWaiters.delete(done); resolve(); };
          this.cursorCommandWaiters.add(done); timer = setTimeout(done, 1500);
        });
        return { ...emptyCapabilityCatalog('cursor'), skills: cursorCommandCapabilities(this.cursorCommands) };
      }
      const catalog = emptyCapabilityCatalog('codex');
      try {
        if (section === 'skill') catalog.skills = codexCapabilities(await this.rpc.request('skills/list', { cwds: [this.session.cwd], forceReload: forceRefresh }, 20000), {}).skills;
        else catalog.plugins = codexCapabilities({}, await this.rpc.request('plugin/installed', { cwds: [this.session.cwd] }, 20000)).plugins;
      } catch { if (section === 'skill') catalog.skillError = 'Skill 列表尚未读取成功，可刷新重试。'; else catalog.pluginError = '插件列表尚未读取成功，可刷新重试；Skill 仍可使用。'; }
      return catalog;
    });
  }
  async resolveCapabilities(selections: { id: string; kind: 'skill' | 'plugin' }[]): Promise<AgentCapabilityOption[]> {
    if (this.session.provider === 'cursor' && selections.some(item => item.kind === 'plugin')) throw new Error('Cursor 插件和 MCP 按配置自动加载，请移除消息中的旧工具选择');
    if (!selections.length) return [];
    const kinds = new Set(selections.map(item => item.kind));
    const catalog = await this.capabilities(false, kinds.size === 1 ? selections[0].kind : undefined), available = new Map([...catalog.skills, ...catalog.plugins].map(item => [item.id, item]));
    const resolved = selections.map(selection => {
      const item = available.get(selection.id);
      if (!item || item.kind !== selection.kind) throw new Error(`所选 ${selection.kind === 'skill' ? 'Skill' : '插件'} 已不可用，请重新选择`);
      if (!item.enabled) throw new Error(item.unavailableReason || '所选能力当前不可用');
      return item;
    });
    if (this.session.provider === 'cursor' && resolved.filter(item => item.kind === 'skill').length > 1) throw new Error('Cursor 每条消息只能显式调用一个 Skill，请重新选择');
    return resolved;
  }
  async prompt(text: string, options?: { userText: string; context: Omit<MessageContext, 'nativeId' | 'accepted'>; capabilities?: AgentCapabilityOption[]; submitted?: () => void }) {
    if (!text.trim()) throw new Error('请输入任务内容');
    if (this.session.status === 'running' || this.session.status === 'approval') throw new Error('当前会话仍在运行，可以新建独立会话继续工作');
    await this.ensureStarted();
    if (this.closing) return false;
    const collaborationMode = this.session.provider === 'codex' ? await this.collaborationMode() : undefined;
    const selected = options?.capabilities || [], prefixes = selected.filter(item => item.kind === 'skill' || this.session.provider === 'codex').map(item => this.session.provider === 'cursor' ? '/' + item.invocation : item.kind === 'skill' ? '$' + item.invocation : '@' + item.invocation);
    const nativeText = [prefixes.join(' '), text].filter(Boolean).join(' ');
    const context = options ? { ...options.context, capabilities: selected.map(({ id, kind, name }) => ({ id, kind, name })), nativeId: this.session.nativeId!, accepted: false } : undefined;
    this.message(randomUUID(), 'user', nativeText, false, options ? { userText: options.userText, context } : {});
    this.hooks.event({ direction: 'user', text: nativeText, ...(options ? { userText: options.userText, capabilities: context?.capabilities } : {}) });
    this.turnId = undefined; this.turnActive = true; this.session.status = 'running'; this.session.error = undefined; this.cursorMessageId = randomUUID(); this.hooks.changed();
    this.connection.begin();
    try {
      if (this.session.provider === 'codex') {
        const input: any[] = [{ type: 'text', text: nativeText, text_elements: [] }, ...selected.map(item => item.kind === 'skill' ? { type: 'skill', name: item.invocation, path: item.path } : { type: 'mention', name: item.invocation, path: item.path })];
        const result = await this.rpc.request('turn/start', { threadId: this.session.nativeId, ...(this.session.model ? { model: this.session.model } : {}), ...(collaborationMode ? { collaborationMode } : {}), input }, 60000, options?.submitted);
        if (this.turnActive) { this.turnId = result.turn.id; this.hooks.changed(); }
      } else {
        const result = await this.rpc.request('session/prompt', { sessionId: this.session.nativeId, prompt: [{ type: 'text', text: nativeText }] }, 0, options?.submitted);
        this.hooks.event({ method: 'session/prompt/result', result }); this.finish();
      }
      if (context) { context.accepted = true; this.hooks.changed(); }
      return true;
    } catch (e: any) { if (!this.closing) { this.connection.error(e, false); this.finish(e.message); } return false; }
  }
  get activeTurnId(): string | undefined {
    return this.session.provider === 'codex' && this.turnActive && !this.closing && ['running', 'approval'].includes(this.session.status) ? this.turnId : undefined;
  }
  async steer(expectedTurnId: string, text: string, options: { userText: string; context: Omit<MessageContext, 'nativeId' | 'accepted'>; capabilities?: AgentCapabilityOption[] }) {
    if (this.session.provider !== 'codex') throw new Error('当前 Cursor 接入暂不支持生成中引导，请等待本轮结束后发送');
    if (!text.trim()) throw new Error('请输入引导内容');
    if (!expectedTurnId || this.activeTurnId !== expectedTurnId) throw new Error('当前轮次已结束或发生变化，引导未发送；请核对后重新发送');
    if (this.steering) throw new Error('上一条引导正在发送，请稍候');
    this.steering = true;
    const selected = options.capabilities || [], nativeId = this.session.nativeId!;
    const nativeText = [selected.map(item => (item.kind === 'skill' ? '$' : '@') + item.invocation).join(' '), text].filter(Boolean).join(' ');
    const input = [{ type: 'text', text: nativeText, text_elements: [] }, ...selected.map(item => item.kind === 'skill' ? { type: 'skill', name: item.invocation, path: item.path } : { type: 'mention', name: item.invocation, path: item.path })];
    // Keep the message at its submission position even if streamed output precedes the acknowledgement.
    const index = this.session.messages.length, createdAt = now();
    try {
      const result = await this.rpc.request('turn/steer', { threadId: nativeId, expectedTurnId, input });
      if (result?.turnId !== expectedTurnId) throw new Error('CLI 返回了不同轮次，未能确认引导送达；请先查看回复，避免重复发送');
      const context: MessageContext = { ...options.context, capabilities: selected.map(({ id, kind, name }) => ({ id, kind, name })), nativeId, accepted: true };
      this.session.messages.splice(index, 0, { id: randomUUID(), role: 'user', text: nativeText, userText: options.userText, context, steering: true, createdAt });
      this.hooks.event({ direction: 'user', method: 'turn/steer', turnId: expectedTurnId, text: nativeText, userText: options.userText, capabilities: context.capabilities });
      this.hooks.changed();
      return true;
    } catch (error: any) {
      if (/method.*not.*found|unknown method|unsupported.*method|不支持.*方法/i.test(error.message)) throw new Error('当前 Codex CLI 不支持引导，请更新 Codex CLI；输入已保留');
      if (/超时|连接已关闭|进程已退出/.test(error.message)) throw new Error('未能确认引导是否送达，输入已保留；请先查看回复，避免重复发送');
      // A rejected steer does not fail or interrupt the running task.
      throw error;
    } finally { this.steering = false; }
  }
  private finish(error?: string) {
    this.connection.finish(error);
    const completedTurn = this.turnActive; this.turnActive = false;
    if (error) { const issue = permissionIssue(error); if (issue) this.session.permissionIssue = issue; else this.hooks.authFailed?.(error); }
    this.session.status = error ? 'error' : 'idle'; this.session.error = error; this.session.approvals = [];
    this.turnId = undefined; this.requests.clear(); this.fileChanges.clear(); this.hooks.changed(); if (completedTurn) this.hooks.done();
  }
  private onMessage(m: RpcMessage) {
    if (this.closing) return;
    const method = m.method!, p = m.params || {}, s = this.session;
    if (method === 'mcpServer/oauthLogin/completed') {
      this.mcp?.completed(p); this.hooks.changed();
      if (p.success) void this.mcpReload(false).catch(() => {});
      return;
    }
    if (method === 'account/chatgptAuthTokens/refresh' && m.id !== undefined && this.authBridge) { void this.authBridge.refresh(this.rpc, m.id); return; }
    // Only session events are archived. Account/authentication messages are never stored here.
    if (/^(item\/|turn\/|session\/|cursor\/|error$)/.test(method)) this.hooks.event({ method, params: p });
    if (m.id !== undefined) { this.onRequest(m); return; }
    if (s.provider === 'cursor' && p.sessionId && s.nativeId && p.sessionId !== s.nativeId) return;
    if (s.provider === 'codex') {
      if (p.threadId && s.nativeId && p.threadId !== s.nativeId) return;
      if (p.turnId && this.turnId && p.turnId !== this.turnId) return;
      if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/completed' && p.item?.type === 'agentMessage') this.connection.responded();
      if (method === 'item/agentMessage/delta') this.message(p.itemId, 'assistant', p.delta || '', true);
      if (method === 'item/plan/delta') {
        this.message(p.itemId, 'assistant', p.delta || '', true);
        const message = s.messages.find(value => value.id === p.itemId)!; message.kind = 'plan';
        s.proposedPlan = { messageId: message.id, text: message.text, ready: false }; this.hooks.changed();
      }
      if (method === 'turn/plan/updated') this.updatePlanSteps('steps-' + p.turnId, p.plan);
      if (method === 'item/commandExecution/outputDelta') this.message(p.itemId, 'tool', p.delta || '', true);
      if (method === 'item/started' && p.item?.type === 'commandExecution') this.message(p.item.id, 'tool', '$ ' + p.item.command + '\n');
      if (method === 'item/started' && p.item?.type === 'fileChange' && Array.isArray(p.item.changes)) this.fileChanges.set(p.item.id, { turnId: p.turnId, changes: p.item.changes });
      if (method === 'item/completed') {
        const i = p.item || {};
        if (i.type === 'fileChange' && i.status !== 'failed') s.outputFiles = [...new Set([...(s.outputFiles || []), ...(i.changes || this.fileChanges.get(i.id)?.changes || []).map((change: any) => change.path).filter((value: unknown): value is string => typeof value === 'string')])];
        this.fileChanges.delete(i.id);
        if (i.type === 'plan') {
          this.message(i.id, 'assistant', i.text || ''); s.messages.find(value => value.id === i.id)!.kind = 'plan';
          s.proposedPlan = { messageId: i.id, text: i.text || '', ready: !!i.text?.trim() }; this.hooks.changed();
        }
        else if (i.type === 'agentMessage') this.message(i.id, 'assistant', i.text || '');
        else if (i.type === 'commandExecution') { if (i.exitCode !== 0 || i.status === 'failed') { const issue = permissionIssue(i.aggregatedOutput); if (issue) { s.permissionIssue = issue; this.hooks.changed(); } } this.message(i.id, 'tool', '$ ' + i.command + '\n' + (i.aggregatedOutput || '') + '\n退出码：' + i.exitCode); }
        else if (i.type !== 'userMessage' && i.type !== 'reasoning') this.message(i.id || randomUUID(), 'tool', pretty(i));
      }
      if (method === 'turn/started') { this.turnId = p.turn?.id; s.status = 'running'; this.hooks.changed(); }
      if (method === 'turn/completed' && (!this.turnId || !p.turn?.id || p.turn.id === this.turnId)) { if (p.turn?.error) this.connection.error(p.turn.error, false); this.finish(p.turn?.error ? p.turn.error.message || 'CLI 请求失败' : undefined); }
      if (method === 'error') { this.connection.error(p.error || p, p.willRetry === true); this.message(randomUUID(), 'system', p.error?.message || pretty(p)); if (!p.willRetry) this.finish(p.error?.message || '运行失败'); }
    } else if (method === 'session/update') {
      if (p.sessionId && s.nativeId && p.sessionId !== s.nativeId) return;
      const u = p.update || {};
      if (u.sessionUpdate === 'available_commands_update') { this.cursorCommandsKnown = true; this.cursorCommands = Array.isArray(u.availableCommands) ? u.availableCommands : []; this.capabilityCache.invalidate('skill'); for (const done of this.cursorCommandWaiters) done(); this.cursorCommandWaiters.clear(); }
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { this.connection.responded(); this.message(this.cursorMessageId, 'assistant', u.content.text, true); }
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        if (u.status !== 'failed' && Array.isArray(u.locations)) s.outputFiles = [...new Set([...(s.outputFiles || []), ...u.locations.map((location: any) => location.path).filter((value: unknown): value is string => typeof value === 'string')])];
        const text = [u.title, u.status, ...(u.content || []).map((x: any) => x.content?.text || pretty(x))].filter(Boolean).join('\n');
        if (u.status === 'failed') { const issue = permissionIssue(text); if (issue) { s.permissionIssue = issue; this.hooks.changed(); } }
        this.message(u.toolCallId, 'tool', text, u.sessionUpdate === 'tool_call_update');
      }
      if (u.sessionUpdate === 'plan') this.updatePlanSteps('steps-' + this.cursorMessageId, u.entries);
    } else if (method === 'cursor/update_todos') this.updatePlanSteps('steps-' + this.cursorMessageId, p.todos);
    else if (method.startsWith('cursor/')) this.message(randomUUID(), 'tool', pretty(p));
  }
  private updatePlanSteps(id: string, raw: unknown) {
    const steps = planSteps(raw); if (!steps.length) return;
    this.message(id, 'assistant', '执行计划'); const message = this.session.messages.find(value => value.id === id)!;
    message.kind = 'planSteps'; message.steps = steps; this.hooks.changed();
  }
  private onRequest(m: RpcMessage) {
    const p = m.params || {}, method = m.method!, id = randomUUID();
    if (this.session.provider === 'codex' && p.threadId && this.session.nativeId && p.threadId !== this.session.nativeId) { this.rpc.reject(m.id!, '请求不属于当前会话'); return; }
    if (this.session.provider === 'cursor' && p.sessionId && this.session.nativeId && p.sessionId !== this.session.nativeId) { this.rpc.reject(m.id!, '请求不属于当前会话'); return; }
    if (p.turnId && this.turnId && p.turnId !== this.turnId) { this.rpc.reject(m.id!, '请求不属于当前轮次'); return; }
    if ([...this.requests.values()].some(r => r.id === m.id)) return;
    const approval: Approval = { id, method, title: 'CLI 请求确认', details: pretty(p), options: [] };
    const command = p.command || p.toolCall?.rawInput?.command;
    approval.summary = [command ? '命令：' + pretty(command) : '', p.cwd ? '目录：' + p.cwd : '', p.reason ? '原因：' + p.reason : ''].filter(Boolean).join('\n');
    if (method === 'session/request_permission') {
      approval.title = p.toolCall?.title || 'Cursor 工具操作';
      approval.options = (p.options || []).filter((o: any) => ['allow_once', 'reject_once'].includes(o.kind)).map((o: any) => ({ id: o.optionId, label: o.kind === 'allow_once' ? '允许本次' : '拒绝', kind: o.kind === 'allow_once' ? 'allow' : 'deny' }));
      if (!approval.options.length) { this.rpc.respond(m.id!, { outcome: { outcome: 'cancelled' } }); this.message(randomUUID(), 'system', 'CLI 未提供可用的一次性授权选项，本次请求已取消。'); return; }
    } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      approval.title = method.includes('commandExecution') ? 'Codex 请求执行命令' : 'Codex 请求修改文件';
      if (method === 'item/fileChange/requestApproval') {
        // The approval itself may carry only an itemId; the diff arrives in item/started.
        const item = this.fileChanges.get(p.itemId);
        if (item && item.turnId === p.turnId) { approval.details = pretty({ ...p, changes: item.changes }); approval.summary = [approval.summary, ...item.changes.map((c: any) => typeof c.path === 'string' ? '文件：' + c.path : '')].filter(Boolean).join('\n'); }
      }
      approval.options = [{ id: 'accept', label: '允许本次', kind: 'allow' }, { id: 'decline', label: '拒绝', kind: 'deny' }];
      if (Array.isArray(p.availableDecisions)) { approval.options = approval.options.filter(o => p.availableDecisions.includes(o.id)); if (p.availableDecisions.includes('cancel')) approval.options.push({ id: 'cancel', label: '取消操作', kind: 'deny' }); }
      if (!approval.options.length) { this.rpc.reject(m.id!, '当前界面不支持此授权范围，请由 CLI 提供一次性授权或取消选项'); return; }
    } else if (method === 'item/permissions/requestApproval') {
      approval.title = 'Codex 请求额外权限'; approval.options = [{ id: 'accept', label: '允许本轮', kind: 'allow' }, { id: 'decline', label: '拒绝', kind: 'deny' }];
    } else if (method === 'item/tool/requestUserInput' || method === 'cursor/ask_question') {
      approval.title = p.title || 'Agent 需要补充信息';
      approval.questions = (p.questions || []).map((q: any) => ({ id: q.id, text: q.question || q.prompt, options: (q.options || []).map((o: any) => ({ id: o.id || o.label, label: o.label })), allowMultiple: method === 'cursor/ask_question' && !!q.allowMultiple }));
      approval.options = [{ id: 'answer', label: '提交回答', kind: 'answer' }, { id: 'skip', label: method === 'cursor/ask_question' ? '跳过' : '不提供信息，继续', kind: 'deny' }];
    } else if (method === 'cursor/create_plan') {
      approval.title = p.name || 'Cursor 方案确认'; approval.details = p.plan || pretty(p);
      approval.options = [{ id: 'accept', label: '执行计划', kind: 'allow' }, { id: 'decline', label: '返回修改', kind: 'deny' }, { id: 'cancel', label: '取消', kind: 'deny' }];
    } else if (method === 'mcpServer/elicitation/request') {
      this.rpc.respond(m.id!, { action: 'decline', content: null }); this.message(randomUUID(), 'system', '已拒绝当前界面尚不支持的 MCP 表单请求。'); return;
    } else { this.rpc.reject(m.id!); this.message(randomUUID(), 'system', 'CLI 请求暂不支持，已明确返回错误：' + method); return; }
    this.requests.set(id, m); this.session.approvals.push(approval); this.session.status = 'approval'; this.hooks.changed(); this.hooks.needsApproval?.(approval.questions ? 'question' : 'approval');
  }
  answer(id: string, option: string, answers: Record<string, string | string[]> = {}): void | Promise<void> {
    const req = this.requests.get(id), approval = this.session.approvals.find(a => a.id === id);
    if (!req || !approval || !approval.options.some(x => x.id === option)) throw new Error('确认项已过期或选项无效');
    if (this.answeringPlans.has(id)) throw new Error('正在提交计划，请稍候');
    const complete = (result: unknown) => {
      if (this.closing || this.requests.get(id) !== req) throw new Error('此确认已失效');
      this.rpc.respond(req.id!, result); this.hooks.event({ direction: 'user', method: req.method, result });
      this.requests.delete(id); this.session.approvals = this.session.approvals.filter(x => x.id !== id);
      this.session.status = this.session.approvals.length ? 'approval' : 'running'; this.hooks.changed();
    };
    const p = req.params || {}; let result: unknown;
    if (req.method === 'session/request_permission') result = { outcome: { outcome: 'selected', optionId: option } };
    else if (req.method === 'cursor/create_plan') {
      if (option === 'accept') {
        this.answeringPlans.add(id);
        return this.rpc.request('session/set_mode', { sessionId: this.session.nativeId, modeId: 'agent' }).then(() => {
          if (this.closing || this.requests.get(id) !== req) throw new Error('此计划已失效');
          this.session.mode = 'default'; complete({ outcome: { outcome: 'accepted' } });
        }).finally(() => { this.answeringPlans.delete(id); });
      }
      const reason = typeof answers.reason === 'string' ? answers.reason.trim().slice(0, 100000) : '';
      result = { outcome: option === 'accept' ? { outcome: 'accepted' } : option === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'rejected', ...(reason ? { reason } : {}) } };
    }
    else if (req.method === 'cursor/ask_question') {
      if (option === 'skip') result = { outcome: { outcome: 'skipped', reason: '用户跳过' } };
      else {
        const selected = (p.questions || []).map((q: any) => {
          const value = answers[q.id], ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
          const allowed = new Set((q.options || []).map((o: any) => o.id));
          if (!ids.length || (!q.allowMultiple && ids.length !== 1) || new Set(ids).size !== ids.length || ids.some(id => !allowed.has(id))) throw new Error('请为每个问题选择有效答案');
          return { questionId: q.id, selectedOptionIds: ids };
        });
        if (!selected.length) throw new Error('当前提问没有可提交的问题');
        result = { outcome: { outcome: 'answered', answers: selected } };
      }
    } else if (req.method === 'item/tool/requestUserInput') {
      result = { answers: Object.fromEntries((p.questions || []).map((q: any) => {
        if (option === 'skip') return [q.id, { answers: ['我暂不提供更多信息，请根据已有信息继续。'] }];
        const value = answers[q.id];
        if (typeof value !== 'string' || !value.trim()) throw new Error('请为每个问题填写答案');
        return [q.id, { answers: [value.trim()] }];
      })) };
    }
    else if (req.method === 'item/permissions/requestApproval') result = { permissions: option === 'accept' ? p.permissions : {}, scope: 'turn' };
    else result = { decision: option };
    complete(result);
  }
  async cancel() {
    if (this.session.provider === 'codex' && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.session.nativeId, turnId: this.turnId });
    else if (this.session.provider === 'cursor' && this.session.nativeId) this.rpc.notify('session/cancel', { sessionId: this.session.nativeId });
    else this.close();
  }
  async close() { this.closing = true; this.turnActive = false; this.connection.stop(); for (const done of this.cursorCommandWaiters) done(); this.cursorCommandWaiters.clear(); this.session.status = 'idle'; this.session.approvals = []; this.hooks.changed(); await Promise.all([this.rpc.close(), this.authBridge?.close()]); }
}
