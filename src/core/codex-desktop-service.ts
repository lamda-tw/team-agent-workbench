import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as asar from '@electron/asar';
import { privateBridgeDirectory, installedCodexDesktopExecutable } from './codex-shared-backend';
import { sameNativePath } from './native-transcript';
import { findCodexRollout, type CodexStorage } from './codex-storage';
import type { CodexDesktopBridge } from './codex-desktop-bridge';
import type { AgentSession } from '../shared/types';
import { runtimeAssets } from '../shared/runtime-assets';

const run = promisify(execFile), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface CodexDesktopTarget { app: string; executable: string; archive?: string }
export interface CodexDesktopIntegration {
  storage(session: AgentSession, executable: string, env: NodeJS.ProcessEnv): Promise<CodexStorage>;
  open(session: AgentSession, executable: string, env: NodeJS.ProcessEnv): Promise<void>;
}
export async function codexDesktopTarget(): Promise<CodexDesktopTarget> {
  if (process.platform !== 'win32') throw new Error('Codex 桌面联动暂仅支持 Windows');
  const { stdout } = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation'], { windowsHide: true, timeout: 15000 });
  const root = stdout.trim();
  if (!root) throw new Error('尚未安装 Codex 桌面版，请安装后使用桌面联动；普通会话仍可使用');
  return { app: path.join(root,'app','ChatGPT.exe'), archive: path.join(root,'app','resources','app.asar'), executable: await installedCodexDesktopExecutable(path.join(root,'app','resources','codex.exe')) };
}
async function codexDesktopRunning() {
  const { stdout } = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\'" | Where-Object { $_.ExecutablePath -like "*OpenAI.Codex*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object -ExpandProperty ProcessId'], {windowsHide:true,timeout:15000});
  return !!stdout.trim();
}
export function validateManagedBridge(value: CodexDesktopBridge, sourceHome: string) {
  let endpoint: URL; try { endpoint = new URL(value.endpoint); } catch { throw new Error('Codex 联动连接记录不可用'); }
  if(value.version!==1||endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/rpc\/[a-f0-9]{64}$/.test(endpoint.pathname)||!sameNativePath(value.sourceHome,sourceHome)||!Number.isInteger(value.pid)||value.pid<=0||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now())throw new Error('Codex 联动连接已失效，请核对原生客户端后重新连接');
}
async function ready(bridge: CodexDesktopBridge) {
  const url = new URL(bridge.endpoint); url.protocol='http:';url.pathname+='/readyz';
  try{return(await fetch(url,{signal:AbortSignal.timeout(2500),redirect:'error'})).ok;}catch{return false;}
}
const jobs = new Map<string,Promise<CodexDesktopBridge>>();
const desktopJobs = new Map<string,Promise<void>>();
type Options = { sourceHome?: string; parent?: string; workerFile?: string; privateDirectory?: (parent:string) => Promise<string>; discover?: () => Promise<CodexDesktopTarget>; running?: () => Promise<boolean>; launchWorker?: (file:string,env:NodeJS.ProcessEnv) => Promise<void>; launchDesktop?: (target:CodexDesktopTarget,args:string[],env:NodeJS.ProcessEnv) => Promise<number|void> };

/** Lazy, per-personal-profile service. Ordinary Workbench startup never calls ensure(). */
export class CodexDesktopService implements CodexDesktopIntegration {
  readonly sourceHome: string;
  readonly parent: string;
  constructor(private options: Options = {}) {
    this.sourceHome = path.resolve(options.sourceHome || process.env.CODEX_HOME || path.join(os.homedir(),'.codex'));
    const base = path.join(process.env.LOCALAPPDATA || os.tmpdir(),'TeamAgentWorkbench','codex-desktop-beta');
    // Reuse the already verified legacy Beta backend for the default personal profile.
    this.parent = options.parent || (sameNativePath(this.sourceHome,path.join(os.homedir(),'.codex')) ? base : path.join(base,createHash('sha256').update(this.sourceHome.toLowerCase()).digest('hex').slice(0,24)));
  }
  private async active() {
    const activeFile = path.join(this.parent,'active.json');
    let record: {file:string};
    try { record=JSON.parse(await fs.readFile(activeFile,'utf8')); }
    catch(e:any){if(e.code==='ENOENT')return;throw new Error('Codex 联动后台记录不可用，请保留记录后检查');}
    const relative=typeof record.file==='string' ? path.relative(this.parent,record.file) : '..';
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Codex 联动后台记录不属于当前用户');
    let descriptor:CodexDesktopBridge;
    try { descriptor=JSON.parse(await fs.readFile(record.file,'utf8')); }
    catch(e:any){if(e.code==='ENOENT')return;throw new Error('Codex 联动后台记录不可用');}
    validateManagedBridge(descriptor,this.sourceHome);
    if(!await ready(descriptor))throw new Error('Codex 共享后台无法连接；请核对已有回复后重新连接，不会重复发送');
    return descriptor;
  }
  async ensure(env:NodeJS.ProcessEnv={}):Promise<CodexDesktopBridge> {
    const key=path.resolve(this.parent).toLowerCase();
    const previous=jobs.get(key);if(previous)return previous;
    const job=this.establish(env);jobs.set(key,job);
    try{return await job;}finally{if(jobs.get(key)===job)jobs.delete(key);}
  }
  private async establish(env:NodeJS.ProcessEnv) {
    const existing=await this.active();if(existing)return existing;
    await fs.mkdir(this.parent,{recursive:true});
    const lockFile=path.join(this.parent,'launch.lock'),nonce=randomUUID(),deadline=Date.now()+45000;
    let lock;
    while(Date.now()<deadline){
      try{lock=await fs.open(lockFile,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,nonce,at:Date.now()}));break;}
      catch(e:any){
        if(e.code!=='EEXIST')throw e;
        const current=await this.active();if(current)return current;
        try{
          const saved=JSON.parse(await fs.readFile(lockFile,'utf8'));let alive=true;try{process.kill(saved.pid,0);}catch{alive=false;}
          // Once a worker might exist, only its published registry or an explicit
          // failed-start record can justify recovery. A dead UI is not proof.
          const relative=saved.directory&&path.relative(this.parent,saved.directory);
          const owned=relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);
          const failed=owned&&await fs.stat(path.join(saved.directory,'failed.txt')).catch(()=>undefined);
          if(!alive&&Date.now()-saved.at>5000&&(!saved.directory||failed)) {
            const reaperFile=lockFile+'.reap';let reaper;
            try{reaper=await fs.open(reaperFile,'wx',0o600);
              const latest=JSON.parse(await fs.readFile(lockFile,'utf8'));
              if(latest.nonce===saved.nonce)await fs.rm(lockFile,{force:true});
            }catch(e:any){if(e.code!=='EEXIST'&&e.code!=='ENOENT')throw e;}
            finally{if(reaper){await reaper.close();await fs.rm(reaperFile,{force:true});}}
            continue;
          }
        }catch{}
        await pause(150);
      }
    }
    if(!lock)throw new Error('Codex 后台仍在启动，请稍后重试；输入已保留');
    try {
      const prior=await this.active();if(prior)return prior;
      // Never close a user's desktop or create another writer beside its ordinary backend.
      if(await (this.options.running||codexDesktopRunning)())throw new Error('Codex 当前以普通方式运行。首次联动请保存工作并退出 Codex，再重试；不会自动关闭你的聊天');
      const target=await (this.options.discover||codexDesktopTarget)();
      const directory=await(this.options.privateDirectory||privateBridgeDirectory)(this.parent),inputFile=path.join(directory,'input.json');
      await fs.writeFile(lockFile,JSON.stringify({pid:process.pid,nonce,at:Date.now(),directory}),{mode:0o600});
      await fs.writeFile(inputFile,JSON.stringify({executable:target.executable,sourceHome:this.sourceHome,cwd:this.sourceHome,stateDirectory:directory,registryFile:path.join(this.parent,'active.json')}),{mode:0o600});
      await fs.mkdir(this.sourceHome,{recursive:true});
      const worker=this.options.workerFile || path.join(__dirname,runtimeAssets,'codex-desktop-worker.cjs');
      if(this.options.launchWorker)await this.options.launchWorker(inputFile,env);
      else {
        await fs.access(worker);
        const child=spawn(process.execPath,[worker,inputFile],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,...env,ELECTRON_RUN_AS_NODE:process.versions.electron?'1':undefined,CODEX_APP_SERVER_WS_URL:undefined,WORKBENCH_CODEX_DESKTOP_BRIDGE:undefined}});
        await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      }
      const file=path.join(directory,'bridge.json');
      while(Date.now()<deadline){
        if(await fs.stat(path.join(directory,'failed.txt')).catch(()=>undefined))throw new Error('Codex 共享后台启动失败，请检查安装与本机网络；输入已保留');
        let bridge:CodexDesktopBridge|undefined;
        try{bridge=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
        if(bridge){validateManagedBridge(bridge,this.sourceHome);if(!await ready(bridge))throw new Error('Codex 后台尚未就绪，请稍后重试');
          const temp=path.join(this.parent,'active.'+nonce+'.tmp');await fs.writeFile(temp,JSON.stringify({file,managed:true}),{mode:0o600});await fs.rename(temp,path.join(this.parent,'active.json'));return bridge;
        }
        await pause(150);
      }
      throw new Error('Codex 共享后台启动超时，请稍后重试；输入已保留');
    }finally{await lock.close();const saved=await fs.readFile(lockFile,'utf8').then(JSON.parse).catch(()=>undefined);if(saved?.nonce===nonce)await fs.rm(lockFile,{force:true});}
  }
  async storage(session:AgentSession,_executable:string,env:NodeJS.ProcessEnv) {
    if(session.provider!=='codex'||session.purpose!=='work'||!session.codexDesktop||session.networkRoute==='management')throw new Error('此会话不能使用 Codex 桌面联动；当前联动仅支持本机网络');
    const bridge=await this.ensure(env);
    const resumePath=session.nativeId&&await findCodexRollout(this.sourceHome,session.nativeId);
    if(session.nativeId&&!resumePath)throw new Error('原 Codex 会话记录未找到，已保留会话与输入；不会另建会话');
    return {home:this.sourceHome,sourceHome:this.sourceHome,args:[],env:{CODEX_HOME:this.sourceHome,CODEX_SQLITE_HOME:this.sourceHome},resumePath,sharedEndpoint:bridge.endpoint};
  }
  async open(session:AgentSession,_executable:string,env:NodeJS.ProcessEnv) {
    const key=path.resolve(this.parent).toLowerCase(),previous=desktopJobs.get(key)||Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>this.openWindow(session,env));desktopJobs.set(key,job);
    try{await job;}finally{if(desktopJobs.get(key)===job)desktopJobs.delete(key);}
  }
  private async openWindow(session:AgentSession,env:NodeJS.ProcessEnv) {
    if(!session.codexDesktop||session.provider!=='codex'||session.networkRoute==='management')throw new Error('请先创建启用桌面联动的 Codex 会话');
    const bridge=await this.ensure(env),target=await(this.options.discover||codexDesktopTarget)();
    const record=await fs.readFile(path.join(this.parent,'active.json'),'utf8').then(JSON.parse);
    let attachedPid:number|undefined;
    if(record.managed&&await(this.options.running||codexDesktopRunning)()) {
      const attachment=await fs.readFile(path.join(path.dirname(record.file),'desktop.json'),'utf8').then(JSON.parse).catch(()=>undefined);
      let attached=false;try{if(attachment?.endpointHash===createHash('sha256').update(bridge.endpoint).digest('hex')){process.kill(attachment.pid,0);attached=true;attachedPid=attachment.pid;}}catch{}
      if(!attached)throw new Error('Codex 当前以普通方式运行。请保存并退出后，再点击“在 Codex 中打开”；不会自动关闭你的聊天');
    }
    if(target.archive){const file=asar.listPackage(target.archive,{isPack:false}).find(file=>/application-network-startup-.*\.js$/.test(file));if(!file||!asar.extractFile(target.archive,file.replace(/^[/\\]/,'')).toString().includes('CODEX_APP_SERVER_WS_URL'))throw new Error('当前 Codex 桌面版不支持此联动入口，请更新后再试');}
    const environment={...process.env,...env,CODEX_APP_SERVER_WS_URL:bridge.endpoint,CODEX_APP_SERVER_FORCE_CLI:undefined,ELECTRON_RUN_AS_NODE:undefined};
    const args=session.nativeId?['codex://threads/'+session.nativeId]:[];
    let launchedPid:number|void;
    if(this.options.launchDesktop)launchedPid=await this.options.launchDesktop(target,args,environment);
    else {const child=spawn(target.app,args,{detached:true,windowsHide:true,stdio:'ignore',env:environment});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();launchedPid=child.pid;}
    const pid=attachedPid||launchedPid;
    if(pid)await fs.writeFile(path.join(path.dirname(record.file),'desktop.json'),JSON.stringify({pid,endpointHash:createHash('sha256').update(bridge.endpoint).digest('hex')}),{mode:0o600});
  }
}
