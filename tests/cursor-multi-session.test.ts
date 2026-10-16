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
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cursor-multi-')),ids:string[]=[randomUUID(),randomUUID()];
  let visible=ids[0],now=0,permission='review';
  const calls:Array<{id:string;kind:string;text:string}>=[];
  const histories=ids.map(nativeId=>({nativeId,cwd:directory,status:'completed',settled:true,runtimeCheckpointAvailable:true,headersCount:0,bubbles:[],promptMessages:[],archivedMessages:[],toolArtifacts:[],toolCoverage:[],checkpointSha256:nativeId,stateFields:[],summaryArchiveCount:0,issues:[]} as CursorDesktopHistory));
  const models=['auto','auto'];
  const history=(id:string)=>{const value=histories.find(value=>value.nativeId===id);assert.ok(value);return value;};
  const settings=(id:string):CursorNativeSettings=>({state:'ready',revision:JSON.stringify([models[ids.indexOf(id)],permission]),model:{id:models[ids.indexOf(id)],label:models[ids.indexOf(id)],options:['auto','next'].map(id=>({id,label:id}))},mode:{id:'agent',label:'Agent',options:[]},permission:{id:permission,label:permission,options:['review','ask'].map(id=>({id,label:id}))}});
  const check=(id:string,cwd:string)=>{assert.equal(cwd,directory);history(id);if(id!==visible)throw Error('请打开关联会话');};
  const client:CursorDesktopClient={async hasWorkspace(){return true;},async list(){return[];},async create(){throw Error('no replacement Agent');},
    async snapshot(id,cwd){check(id,cwd);return{sessionId:id,status:'completed',messages:[],settings:settings(id)};},
    async settings(id,cwd){check(id,cwd);return settings(id);},
    async changeSetting(id,cwd,kind,value,revision){check(id,cwd);assert.equal(settings(id).revision,revision);calls.push({id,kind,text:value});if(kind==='permission')permission=value;else models[ids.indexOf(id)]=value;},
    async send(id,cwd,text){check(id,cwd);calls.push({id,kind:'send',text});const nativeMessageId=randomUUID(),h=history(id);h.bubbles.push({bubbleId:nativeMessageId,type:1,text},{bubbleId:randomUUID(),type:2,text:'reply '+text});h.checkpointSha256+=text;return{submitted:true,sessionId:id,nativeMessageId};},
    async focus(){throw Error('background polling must never focus');},async stop(){throw Error('settings must never Stop');},close(){},
  };
  const make=(id:string)=>new CursorFileBridge(path.join(directory,id),{nativeId:id,cwd:directory},'unused',client,{readHistory:(_file,id)=>structuredClone(history(id)),pollMs:1000000,now:()=>now});
  const bridges=ids.map(make);for(const bridge of bridges)await bridge.start();
  const tick=async()=>{now+=2000;for(const bridge of bridges)await bridge.refresh();};
  return{ids,bridges,models,calls,histories,settings,make,tick,show:(index:number)=>{visible=ids[index];},clean:async()=>{for(const bridge of bridges)await bridge.close();await fs.rm(directory,{recursive:true,force:true});}};
}

test('two native sessions keep independent queues and histories, including hidden-session restart and cancellation',async()=>{
  const f=await fixture();try{
    const [a,b]=f.bridges;
    await b.enqueue('B first');const cancelled=await b.enqueue('B cancelled');await b.cancel(cancelled.id);
    await a.enqueue('A first');await f.tick();await f.tick();
    assert.deepEqual(f.calls,[{id:f.ids[0],kind:'send',text:'A first'}]);
    assert.equal((await b.requests())[0].state,'queued');assert.match((await b.view()).error!,/打开关联会话/);
    await b.close();f.bridges[1]=f.make(f.ids[1]);await f.bridges[1].start();
    f.show(1);await f.tick();await f.tick();await f.tick();
    assert.deepEqual(f.calls,[{id:f.ids[0],kind:'send',text:'A first'},{id:f.ids[1],kind:'send',text:'B first'}]);
    assert.equal((await f.bridges[1].requests())[1].state,'cancelled');
    assert.deepEqual(f.histories.map(h=>h.bubbles.filter(b=>b.type===1).map(b=>b.text)),[['A first'],['B first']]);
    await a.close();await f.bridges[1].enqueue('B after A closed');await f.tick();await f.tick();
    assert.equal(f.calls.at(-1)?.text,'B after A closed');assert.equal(f.calls.filter(c=>c.text==='B first').length,1);
  }finally{await f.clean();}
});

test('shared native permissions invalidate a stale hidden-session change instead of overwriting another session',async()=>{
  const f=await fixture();try{
    const [a,b]=f.bridges;
    await a.configure('model','next',f.settings(f.ids[0]).revision);
    f.show(1);await b.configure('permission','ask',f.settings(f.ids[1]).revision);await f.tick();await f.tick();await f.tick();
    assert.deepEqual(f.calls,[{id:f.ids[1],kind:'permission',text:'ask'}]);
    f.show(0);await a.enqueue('A after review');await f.tick();await f.tick();
    assert.equal((await a.view()).settings?.pending?.state,'error');assert.equal((await a.view()).settings?.permission?.id,'ask');assert.deepEqual(f.models,['auto','auto']);
    await a.configure(undefined,undefined,undefined,true);await f.tick();await f.tick();
    assert.equal(f.calls.at(-1)?.id,f.ids[0]);assert.equal(f.calls.at(-1)?.text,'A after review');
    await a.configure('model','next',f.settings(f.ids[0]).revision);await f.tick();await f.tick();await f.tick();
    assert.deepEqual(f.models,['next','auto']);assert.equal((await a.view()).settings?.pending,undefined);
  }finally{await f.clean();}
});
