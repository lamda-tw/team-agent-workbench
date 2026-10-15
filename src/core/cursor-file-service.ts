import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { AgentSession, CursorQueuedRequest } from '../shared/types';
import { CursorDesktopService, type CursorDesktopIntegration, type CursorDesktopOptions } from './cursor-desktop-service';
import type { CursorDesktopClient } from './cursor-desktop-client';
import { CursorFileBridge, cursorRequestCandidateIds } from './cursor-file-bridge';
import { readCursorDesktopHistory } from './cursor-desktop-history';
import { cursorHistoryMessages } from './cursor-history-messages';

/** One native IDE executor, a persistent local mailbox, and an authenticated
 * loopback observation/control endpoint. No CLI, native DB writes or context replay. */
export class CursorFileService implements CursorDesktopIntegration {
  readonly fileBridge = true;
  readonly parent: string;
  private launcher: CursorDesktopService;
  private server?: http.Server;
  private bridges = new Map<string, CursorFileBridge>();
  private entries = new Map<string, { owner: string; session: AgentSession; bridge: CursorFileBridge }>();
  private preparation: Promise<unknown> = Promise.resolve();
  private closed = false;
  private database: string;
  constructor(options: CursorDesktopOptions & { database?: string; readHistory?: typeof readCursorDesktopHistory } = {}) {
    this.parent = options.parent || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TeamAgentWorkbench', 'cursor-ide');
    this.database = options.database || path.join(process.env.APPDATA || '', 'Cursor/User/globalStorage/state.vscdb');
    this.launcher = new CursorDesktopService({ ...options, parent: this.parent, surface: 'ide' });
    this.readHistory = options.readHistory || readCursorDesktopHistory;
  }
  private readHistory: typeof readCursorDesktopHistory;
  async list(cwd: string, launch = false) {
    const chats=(await this.launcher.list(cwd, launch)).filter(chat => !cwd.trim() || path.resolve(chat.cwd).toLowerCase() === path.resolve(cwd).toLowerCase());
    return chats.map(chat=>{try{return{...chat,title:this.readHistory(this.database,chat.nativeId,chat.cwd).title||chat.title};}catch{return chat;}});
  }
  async prepare(session: AgentSession, launch = true, persist?: () => Promise<void>) {
    const job = this.preparation.then(() => this.associate(session, launch, persist));
    this.preparation = job.catch(() => {}); await job;
  }
  private async associate(session: AgentSession, launch: boolean, persist?: () => Promise<void>) {
    if (this.closed || session.closedAt || session.provider !== 'cursor' || session.purpose !== 'work' || session.networkRoute === 'management' || !session.cursorNative?.managed || !/^[0-9a-f-]{36}$/i.test(session.id)) throw Error('此会话不能关联 Cursor 原生窗口');
    if (!session.nativeId) throw Error('请先在 Cursor 普通 IDE 中创建会话，再使用“导入 Cursor 会话”关联');
    const nativeId = session.nativeId, cwd = session.cwd;
    // Existing saved history and a unique visible IDE target must both agree.
    const history = this.readHistory(this.database, nativeId, cwd);
    if (history.issues.some(issue => issue.kind !== 'empty-native-checkpoint')) throw Error('Cursor 原生历史尚未完整保存，请稍后重新连接');
    if(launch)await this.launcher.list(cwd,true);
    const client = await this.launcher.clientFor(cwd, launch);
    // The workspace can exist before Cursor has restored the selected chat.
    // Observe that exact identity while it loads; never create a replacement.
    let observation;
    for (let attempt = 0; ; attempt++) {
      if (this.closed || session.closedAt) throw Error('会话已关闭，未建立关联');
      try { observation = await client.snapshot(nativeId, cwd); break; }
      catch (error) {
        if (!launch || attempt >= 29) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (observation.sessionId !== nativeId) throw Error('Cursor 原生会话身份发生变化');
    if (this.closed || session.closedAt) throw Error('会话已关闭，未建立关联');
    const key = nativeId + '-' + createHash('sha256').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0,16);
    let bridge = this.bridges.get(key);
    if (!bridge) {
      // The launcher owns the shared CDP client; detaching one session must not
      // close the connections of another linked native session.
      const proxy: CursorDesktopClient = {
        hasWorkspace: async directory => (await this.launcher.clientFor(directory,false)).hasWorkspace(directory), list: async () => (await this.launcher.clientFor(cwd,false)).list(), create: async directory => (await this.launcher.clientFor(directory,false)).create(directory),
        snapshot: async (id,directory) => (await this.launcher.clientFor(directory,false)).snapshot(id,directory), send: async (id,directory,text) => (await this.launcher.clientFor(directory,false)).send(id,directory,text),
        focus: async (id,directory) => (await this.launcher.clientFor(directory,false)).focus(id,directory), stop: async (id,directory) => (await this.launcher.clientFor(directory,false)).stop(id,directory), close() {},
      };
      bridge = new CursorFileBridge(path.join(this.parent, 'queues', key), { nativeId, cwd }, this.database, proxy, { readHistory: this.readHistory });
      await bridge.start(); this.bridges.set(key, bridge);
    }
    if (!this.server) {
      this.server = http.createServer((request, response) => void this.handle(request, response));
      await new Promise<void>((resolve, reject) => { this.server!.once('error',reject);this.server!.listen(0,'127.0.0.1',resolve); });
      this.server.unref();
    }
    const existing = [...this.entries].find(([,entry]) => entry.owner === session.id && entry.bridge === bridge);
    const token = existing?.[0] || randomBytes(32).toString('hex');
    this.entries.set(token, { owner: session.id, session, bridge });
    const directory = path.join(this.parent, 'bindings'); await fs.mkdir(directory, { recursive:true });
    const file = path.join(directory, session.id + '.json'), temporary = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ version:2, transport:'ide-files-v1', endpoint:`http://127.0.0.1:${(this.server.address() as any).port}/native/${token}`, sessionId:nativeId,workspace:cwd,expiresAt:new Date(Date.now()+365*86400000).toISOString() }), {flag:'wx',mode:0o600});
    await fs.rename(temporary,file);
    session.cursorNative.descriptorFile = file; session.cursorNative.transport = 'ide-files-v1';
    await persist?.();
  }
  private async snapshot(entry: { session: AgentSession; bridge: CursorFileBridge }) {
    const view = await entry.bridge.view(), history = view.history;
    if (!history) throw Error('正在读取 Cursor 原生历史，请稍后重试');
    const messages = cursorHistoryMessages(history);
    const requests: CursorQueuedRequest[] = view.requests.map(request => ({id:request.id,text:request.text,state:request.state,createdAt:request.createdAt,error:request.error,nativeMessageId:request.nativeMessageId,
      ...(request.state==='uncertain'?{candidates:cursorRequestCandidateIds(request,history)}:{})}));
    return { sessionId:history.nativeId, status:view.nativeStatus==='generating'||requests.some(request=>request.state==='accepted'||request.state==='sending')?'generating':history.settled?'completed':view.nativeStatus,
      messages:messages.filter(message=>message.role==='user'||message.role==='assistant').map(message=>({id:message.nativeItemId!,role:message.role,text:message.text})),
      nativeHistory:{nativeId:history.nativeId,messages,checkpointSha256:history.checkpointSha256,issues:history.issues},queue:{paused:view.paused,requests},connectionError:view.error };
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const respond = (status:number,value:unknown) => { response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value)); };
    const match = /^\/native\/([a-f0-9]{64})\/(snapshot|enqueue|cancel|resume|reconcile|stop|focus)$/.exec(request.url||'');
    const entry = match && this.entries.get(match[1]);
    if (request.headers.origin || request.headers.host!==`127.0.0.1:${(this.server?.address() as any)?.port}` || !entry || entry.session.closedAt || this.closed || !match) { respond(403,{});return; }
    const operation=match[2];if(request.method!==(operation==='snapshot'?'GET':'POST')){respond(405,{});return;}
    try {
      let raw='';for await(const chunk of request){raw+=chunk.toString();if(Buffer.byteLength(raw)>220*1024)throw Error('消息过长');}
      const body=raw?JSON.parse(raw):{};
      if(operation==='snapshot'){respond(200,await this.snapshot(entry));return;}
      if(operation==='enqueue'){
        if(typeof body.text!=='string'||typeof body.id!=='string')throw Error('发送内容无效');
        if(/^\s*\/(summarize|compact)(?:\s|$)/i.test(body.text))throw Error('请在 Cursor 原生窗口执行上下文压缩；压缩期间工作台的后续消息会等待');
        const queued=await entry.bridge.enqueue(body.text,body.id);respond(200,{id:queued.id,state:queued.state});return;
      }
      if(operation==='cancel'){respond(200,{ok:true,cancelled:await entry.bridge.cancel(body.id,typeof body.text==='string'?body.text:undefined)});return;}
      else if(operation==='resume')await entry.bridge.resume();
      else if(operation==='reconcile')await entry.bridge.reconcile(body.id,body.nativeMessageId);
      else {const client=await this.launcher.clientFor(entry.session.cwd,false);if(operation==='focus')await client.focus(entry.session.nativeId!,entry.session.cwd);else {await entry.bridge.pauseQueue(true);await client.stop(entry.session.nativeId!,entry.session.cwd);}}
      respond(200,{ok:true});
    }catch(error:any){respond(409,{message:error.message||'Cursor 原生连接暂不可用'});}
  }
  async open(session:AgentSession,persist?:()=>Promise<void>){await this.prepare(session,true,persist);await(await this.launcher.clientFor(session.cwd,false)).focus(session.nativeId!,session.cwd);}
  async release(sessionId:string){for(const[token,entry]of this.entries)if(entry.owner===sessionId){this.entries.delete(token);await entry.bridge.pauseQueue();for(const request of await entry.bridge.requests())if(request.state==='queued')await entry.bridge.cancel(request.id);}}
  async close(){this.closed=true;await this.preparation;await Promise.allSettled([...this.bridges.values()].map(bridge=>bridge.close()));this.bridges.clear();this.entries.clear();this.server?.closeAllConnections();if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));await this.launcher.close();}
}
