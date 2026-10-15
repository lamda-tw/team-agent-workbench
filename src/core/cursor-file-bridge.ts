import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { CursorDesktopClient } from './cursor-desktop-client';
import { readCursorDesktopHistory, type CursorDesktopHistory } from './cursor-desktop-history';
import type { CursorNativeSettings, CursorSettingKind, CursorSettingsChange } from '../shared/cursor-native-settings';

interface Binding { nativeId: string; cwd: string }
export interface CursorFileRequest { version: 1; id: string; nativeId: string; cwd: string; text: string; createdAt: string; sequence?: number; state: 'queued' | 'sending' | 'accepted' | 'completed' | 'aborted' | 'error' | 'uncertain' | 'cancelled'; nativeMessageId?: string; beforeCheckpoint?: string; beforeMessageIds?: string[]; beforeBoundary?: string; beforeWasEmpty?: boolean; checkpoint?: string; error?: string }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const signature = (request: CursorFileRequest) => createHash('sha256').update(JSON.stringify([request.nativeId, path.resolve(request.cwd).toLowerCase(), request.text])).digest('hex');
export function cursorRequestCandidateIds(request:CursorFileRequest,history:CursorDesktopHistory){
  const boundary=request.beforeBoundary?history.bubbles.findIndex(bubble=>bubble.bubbleId===request.beforeBoundary):-1;
  return history.bubbles.filter((bubble,index)=>bubble.type===1&&bubble.text?.trim()===request.text.trim()&&(request.beforeBoundary?boundary>=0&&index>boundary:request.beforeWasEmpty===true?true:!!request.beforeMessageIds&&!request.beforeMessageIds.includes(bubble.bubbleId))).map(bubble=>bubble.bubbleId as string);
}

/** Durable request mailbox for one native IDE executor. Cursor itself owns
 * execution, tools and compaction. Native storage is only read, never rewritten.
 * Only the verified IDE transport may expose this mailbox to a workbench session. */
export class CursorFileBridge {
  private timer?: NodeJS.Timeout;
  private polling = false;
  private closed = false;
  private paused = false;
  private owner = randomUUID();
  private owned = false;
  private state?: CursorDesktopHistory;
  private lastError?: string;
  private current?: string;
  private nativeStatus = 'unknown';
  private settings?: CursorNativeSettings;
  private modeCatalog?: CursorNativeSettings;
  private settingsChange?: CursorSettingsChange;
  private settingsAttemptAt = 0;
  private stopRequestId?: string;
  private mutation: Promise<unknown> = Promise.resolve();
  private pendingRefresh?: Promise<void>;
  private stableCheckpoint?: string;
  private terminalObservation?: { key: string; since: number };
  private sawNativeRunning = false;
  constructor(readonly directory: string, readonly binding: Binding, private database: string, private client: CursorDesktopClient, private options: { readHistory?: typeof readCursorDesktopHistory; pollMs?: number; now?: () => number } = {}) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const job = this.mutation.then(work, work); this.mutation = job.catch(() => {}); return job; }
  private async pause(value: boolean) { this.paused = value; await this.atomic(path.join(this.directory, 'control.json'), { version: 1, ...this.binding, paused: value, stopRequestId: this.stopRequestId, settingsChange: this.settingsChange }); }
  async configure(kind?: CursorSettingKind, value?: string, revision?: string, cancel = false) {
    return this.serial(async () => {
      if (this.closed || !this.owned || !this.client.settings || !this.client.changeSetting) throw Error('当前 Cursor 设置接口不可用');
      if (cancel) { this.settingsChange = undefined; await this.pause(this.paused); return this.settings; }
      const actual = await this.client.settings(this.binding.nativeId, this.binding.cwd, value ? undefined : kind);
      this.settings = actual;
      if (!value && kind === 'mode') this.modeCatalog = actual;
      if (!value) return { ...actual, pending: this.settingsChange };
      if (this.settingsChange) throw Error('请先完成或取消上一次设置更改');
      if (!kind || actual.state !== 'ready' || actual.revision !== revision) throw Error('Cursor 设置已经变化，请刷新后重新选择');
      // Mode choices come from the native menu again at application time. A busy
      // turn is never interrupted merely to open that menu.
      let option = actual[kind]?.options.find(option => option.id === value);
      if (kind === 'mode' && !option && this.modeCatalog?.revision === actual.revision) option = this.modeCatalog.mode?.options.find(option => option.id === value);
      if (!option || option.disabled) throw Error('Cursor 当前不支持这个选项');
      if (actual[kind]?.id === value) return actual;
      this.settingsChange = { id: randomUUID(), kind, value, label: option.label, revision, state: 'waiting' };
      await this.pause(this.paused);
      return { ...actual, pending: this.settingsChange };
    });
  }
  async pauseQueue(stopCurrent = false) {
    this.paused = true;
    await this.serial(async () => { if(this.closed||!this.owned)throw new Error('中介尚未连接');if(stopCurrent)this.stopRequestId=(await this.requests()).find(request=>['sending','accepted'].includes(request.state))?.id;await this.pause(true); });
  }
  private file(id: string) { if (!uuid.test(id)) throw new Error('请求编号无效'); return path.join(this.directory, id + '.json'); }
  private async atomic(file: string, value: unknown) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  }
  private async save(request: CursorFileRequest) { await this.atomic(this.file(request.id), request); }
  private assertBound(request: CursorFileRequest) {
    if (request.version !== 1 || !uuid.test(request.id) || request.nativeId !== this.binding.nativeId || !samePath(request.cwd, this.binding.cwd) || typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 200 * 1024 || !['queued', 'sending', 'accepted', 'completed', 'aborted', 'error', 'uncertain', 'cancelled'].includes(request.state)) throw new Error('请求不属于关联的原生会话');
  }
  async requests() {
    const result: CursorFileRequest[] = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith('.json') || !uuid.test(name.slice(0, -5))) continue;
      const file = this.file(name.slice(0, -5)), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('请求文件不可用');
      const request = JSON.parse(await fs.readFile(file, 'utf8')) as CursorFileRequest;
      this.assertBound(request); result.push(request);
    }
    return result.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async start() {
    if (!uuid.test(this.binding.nativeId) || !path.isAbsolute(this.binding.cwd) || !path.isAbsolute(this.directory)) throw new Error('原生会话绑定无效');
    await fs.mkdir(this.directory, { recursive: true });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new Error('中介目录不能使用符号链接');
    const ownerFile = path.join(this.directory, 'owner.lock');
    try { const file = await fs.open(ownerFile, 'wx', 0o600); try { await file.writeFile(JSON.stringify({ owner: this.owner, pid: process.pid })); } finally { await file.close(); } }
    catch {
      const previous = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
      if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('原生会话锁无法确认');
      try { process.kill(previous.pid, 0); throw new Error('原生会话已有中介进程，请使用原连接'); }
      catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      // Reaping is guarded; a second reaper never removes a successor's lease.
      const guard = await fs.open(path.join(this.directory, 'owner.reap'), 'wx', 0o600);
      try {
        const current = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
        if (current.owner !== previous.owner) throw new Error('原生会话锁已更换');
        await fs.unlink(ownerFile);
        const file = await fs.open(ownerFile, 'wx', 0o600); try { await file.writeFile(JSON.stringify({ owner: this.owner, pid: process.pid })); } finally { await file.close(); }
      } finally { await guard.close(); await fs.unlink(path.join(this.directory, 'owner.reap')); }
    }
    this.owned = true;
    try {
      const control = await fs.readFile(path.join(this.directory, 'control.json'), 'utf8').then(JSON.parse, error => { if (error.code !== 'ENOENT') throw error; });
      if (control) {
        if (control.version !== 1 || control.nativeId !== this.binding.nativeId || !samePath(control.cwd, this.binding.cwd) || typeof control.paused !== 'boolean') throw new Error('等待队列状态与会话不匹配');
        this.paused = control.paused;
        this.stopRequestId = typeof control.stopRequestId === 'string' && uuid.test(control.stopRequestId) ? control.stopRequestId : undefined;
        if (control.settingsChange) {
          const change = control.settingsChange;
          if (!uuid.test(change.id) || !['model','mode','permission'].includes(change.kind) || typeof change.value !== 'string' || typeof change.revision !== 'string') throw Error('原生设置更改记录无效');
          this.settingsChange = { ...change, state: 'error', error: '上次设置更改尚未确认，请核对 Cursor 后重新选择，或沿用当前设置' };
        }
      }
      for (const request of await this.requests()) {
        if (request.state === 'sending') { request.state = 'uncertain'; request.error = '上次发送结果未确认，请核对原生窗口；不会重复发送'; await this.save(request); }
        if (request.state === 'uncertain') await this.pause(true);
      }
      this.timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 500); this.timer.unref(); await this.refresh();
    } catch (error) { await this.close(); throw error; }
  }
  async enqueue(text: string, id: string = randomUUID()) {
    return this.serial(async () => {
    if (this.closed || !this.owned) throw new Error('中介尚未连接');
    const request: CursorFileRequest = { version: 1, id, ...this.binding, text, state: 'queued', createdAt: new Date().toISOString() };
    this.assertBound(request);
    const previous = await fs.readFile(this.file(id), 'utf8').then(value => JSON.parse(value) as CursorFileRequest, error => { if (error.code !== 'ENOENT') throw error; });
    if (previous) { this.assertBound(previous); if (signature(previous) !== signature(request)) throw new Error('同一请求编号不能重复用于不同内容'); return previous; }
    const requests = await this.requests();
    if (requests.filter(value => ['queued', 'sending', 'accepted'].includes(value.state)).length >= 32) throw new Error('等待队列已满');
    request.sequence = Math.max(0, ...requests.map(value => value.sequence ?? 0)) + 1;
    await this.save(request);
    void this.refresh(); return request;
    });
  }
  async cancel(id: string, text?: string) {
    return this.serial(async () => {
    if(this.closed||!this.owned)throw new Error('中介尚未连接');
    const request = (await this.requests()).find(value => value.id === id);
    if (!request && text !== undefined) {
      const tombstone:CursorFileRequest={version:1,id,...this.binding,text,createdAt:new Date().toISOString(),state:'cancelled'};
      this.assertBound(tombstone);await this.save(tombstone);return true;
    }
    if (!request || request.state !== 'queued') return false;
    request.state = 'cancelled'; await this.save(request); return true;
    });
  }
  async resume() { await this.serial(async () => { if (this.closed || !this.owned) throw new Error('中介尚未连接'); if ((await this.requests()).some(request => request.state === 'uncertain')) throw new Error('先核对未确认的发送，再恢复等待队列'); await this.pause(false); }); await this.refresh(); }
  async reconcile(id: string, nativeMessageId?: string) {
    await this.serial(async () => {
      if(this.closed||!this.owned)throw new Error('中介尚未连接');
      const request = (await this.requests()).find(value => value.id === id);
      if (!request || request.state !== 'uncertain') throw new Error('此请求不需要核对');
      if (nativeMessageId) {
        const history = (this.options.readHistory || readCursorDesktopHistory)(this.database, this.binding.nativeId, this.binding.cwd);
        if (!cursorRequestCandidateIds(request,history).includes(nativeMessageId)) throw new Error('未找到与请求匹配的新原生消息');
        request.nativeMessageId = nativeMessageId; request.state = 'accepted'; request.error = undefined;
      } else { request.state = 'cancelled'; request.error = '用户已核对，不再发送此请求'; }
      await this.save(request);
    });
  }
  async view() { return { nativeId: this.binding.nativeId, nativeStatus: this.nativeStatus, paused: this.paused, current: this.current, error: this.lastError, history: this.state, settings: this.settings ? { ...this.settings, pending: this.settingsChange } : undefined, requests: await this.requests() }; }
  refresh(): Promise<void> {
    if (this.closed || !this.owned) return Promise.resolve();
    if (this.pendingRefresh) return this.pendingRefresh;
    const job = this.poll(); this.pendingRefresh = job;
    void job.finally(() => { if (this.pendingRefresh === job) this.pendingRefresh = undefined; });
    return job;
  }
  private async poll() {
    this.polling = true;
    try {
      this.state = (this.options.readHistory || readCursorDesktopHistory)(this.database, this.binding.nativeId, this.binding.cwd);
      const observation = await this.client.snapshot(this.binding.nativeId, this.binding.cwd);
      if (this.closed) return;
      if (observation.sessionId !== this.binding.nativeId) throw new Error('原生窗口会话已改变');
      this.nativeStatus = observation.status;
      this.settings = observation.settings;
      const stable = this.stableCheckpoint === this.state.checkpointSha256;
      this.stableCheckpoint = this.state.checkpointSha256;
      const terminalKey = [observation.status, this.state.status, this.state.checkpointSha256, this.state.bubbles.length].join(':');
      const now = (this.options.now || Date.now)();
      if (observation.status === 'generating') this.terminalObservation = undefined;
      else if (this.terminalObservation?.key !== terminalKey) this.terminalObservation = { key: terminalKey, since: now };
      const terminalStable = !!this.terminalObservation && now - this.terminalObservation.since >= 1500;
      this.lastError = undefined;
      if (this.state.issues.some(issue => issue.kind !== 'empty-native-checkpoint')) { this.lastError = 'Cursor 原生历史尚未完整保存，等待保存后继续'; return; }
      // Manual/automatic native compaction has its own saved bubble. Its
      // composer can briefly look idle while the checkpoint is still changing.
      // That is neither a native Stop nor permission to dispatch another turn.
      const lastBubble = this.state.bubbles.at(-1);
      if (lastBubble?.capabilityType === 22 && !lastBubble.summarizationAborted) {
        if (!this.state.settled) { this.nativeStatus = 'generating'; return; }
        this.sawNativeRunning = false;
      }
      const requests = await this.requests(), active = requests.find(request => request.state === 'accepted');
      if (active) {
        this.current = active.id;
        const at = this.state.bubbles.findIndex(bubble => bubble.bubbleId === active.nativeMessageId);
        if (at < 0 || observation.status === 'generating') return;
        const following = this.state.bubbles.slice(at + 1), nextUser = following.findIndex(bubble => bubble.type === 1), turn = nextUser < 0 ? following : following.slice(0, nextUser);
        if (stable && terminalStable && this.state.settled && turn.some(bubble => bubble.type === 2 && bubble.text?.trim())) {
          active.state = 'completed'; active.checkpoint = this.state.checkpointSha256; await this.save(active); this.current = undefined;
        } else if (terminalStable && (this.stopRequestId === active.id || this.state.checkpointSha256 !== active.beforeCheckpoint || turn.some(bubble => bubble.errorDetails)) && ['error', 'aborted'].includes(this.state.status) && ['completed', 'none', 'error', 'aborted', 'cancelled'].includes(observation.status)) {
          active.state = turn.some(bubble => bubble.errorDetails) ? 'error' : 'aborted'; active.checkpoint = this.state.checkpointSha256; active.error = active.state === 'error' ? 'Cursor 原生执行失败，请在原生窗口处理' : 'Cursor 原生执行已停止'; await this.save(active); await this.pause(true); this.current = undefined;
        }
        return;
      }
      if (observation.status === 'generating') this.sawNativeRunning = true;
      else if (this.sawNativeRunning && terminalStable) { this.sawNativeRunning = false; if (['aborted', 'error'].includes(this.state.status)) await this.pause(true); }
      if (requests.some(request => ['sending', 'uncertain'].includes(request.state)) || !['completed', 'none', 'aborted', 'error', 'cancelled'].includes(observation.status)) return;
      // Observe every change from either surface. Never apply a cached selection
      // over a newer native edit, and never retry an unacknowledged setting write.
      if (this.settingsChange) {
        await this.serial(async () => {
          const change = this.settingsChange, actual = this.settings;
          if (!change || actual?.state !== 'ready') return;
          if (actual[change.kind]?.id === change.value) { this.settingsChange = undefined; await this.pause(this.paused); return; }
          if (change.state === 'error') return;
          if (change.state === 'confirming') {
            if (now - this.settingsAttemptAt > 3000) { change.state = 'error'; change.error = 'Cursor 未确认此更改，请在原生窗口完成确认，或沿用当前设置'; await this.pause(this.paused); }
            return;
          }
          if (!stable || !terminalStable || !this.state || !this.state.settled && !['aborted','error'].includes(this.state.status)) return;
          if (actual.revision !== change.revision) { change.state = 'error'; change.error = 'Cursor 设置已在另一端改变，请重新选择，或沿用当前设置'; await this.pause(this.paused); return; }
          change.state = 'confirming'; this.settingsAttemptAt = now; await this.pause(this.paused);
          try { await this.client.changeSetting!(this.binding.nativeId, this.binding.cwd, change.kind, change.value, change.revision); }
          catch (error: any) { change.state = 'error'; change.error = error.message || '设置更改结果尚未确认'; await this.pause(this.paused); }
        });
        return;
      }
      if (observation.settings && observation.settings.state !== 'ready') return;
      const next = await this.serial(async () => {
        if (this.closed || this.paused || this.settingsChange) return;
        const queued = (await this.requests()).find(request => request.state === 'queued'); if (!queued) return;
        queued.state = 'sending'; queued.beforeCheckpoint = this.state!.checkpointSha256; queued.beforeBoundary = this.state!.bubbles.at(-1)?.bubbleId; queued.beforeWasEmpty = this.state!.bubbles.length===0;this.current = queued.id; await this.save(queued); return queued;
      });
      if (!next) return;
      try {
        const receipt = await this.client.send(this.binding.nativeId, this.binding.cwd, next.text);
        if (receipt.sessionId !== this.binding.nativeId || !receipt.nativeMessageId) throw new Error('Cursor 送达记录未确认');
        let persisted=false;
        for(let attempt=0;attempt<30;attempt++){
          const history=(this.options.readHistory||readCursorDesktopHistory)(this.database,this.binding.nativeId,this.binding.cwd);
          if(cursorRequestCandidateIds(next,history).includes(receipt.nativeMessageId)){persisted=true;break;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(!persisted)throw new Error('Cursor 原生消息尚未保存，送达状态待核对；不会重发');
        next.nativeMessageId = receipt.nativeMessageId; next.state = 'accepted'; await this.save(next);
      } catch (error: any) { next.state = 'uncertain'; next.error = error.message; await this.save(next); await this.pause(true); }
    } catch (error: any) { this.lastError = error.message || '原生连接暂不可用'; }
    finally { this.polling = false; }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    // Detach only. Retained accepted/uncertain requests are never replayed.
    await this.pendingRefresh;
    await this.mutation;
    this.client.close();
    if (this.owned) {
      const file = path.join(this.directory, 'owner.lock'), lease = JSON.parse(await fs.readFile(file, 'utf8'));
      if (lease.owner === this.owner) await fs.unlink(file);
      this.owned = false;
    }
  }
}
