import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import type { SharedContent } from '../src/shared/content';

test('closed targets reject personal and team results; reopening restores both capabilities',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-closed-results-')),wb=new Workbench(root,()=>{},()=>{});
  try{
    await wb.store.init();grantTestWorkspace(wb,root);
    const session=await wb.createSession('codex',root,offlineProjectId),local=await wb.createConclusion(offlineProjectId,'验证范围','只验证官方样例。');
    const remote:SharedContent={id:'remote-result',title:'团队验证范围',description:'包括长尾样例。',kind:'contribution',state:'submitted',revision:1,path:'/projects/test/P/result.md',author:'alice',updatedBy:'alice',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),size:1,sha256:'a'.repeat(64)};
    let reads=0;wb.remote.contentList=async()=>{reads++;return [remote];};
    await wb.closeSession(session.id);
    await assert.rejects(wb.attachConclusion(session.id,local.id),/未关闭/);await assert.rejects(wb.attachContent(session.id,remote.id),/未关闭/);
    assert.equal(reads,0);assert.equal(session.sources.length,0);
    await wb.reopenSession(session.id);await wb.attachConclusion(session.id,local.id);await wb.attachContent(session.id,remote.id);
    assert.equal(session.sources.length,2);assert.equal(reads,1);
    await wb.closeSession(session.id);await assert.rejects(wb.attachContent(session.id,remote.id),/未关闭/);assert.equal(session.sources.length,2,'closing preserves references already attached');
  }finally{await wb.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('closing while a team result is being fetched never appends a reference',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-closing-result-')),wb=new Workbench(root,()=>{},()=>{});
  try{
    await wb.store.init();grantTestWorkspace(wb,root);const session=await wb.createSession('codex',root,offlineProjectId);
    let finish!:(items:SharedContent[])=>void,started!:()=>void;
    const reading=new Promise<void>(resolve=>started=resolve),gate=new Promise<SharedContent[]>(resolve=>finish=resolve);
    wb.remote.contentList=()=>{started();return gate;};
    const attaching=wb.attachContent(session.id,'remote-result');
    const rejected=assert.rejects(attaching,/未关闭/);await reading;await wb.closeSession(session.id);
    finish([{id:'remote-result',title:'结果',description:'验证记录',kind:'contribution',state:'submitted',revision:1,path:'/projects/test/P/result.md',author:'alice',updatedBy:'alice',createdAt:'',updatedAt:'',size:1,sha256:'a'.repeat(64)}]);
    await rejected;assert.equal(session.sources.length,0);
  }finally{await wb.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
