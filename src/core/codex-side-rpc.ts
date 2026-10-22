import { EventEmitter } from 'node:events';
import type { AgentRpc, RpcMessage } from './rpc';

/** A borrowed subscription. Closing it never closes the owning CLI connection. */
export class CodexSideRpc extends EventEmitter implements AgentRpc {
  private closed = false;
  private requests = new Set<number | string>();
  private turnId?: string;
  private receive = (message: RpcMessage) => {
    const p = message.params || {}, thread = p.threadId || p.thread?.id;
    if (thread !== this.threadId && !(message.method === 'serverRequest/resolved' && this.requests.has(p.requestId))) return;
    if (message.id !== undefined) this.requests.add(message.id);
    if (message.method === 'serverRequest/resolved') this.requests.delete(p.requestId);
    if (message.method === 'turn/started') this.turnId = p.turn?.id;
    if (message.method === 'turn/completed') this.turnId = undefined;
    this.emit('message', message);
  };
  private disconnected = () => this.detach(new Error('侧边提问已失效：原 Codex 连接已关闭，请重新创建侧聊。'));
  constructor(private owner: AgentRpc, readonly threadId: string) {
    super();
    owner.on('message', this.receive);
    owner.on('closed', this.disconnected);
  }
  async request(method: string, params?: any, timeout?: number, onWritten?: () => void) {
    if (this.closed) throw new Error('侧边提问已失效，请重新创建侧聊');
    if (params?.threadId && params.threadId !== this.threadId) throw new Error('侧聊请求不属于当前分支');
    const result = await this.owner.request(method, params, timeout, onWritten);
    if (method === 'turn/start' && result?.turn?.status === 'inProgress') this.turnId = result.turn.id;
    return result;
  }
  notify(method: string, params?: unknown) { if (!this.closed) this.owner.notify(method, params); }
  respond(id: number | string, result: unknown) { if (!this.closed && this.requests.delete(id)) this.owner.respond(id, result); }
  reject(id: number | string, message?: string) { if (!this.closed && this.requests.delete(id)) this.owner.reject(id, message); }
  private detach(error: Error) {
    if (this.closed) return;
    this.closed = true; this.requests.clear();
    this.owner.off('message', this.receive); this.owner.off('closed', this.disconnected);
    this.emit('closed', error);
  }
  async close() {
    if (this.closed) return;
    this.detach(new Error('侧边提问已关闭'));
    // Unsubscribe also releases in-memory forks. Do not replay a timed-out turn.
    if (this.turnId) await this.owner.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 5000).catch(() => {});
    await this.owner.request('thread/unsubscribe', { threadId: this.threadId }, 5000).catch(() => {});
  }
}

export const sideConversationInstructions = `这是独立的临时侧边提问。继承的父会话历史仅供参考，不能当作当前待办任务。
只处理侧聊边界之后用户提出的问题，不继续执行父会话中的计划、工具调用、授权或未完成请求。
默认只做解释和不修改状态的阅读、搜索、检查。只有用户在本侧聊明确要求时才允许进行对应的最小修改。
不要创建或操控子代理，不干扰父会话。工具权限仍受当前 Codex 策略约束。`;
