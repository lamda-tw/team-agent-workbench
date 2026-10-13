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
  let lostAck = false;
  const server = http.createServer(async (req,res) => {
    const op=req.url?.split('/').at(-1)!; calls.push(op);
    let body='';for await(const chunk of req)body+=chunk;
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
  return {root,session,state,calls,descriptor,lostAck:()=>{lostAck=true;},async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}
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
test('native transport refuses wrong session and concurrent native turns, lost acknowledgements are never retried',async()=>{
  const f=await fixture(),rpc=new CursorNativeRpc(f.session);let acknowledgements=0;
  const prompt={sessionId:f.session.nativeId,prompt:[{type:'text',text:'hello'}]};
  try{
    await rpc.request('initialize');
    await assert.rejects(rpc.request('session/load',{sessionId:randomUUID()}));
    await assert.rejects(rpc.request('session/new'));
    f.state.status='generating';await assert.rejects(rpc.request('session/prompt',prompt),/仍在运行/);assert.equal(f.calls.filter(x=>x==='send').length,0);
    f.state.status='completed';f.lostAck();
    await assert.rejects(rpc.request('session/prompt',prompt,10000,()=>acknowledgements++),/避免重复发送/);
    assert.equal(f.calls.filter(x=>x==='send').length,1);assert.equal(acknowledgements,0);
    f.state.sessionId=randomUUID();await assert.rejects(rpc.snapshot(),/已停止同步/);
  }finally{await rpc.close();await f.close();}
});
test('native transport serializes concurrent prompts and forwards explicit cancellation without clearing history',async()=>{
  const f=await fixture(),rpc=new CursorNativeRpc(f.session);
  try{
    await rpc.request('initialize');
    const prompt={sessionId:f.session.nativeId,prompt:[{type:'text',text:'one'}]};
    const both=await Promise.allSettled([rpc.request('session/prompt',prompt),rpc.request('session/prompt',prompt)]);
    assert.equal(both.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.filter(x=>x==='send').length,1);
    await rpc.request('session/cancel',{sessionId:f.session.nativeId});
    assert.equal(f.calls.filter(x=>x==='stop').length,1);assert.equal(f.state.messages.length,2);
  }finally{await rpc.close();await f.close();}
});
test('production AgentRuntime uses native session without starting a CLI, retains context and external native messages',async()=>{
  const f=await fixture();let done=0,submitted=0;
  const runtime=new AgentRuntime(f.session,'THIS_CLI_MUST_NOT_RUN',{changed(){},event(){},done(){done++;}});
  try{
    await runtime.ensureStarted();assert.equal(runtime.sharedDesktop,true);
    const context:MessageContext={nativeId:f.session.nativeId!,accepted:false,workRecord:false,sourceHashes:{file:'sha'}};
    assert.equal(await runtime.prompt('hello',{userText:'human question',context,submitted:()=>submitted++}),true);
    assert.equal(submitted,1);assert.equal(done,1);assert.equal(f.session.messages.length,2);assert.equal(f.session.messages[0].userText,'human question');assert.equal(f.session.messages[0].context?.accepted,true);
    f.state.status='generating';f.state.messages.push({id:randomUUID(),role:'user',text:'from desktop'});await (runtime.rpc as CursorNativeRpc).snapshot();
    assert.equal(f.session.status,'running');
    f.state.status='completed';f.state.messages.push({id:randomUUID(),role:'assistant',text:'desktop reply'});await (runtime.rpc as CursorNativeRpc).snapshot();
    assert.equal(f.session.status,'idle');assert.equal(done,2);assert.equal(f.session.messages.length,4);
    await runtime.close();assert.equal(f.calls.filter(x=>x==='stop').length,0,'closing workbench does not stop Cursor');
  }finally{await runtime.close();await f.close();}
});
test('native Workbench send ignores CLI login, rejects unsupported settings and reconnects stale account session objects',async()=>{
  const f=await fixture(),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{});
  try{
    await wb.store.init();grantTestWorkspace(wb,f.root);
    const s=await wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct');
    Object.assign(s,{nativeId:f.session.nativeId,cursorNative:f.session.cursorNative});
    wb.requireAuth=async()=>{throw new Error('CLI login must not be checked for native session');};
    (wb as any).availableSessionContext=async(_:AgentSession,text:string)=>({text,sources:[],context:{sourceHashes:{}}});
    (wb as any).adoptLatestProjectBrief=async()=>{};
    assert.equal(await wb.send(s.id,'one'),true);
    const replacement=structuredClone(s);wb.store.sessions=wb.store.sessions.map(item=>item.id===s.id?replacement:item);
    assert.equal(await wb.send(s.id,'two'),true);assert.equal(replacement.messages.length,4);assert.equal(s.messages.length,2);
    await assert.rejects(wb.changeModel(s.id,'model'),/原生窗口/);await assert.rejects(wb.changePermissions(s.id,'full'),/原生窗口/);await assert.rejects(wb.changeNetworkRoute(s.id,'management'),/桌面程序/);await assert.rejects(wb.publishToDesktop(s.id),/已关联/);
    assert.equal(f.calls.filter(x=>x==='send').length,2);
  }finally{await wb.close();await f.close();}
});
