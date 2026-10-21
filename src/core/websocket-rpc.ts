import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { AgentRpc, RpcMessage } from './rpc';

// Disconnecting a client must never terminate the shared native backend.
export class WebSocketRpc extends EventEmitter implements AgentRpc {
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private closed = false;
  private seq = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  constructor(private endpoint: string) { super(); }
  private connect() {
    if (this.closed) return Promise.reject(new Error('共享 Codex 连接已关闭，请重新打开会话；输入已保留'));
    return this.opening ||= new Promise<void>((resolve, reject) => {
      // Local shared backends must not inherit Node's global environment proxy.
      const socket = this.socket = new WebSocket(this.endpoint, { agent: false, maxPayload: 8 * 1024 * 1024 });
      const timer = setTimeout(() => { const error = new Error('连接未能恢复，请点击“恢复同步”；会话和输入已保留'); reject(error); this.finish(error); socket.close(); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); const error = new Error('无法连接，请点击“恢复同步”；会话和输入已保留'); reject(error); this.finish(error); });
      socket.addEventListener('close', () => { clearTimeout(timer); const error = new Error('连接已断开；请恢复同步并核对已有结果，不会自动重发任务'); reject(error); this.finish(error); });
      socket.addEventListener('message', event => {
        let message: RpcMessage;
        try { message = JSON.parse(String(event.data)); } catch { this.finish(new Error('共享 Codex 返回了无效消息')); socket.close(); return; }
        if (message.method) this.emit('message', message);
        else if (typeof message.id === 'number') {
          const call = this.pending.get(message.id); if (!call) return;
          this.pending.delete(message.id); clearTimeout(call.timer);
          message.error ? call.reject(Object.assign(new Error(message.error.message), { data: message.error.data })) : call.resolve(message.result);
        }
      });
    });
  }
  private finish(error: Error) {
    if (this.closed) return; this.closed = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  private write(value: RpcMessage) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw new Error('共享 Codex 连接已关闭');
    this.socket.send(JSON.stringify(value));
  }
  async request(method: string, params: unknown = {}, timeout = 60000, onWritten?: () => void) {
    await this.connect();
    return new Promise<any>((resolve, reject) => {
      const id = ++this.seq;
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error('共享 Codex 操作未能确认完成；请核对已有回复，避免重复发送')); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); onWritten?.(); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params: unknown = {}) { this.write({ method, params }); }
  respond(id: number | string, result: unknown) { this.write({ id, result }); }
  reject(id: number | string, message = '客户端暂不支持此请求') { this.write({ id, error: { code: -32601, message } }); }
  async close() { this.finish(new Error('共享 Codex 连接已关闭')); this.socket?.close(); }
}
