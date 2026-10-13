import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { AgentRpc } from './rpc';
import type { AgentSession, Message } from '../shared/types';
import { sameNativePath } from './native-transcript';

export interface CursorNativeDescriptor { version: 1; endpoint: string; sessionId: string; workspace: string; expiresAt: string }
export interface CursorNativeSnapshot { sessionId: string; status: string; messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>; title?: string }

export async function cursorNativeDescriptor(session: AgentSession): Promise<CursorNativeDescriptor> {
  if (session.provider !== 'cursor' || session.purpose !== 'work' || session.networkRoute === 'management' || !session.cursorNative || !session.nativeId) throw new Error('此会话不能接入 Cursor 原生窗口');
  let descriptor: CursorNativeDescriptor;
  try { descriptor = JSON.parse(await fs.readFile(session.cursorNative.descriptorFile, 'utf8')); }
  catch { throw new Error('Cursor 原生连接已失效，请点击“在 Cursor Agents 中打开”恢复关联'); }
  try {
    const endpoint = new URL(descriptor.endpoint);
    if (descriptor.version !== 1 || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/native\/[a-f0-9]{64}$/.test(endpoint.pathname) || descriptor.sessionId !== session.nativeId || !sameNativePath(descriptor.workspace, session.cwd) || !Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= Date.now()) throw new Error();
  } catch { throw new Error('Cursor 原生连接与当前会话不匹配或已过期'); }
  return descriptor;
}

export function mergeCursorNativeMessages(existing: Message[], incoming: CursorNativeSnapshot['messages']) {
  const result = existing.map(message => ({ ...message }));
  for (const item of incoming) {
    if (!item.id || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string') continue;
    const id = 'cursor-native:' + item.id;
    let prior = result.find(message => message.id === id);
    if (!prior && item.role === 'user') prior = result.find(message => !message.id.startsWith('cursor-native:') && message.role === 'user' && message.text === item.text);
    if (prior) { prior.id = id; prior.text = item.text; }
    else result.push({ id, role: item.role, text: item.text, createdAt: new Date().toISOString() });
  }
  return result;
}

// ACP-shaped transport to a deliberately scoped, user-started native UI bridge.
// It never spawns Cursor CLI or writes Cursor's own history/database.
export class CursorNativeRpc extends EventEmitter implements AgentRpc {
  private descriptor?: CursorNativeDescriptor;
  private closed = false;
  private polling?: NodeJS.Timeout;
  private refreshing = false;
  private last = '';
  private sending = false;
  constructor(private session: AgentSession) { super(); }
  private async invoke(operation: string, body?: unknown, timeout = 10000) {
    if (this.closed) throw new Error('Cursor 原生连接已关闭');
    // Managed descriptors can be renewed while this runtime stays alive. Reading is safe;
    // a send with a lost acknowledgement is still never repeated.
    if (this.session.cursorNative?.managed || !this.descriptor) this.descriptor = await cursorNativeDescriptor(this.session);
    if (Date.parse(this.descriptor.expiresAt) <= Date.now()) throw new Error('Cursor 原生连接已过期，请点击“在 Cursor Agents 中打开”');
    let response: Response;
    try { response = await fetch(this.descriptor.endpoint + '/' + operation, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
    catch { throw new Error(operation === 'send' ? 'Cursor 送达状态未确认，请核对原生窗口，避免重复发送' : 'Cursor 原生连接不可用，请点击“在 Cursor Agents 中打开”恢复关联'); }
    let value: any; try { value = await response.json(); } catch { throw new Error('Cursor 原生窗口未返回可用结果'); }
    if (!response.ok) throw new Error(value.message || 'Cursor 原生窗口暂时不可用');
    return value;
  }
  private publish(snapshot: CursorNativeSnapshot) {
    if (!snapshot || snapshot.sessionId !== this.session.nativeId || typeof snapshot.status !== 'string' || !Array.isArray(snapshot.messages) || snapshot.messages.some(item => !item || typeof item.id !== 'string' || !item.id || !['user','assistant'].includes(item.role) || typeof item.text !== 'string')) throw new Error('Cursor 原生窗口未返回当前会话的可用记录，已停止同步');
    if (this.closed) return;
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === this.last) return;
    this.last = fingerprint;
    this.emit('message', { method: 'cursor/nativeSnapshot', params: { sessionId: snapshot.sessionId, snapshot } });
  }
  async snapshot() { const value = await this.invoke('snapshot'); this.publish(value); return value as CursorNativeSnapshot; }
  private async refresh() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try { await this.snapshot(); }
    catch (error) { if (!this.closed && !this.sending) this.emit('diagnostic', error instanceof Error ? error.message : 'Cursor 原生窗口暂时不可用'); }
    finally { this.refreshing = false; }
  }
  async request(method: string, params: any = {}, _timeout = 60000, onWritten?: () => void): Promise<any> {
    if (method === 'initialize') { await this.snapshot(); this.polling ||= setInterval(() => void this.refresh(), 400); this.polling.unref(); return { protocolVersion: 1 }; }
    if (method === 'authenticate') return {};
    if (params.sessionId && params.sessionId !== this.session.nativeId) throw new Error('操作不属于关联的 Cursor 原生会话');
    if (method === 'session/load') { await this.snapshot(); return { sessionId: this.session.nativeId, modes: { currentModeId: 'agent', availableModes: [] } }; }
    if (method === 'session/new') throw new Error('请先在 Cursor 原生窗口创建并关联会话');
    if (method === 'session/prompt') {
      const text = params.prompt?.map((part: any) => part.type === 'text' ? part.text : '').join('\n');
      if (!text?.trim()) throw new Error('请输入任务内容');
      if (this.sending) throw new Error('正在向 Cursor 提交消息，请稍候');
      this.sending = true;
      try {
        const before = await this.snapshot();
        if (before.status === 'generating') throw new Error('Cursor 原生会话仍在运行，请等待本轮结束');
        const previousIds = new Set(before.messages.filter(message => message.role === 'assistant').map(message => message.id));
        // A lost acknowledgement must not trigger an automatic repeat send.
        const acknowledgement = await this.invoke('send', { text }, 20000);
        if (acknowledgement?.submitted !== true) throw new Error('Cursor 送达状态未确认，请核对原生窗口，避免重复发送');
        onWritten?.();
        const deadline = Date.now() + 600000;
        while (!this.closed && Date.now() < deadline) {
          const state = await this.snapshot();
          if (['aborted','error'].includes(state.status)) throw new Error('Cursor 原生会话已停止或失败，请核对已有回复');
          if (state.status !== 'generating' && state.messages.some(message => message.role === 'assistant' && !previousIds.has(message.id) && message.text.trim())) return { stopReason: 'end_turn' };
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error('Cursor 回复尚未确认完成，请核对原生窗口，避免重复发送');
      } finally { this.sending = false; }
    }
    if (method === 'session/cancel') return this.invoke('stop', {});
    if (method === 'cursor/nativeFocus') return this.invoke('focus', {});
    throw new Error('请在 Cursor 原生窗口设置模型、模式、权限及工具');
  }
  notify(method: string, params?: unknown) {
    if (method === 'session/cancel') void this.request(method, params).catch(() => this.emit('diagnostic', '请在 Cursor 原生窗口停止当前回复'));
  }
  respond() { throw new Error('请在 Cursor 原生窗口处理授权或提问'); }
  reject() { throw new Error('请在 Cursor 原生窗口处理授权或提问'); }
  async close() { if (this.closed) return; this.closed = true; clearInterval(this.polling); this.emit('closed', new Error('Cursor 原生连接已关闭')); }
}
