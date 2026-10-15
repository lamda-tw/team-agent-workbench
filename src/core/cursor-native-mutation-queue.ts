import path from 'node:path';
import { createHash } from 'node:crypto';
import { sameNativePath } from './native-transcript';

export interface CursorMutationBinding { nativeId: string; workspace: string; backendId: string }
type Origin = { requestId: string; source: 'workbench' | 'native' };
export type CursorMutationRequest = Origin & ({ kind: 'prompt'; text: string } | { kind: 'compact' });
export interface CursorDispatchReceipt extends CursorMutationBinding { requestId: string; executionId: string }
export interface CursorCommitReceipt extends CursorDispatchReceipt {
  checkpointId: string;
  status: 'completed' | 'aborted' | 'error';
}
export interface CursorNotStartedReceipt extends CursorMutationBinding { requestId: string }
export type CursorMutationResult = { status: 'committed'; receipt: CursorCommitReceipt } | { status: 'cancelled' | 'not-started' };
export interface CursorMutationTransport {
  dispatch(binding: Readonly<CursorMutationBinding>, request: Readonly<CursorMutationRequest>): Promise<CursorDispatchReceipt>;
  waitCommitted(receipt: Readonly<CursorDispatchReceipt>): Promise<CursorCommitReceipt>;
  reconcile(binding: Readonly<CursorMutationBinding>, requestId: string): Promise<
    { status: 'committed'; receipt: CursorCommitReceipt } | { status: 'not-started'; receipt: CursorNotStartedReceipt } | { status: 'running' | 'unknown' }>;
}
export interface CursorMutationTicket { requestId: string; completion: Promise<CursorMutationResult> }
interface Entry { request: Readonly<CursorMutationRequest>; ticket: CursorMutationTicket; resolve: (result: CursorMutationResult) => void; receipt?: CursorDispatchReceipt }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Queue prototype for ONE authoritative native backend. Neither GUI nor CLI
 * transport is enabled by this class. Both senders must reach this owner before
 * changing native history. A stop Hook alone cannot supply waitCommitted.
 * Drafts remain here until dispatch; no old context or replacement summary is
 * attached. A lost acknowledgement suspends the queue instead of resending.
 * An aborted native turn preserves but pauses its waiting requests until an
 * explicit resume. This prototype does not recover across process restarts. */
export class CursorNativeMutationQueue {
  readonly binding: Readonly<CursorMutationBinding>;
  private waiting: Entry[] = [];
  private active?: Entry;
  private known = new Map<string, { signature: string; ticket: CursorMutationTicket }>();
  private phase: 'idle' | 'executing' | 'awaiting-commit' | 'uncertain' | 'paused' = 'idle';
  private closed = false;
  private recovering?: Promise<boolean>;
  constructor(binding: CursorMutationBinding, private transport: CursorMutationTransport, private limit = 32) {
    if (!uuid.test(binding.nativeId) || !path.isAbsolute(binding.workspace) || !binding.backendId.trim() || !Number.isSafeInteger(limit) || limit < 1) throw new Error('原生会话的执行归属未确认');
    this.binding = Object.freeze({ ...binding });
  }
  snapshot() {
    return { ...this.binding, phase: this.phase, closed: this.closed, activeRequestId: this.active?.request.requestId,
      waiting: this.waiting.map((entry, index) => ({ requestId: entry.request.requestId, source: entry.request.source, kind: entry.request.kind, position: index + 1 })) };
  }
  enqueue(request: CursorMutationRequest): CursorMutationTicket {
    if (this.closed) throw new Error('会话等待队列已关闭');
    if (!uuid.test(request.requestId) || !['native', 'workbench'].includes(request.source) || !['prompt', 'compact'].includes(request.kind)
      || (request.kind === 'prompt' && (typeof request.text !== 'string' || !request.text.trim()))) throw new Error('待执行请求不可用');
    const copy = Object.freeze(structuredClone(request));
    const signature = createHash('sha256').update(JSON.stringify([copy.requestId, copy.source, copy.kind, copy.kind === 'prompt' ? copy.text : null])).digest('hex');
    const prior = this.known.get(copy.requestId);
    if (prior) { if (prior.signature !== signature) throw new Error('同一请求编号不能用于不同内容'); return prior.ticket; }
    if (this.waiting.length >= this.limit) throw new Error('等待队列已满，请等待当前请求完成');
    let resolve!: Entry['resolve'];
    const completion = new Promise<CursorMutationResult>(done => resolve = done);
    const ticket = Object.freeze({ requestId: copy.requestId, completion });
    this.known.set(copy.requestId, { signature, ticket });
    this.waiting.push({ request: copy, ticket, resolve });
    void this.drain();
    return ticket;
  }
  cancelQueued(requestId: string) {
    const index = this.waiting.findIndex(entry => entry.request.requestId === requestId);
    if (index < 0) return false; // Active execution must be stopped and confirmed by the native owner.
    const [entry] = this.waiting.splice(index, 1);
    entry.resolve({ status: 'cancelled' });
    return true;
  }
  private assertScope(receipt: CursorNotStartedReceipt, requestId: string) {
    if (!receipt || receipt.nativeId !== this.binding.nativeId || receipt.backendId !== this.binding.backendId
      || !sameNativePath(receipt.workspace, this.binding.workspace) || receipt.requestId !== requestId) throw new Error('原生执行确认不属于当前会话');
  }
  private assertReceipt(receipt: CursorDispatchReceipt, requestId: string, executionId?: string) {
    this.assertScope(receipt, requestId);
    if (typeof receipt.executionId !== 'string' || !receipt.executionId || (executionId !== undefined && receipt.executionId !== executionId)) throw new Error('原生执行编号未确认');
  }
  private commit(entry: Entry, receipt: CursorCommitReceipt) {
    this.assertReceipt(receipt, entry.request.requestId, entry.receipt?.executionId);
    if (typeof receipt.checkpointId !== 'string' || !receipt.checkpointId || !['completed', 'aborted', 'error'].includes(receipt.status)) throw new Error('原生执行状态尚未提交完成');
    this.finish(entry, { status: 'committed', receipt }, receipt.status === 'aborted');
  }
  private finish(entry: Entry, result: CursorMutationResult, pause = false) {
    if (this.active !== entry) throw new Error('执行者已经改变');
    this.active = undefined; this.phase = pause ? 'paused' : 'idle';
    entry.resolve(result);
    if (!this.closed && !pause) void this.drain();
  }
  resume() {
    if (this.closed) throw new Error('会话等待队列已关闭');
    if (this.phase !== 'paused') return false;
    this.phase = 'idle';
    void this.drain();
    return true;
  }
  private async drain() {
    if (this.closed || this.phase === 'paused' || this.active || this.waiting.length === 0) return;
    const entry = this.waiting.shift()!;
    this.active = entry; this.phase = 'executing';
    try {
      const receipt = await this.transport.dispatch(this.binding, entry.request);
      this.assertReceipt(receipt, entry.request.requestId);
      entry.receipt = Object.freeze(structuredClone(receipt));
      this.phase = 'awaiting-commit';
      this.commit(entry, await this.transport.waitCommitted(entry.receipt));
    } catch {
      // The original request remains pending. Never replay it or dispatch a
      // successor on a timeout, connection failure, or mismatched receipt.
      if (this.active === entry) this.phase = 'uncertain';
    }
  }
  reconcile(): Promise<boolean> {
    if (this.recovering) return this.recovering;
    const entry = this.active;
    if (!entry || this.phase !== 'uncertain') return Promise.resolve(false);
    const job = this.recover(entry); this.recovering = job;
    void job.finally(() => { if (this.recovering === job) this.recovering = undefined; });
    return job;
  }
  private async recover(entry: Entry) {
    try {
      const result = await this.transport.reconcile(this.binding, entry.request.requestId);
      if (this.active !== entry) return false;
      if (result.status === 'committed') { this.commit(entry, result.receipt); return true; }
      if (result.status === 'not-started') {
        this.assertScope(result.receipt, entry.request.requestId);
        if (entry.receipt) return false; // Cannot contradict a confirmed execution with a negative acknowledgement.
        this.finish(entry, { status: 'not-started' }); return true;
      }
    } catch { /* Remain suspended until an authoritative confirmation is available. */ }
    return false;
  }
  close() {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) entry.resolve({ status: 'cancelled' });
    // Closing a window must not release an executing mutation or invent a stop.
  }
}
