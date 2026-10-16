import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { cursorAgentsPage } from './cursor-agents-page';
import { cursorIdePage } from './cursor-ide-page';
import { cursorIdeSettings } from './cursor-ide-settings';
import type { CursorNativeSettings, CursorSettingKind } from '../shared/cursor-native-settings';
import { fileURLToPath } from 'node:url';
import { sameNativePath } from './native-transcript';
import type { CursorNativeSnapshot } from './cursor-native-rpc';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface CursorDesktopChat { nativeId: string; cwd: string; title: string }
export interface CursorDesktopClient {
  hasWorkspace(cwd: string): Promise<boolean>;
  list(): Promise<CursorDesktopChat[]>;
  create(cwd: string): Promise<CursorDesktopChat>;
  snapshot(id: string, cwd: string): Promise<CursorNativeSnapshot>;
  send(id: string, cwd: string, text: string): Promise<{ submitted: true; sessionId?: string; nativeMessageId?: string }>;
  focus(id: string, cwd: string): Promise<void>;
  stop(id: string, cwd: string): Promise<void>;
  settings?(id: string, cwd: string, kind?: CursorSettingKind): Promise<CursorNativeSettings>;
  changeSetting?(id: string, cwd: string, kind: CursorSettingKind, value: string, revision: string): Promise<void>;
  close(): void;
}

/** One CDP connection per native page. Closing it only detaches the observer. */
export class CursorCdpConnection {
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void>;
  constructor(endpoint: string) {
    this.socket = new WebSocket(endpoint, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    this.ready = new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); this.socket.once('close', () => reject(new Error('Cursor 窗口连接已关闭'))); });
    void this.ready.catch(() => {});
    this.socket.on('message', raw => {
      let value: any; try { value = JSON.parse(raw.toString()); } catch { return; }
      const job = this.pending.get(value.id); if (!job) return;
      this.pending.delete(value.id); clearTimeout(job.timer);
      value.error ? job.reject(new Error('Cursor 窗口操作失败')) : job.resolve(value.result);
    });
    this.socket.on('close', () => { for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Cursor 窗口连接已关闭')); } this.pending.clear(); });
  }
  get closed() { return this.socket.readyState >= WebSocket.CLOSING; }
  async call(method: string, params: object = {}) {
    await this.ready;
    if (this.closed) throw new Error('Cursor 窗口连接已关闭');
    const id = ++this.next;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Cursor 窗口响应超时')); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async evaluate<T>(fn: (arg: any) => T | Promise<T>, arg?: unknown): Promise<T> {
    const result = await this.call('Runtime.evaluate', { expression: `(() => { const __name = fn => fn; return (${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'}); })()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] || 'Cursor 窗口状态不可用');
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

export function cursorWorkspacePath(workspace: any): string | undefined {
  // Multi-root and remote workspaces require a separate explicit mapping; never guess by window title.
  const uri = workspace?.uri;
  if (!uri || typeof uri !== 'object' || uri.scheme !== 'file' || uri.authority || typeof uri.path !== 'string') return;
  try { return fileURLToPath(new URL('file://' + encodeURI(uri.path).replace(/#/g, '%23').replace(/\?/g, '%3F'))); } catch { return; }
}

export class CursorDesktopCdp implements CursorDesktopClient {
  private pages = new Map<string, CursorCdpConnection>();
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private browserEndpoint: string, private surface: 'agents' | 'ide' = 'agents') {
    const url = new URL(browserEndpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/devtools\/browser\/[\w-]+$/.test(url.pathname)) throw new Error('Cursor 连接记录无效');
  }
  private async windows() {
    const url=new URL(this.browserEndpoint);url.protocol='http:';url.pathname='/json/version';
    const version:any=await(await fetch(url,{signal:AbortSignal.timeout(2500),redirect:'error'})).json();
    if(version.webSocketDebuggerUrl!==this.browserEndpoint)throw new Error('Cursor 窗口已经更换，请重新打开联动');
    url.pathname='/json/list';
    const targets:any[]=await(await fetch(url,{signal:AbortSignal.timeout(2500),redirect:'error'})).json();
    const allowed=targets.filter(target=>target.type==='page' && typeof target.url==='string' && /\/workbench(?:\.html|\/)/.test(target.url) && typeof target.webSocketDebuggerUrl==='string');
    for(const [id,page] of this.pages)if(!allowed.some(target=>target.id===id)){page.close();this.pages.delete(id);}
    const result:CursorCdpConnection[]=[];
    const workspaces=new Set<string>();
    for(const target of allowed){
      const endpoint=new URL(target.webSocketDebuggerUrl);
      if(endpoint.protocol!=='ws:'||endpoint.host!==new URL(this.browserEndpoint).host||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!endpoint.pathname.startsWith('/devtools/page/'))throw new Error('Cursor 窗口连接地址无效');
      let page=this.pages.get(target.id);
      if(!page||page.closed){page=new CursorCdpConnection(endpoint.href);this.pages.set(target.id,page);}
      const configuration=await page.evaluate(async()=> { const c=await (window as any).vscode?.context?.resolveConfiguration();return {glass:c?.glass===true,workspace:c?.workspace}; });
      if(this.surface==='ide'&&configuration.glass)throw new Error('请先关闭独立的 Cursor Agents 窗口，联动会话使用普通 IDE 窗口，避免两个后台各自执行');
      if(this.surface==='ide'){
        const directory=cursorWorkspacePath(configuration.workspace);
        if(directory){const key=directory.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();if(workspaces.has(key))throw new Error('同一 Cursor 工作目录打开了多个 IDE 窗口，请保留一个后继续联动');workspaces.add(key);}
      }
      if(this.surface === 'ide' ? !configuration.glass && !!cursorWorkspacePath(configuration.workspace) && !configuration.workspace?.configPath : configuration.glass)result.push(page);
    }
    return result;
  }
  private read(page:CursorCdpConnection,operation:string,details:Record<string,unknown>={}):Promise<any>{
    const adapter = this.surface === 'ide' ? new Function('arg', `return (${cursorIdePage.toString()})(arg, ${cursorIdeSettings.toString()});`) as (arg:any)=>any : cursorAgentsPage;
    return page.evaluate<any>(adapter,{operation,...details});
  }
  settings(id:string,cwd:string,kind?:CursorSettingKind){return this.serial(async()=>{
    const page=await this.target(id,cwd);
    if(kind!=='mode')return this.read(page,'settings',{id,cwd}) as Promise<CursorNativeSettings>;
    const opened=await this.read(page,'settingsOpenMode',{id,cwd});
    try{for(let attempt=0;attempt<20;attempt++){const result=await this.read(page,'settings',{id,cwd});if(result.mode?.options.length)return result as CursorNativeSettings;await pause(100);}throw new Error('Cursor 模式列表暂不可用');}
    finally{if(opened.modeMenuOpened)await this.read(page,'settingsCloseMode',{id,cwd}).catch(()=>{});}
  });}
  changeSetting(id:string,cwd:string,kind:CursorSettingKind,value:string,revision:string){return this.serial(async()=>{
    const page=await this.target(id,cwd);
    if(kind==='mode'){
      const opened=await this.read(page,'settingsOpenMode',{id,cwd});
      try{for(let attempt=0;attempt<20;attempt++){const state=await this.read(page,'settings',{id,cwd});if(state.mode?.options.length){await this.read(page,'settingsChange',{id,cwd,kind,value,revision});return;}await pause(100);}throw Error('Cursor 模式列表暂不可用');}
      finally{if(opened.modeMenuOpened)await this.read(page,'settingsCloseMode',{id,cwd}).catch(()=>{});}
    } else await this.read(page,'settingsChange',{id,cwd,kind,value,revision});
  });}
  async list(){
    const chats:CursorDesktopChat[]=[];
    for(const page of await this.windows())chats.push(...(await this.read(page,'catalog')).chats);
    // The same native ID rendered in multiple windows is not a unique control target.
    return chats.filter(chat=>chats.filter(other=>other.nativeId===chat.nativeId).length===1);
  }
  async hasWorkspace(cwd:string){
    for(const page of await this.windows())if((await this.read(page,'catalog')).workspaces.some((directory:string)=>sameNativePath(directory,cwd)))return true;
    return false;
  }
  private async target(id:string,cwd:string,reveal=false){
    const matches:CursorCdpConnection[]=[];
    for(const page of await this.windows()){
      const catalog=await this.read(page,'catalog');
      const candidates=[...catalog.chats,...(reveal&&this.surface==='ide'?catalog.tabs||[]:[])];
      if(candidates.some((chat:CursorDesktopChat)=>chat.nativeId===id&&sameNativePath(chat.cwd,cwd)))matches.push(page);
    }
    if(matches.length!==1)throw new Error(this.surface === 'ide' ? '请在 Cursor 普通 IDE 中打开关联会话，并保持原工作目录；不能关联重复窗口' : '请在 Cursor Agents 中打开关联会话，并保持原工作目录；不能关联重复窗口');
    return matches[0];
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{const job=this.mutation.then(work,work);this.mutation=job.catch(()=>{});return job;}
  async snapshot(id:string,cwd:string):Promise<CursorNativeSnapshot>{return this.read(await this.target(id,cwd),'snapshot',{id,cwd});}
  focus(id:string,cwd:string){return this.serial(async()=>{
    // On a cold launch the workspace configuration appears before native
    // editor tabs. Retry only identity discovery, never a reveal or send.
    let page:CursorCdpConnection;
    for(let attempt=0;;attempt++){
      try{page=await this.target(id,cwd,true);break;}
      catch(error){if(this.surface!=='ide'||attempt>=49)throw error;await pause(100);}
    }
    await this.read(page,'reveal',{id,cwd});await page.call('Page.bringToFront');
    for(let i=0;i<30;i++){try{await this.read(page,'focus',{id,cwd});return;}catch{await pause(100);}}
    throw new Error(this.surface === 'ide' ? '请在 Cursor 普通 IDE 中打开关联会话' : '请在 Cursor Agents 中打开关联会话');
  });}
  create(cwd:string){return this.serial(async()=>{
    const matches:CursorCdpConnection[]=[];
    for(const page of await this.windows())if((await this.read(page,'catalog')).workspaces.some((directory:string)=>sameNativePath(directory,cwd)))matches.push(page);
    if(matches.length!==1)throw new Error('请在 Cursor Agents 中添加对应本地项目，并关闭重复的项目窗口');
    const page=matches[0];await this.read(page,'canCreate',{cwd});
    let previousIds:string[];
    try{previousIds=(await this.read(page,'create',{cwd})).previousIds;}
    catch{throw Object.assign(new Error('Cursor Agents 新建结果未确认，请在原生窗口核对后关联已有会话'),{code:'CURSOR_CREATE_UNCONFIRMED'});}
    for(let i=0;i<40;i++){
      await pause(150);
      const catalog=await this.read(page,'catalog').catch(()=>undefined);
      const created:CursorDesktopChat[]=(catalog?.chats||[]).filter((chat:CursorDesktopChat)=>sameNativePath(chat.cwd,cwd)&&!previousIds.includes(chat.nativeId));
      if(created.length===1)return created[0];
      if(created.length>1)break;
    }
    throw Object.assign(new Error('Cursor Agents 新建结果未确认，请在原生窗口核对后关联已有会话'),{code:'CURSOR_CREATE_UNCONFIRMED'});
  });}
  send(id:string,cwd:string,text:string){return this.serial(async()=>{
    const page=await this.target(id,cwd),token=randomUUID();
    await this.read(page,'prepareSend',{id,cwd,token});
    try{
      await page.call('Input.insertText',{text});
      await this.read(page,'checkSend',{id,cwd,text,token});
      try{
        // The native button is scoped and clicked in the same renderer task as identity validation.
        // A global Enter could reach a different panel if the user changes focus between CDP calls.
        await this.read(page,'submit',{id,cwd,text,token});
        for(let i=0;i<50;i++){
          await pause(150);
          const receipt=await this.read(page,'receipt',{id,token,cwd,text});
          if(receipt.received)return {submitted:true as const,sessionId:receipt.state.sessionId as string,...(receipt.nativeMessageId ? { nativeMessageId: receipt.nativeMessageId as string } : {})};
        }
      }catch{/* A lost acknowledgement must never cause another click or a repeat send. */}
      throw new Error('Cursor 送达状态未确认，请核对原生窗口；不会自动重复发送');
    }finally{await this.read(page,'release',{token}).catch(()=>{});}
  });}
  stop(id:string,cwd:string){return this.serial(async()=>{
    const page=await this.target(id,cwd);await this.read(page,'stop',{id,cwd});
    if(this.surface==='ide'){
      for(let i=0;i<30;i++){const state=await this.read(page,'snapshot',{id,cwd});if(state.status!=='generating')return;await pause(150);}
      throw new Error('停止结果尚未确认，请在 Cursor 原生窗口查看；等待队列已暂停');
    }
  });}
  close(){for(const page of this.pages.values())page.close();this.pages.clear();}
}
