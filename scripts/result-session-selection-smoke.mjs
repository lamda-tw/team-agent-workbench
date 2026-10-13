import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root=process.cwd(), out=path.join(root,'artifacts','result-session-selection');
await fs.mkdir(out,{recursive:true});
await build({stdin:{resolveDir:root,loader:'tsx',contents:`
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import {ConclusionLibrary} from './src/renderer/conclusions';import {SharedContentLibrary} from './src/renderer/shared-content';
  import './src/renderer/styles.css';import './src/renderer/result-card.css';
  function App(){
    const [sessions,setSessions]=useState(window.fixture.sessions);
    window.setClosed=(id,closed)=>setSessions(current=>current.map(session=>session.id===id?{...session,closedAt:closed?'2026-10-12T00:00:00Z':undefined}:session));
    const team=new URLSearchParams(location.search).get('scope')==='team';
    return <main style={{padding:24}}>{team?
      <SharedContentLibrary project={window.fixture.project} username="alice" admin={false} aliases={{}} aliasSaved={async()=>{}} attachSessions={sessions} mergeSessions={sessions} notice={()=>{}} mergeStarted={()=>{}} attach={async(item,ids)=>{for(const id of ids)await window.workbench.call('session.attachContent',{id,contentId:item.id});}}/>:
      <ConclusionLibrary project={window.fixture.project} sessions={sessions} notice={()=>{}} mergeStarted={()=>{}}/>}</main>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
`},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'ui.js'),logLevel:'silent'});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
await page.addInitScript(()=>{
  const now='2026-10-12T00:00:00Z',project={id:'project-a',name:'竞赛优化',remoteRoot:'/p',uploadPath:'/p/submissions/alice',historyPath:'/p/trajectories/alice'};
  const session=(id,title,provider,extra={})=>({id,title,provider,purpose:'work',messages:[],sources:[],approvals:[],status:'idle',binding:{username:'alice',project},...extra});
  const item={id:'00000000-0000-4000-8000-000000000001',projectId:project.id,title:'验收目标',category:'project_goal',resultStatus:'confirmed',content:'减少量化误差，覆盖官方样例。',description:'减少量化误差，覆盖官方样例。',version:1,revision:1,sources:[],versions:[],kind:'contribution',state:'submitted',author:'alice',updatedBy:'alice',createdAt:now,updatedAt:now,path:'/p/result.md',sha256:'a'.repeat(64),size:1};
  window.fixture={project,sessions:[session('open','可用会话','codex'),session('running','正在运行','cursor',{status:'running'}),session('closed','已关闭会话','claude',{closedAt:now}),session('helper','整理任务','codex',{purpose:'prepare'}),session('foreign','另一项目','codex',{binding:{username:'alice',project:{...project,id:'other-project'}}})]};
  window.calls=[];
  window.workbench={subscribe:()=>()=>{},call:async(action,payload)=>{
    window.calls.push({action,payload});
    if(action==='conclusion.list')return [structuredClone(item)];
    if(action==='content.list')return [structuredClone(item)];
    if(action==='content.history')return [];
    if(action==='session.attachConclusion'||action==='session.attachContent')return {id:'source'};
    throw Error('Unexpected test API '+action);
  }};
});
const choose=async()=>{
  const button=page.getByRole('button',{name:'加入会话',exact:true,includeHidden:true});
  if(!await button.isVisible())await button.locator('xpath=ancestor::details[contains(@class,"result-more")]').locator('summary').click();
  return button;
};
try{
  for(const scope of ['personal','team']){
    await page.goto(pathToFileURL(path.join(out,'index.html')).href+'?scope='+scope);
    await expect(page.locator('.result-card')).toHaveCount(1);await (await choose()).click();
    const dialog=page.getByRole('dialog',{name:scope==='personal'?'选择使用成果的会话':'选择加入的会话',exact:true});
    await expect(dialog.locator('input[type=checkbox]')).toHaveCount(2);
    for(const text of ['已关闭会话','整理任务','另一项目'])await expect(dialog).not.toContainText(text);
    await expect(dialog).toContainText('正在运行');
    await dialog.locator('input[type=checkbox]').first().check();await expect(dialog.getByRole('button',{name:'加入 1 个会话',exact:true})).toBeEnabled();
    await page.evaluate(()=>window.setClosed('open',true));
    await expect(dialog).not.toContainText('可用会话');await expect(dialog.getByRole('button',{name:'加入 0 个会话',exact:true})).toBeDisabled();
    await page.evaluate(()=>window.setClosed('open',false));
    await expect(dialog.locator('input[type=checkbox]').first()).not.toBeChecked();
    await dialog.locator('input[type=checkbox]').first().check();await dialog.getByRole('button',{name:'加入 1 个会话',exact:true}).click();await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(()=>window.calls.filter(call=>call.action.startsWith('session.attach')).map(call=>call.payload.id))).toEqual(['open']);
    await page.evaluate(()=>{window.setClosed('open',true);window.setClosed('running',true);});
    await expect(await choose()).toBeDisabled();await expect(await choose()).toHaveAttribute('title','请先创建或重新打开当前项目的工作会话');
    await page.evaluate(()=>window.setClosed('closed',false));await expect(await choose()).toBeEnabled();await (await choose()).click();
    await expect(dialog.locator('input[type=checkbox]')).toHaveCount(1);await expect(dialog).toContainText('Claude Code');
    await page.screenshot({path:path.join(out,scope+'-reopened.png')});
    await page.evaluate(()=>window.setClosed('closed',true));await expect(dialog).toContainText('当前项目没有打开的工作会话');await expect(dialog.getByRole('button',{name:'加入 0 个会话',exact:true})).toBeDisabled();
    checks.push(scope+': closed/helper/other-project hidden; running allowed; closing prunes selection; reopening returns unselected; only open targets submitted; no open targets disables entry');
  }
  expect(errors).toEqual([]);await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,out}));
}catch(error){await page.screenshot({path:path.join(out,'failure.png')});throw error;}finally{await browser.close();}
