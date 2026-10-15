import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CursorFileBridge } from '../src/core/cursor-file-bridge';
import type { CursorDesktopClient } from '../src/core/cursor-desktop-client';
import type { CursorDesktopHistory } from '../src/core/cursor-desktop-history';
import type { CursorNativeSettings } from '../src/shared/cursor-native-settings';

async function fixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cursor-settings-')),binding={nativeId:randomUUID(),cwd:root};
  const history:CursorDesktopHistory={...binding,status:'completed',settled:true,runtimeCheckpointAvailable:true,headersCount:0,bubbles:[],promptMessages:[],archivedMessages:[],toolArtifacts:[],toolCoverage:[],checkpointSha256:'checkpoint',stateFields:[],summaryArchiveCount:0,issues:[]};
  const settings:CursorNativeSettings={state:'ready',revision:'initial',model:{id:'auto',label:'Auto',options:[{id:'auto',label:'Auto'},{id:'next',label:'Next'},{id:'disabled',label:'Disabled',disabled:true}]},mode:{id:'agent',label:'Agent',options:[{id:'agent',label:'Agent'},{id:'plan',label:'Plan'}]},permission:{id:'ask',label:'Ask',options:[{id:'ask',label:'Ask'},{id:'review',label:'Review'}]}};
  let status='completed',now=0,ack=false,fail=false;
  const calls:string[]=[];
  const client:CursorDesktopClient={async hasWorkspace(){return true;},async list(){return[];},async create(){throw Error('never create');},async snapshot(){return{sessionId:binding.nativeId,status,messages:[],settings:structuredClone(settings)};},async settings(_id,_cwd,kind){const value=structuredClone(settings);if(kind!=='mode')value.mode!.options=[];return value;},async changeSetting(_id,_cwd,kind,value){calls.push(`set:${kind}:${value}`);if(fail)throw Error('native policy denied');if(ack){settings[kind]!.id=value;settings.revision+=':changed';}},async send(_id,_cwd,text){calls.push(`send:${text}`);const id=randomUUID();history.bubbles.push({bubbleId:id,type:1,text});return{submitted:true,sessionId:binding.nativeId,nativeMessageId:id};},async focus(){},async stop(){calls.push('stop');},close(){}};
  const directory=path.join(root,'mailbox'),make=()=>new CursorFileBridge(directory,binding,'unused',client,{readHistory:()=>structuredClone(history),pollMs:1000000,now:()=>now});
  const bridge=make();await bridge.start();
  return{bridge,make,settings,calls,history,directory,busy:(value:boolean)=>{status=value?'generating':'completed';},advance:()=>{now+=2000;},ack:()=>{ack=true;},fail:()=>{fail=true;},clean:async()=>{await bridge.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('busy changes wait without Stop; native read-back is required before dispatching queued text',async()=>{
  const f=await fixture();try{
    f.busy(true);await f.bridge.refresh();await f.bridge.configure('model','next','initial');await f.bridge.enqueue('after change');await f.bridge.refresh();assert.deepEqual(f.calls,[]);
    f.busy(false);await f.bridge.refresh();f.advance();await f.bridge.refresh();assert.deepEqual(f.calls,['set:model:next']);
    assert.equal((await f.bridge.view()).settings?.model?.id,'auto');assert.equal((await f.bridge.view()).settings?.pending?.state,'confirming');
    f.advance();await f.bridge.refresh();f.advance();await f.bridge.refresh();assert.equal((await f.bridge.view()).settings?.pending?.state,'error');assert.equal(f.calls.length,1,'unacknowledged native writes must never retry');
    f.settings.model!.id='next';f.settings.revision='native-ack';await f.bridge.refresh();assert.equal((await f.bridge.view()).settings?.pending,undefined);await f.bridge.refresh();assert.deepEqual(f.calls,['set:model:next','send:after change']);
  }finally{await f.clean();}
});

test('another native edit wins; explicit cancellation releases queued messages under actual settings',async()=>{
  const f=await fixture();try{
    await f.bridge.configure('model','next','initial');await f.bridge.enqueue('queued');f.settings.revision='native-edit';await f.bridge.refresh();f.advance();await f.bridge.refresh();
    assert.equal((await f.bridge.view()).settings?.pending?.state,'error');assert.deepEqual(f.calls,[]);
    await f.bridge.configure(undefined,undefined,undefined,true);await f.bridge.refresh();assert.deepEqual(f.calls,['send:queued']);assert.equal(f.settings.revision,'native-edit');
  }finally{await f.clean();}
});

test('settings remain changeable while the send queue is paused, without resuming it',async()=>{
  const f=await fixture();try{
    f.ack();f.history.status='aborted';f.history.settled=false;await f.bridge.pauseQueue();await f.bridge.configure('permission','review','initial');await f.bridge.enqueue('stay paused');await f.bridge.refresh();f.advance();await f.bridge.refresh();await f.bridge.refresh();await f.bridge.refresh();
    assert.deepEqual(f.calls,['set:permission:review']);assert.equal((await f.bridge.view()).paused,true);assert.equal((await f.bridge.view()).settings?.pending,undefined);
  }finally{await f.clean();}
});

test('stale, disabled and unadvertised choices are rejected; Plan uses a freshly read native catalog',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.bridge.configure('model','next','stale'),/变化/);await assert.rejects(f.bridge.configure('model','disabled','initial'),/不支持/);
    await assert.rejects(f.bridge.configure('mode','invented','initial'),/不支持/);await assert.rejects(f.bridge.configure('mode','plan','initial'),/不支持/);
    await f.bridge.configure('mode');const result=await f.bridge.configure('mode','plan','initial');assert.equal(result?.pending?.label,'Plan');
    await assert.rejects(f.bridge.configure('model','next','initial'),/上一次/);assert.deepEqual(f.calls,[]);
  }finally{await f.clean();}
});

test('pending settings survive restart for review but are never automatically replayed',async()=>{
  const f=await fixture();let second:CursorFileBridge|undefined;try{
    f.busy(true);await f.bridge.configure('permission','review','initial');await f.bridge.close();f.busy(false);second=f.make();await second.start();f.advance();await second.refresh();
    assert.equal((await second.view()).settings?.pending?.state,'error');assert.deepEqual(f.calls,[]);
    await second.configure(undefined,undefined,undefined,true);await second.refresh();assert.equal((await second.view()).settings?.pending,undefined);
  }finally{await second?.close();await f.clean();}
});

test('unavailable settings block messages; rejected native changes remain visible and block dependent sends',async()=>{
  const f=await fixture();try{
    f.settings.state='unavailable';await f.bridge.enqueue('must wait');await f.bridge.refresh();assert.deepEqual(f.calls,[]);
    await assert.rejects(f.bridge.configure('model','next','initial'),/变化/);
    f.settings.state='ready';f.fail();await f.bridge.configure('model','next','initial');f.advance();await f.bridge.refresh();
    assert.equal((await f.bridge.view()).settings?.pending?.state,'error');assert.match((await f.bridge.view()).settings!.pending!.error!,/policy denied/);await f.bridge.refresh();assert.deepEqual(f.calls,['set:model:next']);
  }finally{await f.clean();}
});
