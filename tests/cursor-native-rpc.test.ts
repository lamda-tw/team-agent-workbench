import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { CursorNativeRpc, cursorNativeDescriptor, mergeCursorNativeMessages, type CursorNativeSnapshot } from '../src/core/cursor-native-rpc';
import { AgentRuntime } from '../src/core/agents';
import { Workbench } from '../src/core/workbench';
import { sessionContext } from '../src/core/session-context';
import type { AgentSession, Message, MessageContext } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-native-'));
  const session: AgentSession = { id: randomUUID(), title: 'native', provider: 'cursor', cwd: root, purpose: 'work', networkRoute: 'direct', createdAt: new Date().toISOString(), status: 'idle', messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root,'handoff.md'), nativeId: randomUUID(), cursorNative: { descriptorFile: path.join(root,'bridge.json') } };
  const state: CursorNativeSnapshot = { sessionId: session.nativeId!, status: 'completed', messages: [] };
  const calls: string[] = [];
  let lostAck = false, unavailable = false;
  const server = http.createServer(async (req,res) => {
    const op=req.url?.split('/').at(-1)!; calls.push(op);
    let body='';for await(const chunk of req)body+=chunk;
    if (op === 'snapshot' && unavailable) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({message:'Cursor 关联面板已关闭'})); return; }
    if(op==='send') {
      const text=JSON.parse(body).text;
      state.messages.push({id:randomUUID(),role:'user',text},{id:randomUUID(),role:'assistant',text:'REPLY:'+text});
      if(lostAck){res.destroy();return;}
    }
    if(op==='stop')state.status='aborted';
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(op==='snapshot'?state:op==='send'?{submitted:true}:{}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const descriptor={version:1,endpoint:'http://127.0.0.1:'+(server.address() as any).port+'/native/'+'a'.repeat(64),sessionId:session.nativeId,workspace:root,expiresAt:new Date(Date.now()+60000).toISOString()};
  await fs.writeFile(session.cursorNative!.descriptorFile,JSON.stringify(descriptor));
  return {root,session,state,calls,descriptor,lostAck:()=>{lostAck=true;},unavailable:(value:boolean)=>{unavailable=value;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}

test('an externally started turn loses its connection visibly and resumes the same native conversation without resending',async()=>{
  const f=await fixture();let done=0,authFailures=0;
  f.state.status='generating';f.state.messages.push({id:'user',role:'user',text:'native task'});
  const runtime=new AgentRuntime(f.session,'CLI_MUST_NOT_RUN',{changed(){},event(){},done(){done++;},authFailed(){authFailures++;}});
  try{
    await runtime.ensureStarted();const originalId=f.session.nativeId;assert.equal(f.session.status,'running');assert.equal(f.session.desktopSyncState,'connected');
    f.unavailable(true);await assert.rejects((runtime.rpc as CursorNativeRpc).snapshot(),/面板已关闭/);
    assert.equal(f.session.status,'error');assert.equal(f.session.desktopSyncState,'disconnected');assert.equal(f.session.cliConnection?.state,'failed');assert.equal(f.session.messages[0].text,'native task');assert.equal(authFailures,0);
    f.unavailable(false);f.state.status='completed';f.state.messages.push({id:'reply',role:'assistant',text:'native result'});
    await (runtime.rpc as CursorNativeRpc).snapshot();assert.equal(f.session.status,'idle');assert.equal(f.session.desktopSyncState,'connected');assert.equal(f.session.error,undefined);assert.equal(f.session.nativeId,originalId);assert.equal(done,1);
    assert.equal(f.calls.filter(call=>['send','stop'].includes(call)).length,0);assert.equal(f.session.messages.length,2);
  }finally{await runtime.close();await f.close();}
});

test('idle native sessions also show disconnects and reconnect even when their snapshot is unchanged',async()=>{
  const f=await fixture(),runtime=new AgentRuntime(f.session,'CLI_MUST_NOT_RUN',{changed(){},event(){},done(){}});
  try{
    await runtime.ensureStarted();f.unavailable(true);await assert.rejects((runtime.rpc as CursorNativeRpc).snapshot());
    assert.equal(f.session.desktopSyncState,'disconnected');assert.equal(f.session.status,'error');
    f.unavailable(false);await (runtime.rpc as CursorNativeRpc).snapshot();assert.equal(f.session.desktopSyncState,'connected');assert.equal(f.session.status,'idle');assert.equal(f.session.error,undefined);
  }finally{await runtime.close();await f.close();}
});

test('a native model error stays visible across a reconnect and never changes CLI account state',async()=>{
  const f=await fixture();let authFailures=0;
  const runtime=new AgentRuntime(f.session,'CLI_MUST_NOT_RUN',{changed(){},event(){},done(){},authFailed(){authFailures++;}});
  try{
    await runtime.ensureStarted();f.state.status='generating';await (runtime.rpc as CursorNativeRpc).snapshot();
    f.state.status='error';await (runtime.rpc as CursorNativeRpc).snapshot();assert.equal(f.session.status,'error');assert.match(f.session.error!,/原生会话出现错误/);
    f.unavailable(true);await assert.rejects((runtime.rpc as CursorNativeRpc).snapshot());
    f.unavailable(false);await (runtime.rpc as CursorNativeRpc).snapshot();assert.equal(f.session.status,'error');assert.match(f.session.error!,/原生会话出现错误/);assert.equal(f.session.desktopSyncState,'connected');assert.equal(authFailures,0);
  }finally{await runtime.close();await f.close();}
});

test('binding an already failed native conversation preserves the native error without reporting a CLI login failure',async()=>{
  const f=await fixture();f.state.status='error';let authFailures=0;
  const runtime=new AgentRuntime(f.session,'CLI_MUST_NOT_RUN',{changed(){},event(){},done(){},authFailed(){authFailures++;}});
  try{
    await runtime.ensureStarted();assert.equal(f.session.desktopSyncState,'connected');assert.equal(f.session.status,'error');assert.match(f.session.error!,/原生会话出现错误/);assert.equal(authFailures,0);assert.equal(f.calls.filter(x=>['send','stop'].includes(x)).length,0);
  }finally{await runtime.close();await f.close();}
});
test('native descriptor rejects other identities, paths, routes, expired or remote endpoints with no CLI fallback',async()=>{
  const f=await fixture();
  try{
    assert.equal((await cursorNativeDescriptor(f.session)).sessionId,f.session.nativeId);
    for(const update of [{provider:'codex'},{purpose:'prepare'},{networkRoute:'management'},{nativeId:randomUUID()},{cwd:path.join(f.root,'elsewhere')}])await assert.rejects(cursorNativeDescriptor({...f.session,...update} as AgentSession));
    for(const update of [{endpoint:'http://example.com/native/'+'a'.repeat(64)},{endpoint:f.descriptor.endpoint+'?key=bad'},{sessionId:randomUUID()},{version:2},{workspace:path.join(f.root,'elsewhere')},{expiresAt:'invalid'},{expiresAt:new Date(0).toISOString()}]){
      await fs.writeFile(f.session.cursorNative!.descriptorFile,JSON.stringify({...f.descriptor,...update}));
      await assert.rejects(cursorNativeDescriptor(f.session));
    }
    await fs.rm(f.session.cursorNative!.descriptorFile);
    await assert.rejects(cursorNativeDescriptor(f.session),/失效/);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('visible native transcript merges retain offscreen history and local reference receipts without duplicates or mutation',()=>{
  const context:MessageContext={nativeId:'native',accepted:true,workRecord:false,sourceHashes:{file:'sha'},capabilities:[]};
  const original:Message[]=[{id:'cursor-native:old',role:'assistant',text:'offscreen',createdAt:'old'},{id:'local',role:'user',text:'with references',userText:'question',context,createdAt:'original'}];
  const incoming=[{id:'u',role:'user' as const,text:'with references'},{id:'a',role:'assistant' as const,text:'partial'}];
  const first=mergeCursorNativeMessages(original,incoming);
  const second=mergeCursorNativeMessages(first,[{id:'a',role:'assistant',text:'complete'}]);
  assert.equal(second.length,3);assert.equal(second[0].text,'offscreen');assert.equal(second[1].id,'cursor-native:u');assert.equal(second[1].userText,'question');assert.equal(second[1].context,context);assert.equal(second[2].text,'complete');assert.equal(original[1].id,'local');assert.equal(first[2].text,'partial');
});
test('native beta does not claim to maintain summaries or start background CLI tasks',async()=>{
  const f=await fixture();
  try {const input=sessionContext(f.session,'human question',[]);assert.equal(input.text,'human question');assert.equal(input.context.workRecord,false);}
  finally {await f.close();}
});
test('native view transport refuses every prompt without reading a snapshot, sending or acknowledging',async()=>{
  const f=await fixture(),rpc=new CursorNativeRpc(f.session);let acknowledgements=0;
  try{
    await rpc.request('initialize');const before=f.calls.length;
    await assert.rejects(rpc.request('session/load',{sessionId:randomUUID()}));
    await assert.rejects(rpc.request('session/new'));
    const prompt={sessionId:f.session.nativeId,prompt:[{type:'text',text:'same text'}]};
    const both=await Promise.allSettled([rpc.request('session/prompt',prompt,10000,()=>acknowledgements++),rpc.request('session/prompt',prompt)]);
    assert.equal(both.filter(x=>x.status==='rejected').length,2);assert.equal(f.calls.length,before);assert.equal(acknowledgements,0);assert.equal(f.state.messages.length,0);
    f.state.status='generating';await rpc.request('session/cancel',{sessionId:f.session.nativeId});assert.equal(f.calls.filter(x=>x==='stop').length,1);
  }finally{await rpc.close();await f.close();}
});

test('runtime retains native records and external updates but refuses workbench execution before initialization',async()=>{
  const f=await fixture();let submitted=0;f.state.messages.push({id:'native-user',role:'user',text:'original context'},{id:'native-reply',role:'assistant',text:'native answer'});
  const runtime=new AgentRuntime(f.session,'THIS_CLI_MUST_NOT_RUN',{changed(){},event(){},done(){}});
  try{
    await assert.rejects(runtime.prompt('new task',{userText:'new task',context:{sourceHashes:{},workRecord:false},submitted:()=>submitted++}),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    assert.equal(f.calls.length,0);assert.equal(submitted,0);assert.equal(f.session.messages.length,0);
    await runtime.ensureStarted();assert.equal(f.session.messages.length,2);const id=f.session.nativeId;
    f.state.status='generating';f.state.messages.push({id:'next',role:'user',text:'native continuation'});await (runtime.rpc as CursorNativeRpc).snapshot();assert.equal(f.session.status,'running');
    f.state.status='completed';f.state.messages.push({id:'next-reply',role:'assistant',text:'continued answer'});await (runtime.rpc as CursorNativeRpc).snapshot();assert.equal(f.session.messages.length,4);
    await assert.rejects(runtime.prompt('blocked'),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});assert.equal(f.session.nativeId,id);assert.equal(f.session.messages.length,4);
    assert.equal(f.calls.filter(x=>['send','stop'].includes(x)).length,0);
  }finally{await runtime.close();await f.close();}
});

test('workbench blocks legacy linked sends before auth, context injection, state mutation or CLI execution',async()=>{
  const f=await fixture(),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{});
  try{
    await wb.store.init();grantTestWorkspace(wb,f.root);
    const s=await wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct');
    Object.assign(s,{nativeId:f.session.nativeId,cursorNative:f.session.cursorNative});
    s.messages.push({id:'saved',role:'assistant',text:'preserved',createdAt:new Date().toISOString()});const before=JSON.stringify(s);
    wb.requireAuth=async()=>{throw new Error('CLI login must not be checked');};
    (wb as any).availableSessionContext=async()=>{throw new Error('must not build a replacement context');};
    (wb as any).adoptLatestProjectBrief=async()=>{throw new Error('must not update references on a rejected send');};
    await assert.rejects(wb.send(s.id,'new task'),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    assert.equal(JSON.stringify(s),before);assert.equal(f.calls.length,0);assert.equal((wb as any).runtimes.size,0);
    await assert.rejects(wb.changeModel(s.id,'model'),/原生窗口/);await assert.rejects(wb.changePermissions(s.id,'full'),/原生窗口/);
    await wb.restoreDesktopSync(s.id);assert.equal(s.nativeId,f.session.nativeId);assert.equal(s.desktopSyncState,'connected');assert.equal(f.calls.filter(x=>['send','stop'].includes(x)).length,0);
  }finally{await wb.close();await f.close();}
});
