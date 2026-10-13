import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentCapabilityCatalog, AgentCapabilityOption, AgentSession, Approval, Message, MessageContext, PermissionMode } from '../shared/types';
import type { AgentHooks } from './agents';
import { claudeLocalSkills, claudePluginCapabilities, emptyCapabilityCatalog } from './provider-capabilities';
import { CapabilityCache } from './capability-cache';
import { spawnCLI, stopCLI } from './rpc';
import { CliConnectionTracker } from './cli-connection';

const now = () => new Date().toISOString();
export const claudeNativeMode = (mode: PermissionMode | undefined, purpose: AgentSession['purpose']) => purpose === 'prepare' || mode === 'full' ? 'bypassPermissions' : mode === 'auto' ? 'auto' : mode === 'review' ? 'manual' : undefined;

/** Claude's stream-json control channel is separate from the team's session record. */
export class ClaudeRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private initialized = false;
  private pending = new Map<string, { requestId: string; input: Record<string, unknown>; toolName: string }>();
  private closed = false;
  private running = false;
  private finished = false;
  private replyId = '';
  private streamed = false;
  private stderr = '';
  private currentContext?: MessageContext;
  onClosed?: () => void;
  private connection: CliConnectionTracker;
  private capabilityCache = new CapabilityCache('claude');
  constructor(readonly session: AgentSession, private executable: string, private hooks: AgentHooks, private networkEnv: NodeJS.ProcessEnv = {}) { this.connection = new CliConnectionTracker(session, hooks.changed, hooks.connectionChanged); }
  get activeTurnId() { return undefined; }
  async start() {
    if (this.closed) throw new Error('CLI 连接已关闭');
    if (this.initialized) return;
    this.initialized = true;
    const mode = claudeNativeMode(this.session.permissionMode, this.session.purpose);
    this.session.permissions = { provider: 'claude', source: 'runtime', checkedAt: now(), sandbox: 'claude-code', approval: mode || 'inherit', warnings: [] };
    this.session.status = 'idle'; this.session.error = undefined; this.hooks.changed();
  }
  async ensureStarted() { await this.start(); }
  async capabilities(forceRefresh = false, kind?: 'skill' | 'plugin'): Promise<AgentCapabilityCatalog> {
    if (this.closed) throw new Error('CLI 连接已关闭');
    return this.capabilityCache.get(forceRefresh, kind, async section => section === 'skill'
      ? { ...emptyCapabilityCatalog('claude'), skills: await claudeLocalSkills(this.session.cwd) }
      : claudePluginCapabilities(this.session.cwd, this.executable, this.networkEnv));
  }
  async resolveCapabilities(selections: { id: string; kind: 'skill' | 'plugin' }[]): Promise<AgentCapabilityOption[]> {
    if (!selections.length) return [];
    const kinds = new Set(selections.map(item => item.kind));
    const catalog = await this.capabilities(false, kinds.size === 1 ? selections[0].kind : undefined);
    const available = new Map([...catalog.skills, ...catalog.plugins].map(item => [item.id, item]));
    return selections.map(selection => {
      const item = available.get(selection.id);
      if (!item || item.kind !== selection.kind || !item.enabled) throw new Error(`所选 ${selection.kind === 'skill' ? 'Skill' : '插件'} 已不可用，请重新选择`);
      return item;
    });
  }
  private message(id: string, role: Message['role'], value: string, append = false, metadata: Pick<Message, 'userText' | 'context'> = {}) {
    const item = this.session.messages.find(m => m.id === id);
    if (item) item.text = append ? item.text + value : value;
    else this.session.messages.push({ id, role, text: value, createdAt: now(), ...metadata });
    this.hooks.changed();
  }
  private send(value: unknown) { if (!this.child || this.child.stdin.destroyed) throw new Error('CLI 连接已关闭'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  async prompt(text: string, options?: { userText: string; context: Omit<MessageContext, 'nativeId' | 'accepted'>; capabilities?: AgentCapabilityOption[]; submitted?: () => void }): Promise<boolean> {
    if (!text.trim()) throw new Error('请输入任务内容');
    if (this.running) throw new Error('当前会话仍在运行');
    await this.ensureStarted();
    const selected = options?.capabilities || [];
    const skills = selected.filter(item => item.kind === 'skill').map(item => '/' + item.invocation);
    const plugins = selected.filter(item => item.kind === 'plugin');
    const nativeText = [skills.join(' '), text].filter(Boolean).join(' ') + (plugins.length ? `\n\n[本轮用户选择的插件：${plugins.map(item => item.name).join('、')}。请在与当前任务相关时使用已安装的插件能力。]` : '');
    const plannedId = this.session.nativeId || randomUUID();
    const context = options ? { ...options.context, capabilities: selected.map(({ id, kind, name }) => ({ id, kind, name })), nativeId: plannedId, accepted: false } : undefined;
    this.currentContext = context;
    const mode = claudeNativeMode(this.session.permissionMode, this.session.purpose);
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', ...(this.session.purpose === 'background' ? ['--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'] : []), ...(mode ? ['--permission-mode', mode] : []), ...(this.session.nativeId ? ['--resume', this.session.nativeId] : ['--session-id', plannedId]), ...(this.session.model ? ['--model', this.session.model] : [])];
    this.message(randomUUID(), 'user', nativeText, false, options ? { userText: options.userText, context } : {});
    this.hooks.event({ direction: 'user', text: nativeText, ...(options ? { userText: options.userText, capabilities: context?.capabilities } : {}) });
    this.session.status = 'running'; this.session.error = undefined; this.running = true; this.finished = false; this.streamed = false; this.stderr = ''; this.replyId = randomUUID(); this.hooks.changed();
    this.connection.begin();
    try {
      const child = spawnCLI(this.executable, args, this.session.cwd, this.networkEnv);
      this.child = child;
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => { try { this.onEvent(JSON.parse(line), plannedId); } catch { /* Raw diagnostics may contain credentials. */ } });
      child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4000); if (!this.closed) this.connection.diagnostic(String(data)); });
      const completed = new Promise<boolean>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => {
          lines.close(); this.child = undefined;
          if (this.closed) { resolve(false); return; }
          const error = this.finished ? undefined : code === 0 ? 'Claude Code 未返回结果' : this.safeError();
          this.finish(error); resolve(!error && !this.session.error);
        });
      });
      this.send({ type: 'user', message: { role: 'user', content: nativeText }, session_id: plannedId });
      options?.submitted?.();
      return await completed;
    } catch (error: any) { if (!this.closed) this.finish(error.message || 'Claude Code 无法启动'); return false; }
  }
  private safeError() {
    if (/not logged in|please log in|authentication|unauthorized/i.test(this.stderr)) return 'Claude Code 尚未登录或登录已过期，请重新登录。';
    if (/network|proxy|timeout|connection|fetch failed|ENOTFOUND|ECONN/i.test(this.stderr)) return 'Claude Code 无法连接服务，请检查网络或代理。';
    return 'Claude Code 运行失败，请检查 CLI 登录状态、模型和本机环境。';
  }
  private onEvent(event: any, plannedId: string) {
    if (this.closed || !event || typeof event !== 'object') return;
    if (event.type === 'error' || event.type === 'result' && event.is_error) this.connection.error(event.error || { message: (event.errors || []).join('\n') }, false);
    if (event.type === 'system' && event.subtype === 'api_retry') this.connection.error({ message: `Retrying ${event.attempt || 1}`, statusCode: event.error_status }, true);
    if (event.type === 'assistant' && !event.error || event.type === 'stream_event' && event.event?.type === 'content_block_delta') this.connection.responded();
    if (['control_request', 'assistant', 'stream_event'].includes(event.type) || (event.type === 'result' && !event.is_error)) {
      if (this.currentContext && !this.currentContext.accepted) { this.currentContext.accepted = true; this.hooks.changed(); }
    }
    if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') { this.onPermission(event); return; }
    if (event.type === 'system' && event.subtype === 'init') {
      this.session.nativeId = typeof event.session_id === 'string' ? event.session_id : plannedId;
      this.hooks.changed(); return;
    }
    if (event.type === 'stream_event' && !event.parent_tool_use_id) {
      const e = event.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        this.streamed = true; this.message(this.replyId, 'assistant', e.delta.text, true);
      }
      return;
    }
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const text = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('');
      if (text && !this.streamed) this.message(this.replyId, 'assistant', text);
      for (const block of blocks) if (block.type === 'tool_use') {
        const detail = typeof block.input?.command === 'string' ? block.input.command : JSON.stringify(block.input || {});
        this.message(block.id || randomUUID(), 'tool', `${block.name || '工具'}\n${detail}`);
        if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(block.name) && typeof block.input?.file_path === 'string') {
          const file = path.isAbsolute(block.input.file_path) ? block.input.file_path : path.resolve(this.session.cwd, block.input.file_path);
          this.session.outputFiles = [...new Set([...(this.session.outputFiles || []), file])];
        }
        this.hooks.event({ method: 'claude/tool_use', name: block.name, input: block.input, id: block.id });
      }
      return;
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        this.message('result-' + block.tool_use_id, 'tool', content);
        this.hooks.event({ method: 'claude/tool_result', toolUseId: block.tool_use_id, content, isError: block.is_error });
      }
      return;
    }
    if (event.type === 'result') {
      this.finished = true;
      if (typeof event.session_id === 'string') this.session.nativeId = event.session_id;
      if (typeof event.result === 'string' && !this.streamed && !this.session.messages.some(m => m.id === this.replyId)) this.message(this.replyId, 'assistant', event.result);
      if (event.is_error) this.session.error = 'Claude Code 未完成本轮任务，请查看已返回的内容。';
      this.hooks.event({ method: 'claude/result', subtype: event.subtype, isError: event.is_error, sessionId: this.session.nativeId });
      this.hooks.changed();
      // Stream-json input otherwise stays open for another turn; resume by ID next time.
      this.child?.stdin.end();
    }
  }
  private onPermission(event: any) {
    if (this.session.purpose === 'background') { this.send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'deny', message: '后台文本任务不允许工具操作' } } }); return; }
    const req = event.request, name = typeof req.tool_name === 'string' ? req.tool_name : '工具';
    const input = req.input && typeof req.input === 'object' ? req.input : {};
    const id = randomUUID(), questions = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions : [];
    const approval: Approval = { id, method: 'claude/can_use_tool', title: questions.length ? 'Claude Code 需要补充信息' : `Claude Code 请求使用 ${name}`, details: JSON.stringify(input, null, 2), summary: typeof input.command === 'string' ? input.command : undefined,
      options: questions.length ? [{ id: 'answer', label: '提交回答', kind: 'answer' }, { id: 'skip', label: '跳过', kind: 'deny' }] : [{ id: 'accept', label: '允许本次', kind: 'allow' }, { id: 'decline', label: '拒绝', kind: 'deny' }],
      questions: questions.length ? questions.map((q: any, i: number) => ({ id: String(i), text: String(q.question || ''), options: (q.options || []).map((o: any) => ({ id: String(o.label), label: String(o.label) })), allowMultiple: !!q.multiSelect })) : undefined };
    this.pending.set(id, { requestId: event.request_id, input, toolName: name }); this.session.approvals.push(approval); this.session.status = 'approval'; this.hooks.changed(); this.hooks.needsApproval?.(questions.length ? 'question' : 'approval');
  }
  answer(id: string, option: string, answers: Record<string, string | string[]> = {}) {
    const pending = this.pending.get(id), approval = this.session.approvals.find(a => a.id === id);
    if (!pending || !approval || !approval.options.some(item => item.id === option)) throw new Error('确认项已过期或选项无效');
    let response: any;
    if (approval.questions?.length && option === 'answer') {
      const values: Record<string, string | string[]> = {};
      for (const [index, q] of approval.questions.entries()) {
        const value = answers[q.id];
        if (Array.isArray(value) && (!q.allowMultiple || !value.length || value.some(v => !q.options.some(o => o.id === v)))) throw new Error('请选择有效答案');
        if (typeof value === 'string' && !value.trim()) throw new Error('请填写有效答案');
        if (!value) throw new Error('请为每个问题填写答案');
        values[String((pending.input.questions as any[])[index].question)] = value;
      }
      response = { behavior: 'allow', updatedInput: { ...pending.input, answers: values } };
    } else if (option === 'accept') response = { behavior: 'allow', updatedInput: pending.input };
    else response = { behavior: 'deny', message: option === 'skip' ? '用户跳过本次提问' : '用户拒绝本次操作' };
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: pending.requestId, response } });
    this.hooks.event({ direction: 'user', method: 'claude/can_use_tool', toolName: pending.toolName, decision: response.behavior });
    this.pending.delete(id); this.session.approvals = this.session.approvals.filter(a => a.id !== id);
    this.session.status = this.session.approvals.length ? 'approval' : 'running'; this.hooks.changed();
  }
  async steer(_expectedTurnId: string, _text: string, _options: { userText: string; context: Omit<MessageContext, 'nativeId' | 'accepted'>; capabilities?: AgentCapabilityOption[] }): Promise<boolean> { throw new Error('当前 Claude Code 接入暂不支持生成中引导，请等待本轮结束后发送'); }
  private finish(error?: string) {
    if (!this.running) return;
    const wasRunning = this.running; this.running = false; this.pending.clear(); this.session.approvals = [];
    this.currentContext = undefined;
    this.session.status = error || this.session.error ? 'error' : 'idle'; this.session.error = error || this.session.error;
    this.connection.finish(this.session.error);
    if (error) this.hooks.authFailed?.(error);
    this.hooks.changed(); if (wasRunning) this.hooks.done();
  }
  async cancel() { if (this.child) await stopCLI(this.child); }
  async close() { this.closed = true; this.running = false; this.connection.stop(); if (this.child) await stopCLI(this.child); this.session.approvals = []; this.session.status = 'idle'; this.hooks.changed(); this.onClosed?.(); }
}
