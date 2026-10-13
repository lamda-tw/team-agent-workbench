import { randomUUID } from 'node:crypto';
import type { RpcMessage } from './rpc';

export interface SharedClient {
  id: string;
  send(message: RpcMessage): void;
  upstream(message: RpcMessage): void;
}
type Client = SharedClient & { actor: string; workbench: boolean };
type Owner = { clientId: string; actor: string; turnId?: string; requestId: string | number; disconnected?: boolean };
type Pending = { alias: string; message: RpcMessage; owner: Owner; answered: boolean; delivered?: boolean; sources: Map<string, { client: Client; id: string | number }> };
const rpcKey = (client: string, id: string | number) => client + ':' + typeof id + ':' + id;
const decisions = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);

/** Route decisions once, to the client that started the turn. Observers never reject another client's request. */
export class CodexApprovalRouter {
  private clients = new Map<string, Client>();
  private owners = new Map<string, Owner>();
  private starts = new Map<string, string>();
  private reads = new Map<string, { threadId: string; owner?: Owner; resume: boolean }>();
  private pending = new Map<string, Pending>();
  private aliases = new Map<string, Pending>();
  add(client: SharedClient) { this.clients.set(client.id, { ...client, actor: client.id, workbench: false }); }
  remove(id: string) {
    this.clients.delete(id);
    for (const owner of this.owners.values()) if (owner.clientId === id) owner.disconnected = true;
    for (const key of this.starts.keys()) if (key.startsWith(id + ':')) this.starts.delete(key);
    for (const pending of [...this.pending.values()]) {
      pending.sources.delete(id);
      if (!pending.sources.size) this.resolve(pending);
      else if (pending.owner.clientId === id) pending.delivered = false;
    }
    for (const key of this.reads.keys()) if (key.startsWith(id + ':')) this.reads.delete(key);
  }
  client(id: string, message: RpcMessage): boolean {
    const client = this.clients.get(id); if (!client) return true;
    const p: any = message.params || {};
    if (message.method === 'initialize') {
      const name = p.clientInfo?.name;
      if (typeof name === 'string' && name) client.actor = name;
      client.workbench = client.actor.startsWith('team_agent_workbench');
      for (const owner of this.owners.values()) if (owner.actor === client.actor && !this.clients.has(owner.clientId)) owner.clientId = id;
    }
    if (!message.method && typeof message.id === 'string' && message.id.startsWith('wb-approval:')) {
      const pending = this.aliases.get(message.id);
      if (!pending || pending.answered || pending.owner.clientId !== id) return true;
      pending.answered = true;
      // The response goes back on the upstream connection that received the request.
      const source = [...pending.sources.values()].find(source => this.clients.has(source.client.id));
      if (source) source.client.upstream({ ...message, id: source.id });
      return true;
    }
    if (message.method === 'turn/start' && message.id !== undefined && typeof p.threadId === 'string') {
      if (this.owners.has(p.threadId)) {
        client.send({ id: message.id, error: { code: -32001, message: '这条会话已有任务正在运行，请等本轮结束后发送' } });
        return true;
      }
      this.owners.set(p.threadId, { clientId: id, actor: client.actor, requestId: message.id });
      this.starts.set(rpcKey(id, message.id), p.threadId);
    }
    if (['thread/read', 'thread/resume'].includes(message.method || '') && message.id !== undefined && typeof p.threadId === 'string') {
      this.reads.set(rpcKey(id, message.id), { threadId: p.threadId, owner: this.owners.get(p.threadId), resume: message.method === 'thread/resume' });
    }
    return false;
  }
  server(id: string, message: RpcMessage): boolean {
    const client = this.clients.get(id); if (!client) return true;
    const p: any = message.params || {};
    if (!message.method && message.id !== undefined) {
      const key = rpcKey(id, message.id), threadId = this.starts.get(key);
      if (threadId) {
        this.starts.delete(key);
        const owner = this.owners.get(threadId);
        if (owner?.clientId === id && owner.requestId === message.id) {
          if (message.error) this.owners.delete(threadId);
          else { owner.turnId = (message.result as any)?.turn?.id; this.deliver(threadId, owner); }
        }
      }
      const read = this.reads.get(key); this.reads.delete(key);
      const thread: any = (message.result as any)?.thread;
      if (read && thread?.id === read.threadId && ['idle', 'notLoaded'].includes(thread.status?.type) && (read.owner?.turnId || read.owner?.disconnected) && this.owners.get(read.threadId) === read.owner) this.owners.delete(read.threadId);
      if (read?.resume && thread?.id === read.threadId) {
        const owner = this.owners.get(read.threadId);
        if (owner?.clientId === id) queueMicrotask(() => this.deliver(read.threadId, owner));
      }
    }
    if (message.method === 'turn/started' && typeof p.threadId === 'string') {
      const owner = this.owners.get(p.threadId);
      if (owner && !owner.turnId) { owner.turnId = p.turn?.id; this.deliver(p.threadId, owner); }
    }
    if (message.method === 'turn/completed' && typeof p.threadId === 'string') {
      const owner = this.owners.get(p.threadId);
      if (owner && (!owner.turnId || owner.turnId === p.turn?.id)) this.owners.delete(p.threadId);
      for (const pending of this.pending.values()) if ((pending.message.params as any)?.threadId === p.threadId && (pending.message.params as any)?.turnId === p.turn?.id) this.resolve(pending);
    }
    if (message.method === 'serverRequest/resolved') {
      for (const pending of [...this.pending.values()]) {
        if ((pending.message.params as any)?.threadId === p.threadId && pending.sources.get(id)?.id === p.requestId) this.resolve(pending);
      }
    }
    // Dynamic tools stay with their registered native host; they are not human approvals.
    if (message.method === 'item/tool/call' && message.id !== undefined && client.workbench) return true;
    if (message.method && decisions.has(message.method) && message.id !== undefined && typeof p.threadId === 'string') {
      const owner = this.owners.get(p.threadId);
      // Unknown provenance stays pending at its original client; never turn an observer into an approver.
      if (!owner) {
        if (client.workbench) { client.send({ method: 'workbench/approvalPendingElsewhere', params: { threadId: p.threadId, turnId: p.turnId } }); return true; }
        return false;
      }
      if (owner.turnId && p.turnId && owner.turnId !== p.turnId) return true;
      const key = [p.threadId, p.turnId || '', message.method, p.approvalId || p.itemId || p.elicitationId || message.id].join(':');
      let pending = this.pending.get(key);
      if (!pending) {
        pending = { alias: 'wb-approval:' + randomUUID(), message, owner, answered: false, sources: new Map() };
        this.pending.set(key, pending); this.aliases.set(pending.alias, pending);
      }
      const first = pending.sources.size === 0;
      pending.sources.set(id, { client, id: message.id });
      if (first && owner.turnId && this.clients.has(owner.clientId)) { pending.delivered = true; this.clients.get(owner.clientId)!.send({ ...message, id: pending.alias }); }
      if (client.workbench && id !== owner.clientId) client.send({ method: 'workbench/approvalPendingElsewhere', params: { threadId: p.threadId, turnId: p.turnId } });
      return true;
    }
    return false;
  }
  private deliver(threadId: string, owner: Owner) {
    const target = this.clients.get(owner.clientId); if (!target || !owner.turnId) return;
    for (const pending of this.pending.values()) if ((pending.message.params as any)?.threadId === threadId && !pending.answered && !pending.delivered) {
      pending.delivered = true;
      target.send({ ...pending.message, id: pending.alias });
    }
  }
  private resolve(pending: Pending) {
    if (!this.aliases.has(pending.alias)) return;
    this.aliases.delete(pending.alias);
    for (const [key, value] of this.pending) if (value === pending) this.pending.delete(key);
    const threadId = (pending.message.params as any)?.threadId;
    const stillPending = [...this.pending.values()].some(value => (value.message.params as any)?.threadId === threadId);
    this.clients.get(pending.owner.clientId)?.send({ method: 'serverRequest/resolved', params: { threadId: (pending.message.params as any)?.threadId, requestId: pending.alias } });
    for (const client of this.clients.values()) if (client.workbench && client.id !== pending.owner.clientId) client.send({ method: 'workbench/approvalResolved', params: { threadId, turnId: (pending.message.params as any)?.turnId, stillPending } });
  }
}
