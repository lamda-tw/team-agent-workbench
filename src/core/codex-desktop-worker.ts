import fs from 'node:fs/promises';
import path from 'node:path';
import { startCodexSharedBackend } from './codex-shared-backend';
import { WebSocketRpc } from './websocket-rpc';
export async function hasNoLoadedThreads(rpc:{request:(method:string,params?:unknown,timeout?:number)=>Promise<any>}) {
  try{const result=await rpc.request('thread/loaded/list',{},5000);return Array.isArray(result?.data)&&result.data.length===0;}catch{return false;}
}
export async function hasNoActiveThreads(rpc:{request:(method:string,params?:unknown,timeout?:number)=>Promise<any>}) {
  try {
    const result = await rpc.request('thread/loaded/list', {}, 5000);
    if (!Array.isArray(result?.data) || result.nextCursor) return false;
    for (const value of result.data) {
      const id = typeof value === 'string' ? value : value?.id;
      if (!id) return false;
      const state = (await rpc.request('thread/read', { threadId: id }, 5000))?.thread?.status?.type;
      if (!['idle', 'notLoaded'].includes(state)) return false;
    }
    return true;
  } catch { return false; }
}
async function main() {
  const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
  let backend:Awaited<ReturnType<typeof startCodexSharedBackend>>|undefined;
  try {
    backend=await startCodexSharedBackend(input);
    if(input.registryFile) {
      if(path.dirname(path.resolve(input.registryFile))!==path.dirname(path.resolve(input.stateDirectory))||path.basename(input.registryFile)!=='active.json')throw new Error('Invalid registry path');
      const pending=input.registryFile+'.'+process.pid+'.tmp';
      await fs.writeFile(pending,JSON.stringify({file:path.join(input.stateDirectory,'bridge.json'),managed:true}),{mode:0o600});await fs.rename(pending,input.registryFile);
    }
    // Shared clients include the desktop. Closing one Workbench never stops others.
    let lastActive=Date.now();
    let checking=false;
    const idle=setInterval(()=>{
      if(backend!.hasClients()){
        lastActive=Date.now();
        if(Date.parse(backend!.descriptor.expiresAt)-Date.now()<60*60*1000)void backend!.renew().catch(()=>{});
        return;
      }
      if(checking||Date.now()-lastActive<15*60*1000)return;
      checking=true;
      void(async()=>{const rpc=new WebSocketRpc(backend!.descriptor.endpoint);let empty=false;
        try{await rpc.request('initialize',{clientInfo:{name:'workbench_idle_probe',version:'1'}});rpc.notify('initialized');empty=await hasNoActiveThreads(rpc);}
        catch{}finally{await rpc.close();await new Promise(resolve=>setTimeout(resolve,150));}
        if(empty&&!backend!.hasClients())await backend!.close();
        else if(Date.parse(backend!.descriptor.expiresAt)-Date.now()<60*60*1000)await backend!.renew();
      })().finally(()=>{checking=false;});
    },30000);idle.unref();
    process.once('SIGINT',()=>void backend!.close());process.once('SIGTERM',()=>void backend!.close());
  }catch{await backend?.close();await fs.writeFile(path.join(input.stateDirectory,'failed.txt'),'Codex 后台启动失败');process.exitCode=1;}
}
if(process.argv[2]?.endsWith('input.json'))void main().catch(()=>{process.exitCode=1});
