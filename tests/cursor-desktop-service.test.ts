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

test('first-send promotion persists the new native ID and renews its descriptor before acknowledging, including restart recovery',async()=>{
  const f=await fixture();let service=new CursorDesktopService(f.options);let rpc:CursorNativeRpc|undefined;
  const saved=path.join(f.root,'saved-session.json');
  try {
    await service.prepare(f.session,true,async()=>{f.calls.push('persist');await fs.writeFile(saved,JSON.stringify(f.session));});
    const draftId=f.session.nativeId;
    f.promote();rpc=new CursorNativeRpc(f.session);
    await rpc.request('session/prompt',{sessionId:draftId,prompt:[{type:'text',text:'promote'}]});
    assert.notEqual(f.session.nativeId,draftId);
    const persisted:AgentSession=JSON.parse(await fs.readFile(saved,'utf8'));
    assert.equal(persisted.nativeId,f.state.sessionId);
    assert.equal(JSON.parse(await fs.readFile(f.session.cursorNative!.descriptorFile,'utf8')).sessionId,f.state.sessionId);
    assert.equal(f.calls.filter(x=>x==='persist').length,1);
    await rpc.close();await service.close();service=new CursorDesktopService(f.options);
    await service.prepare(persisted,false);rpc=new CursorNativeRpc(persisted);
    assert.equal((await rpc.snapshot()).messages[0].text,'promote');
    assert.equal(f.calls.filter(x=>x==='create').length,1);assert.equal(f.calls.filter(x=>x==='send').length,1);
  } finally {await rpc?.close();await service.close();await f.clean();}
});

test('normal Cursor desktop service creates once, confirms delivery, recovers after Workbench restart without launching or replacing the native chat', async()=>{
  const f=await fixture();let service=new CursorDesktopService(f.options);let rpc:CursorNativeRpc|undefined;
  try {
    await assert.rejects(service.prepare(f.session,false),/尚未打开/);
    assert.equal(f.calls.length,0);
    await Promise.all([service.prepare(f.session),service.prepare(f.session)]);
    assert.equal(f.calls.filter(x=>x==='create').length,1);assert.equal(f.calls.filter(x=>x==='launch').length,1);
    rpc=new CursorNativeRpc(f.session);await rpc.request('initialize');
    await rpc.request('session/prompt',{sessionId:f.session.nativeId,prompt:[{type:'text',text:'hello'}]});
    assert.equal(f.calls.filter(x=>x==='send').length,1);
    const prior=f.session.cursorNative!.descriptorFile;
    await rpc.close();await service.close();assert.ok(!f.calls.includes('stop'));
    service=new CursorDesktopService(f.options);await service.prepare(f.session,false);
    assert.notEqual(prior,f.session.cursorNative!.descriptorFile);
    assert.equal(f.calls.filter(x=>x==='launch').length,1);assert.equal(f.calls.filter(x=>x==='create').length,1);
    rpc=new CursorNativeRpc(f.session);const snapshot=await rpc.snapshot();assert.equal(snapshot.messages.length,2);
    await service.open(f.session);assert.ok(f.calls.includes('focus'));
  } finally {await rpc?.close();await service.close();await f.clean();}
});

test('Cursor refuses to replace an already open unmanaged app, and never retries a send with an uncertain acknowledgement', async()=>{
  const f=await fixture(), service=new CursorDesktopService(f.options);let rpc:CursorNativeRpc|undefined;
  try {
    f.running(true);await assert.rejects(service.prepare(f.session),/保存并退出/);assert.ok(!f.calls.includes('launch'));
    f.running(false);await service.prepare(f.session);rpc=new CursorNativeRpc(f.session);f.rejectSend();
    await assert.rejects(rpc.request('session/prompt',{prompt:[{type:'text',text:'once'}]}),/ack lost/);
    assert.equal(f.calls.filter(x=>x==='send').length,1);
    f.unavailable(true);f.running(true);await assert.rejects(service.prepare(f.session),/保存并退出/);
    assert.equal(f.calls.filter(x=>x==='launch').length,1);assert.equal(f.calls.filter(x=>x==='create').length,1);
  } finally {await rpc?.close();await service.close();await f.clean();}
});

test('local Cursor bridge scopes paths and methods, denies browser origins and revokes closed session access', async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options);
  try {
    await service.prepare(f.session);const descriptor=JSON.parse(await fs.readFile(f.session.cursorNative!.descriptorFile,'utf8'));
    assert.equal((await fetch(descriptor.endpoint+'/snapshot',{headers:{Origin:'http://example.com'}})).status,403);
    assert.equal((await fetch(descriptor.endpoint+'/send')).status,405);
    assert.equal((await fetch(descriptor.endpoint.replace(/native\/.+/, 'native/'+'0'.repeat(64))+'/snapshot')).status,403);
    assert.equal((await fetch(descriptor.endpoint+'/snapshot')).status,200);
    service.release(f.session.id);assert.equal((await fetch(descriptor.endpoint+'/snapshot')).status,403);
    assert.ok(!f.calls.includes('send'));assert.ok(!f.calls.includes('stop'));
  }finally{await service.close();await f.clean();}
});

test('formal Workbench creation and desktop import use Cursor desktop identity without CLI login, deduplicate and retain associations when Beta is disabled',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{},undefined,undefined,undefined,undefined,service);
  try {
    await wb.store.init();grantTestWorkspace(wb,f.root);
    await assert.rejects(wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct',true),/Beta/);
    await wb.setBetaFeature('cursorDesktopSync',true);
    const s=await wb.createSession('cursor',f.root,offlineProjectId,'work',undefined,'ignored','full',false,'direct',true);
    assert.equal(s.cursorNative?.managed,true);assert.equal(s.codexDesktop,undefined);assert.equal(s.nativeId,undefined);assert.equal(f.calls.length,0);
    wb.requireAuth=async()=>{throw new Error('CLI login must not run');};
    (wb as any).availableSessionContext=async(_:AgentSession,text:string)=>({text,sources:[],context:{sourceHashes:{}}});
    (wb as any).adoptLatestProjectBrief=async()=>{};
    const draftId=f.state.sessionId;f.promote();
    assert.equal(await wb.send(s.id,'from workbench'),true);assert.equal(s.nativeId,f.state.sessionId);
    assert.notEqual(s.nativeId,draftId);assert.equal(s.messages.find(m=>m.role==='user')?.context?.nativeId,s.nativeId);
    await assert.rejects(wb.linkCursorDesktopSessions([s.nativeId!],offlineProjectId),/已关联/);
    await wb.setBetaFeature('cursorDesktopSync',false);assert.equal(await wb.send(s.id,'still linked'),true);
    await wb.closeSession(s.id);assert.ok(!f.calls.includes('stop'));
    const fresh=new CursorDesktopService(f.options);await fresh.close();
  } finally {await wb.close();await f.clean();}
});

test('existing desktop chat import hydrates visible history and never creates a replacement session',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options),wb=new Workbench(path.join(f.root,'data'),()=>{},()=>{},undefined,undefined,undefined,undefined,service);
  try {
    await wb.store.init();grantTestWorkspace(wb,f.root);await wb.setBetaFeature('cursorDesktopSync',true);
    await service.list(f.root,true);f.state.messages.push({id:'earlier',role:'user',text:'native context'});
    const [s]=await wb.linkCursorDesktopSessions([f.state.sessionId],offlineProjectId);
    assert.equal(s.nativeId,f.state.sessionId);assert.equal(s.messages[0].text,'native context');assert.ok(!f.calls.includes('create'));
    const catalog=await wb.listCursorDesktopSessions('');assert.equal(catalog.sessions[0].linkedSessionId,s.id);
  }finally{await wb.close();await f.clean();}
});

test('an uncertain native creation is remembered and a later attempt cannot create a duplicate chat',async()=>{
  const f=await fixture(),service=new CursorDesktopService(f.options);
  f.client.create=async()=>{f.calls.push('create');throw Object.assign(new Error('unconfirmed'),{code:'CURSOR_CREATE_UNCONFIRMED'});};
  try {
    await assert.rejects(service.prepare(f.session),/unconfirmed/);
    assert.equal(f.session.cursorNative?.creationUnconfirmed,true);
    await assert.rejects(service.prepare(f.session),/上次新建结果未确认/);
    assert.equal(f.calls.filter(x=>x==='create').length,1);
  }finally{await service.close();await f.clean();}
});
