import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { CodexDesktopService, validateManagedBridge } from '../src/core/codex-desktop-service';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import type { AgentSession } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { hasNoLoadedThreads, hasNoActiveThreads } from '../src/core/codex-desktop-worker';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-codex-service-')),sourceHome=path.join(root,'personal'),parent=path.join(root,'managers');
  await fs.mkdir(sourceHome,{recursive:true});
  let healthy=true,starts=0,discovered=0,desktopOpens=0,inputText='',desktopArgs:string[]=[],desktopEnv:NodeJS.ProcessEnv={};
  const route='/rpc/'+'a'.repeat(64);
  const server=http.createServer((req,res)=>{
    if(req.method==='POST'&&req.url===route+'/renew'){
      void(async()=>{const {file}=JSON.parse(await fs.readFile(path.join(parent,'active.json'),'utf8'));const value=JSON.parse(await fs.readFile(file,'utf8'));value.expiresAt=new Date(Date.now()+60000).toISOString();await fs.writeFile(file,JSON.stringify(value));res.writeHead(200);res.end();})().catch(()=>{res.writeHead(503);res.end();});return;
    }
    res.writeHead(healthy&&req.url===route+'/readyz'?200:503);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='ws://127.0.0.1:'+(server.address() as any).port+route;
  const options={sourceHome,parent,running:async()=>false,discover:async()=>{discovered++;return{app:'fake-desktop.exe',executable:'fake-native.exe'};},privateDirectory:async(root:string)=>{await fs.mkdir(root,{recursive:true});return fs.mkdtemp(path.join(root,'run-'));},launchWorker:async(file:string,_env:NodeJS.ProcessEnv)=>{
    starts++;inputText=await fs.readFile(file,'utf8');const input=JSON.parse(inputText);
    await new Promise(resolve=>setTimeout(resolve,30));
    await fs.writeFile(path.join(input.stateDirectory,'bridge.json'),JSON.stringify({version:1,endpoint,sourceHome,executable:'fake-native.exe',pid:process.pid,approvalRoutingVersion:1,expiresAt:new Date(Date.now()+60000).toISOString()}));
  },launchDesktop:async(_target:any,args:string[],env:NodeJS.ProcessEnv)=>{desktopOpens++;desktopArgs=args;desktopEnv=env;}};
  return {root,sourceHome,parent,endpoint,options,counts:()=>({starts,discovered,desktopOpens,inputText,desktopArgs,desktopEnv}),fail:()=>{healthy=false;},revive:()=>{healthy=true;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}
test('desktop sync is available without Beta and preserves the per-session choice across restarts',async()=>{
  const f=await fixture(),service=new CodexDesktopService(f.options),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{},undefined,undefined,undefined,service);
  try{
    await wb.store.init();grantTestWorkspace(wb,f.root);
    const a=await wb.createSession('codex',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct',true);
    const ordinary=await wb.createSession('codex',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct',false);
    assert.equal(a.codexDesktop,true);assert.equal(ordinary.codexDesktop,undefined);
    assert.equal(a.nativeId,undefined);assert.equal(f.counts().starts,0);assert.equal(f.counts().desktopOpens,0);
    await wb.setBetaFeature('sessionHandoff',true);await wb.setBetaFeature('sessionHandoff',false);
    assert.equal(a.codexDesktop,true);
    await wb.store.save();const copy=new Store(wb.store.root);await copy.init();assert.equal(copy.sessions.find(s=>s.id===a.id)!.codexDesktop,true);
    await assert.rejects(wb.changeNetworkRoute(a.id,'management'),/本机网络/);
    await assert.rejects(wb.createSession('codex',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'management',true),/本机网络/);
  }finally{await wb.close();assert.equal(f.counts().starts,0);await f.close();}
});
test('concurrent windows and sessions share exactly one lazy backend; reconnect reuses it without opening a desktop',async()=>{
  const f=await fixture(),first=new CodexDesktopService(f.options),second=new CodexDesktopService(f.options);
  try{
    const a={provider:'codex',purpose:'work',codexDesktop:true,networkRoute:'direct',cwd:f.root} as AgentSession;
    const [s1,s2]=await Promise.all([first.storage(a,'ignored',{HTTPS_PROXY:'TEST_ONLY_SECRET'}),second.storage(a,'ignored',{})]);
    assert.equal(s1.sharedEndpoint,s2.sharedEndpoint);assert.equal(s1.home,f.sourceHome);assert.equal(f.counts().starts,1);assert.equal(f.counts().discovered,1);assert.equal(f.counts().desktopOpens,0);assert(!f.counts().inputText.includes('TEST_ONLY_SECRET'));
    const resumed=new CodexDesktopService(f.options);assert.equal((await resumed.ensure()).endpoint,f.endpoint);assert.equal(f.counts().starts,1);
    const nativeId=randomUUID(),file=path.join(f.sourceHome,'sessions','rollout-'+nativeId+'.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'original');
    assert.equal((await resumed.storage({...a,nativeId},'ignored',{})).resumePath,file);assert.equal(await fs.readFile(file,'utf8'),'original');
    await assert.rejects(resumed.storage({...a,nativeId:randomUUID()},'ignored',{}),/不会另建会话/);assert.equal(f.counts().starts,1);
    f.fail();await assert.rejects(resumed.ensure(),/连接暂时中断/);assert.equal(f.counts().starts,1,'an uncertain backend is never replaced with a second writer');
  }finally{await f.close();}
});
test('native open is explicit, targets its own thread, and does not mutate global settings or credentials',async()=>{
  const f=await fixture(),service=new CodexDesktopService(f.options),before=process.env.CODEX_APP_SERVER_WS_URL;
  try{
    const nativeId=randomUUID();await service.open({provider:'codex',purpose:'work',codexDesktop:true,networkRoute:'direct',nativeId} as AgentSession,'ignored',{});
    assert.equal(f.counts().starts,1);assert.equal(f.counts().desktopOpens,1);assert.deepEqual(f.counts().desktopArgs,['codex://threads/'+nativeId]);assert.equal(f.counts().desktopEnv.CODEX_APP_SERVER_WS_URL,f.endpoint);assert.equal(process.env.CODEX_APP_SERVER_WS_URL,before);
    await assert.rejects(service.storage({provider:'codex',purpose:'work',codexDesktop:true,networkRoute:'management'} as AgentSession,'ignored',{}),/本机网络/);assert.equal(f.counts().starts,1);
  }finally{await f.close();}
});
test('ordinary desktop already running and invalid bridge records fail without closing it or launching another backend',async()=>{
  const f=await fixture(),service=new CodexDesktopService({...f.options,running:async()=>true});
  try{
    await assert.rejects(service.ensure(),/不会自动关闭/);assert.equal(f.counts().starts,0);assert.equal(f.counts().desktopOpens,0);
    const good={version:1 as const,endpoint:f.endpoint,sourceHome:f.sourceHome,executable:'fake-native.exe',pid:process.pid,expiresAt:new Date(Date.now()+60000).toISOString()};
    for(const changes of [{endpoint:'ws://example.test/rpc/'+'a'.repeat(64)},{sourceHome:f.root},{expiresAt:new Date(0).toISOString()},{endpoint:f.endpoint+'?token=secret'},{pid:0}])assert.throws(()=>validateManagedBridge({...good,...changes},f.sourceHome));
    const dir=path.join(f.parent,'run-test');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'bridge.json');await fs.writeFile(file,JSON.stringify({...good,sourceHome:f.root}));await fs.writeFile(path.join(f.parent,'active.json'),JSON.stringify({file}));
    await assert.rejects(service.ensure(),/失效/);assert.equal(f.counts().starts,0);
  }finally{await f.close();}
});
test('a desktop started through another route after backend warmup is not silently treated as linked',async()=>{
  const f=await fixture();let running=false;
  const service=new CodexDesktopService({...f.options,running:async()=>running});
  try{
    await service.ensure();running=true;
    await assert.rejects(service.open({provider:'codex',codexDesktop:true,networkRoute:'direct',nativeId:randomUUID()} as AgentSession,'ignored',{}, {ifClosed:true}),/普通方式运行/);
    assert.equal(f.counts().starts,1);assert.equal(f.counts().desktopOpens,0);
  }finally{await f.close();}
});

test('readiness never launches a process; even a warm backend cannot import while an unrelated ordinary desktop is open',async()=>{
  const f=await fixture();let running=true;
  const service=new CodexDesktopService({...f.options,running:async()=>running,launchDesktop:async(...args)=>{await f.options.launchDesktop(...args);return process.pid;}});
  try{
    assert.equal(await service.readyToPrepare(),false);assert.equal(f.counts().starts,0);assert.equal(f.counts().desktopOpens,0);
    running=false;assert.equal(await service.readyToPrepare(),true);assert.equal(f.counts().starts,0);await service.ensure();
    running=true;assert.equal(await service.readyToPrepare(),false);
    await assert.rejects(service.prepare({provider:'codex',purpose:'work',messages:[]} as unknown as AgentSession,f.root,{}),/普通方式运行/);
    assert.equal(f.counts().starts,1);assert.equal(f.counts().desktopOpens,0);
    running=false;await service.open({provider:'codex',purpose:'work',codexDesktop:true,nativeId:randomUUID()} as AgentSession,'ignored',{});running=true;
    assert.equal(await service.readyToPrepare(),true);assert.equal(f.counts().starts,1);assert.equal(f.counts().desktopOpens,1);
  }finally{await f.close();}
});

test('retry after quitting an ordinary desktop automatically opens the linked thread, then reuses its window',async()=>{
  const f=await fixture();let running=true;
  const service=new CodexDesktopService({...f.options,running:async()=>running,launchDesktop:async(target,args,env)=>{await f.options.launchDesktop(target,args,env);running=true;return process.pid;}});
  const session={provider:'codex',purpose:'work',codexDesktop:true,networkRoute:'direct',cwd:f.root} as AgentSession;
  try{
    await assert.rejects(service.storage(session,'ignored',{}),/首次联动请保存工作并退出 Codex，再重试/);
    assert.equal(f.counts().starts,0);assert.equal(f.counts().desktopOpens,0);
    running=false;await service.storage(session,'ignored',{});
    session.nativeId=randomUUID();
    await service.open(session,'ignored',{}, {ifClosed:true});
    assert.equal(f.counts().desktopOpens,1);assert.deepEqual(f.counts().desktopArgs,['codex://threads/'+session.nativeId]);
    assert.equal(f.counts().desktopEnv.CODEX_APP_SERVER_WS_URL,f.endpoint);
    await service.open(session,'ignored',{}, {ifClosed:true});assert.equal(f.counts().desktopOpens,1,'later sends must not refocus the existing window');
    const {file}=JSON.parse(await fs.readFile(path.join(f.parent,'active.json'),'utf8'));
    const attachment=path.join(path.dirname(file),'desktop.json');const saved=JSON.parse(await fs.readFile(attachment,'utf8'));
    await fs.writeFile(attachment,JSON.stringify({...saved,pid:99999999}));running=false;
    await service.open(session,'ignored',{}, {ifClosed:true});assert.equal(f.counts().desktopOpens,2);
    assert.deepEqual(f.counts().desktopArgs,['codex://threads/'+session.nativeId]);assert.equal(f.counts().starts,1);
  }finally{await f.close();}
});

test('concurrent automatic opens launch once even before desktop process discovery catches up',async()=>{
  const f=await fixture();
  const options={...f.options,launchDesktop:async(target:any,args:string[],env:NodeJS.ProcessEnv)=>{await f.options.launchDesktop(target,args,env);return process.pid;}};
  const first=new CodexDesktopService(options),second=new CodexDesktopService(options);
  const session={provider:'codex',purpose:'work',codexDesktop:true,networkRoute:'direct',nativeId:randomUUID()} as AgentSession;
  try{
    await Promise.all([first.open(session,'ignored',{}, {ifClosed:true}),second.open({...session,nativeId:randomUUID()},'ignored',{}, {ifClosed:true})]);
    assert.equal(f.counts().starts,1);assert.equal(f.counts().desktopOpens,1);
    await second.open(session,'ignored',{});assert.equal(f.counts().desktopOpens,2,'the explicit open button still focuses its requested thread');
  }finally{await f.close();}
});

test('a failed automatic launch can retry on the same backend and native thread',async()=>{
  const f=await fixture();let failed=false;
  const service=new CodexDesktopService({...f.options,launchDesktop:async(target,args,env)=>{if(!failed){failed=true;throw Error('desktop launch failed');}await f.options.launchDesktop(target,args,env);return process.pid;}});
  const session={provider:'codex',purpose:'work',codexDesktop:true,networkRoute:'direct',nativeId:randomUUID()} as AgentSession;
  try{
    await assert.rejects(service.open(session,'ignored',{}, {ifClosed:true}),/desktop launch failed/);
    await service.open(session,'ignored',{}, {ifClosed:true});assert.equal(f.counts().starts,1);assert.equal(f.counts().desktopOpens,1);
    assert.deepEqual(f.counts().desktopArgs,['codex://threads/'+session.nativeId]);
  }finally{await f.close();}
});
test('idle cleanup conservatively preserves loaded threads and uncertain backend state',async()=>{
  for(const data of [[randomUUID()],null,undefined])assert.equal(await hasNoLoadedThreads({request:async()=>({data})}),false);
  assert.equal(await hasNoLoadedThreads({request:async()=>{throw new Error('unknown method');}}),false);
  assert.equal(await hasNoLoadedThreads({request:async method=>{assert.equal(method,'thread/loaded/list');return{data:[]};}}),true);
});
test('expiry renews a healthy backend without restarting its process',async()=>{
  const f=await fixture(),service=new CodexDesktopService(f.options);
  try{
    const original=await service.ensure(),{file}=JSON.parse(await fs.readFile(path.join(f.parent,'active.json'),'utf8'));
    await fs.writeFile(file,JSON.stringify({...original,expiresAt:new Date(0).toISOString()}));
    const renewed=await service.ensure();assert.equal(renewed.endpoint,original.endpoint);assert.equal(renewed.pid,original.pid);assert(Date.parse(renewed.expiresAt)>Date.now());assert.equal(f.counts().starts,1);
  }finally{await f.close();}
});
test('confirmed dead managers recover under one lock, preserve their endpoint, and do not resend turns',async()=>{
  const f=await fixture(),first=new CodexDesktopService(f.options);
  try{
    const original=await first.ensure(),{file}=JSON.parse(await fs.readFile(path.join(f.parent,'active.json'),'utf8'));
    const old={...original,pid:99999999};await fs.writeFile(file,JSON.stringify(old));
    await fs.writeFile(path.join(path.dirname(file),'backend.json'),JSON.stringify({version:1,endpoint:original.endpoint,sourceHome:f.sourceHome,executable:'fake-native.exe',port:12345,token:'b'.repeat(64),process:{pid:99999998,startedAt:'old',executable:'fake-native.exe'}}));
    f.fail();const options={...f.options,launchWorker:async(input:string,env:NodeJS.ProcessEnv)=>{assert.equal(JSON.parse(await fs.readFile(input,'utf8')).recover,true);f.revive();await f.options.launchWorker(input,env);}};
    const [a,b]=await Promise.all([new CodexDesktopService(options).ensure(),new CodexDesktopService(options).ensure()]);
    assert.equal(a.endpoint,original.endpoint);assert.equal(b.endpoint,original.endpoint);assert.equal(f.counts().starts,2);
    assert.equal(f.counts().desktopOpens,0);assert(!f.counts().inputText.includes('turn/start'));
  }finally{await f.close();}
});
test('idle expiry keeps active or uncertain threads alive and may close confirmed idle threads',async()=>{
  for(const state of ['active','systemError',undefined])assert.equal(await hasNoActiveThreads({request:async(method)=>method==='thread/loaded/list'?{data:['thread']}:{thread:{status:{type:state}}}}),false);
  assert.equal(await hasNoActiveThreads({request:async(method)=>method==='thread/loaded/list'?{data:['thread']}:{thread:{status:{type:'idle'}}}}),true);
  assert.equal(await hasNoActiveThreads({request:async()=>({data:[],nextCursor:'more'})}),false);
});
test('opening several linked sessions serializes native launch and preserves the original desktop process identity',async()=>{
  const f=await fixture();let running=false,launched=0,active=0,maximum=0;
  const service=new CodexDesktopService({...f.options,running:async()=>running,launchDesktop:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,20));active--;running=true;return ++launched===1?process.pid:99999999;}});
  try{
    const session={provider:'codex',codexDesktop:true,networkRoute:'direct',nativeId:randomUUID()} as AgentSession;
    await Promise.all([service.open(session,'unused',{}),service.open({...session,nativeId:randomUUID()},'unused',{}),service.open({...session,nativeId:randomUUID()},'unused',{})]);
    assert.equal(maximum,1);assert.equal(launched,3);assert.equal(f.counts().starts,1);
    const {file}=JSON.parse(await fs.readFile(path.join(f.parent,'active.json'),'utf8'));
    assert.equal(JSON.parse(await fs.readFile(path.join(path.dirname(file),'desktop.json'),'utf8')).pid,process.pid);
  }finally{await f.close();}
});
test('a worker can publish the registry after its launching UI exits; another window adopts it without a second start',async()=>{
  const f=await fixture(),service=new CodexDesktopService(f.options);
  try{
    const directory=path.join(f.parent,'run-orphan');await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,'bridge.json');await fs.writeFile(file,JSON.stringify({version:1,endpoint:f.endpoint,sourceHome:f.sourceHome,executable:'fake-native.exe',pid:process.pid,approvalRoutingVersion:1,expiresAt:new Date(Date.now()+60000).toISOString()}));
    await fs.writeFile(path.join(f.parent,'launch.lock'),JSON.stringify({pid:99999999,nonce:'orphan',at:Date.now()-10000,directory}));
    const publish=new Promise<void>(resolve=>setTimeout(()=>{void fs.writeFile(path.join(f.parent,'active.json'),JSON.stringify({file,managed:true})).then(resolve);},100));
    assert.equal((await service.ensure()).endpoint,f.endpoint);await publish;
    assert.equal(f.counts().starts,0);assert.equal(f.counts().discovered,0);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.parent,'launch.lock'),'utf8')).nonce,'orphan','unknown worker ownership is not guessed from a dead UI pid');
  }finally{await f.close();}
});
