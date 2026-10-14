import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { AgentRpc } from './rpc';
import type { AgentSession, Message } from '../shared/types';
import { sameNativePath } from './native-transcript';
import { assertCursorSharedSessionAvailable } from '../shared/cursor-session-consistency';

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
  private connectionState?: 'connected' | 'disconnected';
  private connectionError?: string;
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
  private connection(state: 'connected' | 'disconnected', error?: unknown) {
    if (this.closed) return;
    if (state === 'disconnected') this.last = ''; // Reapply native status on recovery even when its content is unchanged.
    const message = state === 'disconnected' ? error instanceof Error ? error.message : '原生会话暂时不可用' : undefined;
    if (state === this.connectionState && message === this.connectionError) return;
    this.connectionState = state; this.connectionError = message;
    this.emit('message', { method: 'cursor/nativeConnection', params: { sessionId: this.session.nativeId, state, message } });
  }
  async snapshot() {
    try { const value = await this.invoke('snapshot'); this.publish(value); this.connection('connected'); return value as CursorNativeSnapshot; }
    catch (error) { this.connection('disconnected', error); throw error; }
  }
  private async refresh() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try { await this.snapshot(); }
    catch { /* snapshot publishes an explicit connection state, including when no task is running. */ }
    finally { this.refreshing = false; }
  }
  async request(method: string, params: any = {}, _timeout = 60000, _onWritten?: () => void): Promise<any> {
    if (method === 'initialize') { await this.snapshot(); this.polling ||= setInterval(() => void this.refresh(), 400); this.polling.unref(); return { protocolVersion: 1 }; }
    if (method === 'authenticate') return {};
    if (params.sessionId && params.sessionId !== this.session.nativeId) throw new Error('操作不属于关联的 Cursor 原生会话');
    if (method === 'session/load') { await this.snapshot(); return { sessionId: this.session.nativeId, modes: { currentModeId: 'agent', availableModes: [] } }; }
    if (method === 'session/new' || method === 'session/prompt') assertCursorSharedSessionAvailable();
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
