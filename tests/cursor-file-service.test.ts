import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CursorFileService } from '../src/core/cursor-file-service';
import { CursorNativeRpc } from '../src/core/cursor-native-rpc';
import { cursorHistoryMessages } from '../src/core/cursor-history-messages';
import type { CursorDesktopHistory } from '../src/core/cursor-desktop-history';
import type { AgentSession } from '../src/shared/types';
import type { CursorDesktopClient } from '../src/core/cursor-desktop-client';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cursor-native-service-')),nativeId=randomUUID(),user=randomUUID(),tool=randomUUID(),assistant=randomUUID();
  const history:CursorDesktopHistory={nativeId,cwd:root,status:'completed',settled:true,runtimeCheckpointAvailable:true,headersCount:3,bubbles:[{bubbleId:user,type:1,text:'original native question'},{bubbleId:tool,type:2,text:'',toolFormerData:{toolCallId:'call',name:'Read',status:'completed'}},{bubbleId:assistant,type:2,text:'original native answer',thinking:{text:'native reasoning'}}],promptMessages:[],archivedMessages:[{blobId:'archived-result',role:'tool',content:[{type:'tool-result',toolCallId:'call',result:'full result after native compaction'}]}],toolArtifacts:[{blobId:'full-blob',toolCallId:'call',kind:'read-file-content',content:'complete original file contents'}],toolCoverage:[{callId:'call',name:'Read',source:'archive'}],checkpointSha256:'native-checkpoint',stateFields:[],summaryArchiveCount:1,issues:[]};
  const calls:string[]=[];let failSend=false,snapshotFailures=0,snapshotAttempts=0;
  const client:CursorDesktopClient={async hasWorkspace(){return true;},async list(){return[{nativeId,cwd:root,title:'Native conversation'}];},async create(){throw Error('must not create');},async snapshot(){snapshotAttempts++;if(snapshotFailures>0){snapshotFailures--;throw Error('selected native chat still restoring');}return{sessionId:nativeId,status:'completed',messages:[]};},async send(_id,_cwd,text){calls.push(text);const id=randomUUID();history.bubbles.push({bubbleId:id,type:1,text});if(failSend)throw Error('delivery unknown');return{submitted:true,sessionId:nativeId,nativeMessageId:id};},async stop(){calls.push('stop');},async focus(){calls.push('focus');},close(){calls.push('detach');}};
  const options={parent:path.join(root,'service'),privateDirectory:async(parent:string)=>{const directory=path.join(parent,'private');await fs.mkdir(directory,{recursive:true});return directory;},database:'unused',readHistory:()=>structuredClone(history),running:async()=>false,launch:async()=>{calls.push('launch');},connect:()=>client,discover:async()=>'ws://127.0.0.1:1234/devtools/browser/test'};
  const service=new CursorFileService(options);
  const session:AgentSession={id:randomUUID(),provider:'cursor',title:'Native conversation',nativeId,cwd:root,purpose:'work',networkRoute:'direct',createdAt:new Date().toISOString(),status:'idle',messages:[],approvals:[],sources:[],autoUpload:false,handoffPath:path.join(root,'handoff.md'),cursorNative:{managed:true,descriptorFile:''}};
  return{root,history,calls,service,session,client,fail:()=>{failSend=true;},delaySnapshot:(count:number)=>{snapshotFailures=count;},snapshotAttempts:()=>snapshotAttempts,clean:async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('display projection retains native order, IDs, archived tool results, original tool blobs and thinking without exposing system prompts',async()=>{
  const f=await fixture();try{
    f.history.promptMessages.push({blobId:'sensitive',role:'system',content:'native hidden system prompt'});
    const messages=cursorHistoryMessages(f.history);
    assert.deepEqual(messages.map(message=>message.nativeItemId),f.history.bubbles.map(bubble=>bubble.bubbleId));
    assert.deepEqual(messages.map(message=>message.role),['user','tool','assistant']);
    assert.match(JSON.stringify(messages[1].nativeDetails),/full result after native compaction/);
    assert.match(JSON.stringify(messages[1].nativeDetails),/complete original file contents/);
    assert.deepEqual(messages[2].nativeDetails?.thinking,{text:'native reasoning'});
    assert.doesNotMatch(JSON.stringify(messages),/native hidden system prompt/);
  }finally{await f.clean();}
});

test('file service and RPC publish full history and commit an idempotent queue request before attempting native execution',async()=>{
  const f=await fixture();let rpc:CursorNativeRpc|undefined;try{
    await f.service.prepare(f.session);assert.equal(f.session.cursorNative?.transport,'ide-files-v1');
    rpc=new CursorNativeRpc(f.session);const snapshots:any[]=[];rpc.on('message',m=>{if(m.method==='cursor/nativeSnapshot')snapshots.push(m.params.snapshot);});
    await rpc.request('initialize');assert.equal(snapshots[0].nativeHistory.messages.length,3);assert.equal(snapshots[0].nativeHistory.checkpointSha256,'native-checkpoint');
    const id=randomUUID();let acknowledged=0;const result=await rpc.request('cursor/nativeEnqueue',{id,text:'one native turn'},0,()=>{acknowledged++;});
    assert.equal(result.id,id);assert.equal(acknowledged,1);
    const again=await rpc.request('cursor/nativeEnqueue',{id,text:'one native turn'});assert.equal(again.id,id);
    await assert.rejects(rpc.request('cursor/nativeEnqueue',{id,text:'different text'}),/同一请求/);
    await rpc.request('cursor/nativeQueueAction',{action:'resume'});
    await rpc.request('cursor/nativeFocus');assert.ok(f.calls.includes('focus'));
    assert.ok(f.calls.filter(value=>value==='one native turn').length<=1);
  }finally{await rpc?.close();await f.clean();}
});

test('loopback control requires the session token, matching host and no browser origin; detach revokes it',async()=>{
  const f=await fixture();try{
    await f.service.prepare(f.session);const descriptor=JSON.parse(await fs.readFile(f.session.cursorNative!.descriptorFile,'utf8'));
    assert.equal((await fetch(descriptor.endpoint+'/snapshot',{headers:{Origin:'https://example.org'}})).status,403);
    assert.equal((await fetch(descriptor.endpoint+'/enqueue')).status,405);
    assert.equal((await fetch(descriptor.endpoint+'/enqueue',{method:'POST',body:JSON.stringify({text:'missing-id'})})).status,409);
    assert.equal((await fetch(descriptor.endpoint+'/snapshot')).status,200);
    await f.service.release(f.session.id);assert.equal((await fetch(descriptor.endpoint+'/snapshot')).status,403);
    assert.equal(f.calls.filter(call=>call==='stop').length,0);
  }finally{await f.clean();}
});

test('a mismatched or incomplete native history cannot establish a writable association',async()=>{
  const f=await fixture();try{
    f.history.issues=[{kind:'missing-blob'}];await assert.rejects(f.service.prepare(f.session),/尚未完整保存/);
    assert.equal(f.session.cursorNative?.descriptorFile,'');assert.equal(f.calls.length,0);
    f.history.issues=[];delete f.session.nativeId;await assert.rejects(f.service.prepare(f.session),/先在 Cursor/);assert.equal(f.calls.length,0);
  }finally{await f.clean();}
});

test('explicit reopening waits for the exact native chat to restore, while passive observation never launches or retries it',async()=>{
  const f=await fixture();try{
    await f.service.prepare(f.session);
    const initialAttempts=f.snapshotAttempts();
    f.delaySnapshot(2);
    await assert.rejects(f.service.prepare(f.session,false),/still restoring/);
    assert.equal(f.snapshotAttempts(),initialAttempts+1);assert.deepEqual(f.calls,['launch']);
    await f.service.open(f.session);
    assert.equal(f.session.nativeId,f.history.nativeId);
    assert.equal(f.session.cursorNative?.transport,'ide-files-v1');
    assert.equal(f.calls.filter(call=>call==='launch').length,1);
    assert.ok(f.snapshotAttempts()>=initialAttempts+3);assert.ok(f.calls.includes('focus'));
    assert.equal(f.calls.some(call=>!['launch','focus'].includes(call)),false);
  }finally{await f.clean();}
});

test('explicit reopening selects a hidden native tab before validating it; passive restore never switches tabs',async()=>{
  const f=await fixture();try{
    await f.service.prepare(f.session);let visible=false;
    const snapshot=f.client.snapshot.bind(f.client);
    f.client.snapshot=async(id,cwd)=>{if(!visible)throw Error('native tab hidden');return snapshot(id,cwd);};
    f.client.focus=async(id,cwd)=>{assert.equal(id,f.session.nativeId);assert.equal(cwd,f.session.cwd);visible=true;f.calls.push('focus');};
    await assert.rejects(f.service.prepare(f.session,false),/hidden/);assert.equal(visible,false);
    await f.service.open(f.session);assert.equal(visible,true);assert.equal(f.calls.filter(call=>call==='focus').length,1);
    f.session.closedAt=new Date().toISOString();visible=false;
    await assert.rejects(f.service.open(f.session),/不能关联/);assert.equal(visible,false);
  }finally{await f.clean();}
});

test('Workbench imports full native history, bypasses CLI auth and context injection, queues busy sends, and retains observation after Stop',async()=>{
  const f=await fixture();const wb=new Workbench(path.join(f.root,'workbench'),()=>{},()=>{},undefined,undefined,undefined,undefined,f.service);
  try{
    await f.service.prepare(f.session);await wb.store.init();grantTestWorkspace(wb,f.root);await wb.setBetaFeature('cursorDesktopSync',true);
    wb.requireAuth=async()=>{throw Error('native turns must not authenticate a CLI');};
    wb.journal.context=async()=>{throw Error('native turns must not rebuild another context');};
    const [session]=await wb.linkCursorDesktopSessions([f.session.nativeId!],offlineProjectId);
    assert.equal(session.nativeId,f.session.nativeId);assert.equal(session.messages.length,3);
    assert.match(JSON.stringify(session.messages),/complete original file contents/);
    await assert.rejects(wb.linkCursorDesktopSessions([f.session.nativeId!],offlineProjectId),/不能重复关联/);
    session.status='running';assert.equal(await wb.send(session.id,'one native request'),true);
    assert.equal(await wb.send(session.id,'queue the next request'),true);
    assert.equal(session.cursorPendingSubmission,undefined);
    await assert.rejects(wb.send(session.id,'/summarize'),/原生窗口/);assert.equal(session.cursorPendingSubmission,undefined);
    await assert.rejects(wb.send(session.id,'explicit refs',['reference-id']),/原生窗口/);
    await assert.rejects(wb.send(session.id,'explicit skill',[],[{id:'skill-id',kind:'skill',name:'independent-skill'}]),/原生窗口/);
    await wb.stop(session.id);assert.ok(f.calls.includes('stop'));
    assert.equal((wb as any).runtimes.has(session.id),true,'Stop must not detach the observer and strand later native messages');
    await wb.closeSession(session.id);
    const queues=await fs.readdir(path.join(f.root,'service','queues'));const files=await fs.readdir(path.join(f.root,'service','queues',queues[0]));
    const requests=await Promise.all(files.filter(file=>/^[0-9a-f-]{36}\.json$/.test(file)).map(file=>fs.readFile(path.join(f.root,'service','queues',queues[0],file),'utf8').then(JSON.parse)));
    assert.equal(requests.find(request=>request.text==='queue the next request').state,'cancelled');
  }finally{await wb.close();await f.clean();}
});

test('native settings RPC preserves the exact session scope and loopback authentication',async()=>{
  const f=await fixture();let rpc:CursorNativeRpc|undefined;try{
    const settings={state:'ready' as const,revision:'native-revision',model:{id:'auto',label:'Auto',options:[{id:'auto',label:'Auto'},{id:'next',label:'Next'}]}};
    f.client.settings=async(id,cwd)=>{assert.equal(id,f.session.nativeId);assert.equal(cwd,f.root);return structuredClone(settings);};
    f.client.changeSetting=async()=>{throw Error('not supposed to apply before idle verification');};
    await f.service.prepare(f.session);rpc=new CursorNativeRpc(f.session);await rpc.request('initialize');
    assert.equal((await rpc.request('cursor/nativeSettings',{sessionId:f.session.nativeId})).model.id,'auto');
    await assert.rejects(rpc.request('cursor/nativeSettings',{sessionId:randomUUID(),kind:'model',value:'next',revision:'native-revision'}),/不属于/);
    const result=await rpc.request('cursor/nativeSettings',{sessionId:f.session.nativeId,kind:'model',value:'next',revision:'native-revision'});assert.equal(result.pending.state,'waiting');assert.equal(result.model.id,'auto');
    await rpc.request('cursor/nativeSettings',{cancel:true});
    const descriptor=JSON.parse(await fs.readFile(f.session.cursorNative!.descriptorFile,'utf8'));
    assert.equal((await fetch(descriptor.endpoint+'/settings',{method:'POST',headers:{Origin:'https://example.org'},body:'{}'})).status,403);
    assert.equal((await fetch(descriptor.endpoint+'/settings')).status,405);
    assert.equal((await fetch(descriptor.endpoint+'/settings',{method:'POST',body:JSON.stringify({kind:'execute-any-command'})})).status,409);
    assert.equal((await fetch(descriptor.endpoint+'/settings',{method:'POST',body:JSON.stringify({kind:'model',value:{arbitrary:true}})})).status,409);
    await f.service.release(f.session.id);assert.equal((await fetch(descriptor.endpoint+'/settings',{method:'POST',body:'{}'})).status,403);
  }finally{await rpc?.close();await f.clean();}
});
