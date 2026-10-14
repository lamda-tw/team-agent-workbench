import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CursorDesktopService, cursorAgentsLaunchArgs } from '../src/core/cursor-desktop-service';
import type { CursorDesktopClient } from '../src/core/cursor-desktop-client';
import { CursorNativeRpc, type CursorNativeSnapshot } from '../src/core/cursor-native-rpc';
import type { AgentSession } from '../src/shared/types';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cursor-desktop-'));
  const state: CursorNativeSnapshot = { sessionId: randomUUID(), status: 'completed', messages: [] };
  const calls: string[] = [];
  let unavailable = false, alreadyRunning = false, rejectSend = false, promoteDraft = false;
  const client: CursorDesktopClient = {
    async hasWorkspace(cwd) { return cwd === root; },
    async list() { calls.push('list'); if (unavailable) throw new Error('disconnected'); return [{ nativeId: state.sessionId, cwd: root, title: 'desktop chat' }]; },
    async create(cwd) { assert.equal(cwd,root);calls.push('create');return {nativeId:state.sessionId,cwd,title:'new'}; },
    async snapshot(id, cwd) { assert.equal(id,state.sessionId);assert.equal(cwd,root);return structuredClone(state); },
    async send(id, cwd, text) { assert.equal(id,state.sessionId);assert.equal(cwd,root);calls.push('send');state.messages.push({id:randomUUID(),role:'user',text},{id:randomUUID(),role:'assistant',text:'reply:'+text});if(promoteDraft){state.sessionId=randomUUID();promoteDraft=false;}if(rejectSend)throw new Error('ack lost');return {submitted:true,sessionId:state.sessionId}; },
    async focus(id) { assert.equal(id,state.sessionId);calls.push('focus'); },
    async stop() { calls.push('stop');state.status='aborted'; },
    close() { calls.push('detach'); },
  };
  const options = { parent:path.join(root,'bridge'),privateDirectory:(parent:string)=>fs.mkdtemp(path.join(parent,'run-')), running:async()=>alreadyRunning,launch:async()=>{calls.push('launch');unavailable=false;},discover:async()=> 'ws://127.0.0.1:1234/devtools/browser/test',connect:()=>client };
  const session: AgentSession = {id:randomUUID(),title:'new',provider:'cursor',cwd:root,purpose:'work',networkRoute:'direct',cursorNative:{managed:true,descriptorFile:''},createdAt:new Date().toISOString(),status:'idle',messages:[],approvals:[],sources:[],autoUpload:false,handoffPath:path.join(root,'handoff.md')};
  return { root, state, calls, client, options, session, promote:()=>{promoteDraft=true;}, running:(value:boolean)=>{alreadyRunning=value;}, unavailable:(value:boolean)=>{unavailable=value;}, rejectSend:()=>{rejectSend=true;}, clean:()=>fs.rm(root,{recursive:true,force:true}) };
}

test('the normal launcher explicitly selects Agents Window and retains the full project path',()=>{
  const cwd='D:\\projects\\same name';
  assert.deepEqual(cursorAgentsLaunchArgs(cwd,1234),['--glass','--remote-debugging-address=127.0.0.1','--remote-debugging-port=1234',cwd]);
});

test('unknown native identity is rejected before starting Cursor or creating a substitute Agent',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options);
  try{
    for(const launch of [false,true])await assert.rejects(service.prepare(f.session,launch),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    f.session.cursorNative!.creationUnconfirmed=true;await assert.rejects(service.prepare(f.session),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    assert.equal(f.calls.length,0);assert.equal(f.session.nativeId,undefined);assert.equal(f.session.cursorNative!.descriptorFile,'');
  }finally{await service.close();await f.clean();}
});

test('legacy record viewing restores the same Agent after restart without creating, sending or replacing its identity',async()=>{
  const f=await fixture();let service=new CursorDesktopService(f.options);let rpc:CursorNativeRpc|undefined;
  f.session.nativeId=f.state.sessionId;f.state.messages.push({id:'original-user',role:'user',text:'original context'},{id:'original-reply',role:'assistant',text:'original reply'});
  try{
    await assert.rejects(service.prepare(f.session,false),/尚未打开/);assert.equal(f.calls.length,0);
    await Promise.all([service.prepare(f.session),service.prepare(f.session)]);assert.equal(f.calls.filter(x=>x==='launch').length,1);
    rpc=new CursorNativeRpc(f.session);await rpc.request('initialize');assert.equal((await rpc.snapshot()).messages.length,2);
    await assert.rejects(rpc.request('session/prompt',{sessionId:f.session.nativeId,prompt:[{type:'text',text:'blocked'}]}),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    const prior=f.session.cursorNative!.descriptorFile;
    await rpc.close();await service.close();service=new CursorDesktopService(f.options);await service.prepare(f.session,false);
    assert.notEqual(f.session.cursorNative!.descriptorFile,prior);rpc=new CursorNativeRpc(f.session);assert.equal((await rpc.snapshot()).sessionId,f.state.sessionId);
    await service.open(f.session);assert.ok(f.calls.includes('focus'));assert.equal(f.calls.filter(x=>['create','send','stop'].includes(x)).length,0);
  }finally{await rpc?.close();await service.close();await f.clean();}
});

test('legacy viewing refuses to replace an already open unmanaged Cursor',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options);f.session.nativeId=f.state.sessionId;
  try{
    f.running(true);await assert.rejects(service.prepare(f.session),/保存并退出/);assert.ok(!f.calls.includes('launch'));
    f.running(false);await service.prepare(f.session);f.unavailable(true);f.running(true);await assert.rejects(service.prepare(f.session),/保存并退出/);
    assert.equal(f.calls.filter(x=>x==='launch').length,1);assert.equal(f.calls.filter(x=>x==='create').length,0);
  }finally{await service.close();await f.clean();}
});

test('local observer denies the send endpoint even when its native descriptor and origin are valid',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options);f.session.nativeId=f.state.sessionId;
  try{
    await service.prepare(f.session);const descriptor=JSON.parse(await fs.readFile(f.session.cursorNative!.descriptorFile,'utf8'));
    assert.equal((await fetch(descriptor.endpoint+'/snapshot',{headers:{Origin:'http://example.com'}})).status,403);
    assert.equal((await fetch(descriptor.endpoint+'/send')).status,405);
    const before=JSON.stringify(f.state);const response=await fetch(descriptor.endpoint+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'blocked'})});
    assert.equal(response.status,409);assert.match((await response.json()).message,/共用完整历史和上下文/);assert.equal(JSON.stringify(f.state),before);assert.equal(f.calls.filter(x=>x==='send').length,0);
    service.release(f.session.id);assert.equal((await fetch(descriptor.endpoint+'/snapshot')).status,403);
  }finally{await service.close();await f.clean();}
});

test('unsupported shared-session creation, import and enabling Beta fail without creating workbench records or launching Cursor',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{},undefined,undefined,undefined,undefined,service);
  try{
    await wb.store.init();grantTestWorkspace(wb,f.root);const beforeSessions=JSON.stringify(wb.store.sessions),beforeSettings=JSON.stringify(wb.store.settings);
    await assert.rejects(wb.setBetaFeature('cursorDesktopSync',true),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    await assert.rejects(wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,'ignored','full',false,'direct',true),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    await assert.rejects(wb.linkCursorDesktopSessions([f.state.sessionId],offlineProjectId),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
    assert.equal(JSON.stringify(wb.store.sessions),beforeSessions);assert.equal(JSON.stringify(wb.store.settings),beforeSettings);assert.equal(f.calls.length,0);
    const normal=await wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct');assert.equal(normal.cursorNative,undefined);
    await wb.setBetaFeature('cursorDesktopSync',false);
  }finally{await wb.close();await f.clean();}
});

test('existing workbench associations remain viewable and reopen the original Agent without CLI execution or new messages',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{},undefined,undefined,undefined,undefined,service);
  try{
    await wb.store.init();grantTestWorkspace(wb,f.root);f.state.messages.push({id:'native-user',role:'user',text:'existing task'},{id:'native-reply',role:'assistant',text:'existing response'});
    const s=await wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct');s.nativeId=f.state.sessionId;s.cursorNative={managed:true,descriptorFile:''};s.nativeLive=true;
    wb.requireAuth=async()=>{throw Error('CLI login must not run');};
    await wb.restoreDesktopSync(s.id);assert.equal(s.messages.length,2);assert.equal(s.nativeId,f.state.sessionId);await wb.store.save();await wb.close();
    const nextService=new CursorDesktopService(f.options),next=new Workbench(path.join(f.root,'data'),()=>{},()=>{},undefined,undefined,undefined,undefined,nextService);
    try{
      await next.store.init();grantTestWorkspace(next,f.root);const restored=next.store.sessions.find(value=>value.id===s.id)!;
      await next.restoreDesktopSync(restored.id);assert.equal(restored.nativeId,s.nativeId);assert.equal(restored.messages.length,2);
      await assert.rejects(next.send(restored.id,'blocked'),{code:'CURSOR_SHARED_SESSION_UNAVAILABLE'});
      const calls=f.calls.length;await next.restoreDesktopSync(restored.id);assert.equal(f.calls.length,calls);
      assert.equal(f.calls.filter(x=>['send','create','stop'].includes(x)).length,0);
      const noNative={...restored,id:randomUUID(),nativeId:undefined};next.store.sessions.push(noNative);await assert.rejects(next.restoreDesktopSync(noNative.id),/已关联/);
    }finally{await next.close();}
  }finally{await wb.close();await f.clean();}
});
