import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prepareDesktopRollout } from '../src/core/native-publish';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import type { AgentSession } from '../src/shared/types';
import { CodexDesktopOption, NativeDesktopControls } from '../src/renderer/native-desktop-controls';
import { NativeDesktopStatus } from '../src/renderer/native-desktop-controls';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const history = (id: string) => [
  {type:'session_meta',payload:{id,cwd:'fixture'}},
  {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'原问题'}]}},
  {type:'response_item',payload:{type:'function_call',call_id:'tool-1',name:'shell',arguments:'{"command":"echo evidence"}'}},
  {type:'response_item',payload:{type:'function_call_output',call_id:'tool-1',output:'evidence'}},
  {type:'compacted',payload:{message:'保留项目约定',replacement_history:[{type:'message',role:'user',content:[{type:'input_text',text:'原问题'}]}]}},
].map(item=>JSON.stringify(item)).join('\n')+'\n';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-existing-sync-')),desktop=path.join(root,'desktop'),data=path.join(root,'data'),privateHome=path.join(data,'codex-home');
  await fs.mkdir(path.join(privateHome,'sessions'),{recursive:true});await fs.mkdir(desktop,{recursive:true});
  let prepares=0,starts=0,failStart=false,ready=true,opens=0;
  let preflight=async()=>{};
  const service={readyToPrepare:async()=>ready,prepare:async(s:AgentSession,home:string)=>{prepares++;await preflight();return prepareDesktopRollout(s,home,desktop);},storage:async()=>{throw Error('fixture runtime only');},open:async()=>{opens++;}};
  const wb=new Workbench(data,()=>{},()=>{},undefined,undefined,undefined,service);
  await wb.store.init();grantTestWorkspace(wb,root);
  const session=await wb.createSession('codex',root,offlineProjectId,'work',undefined,undefined,'inherit',false,'direct');
  session.title='已有会话';session.nativeId=randomUUID();session.codexStorage='workbench';session.nativePath=path.join(privateHome,'sessions','rollout-'+session.nativeId+'.jsonl');
  session.messages=[{id:'original',role:'user',text:'原问题',createdAt:new Date().toISOString()}];
  await fs.writeFile(session.nativePath,history(session.nativeId));
  wb.store.inputs[session.id]={text:'未发送的草稿',sourceIds:[],answers:{}};
  const original=structuredClone(session);
  (wb as any).createRuntime=async(s:AgentSession)=>{
    assert.equal(s.codexDesktop,true);
    const runtime={session:s,close:async()=>{},ensureStarted:async()=>{
      starts++;
      const saved=JSON.parse(await fs.readFile(path.join(data,'sessions.json'),'utf8')).find((item:any)=>item.id===s.id);
      assert.equal(saved.codexDesktop,true,'new execution ownership is durable before resuming');
      if(failStart)throw Error('backend temporarily unavailable');
      s.nativeId ||= randomUUID();s.nativeLive=true;s.desktopSyncState='connected';s.status='idle';s.error=undefined;
    }};
    (wb as any).runtimes.set(s.id,runtime);return runtime;
  };
  (wb as any).openCodexDesktopIfClosed=async()=>{opens++;};
  return {wb,session,original,root,desktop,privateHome,service,opened:()=>opens,setReady(value:boolean){ready=value;},counts:()=>({prepares,starts}),setPreflight(fn:()=>Promise<void>){preflight=fn;},setFailure(value:boolean){failStart=value;},async close(){await wb.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('existing private history keeps its identity, tools, compaction and draft when attached; repeat clicks do not create another thread',async()=>{
  const f=await fixture();try{
    const s=await f.wb.syncCodexDesktop(f.session.id);
    assert.equal(s.id,f.original.id);assert.equal(s.nativeId,f.original.nativeId);assert.equal(s.title,f.original.title);
    assert.deepEqual(s.messages,f.original.messages);assert.equal(f.wb.store.inputs[s.id].text,'未发送的草稿');
    assert.equal(await fs.readFile(s.nativePath!,'utf8'),history(s.nativeId!));
    assert.equal(await fs.readFile(f.original.nativePath!,'utf8'),history(s.nativeId!));
    assert.equal(s.codexStorage,undefined);assert.equal(s.desktopSyncState,'connected');
    await f.wb.syncCodexDesktop(s.id);assert.deepEqual(f.counts(),{prepares:1,starts:1});
    const copy=new Store(f.wb.store.root);await copy.init();assert.equal(copy.sessions.find(item=>item.id===s.id)?.codexDesktop,true);
  }finally{await f.close();}
});

test('previously imported and previously registered desktop sessions attach in place without copying or forking',async()=>{
  const f=await fixture();try{
    const target=path.join(f.desktop,'sessions','rollout-'+f.session.nativeId+'.jsonl');await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(f.session.nativePath!,target);
    f.session.nativeLive=true;f.session.nativePath=target;delete f.session.codexStorage;
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.nativePath,target);assert.equal(f.session.nativeId,f.original.nativeId);
    assert.equal((await fs.readdir(path.dirname(target))).length,1);
  }finally{await f.close();}
});

test('missing or inconsistent native history never falls back to a text-only new conversation',async()=>{
  const f=await fixture();try{
    await fs.rm(f.session.nativePath!);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/完整的 Codex 会话记录/);
    assert.equal(f.session.codexDesktop,undefined);assert.deepEqual(f.session.messages,f.original.messages);assert.equal(f.counts().starts,0);
    await fs.writeFile(f.session.nativePath!,history(randomUUID()));
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/标识不一致/);
    delete f.session.nativeId;
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/缺少完整/);
    assert.equal(f.counts().starts,0);
  }finally{await f.close();}
});

test('a different desktop history with the same native ID is never overwritten; an identical retry is reused',async()=>{
  const f=await fixture();try{
    const target=path.join(f.desktop,'sessions','rollout-'+f.session.nativeId+'.jsonl');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,history(f.session.nativeId!)+JSON.stringify({type:'compacted',payload:{message:'other branch'}})+'\n');
    const before=await fs.readFile(target);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/内容不同/);assert.deepEqual(await fs.readFile(target),before);assert.equal(f.session.codexDesktop,undefined);
    await fs.writeFile(target,history(f.session.nativeId!));await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.nativePath,target);
  }finally{await f.close();}
});

test('first connection failure preserves the ordinary session and can retry; failure after ownership switches recovers only the shared thread',async()=>{
  const f=await fixture();try{
    f.setPreflight(async()=>{throw Error('请保存并退出 Codex');});await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/退出 Codex/);
    assert.equal(f.session.codexDesktop,undefined);assert.equal(f.session.codexStorage,'workbench');assert.equal(f.session.status,'idle');
    f.setPreflight(async()=>{});f.setFailure(true);await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/temporarily/);
    assert.equal(f.session.codexDesktop,true);assert.equal(f.session.desktopSyncState,'disconnected');assert.equal(f.session.nativeId,f.original.nativeId);assert.equal(f.session.codexStorage,undefined);
    const prepared=f.counts().prepares;f.setFailure(false);(f.wb as any).openCodexDesktopIfClosed=async()=>{};
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.counts().prepares,prepared);assert.equal(f.session.desktopSyncState,'connected');assert.equal(f.session.nativeId,f.original.nativeId);
  }finally{await f.close();}
});

test('busy, closed, wrong provider and management-routed sessions cannot attach',async()=>{
  const f=await fixture();try{
    for(const status of ['starting','running','approval'] as const){f.session.status=status;await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/结束后再同步/);}f.session.status='idle';
    f.session.closedAt='closed';await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/已关闭/);delete f.session.closedAt;
    f.session.networkRoute='management';await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/管理端访问/);f.session.networkRoute='direct';
    f.session.provider='cursor';await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/只有 Codex/);f.session.provider='codex';
    assert.equal(f.counts().prepares,0);
  }finally{await f.close();}
});

test('failed ownership persistence leaves the private session writable and permits a clean retry without duplicate history',async()=>{
  const f=await fixture();const save=f.wb.store.save.bind(f.wb.store);let fail=true;
  try{
    f.wb.store.save=async()=>{if(fail){fail=false;throw Error('fixture disk unavailable');}return save();};
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/disk unavailable/);
    assert.equal(f.session.codexDesktop,undefined);assert.equal(f.session.codexStorage,'workbench');assert.equal(f.counts().starts,0);
    assert.equal(f.session.nativePath,f.original.nativePath);assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.codexDesktop,true);assert.equal(f.session.nativeId,f.original.nativeId);
    assert.equal((await fs.readdir(path.join(f.desktop,'sessions'))).length,1);
  }finally{f.wb.store.save=save;await f.close();}
});

test('attachment excludes a competing send, close, stop, settings change and duplicate attachment without losing the draft',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let attaching:Promise<unknown>|undefined;
  try{
    f.setPreflight(()=>gate);attaching=f.wb.syncCodexDesktop(f.session.id);
    await assert.rejects(f.wb.syncCodexDesktop(f.session.id),/结束后再同步/);
    await assert.rejects(f.wb.send(f.session.id,'competing'),/正在运行|正在同步/);
    await assert.rejects(f.wb.closeSession(f.session.id),/正在同步/);
    await assert.rejects(f.wb.stop(f.session.id),/正在同步/);
    await assert.rejects(f.wb.changeModel(f.session.id,'another-model'),/正在启动|切换会话设置/);
    assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');release();await attaching;
  }finally{release();await attaching?.catch(()=>{});await f.close();}
});

test('empty old sessions can be associated without a text-only synthetic rollout',async()=>{
  const f=await fixture();try{
    f.session.messages=[];delete f.session.nativeId;delete f.session.nativePath;
    await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.session.codexDesktop,true);assert.deepEqual(await fs.readdir(f.desktop),[]);
  }finally{await f.close();}
});

test('deferred synchronization keeps latest history but leaves the desktop closed until an explicit open',async()=>{
  const f=await fixture();let closed=0;
  try{
    f.setReady(false);const privateRuntime={session:f.session,close:async()=>{closed++;}};(f.wb as any).runtimes.set(f.session.id,privateRuntime);
    await f.wb.syncCodexDesktop(f.session.id);
    assert(f.session.codexSyncRequest);assert.equal(f.session.codexDesktop,undefined);assert.equal(f.session.status,'idle');assert.equal(closed,0);
    assert.equal((f.wb as any).runtimes.get(f.session.id),privateRuntime);assert.equal((f.wb as any).sending.has(f.session.id),false);
    assert.deepEqual(await fs.readdir(f.desktop),[]);assert.deepEqual(f.counts(),{prepares:0,starts:0});assert.equal(f.opened(),0);
    const saved=new Store(f.wb.store.root);await saved.init();assert.deepEqual(saved.sessions.find(s=>s.id===f.session.id)?.codexSyncRequest,f.session.codexSyncRequest);
    await (f.wb as any).drainDeferredCodexSync();assert.equal(closed,0);assert.equal(f.counts().prepares,0);
    const newTurn=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'排队后继续了工作'}]}})+'\n';
    await fs.appendFile(f.session.nativePath!,newTurn);f.setReady(true);f.session.status='running';
    await (f.wb as any).drainDeferredCodexSync();assert.equal(closed,0);assert.equal(f.counts().prepares,0);
    f.session.status='idle';await (f.wb as any).drainDeferredCodexSync();
    assert.equal(closed,1);assert.equal(f.opened(),0);assert.equal(f.session.codexDesktop,true);assert.equal(f.session.codexSyncRequest,undefined);
    assert.equal(await fs.readFile(f.session.nativePath!,'utf8'),history(f.original.nativeId!)+newTurn);assert.equal(f.session.nativeId,f.original.nativeId);
    assert.equal(f.wb.store.inputs[f.session.id].text,'未发送的草稿');
    await (f.wb as any).drainDeferredCodexSync();await f.wb.syncCodexDesktop(f.session.id);assert.equal(f.opened(),0);
    f.wb.store.settings.providerPaths.codex=process.execPath;
    await f.wb.openCodexDesktop(f.session.id);assert.equal(f.opened(),1);
  }finally{await f.close();}
});

test('cancelled or closed requests never migrate when the desktop exits; reopening can complete the saved request',async()=>{
  const f=await fixture();try{
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);await f.wb.cancelCodexSync(f.session.id);f.setReady(true);
    await (f.wb as any).drainDeferredCodexSync();assert.equal(f.session.codexSyncRequest,undefined);assert.equal(f.counts().starts,0);
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);await f.wb.closeSession(f.session.id);f.setReady(true);
    await (f.wb as any).drainDeferredCodexSync();assert(f.session.codexSyncRequest);assert.equal(f.counts().starts,0);
    await f.wb.reopenSession(f.session.id);await (f.wb as any).drainDeferredCodexSync();assert.equal(f.session.codexDesktop,true);assert.equal(f.opened(),0);
  }finally{await f.close();}
});

test('a cancelled request cannot be revived by a late readiness response',async()=>{
  const f=await fixture();let release!:()=>void;let job:Promise<void>|undefined;
  try{
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);
    f.service.readyToPrepare=async()=>{await new Promise<void>(resolve=>{release=resolve;});return true;};
    job=(f.wb as any).drainDeferredCodexSync();await f.wb.cancelCodexSync(f.session.id);release();await job;
    assert.equal(f.counts().starts,0);assert.equal(f.opened(),0);assert.equal(f.session.codexSyncRequest,undefined);
  }finally{release?.();await job;await f.close();}
});

test('unavailable history pauses the request with an explanation instead of retrying forever; manual retry recovers',async()=>{
  const f=await fixture();try{
    f.setReady(false);await f.wb.syncCodexDesktop(f.session.id);f.setReady(true);await fs.rm(f.session.nativePath!);
    await (f.wb as any).drainDeferredCodexSync();assert.match(f.session.codexSyncRequest!.error!,/完整的 Codex/);
    const before=f.counts().prepares;await (f.wb as any).drainDeferredCodexSync();assert.equal(f.counts().prepares,before);
    await fs.writeFile(f.original.nativePath!,history(f.original.nativeId!));await f.wb.syncCodexDesktop(f.session.id);
    assert.equal(f.session.codexDesktop,true);assert.equal(f.session.codexSyncRequest,undefined);assert.equal(f.opened(),0);
  }finally{await f.close();}
});

test('deferred UI distinguishes waiting from actual sync and exposes cancel and retry in the menu',()=>{
  const s={provider:'codex',purpose:'work',status:'idle',codexSyncRequest:{requestedAt:'now'}} as AgentSession;
  const status=()=>renderToStaticMarkup(React.createElement(NativeDesktopStatus,{session:s}));
  const menu=()=>renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){},showStatus:false}));
  assert.match(status(),/等待 Codex 退出后同步/);assert.doesNotMatch(status(),/>同步中</);
  assert.match(menu(),/取消同步请求/);assert.match(menu(),/可继续工作/);assert.match(menu(),/完成同步/);assert.doesNotMatch(menu(),/完成同步并打开|自动.*重新打开/);
  s.codexSyncRequest!.error='原记录缺失';assert.match(menu(),/原记录缺失/);assert.match(menu(),/重试同步/);assert.match(status(),/同步待处理/);
});

test('sync is an ordinary per-session option; existing and imported sessions expose the same menu command and restrictions',()=>{
  const option=(route:'direct'|'management')=>renderToStaticMarkup(React.createElement(CodexDesktopOption,{checked:true,networkRoute:route,changed(){}}));
  assert.match(option('direct'),/aria-checked="true"/);assert.doesNotMatch(option('direct'),/Beta|disabled/);assert.match(option('management'),/disabled=""/);assert.match(option('management'),/管理端访问/);
  const s={provider:'codex',purpose:'work',status:'idle',nativeId:randomUUID()} as AgentSession;
  const render=()=>renderToStaticMarkup(React.createElement(NativeDesktopControls,{session:s,run(){},showStatus:false}));
  assert.match(render(),/同步到 Codex/);assert.doesNotMatch(render(),/恢复同步/);s.nativeLive=true;assert.match(render(),/同步到 Codex/);
  s.status='running';assert.match(render(),/disabled=""/);assert.match(render(),/回复结束后/);
  s.status='idle';s.networkRoute='management';assert.match(render(),/管理端访问/);
  s.networkRoute='direct';s.codexDesktop=true;assert.match(render(),/在 Codex 中打开/);assert.doesNotMatch(render(),/Beta|同步到 Codex/);
});
