import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CursorFileBridge, cursorRequestCandidateIds, type CursorFileRequest } from '../src/core/cursor-file-bridge';
import type { CursorDesktopClient } from '../src/core/cursor-desktop-client';
import type { CursorDesktopHistory } from '../src/core/cursor-desktop-history';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-mailbox-'));
  const binding = { nativeId: randomUUID(), cwd: root };
  const history: CursorDesktopHistory = { ...binding, status:'completed', settled:true, runtimeCheckpointAvailable:true, headersCount:0, bubbles:[], promptMessages:[], archivedMessages:[], toolArtifacts:[], toolCoverage:[], checkpointSha256:'initial',stateFields:[],summaryArchiveCount:0,issues:[] };
  const observed = { sessionId:binding.nativeId,status:'completed',messages:[] };
  const calls:string[]=[];
  let now=0, failSend=false, releaseSend: (()=>void)|undefined, waitSend=false;
  const client:CursorDesktopClient={
    async hasWorkspace(){return true;},async list(){return [];},async create(){throw Error('must never create a different Agent');},
    async snapshot(){return {...observed};},
    async send(_id,_cwd,text){ calls.push(text);const id=randomUUID();history.bubbles.push({bubbleId:id,type:1,text});if(waitSend)await new Promise<void>(resolve=>{releaseSend=resolve;});if(failSend)throw Error('ack lost');return {submitted:true,sessionId:binding.nativeId,nativeMessageId:id}; },
    async focus(){},async stop(){},close(){calls.push('detach');},
  };
  const directory=path.join(root,'mailbox');
  const make=()=>new CursorFileBridge(directory,binding,'unused.db',client,{readHistory:()=>structuredClone(history),pollMs:1000000,now:()=>now});
  const bridge=make();await bridge.start();
  return {root,binding,history,observed,calls,bridge,make,directory,advance:()=>{now+=2000;},fail:()=>{failSend=true;},block:()=>{waitSend=true;},release:()=>releaseSend?.(),clean:async()=>{await bridge.close();await fs.rm(root,{recursive:true,force:true});}};
}

test('requests publish atomically in submission order and the same request ID cannot execute twice',async()=>{
  const f=await fixture();try{
    f.observed.status='generating';const id=randomUUID();
    const requests=await Promise.all([f.bridge.enqueue('first',id),f.bridge.enqueue('first',id),f.bridge.enqueue('second')]);
    assert.equal(requests[0].id,requests[1].id);assert.deepEqual((await f.bridge.requests()).map(r=>r.text),['first','second']);
    await assert.rejects(f.bridge.enqueue('different',id),/同一请求/);
    assert.equal(await f.bridge.cancel(requests[0].id),true);
    f.observed.status='completed';await f.bridge.refresh();
    assert.deepEqual(f.calls,['second']);
    await f.bridge.enqueue('second',requests[2].id);assert.deepEqual(f.calls,['second']);
  }finally{await f.clean();}
});

test('transient aborted storage immediately after send does not finish or abort the request',async()=>{
  const f=await fixture();try{
    const request=await f.bridge.enqueue('continue original native context');await f.bridge.refresh();
    f.history.status='aborted';f.history.settled=false;f.advance();await f.bridge.refresh();f.advance();await f.bridge.refresh();
    assert.equal((await f.bridge.requests())[0].state,'accepted');assert.equal((await f.bridge.view()).paused,false);
    f.history.status='completed';f.history.settled=true;f.history.checkpointSha256='after-native-response';f.history.bubbles.push({bubbleId:randomUUID(),type:2,text:'native reply'});
    await f.bridge.refresh();f.advance();await f.bridge.refresh();
    const result=(await f.bridge.requests()).find(r=>r.id===request.id)!;
    assert.equal(result.state,'completed');assert.equal(result.checkpoint,'after-native-response');
  }finally{await f.clean();}
});

test('a lost send receipt survives restart without automatic replay and pauses later submissions',async()=>{
  const f=await fixture();let second:CursorFileBridge|undefined;try{
    f.fail();const request=await f.bridge.enqueue('only once');await f.bridge.refresh();
    assert.equal((await f.bridge.requests())[0].state,'uncertain');
    await f.bridge.close();second=f.make();await second.start();await second.enqueue('wait behind uncertain request');await second.refresh();
    assert.equal((await second.view()).paused,true);assert.deepEqual(f.calls,['only once','detach']);
    await assert.rejects(second.resume(),/先核对/);
    await assert.rejects(second.reconcile(request.id,randomUUID()),/未找到/);
    await second.reconcile(request.id,f.history.bubbles[0].bubbleId);
    assert.equal((await second.requests())[0].state,'accepted');
  }finally{await second?.close();await f.clean();}
});

test('the same native mailbox has a single live owner and close drains an in-flight submission before releasing it',async()=>{
  const f=await fixture();const second=f.make();try{
    await assert.rejects(second.start(),/已有中介/);
    f.block();await f.bridge.enqueue('pending acknowledgement');
    for(let i=0;i<20&&!f.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,1));
    let closed=false;const closing=f.bridge.close().then(()=>{closed=true;});
    await new Promise(resolve=>setTimeout(resolve,5));assert.equal(closed,false);assert.equal(f.calls.includes('detach'),false);
    await assert.rejects(second.start(),/已有中介/);
    f.release();await closing;assert.equal(closed,true);assert.equal((await f.bridge.requests())[0].state,'accepted');
    await second.start();assert.equal((await second.requests())[0].state,'accepted');assert.equal(f.calls.filter(x=>x==='pending acknowledgement').length,1);
  }finally{f.release();await second.close();await f.clean();}
});

test('a confirmed native stop persists the pause across restart; cancellation cannot revive a queued request',async()=>{
  const f=await fixture();let second:CursorFileBridge|undefined;try{
    await f.bridge.enqueue('native turn');await f.bridge.refresh();f.observed.status='generating';await f.bridge.refresh();
    const pending=await f.bridge.enqueue('do not execute after stop');assert.equal(await f.bridge.cancel(pending.id),true);
    f.history.checkpointSha256='stopped-state';f.history.status='aborted';f.history.settled=false;f.observed.status='cancelled';await f.bridge.refresh();f.advance();await f.bridge.refresh();
    assert.equal((await f.bridge.requests())[0].state,'aborted');assert.equal((await f.bridge.view()).paused,true);
    await f.bridge.close();second=f.make();await second.start();assert.equal((await second.view()).paused,true);
    await second.resume();assert.equal((await second.view()).paused,false);assert.equal(f.calls.filter(x=>x==='do not execute after stop').length,0);
  }finally{await second?.close();await f.clean();}
});

test('native summarization is a barrier even if its composer briefly looks idle and its saved status says aborted',async()=>{
  const f=await fixture();try{
    f.observed.status='generating';await f.bridge.refresh();
    f.history.bubbles.push({bubbleId:randomUUID(),type:2,text:'',capabilityType:22});f.history.status='aborted';f.history.settled=false;f.observed.status='completed';
    await f.bridge.enqueue('after native summary');await f.bridge.refresh();f.advance();await f.bridge.refresh();
    assert.equal((await f.bridge.view()).paused,false);assert.equal((await f.bridge.view()).nativeStatus,'generating');assert.deepEqual(f.calls,[]);
    f.history.status='completed';f.history.settled=true;f.history.checkpointSha256='compacted-checkpoint';await f.bridge.refresh();
    assert.deepEqual(f.calls,['after native summary']);assert.equal((await f.bridge.view()).paused,false);
  }finally{await f.clean();}
});

test('withdrawing an unconfirmed HTTP submission leaves an idempotent cancellation before a delayed enqueue arrives',async()=>{
  const f=await fixture();try{
    const id=randomUUID();assert.equal(await f.bridge.cancel(id,'withdraw before late request'),true);
    const result=await f.bridge.enqueue('withdraw before late request',id);assert.equal(result.state,'cancelled');await f.bridge.refresh();assert.deepEqual(f.calls,[]);
    await assert.rejects(f.bridge.enqueue('reused for another message',id),/同一请求/);
  }finally{await f.clean();}
});

test('reconciliation and receipts use a native history boundary rather than matching an old identical message or changed timestamps',async()=>{
  const f=await fixture();try{
    const old=randomUUID(),boundary=randomUUID(),fresh=randomUUID();
    f.history.bubbles=[{bubbleId:old,type:1,text:'same text',createdAt:new Date().toISOString()},{bubbleId:boundary,type:2,text:'previous reply'},{bubbleId:fresh,type:1,text:'same text'}];
    const request:CursorFileRequest={version:1,id:randomUUID(),...f.binding,text:'same text',state:'uncertain',createdAt:new Date().toISOString(),beforeBoundary:boundary};
    assert.deepEqual(cursorRequestCandidateIds(request,f.history),[fresh]);
    f.history.bubbles=f.history.bubbles.filter(bubble=>bubble.bubbleId!==boundary);assert.deepEqual(cursorRequestCandidateIds(request,f.history),[],'a missing history boundary cannot establish delivery');
  }finally{await f.clean();}
});

test('closed owners cannot cancel or reconcile records after another process could have acquired the mailbox',async()=>{
  const f=await fixture();try{await f.bridge.close();await assert.rejects(f.bridge.cancel(randomUUID(),'late'),/尚未连接/);await assert.rejects(f.bridge.reconcile(randomUUID()),/尚未连接/);await assert.rejects(f.bridge.pauseQueue(),/尚未连接/);}finally{await f.clean();}
});
