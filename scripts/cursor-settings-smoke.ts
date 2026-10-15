import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { cursorIdePage } from '../src/core/cursor-ide-page';
import { cursorIdeSettings } from '../src/core/cursor-ide-settings';

// Synthetic native DOM contracts + the real Workbench React component. This
// process never attaches to Cursor or uses a personal account/model.
async function main(){
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage(),id='11111111-1111-4111-8111-111111111111',cwd='D:/synthetic';
  await page.evaluate('window.__name=fn=>fn');
  await page.setContent(`<div data-composer-id="${id}" data-composer-status="completed"><div contenteditable="true" role="textbox"></div><button class="vscode-model-picker__trigger">Auto</button><button id="native-mode" class="composer-unified-dropdown" data-mode="agent">Agent</button></div><div data-message-id="old">Previous native answer</div>`);
  await page.evaluate(()=>{
   (window as any).vscode={context:{resolveConfiguration:async()=>({workspace:{uri:{scheme:'file',path:'/D:/synthetic'}}})}};
   const calls:any[]=(window as any).calls=[];
   const model:any=(window as any).model={models:[{name:'default',displayName:'Auto'},{name:'model-b',displayName:'Model B'},{name:'hidden',defaultOn:false}],state:{selections:[{modelId:'default',count:1,parameters:{reasoning:'medium'}}],maxMode:false},selectModel:(value:string)=>calls.push(['model',value]),setAutoMode:(value:boolean)=>calls.push(['auto',value])};
   const approval:any=(window as any).approval={autorunMode:'ask_every_time',availableAutorunModes:[{mode:'ask_every_time',label:'Ask Every Time'},{mode:'smart_auto',label:'Auto-review',sandboxBacked:false},{mode:'run_everything',label:'Run Everything',disabled:true}],sandboxAutoRunSettingEnabled:false,onSetAutorunMode:(mode:string,sandbox:boolean)=>calls.push(['permission',mode,sandbox])};
   const committed:any={stateNode:{}},modelProvider:any={memoizedProps:{value:model},return:committed},permissionProvider:any={memoizedProps:{toolApprovalContext:approval},return:committed};
   committed.child=modelProvider;modelProvider.sibling=permissionProvider;committed.stateNode.current=committed;
   const button:any=document.querySelector('.vscode-model-picker__trigger'),bubble:any=document.querySelector('[data-message-id]');
   modelProvider.child={stateNode:button,return:modelProvider};permissionProvider.child={stateNode:bubble,return:permissionProvider};
   // Deliberately stale DOM fiber. Only HostRoot.current is safe to invoke.
   const staleRoot:any={stateNode:{current:committed}},staleProvider:any={return:staleRoot,memoizedProps:{value:{...model,selectModel:()=>calls.push(['STALE'])}}};
   button.__reactFiber$test={stateNode:button,return:staleProvider};bubble.__reactFiber$test=permissionProvider.child;
   const modeButton=document.querySelector<HTMLButtonElement>('.composer-unified-dropdown')!;
   modeButton.onclick=()=>{
    const previous=document.querySelector('#mode-menu');if(previous){previous.remove();return;}
    const menu=document.createElement('div');menu.id='mode-menu';
    for(const [id,label]of [['agent','Agent'],['plan','Plan'],['multitask','Multitask']]){const row=document.createElement('button');row.id=`composer-mode-native-mode-${id}`;row.innerText=label;row.onclick=()=>{calls.push(['mode',id]);modeButton.dataset.mode=id;modeButton.innerText=label;menu.remove();};menu.append(row);}document.body.append(menu);
   };
   (window as any).sent=0;document.querySelector('[contenteditable]')!.addEventListener('keydown',(event:any)=>{if(event.key==='Enter'){event.preventDefault();(window as any).sent++;}});
  });
  const call=(operation:string,extra:object={})=>page.evaluate(`(()=>{const __name=fn=>fn;return (${cursorIdePage.toString()})(${JSON.stringify({operation,id,cwd,token:'anchor',...extra})},${cursorIdeSettings.toString()});})()`);
  let state=await call('settings');assert.equal(state.state,'ready');assert.equal(state.permission.label,'Ask Every Time');assert.equal(state.model.options.length,2);
  await call('settingsChange',{kind:'model',value:'model-b',revision:state.revision});assert.deepEqual(await page.evaluate(()=>(window as any).calls),[['model','model-b']]);
  assert.equal((await call('settings')).model.id,'default','a callback is not a read-back acknowledgement');
  await assert.rejects(call('settingsChange',{kind:'model',value:'hidden',revision:state.revision}),/不允许/);
  await assert.rejects(call('settingsChange',{kind:'permission',value:'run_everything',revision:state.revision}),/不允许/);
  await call('settingsChange',{kind:'permission',value:'smart_auto:no-sandbox',revision:state.revision});assert.equal((await call('settings')).permission.id,'ask_every_time');
  assert.deepEqual(await page.evaluate(()=>(window as any).calls),[['model','model-b'],['permission','smart_auto',false]]);
  assert.equal((await call('settingsOpenMode')).modeMenuOpened,true);assert.equal((await call('settingsOpenMode')).modeMenuOpened,false);
  state=await call('settings');assert.equal(state.mode.options.find((o:any)=>o.id==='multitask').disabled,true);
  await call('settingsChange',{kind:'mode',value:'plan',revision:state.revision});assert.equal((await call('settings')).mode.id,'plan');
  await assert.rejects(call('settingsChange',{kind:'model',value:'model-b',revision:state.revision}),/已经变化/);
  await call('prepareSend');await page.locator('[contenteditable]').fill('same native history');await call('submit',{text:'same native history'});assert.equal(await page.evaluate(()=>(window as any).sent),1);
  await page.locator('[contenteditable]').fill('');await call('prepareSend');await page.locator('[contenteditable]').fill('must not use stale settings');
  await page.evaluate(()=>{(window as any).model.state.selections[0].parameters.reasoning='high';});
  await assert.rejects(call('submit',{text:'must not use stale settings'}),/设置在发送前/);assert.equal(await page.evaluate(()=>(window as any).sent),1);
  assert.equal(await page.locator('[contenteditable]').innerText(),'must not use stale settings');
  await page.evaluate(()=>{(window as any).model.state.multiModelMode=true;});assert.equal((await call('settings')).state,'unavailable');await assert.rejects(call('prepareSend'),/设置/);
  await page.evaluate(()=>{(window as any).model.state.multiModelMode=false;document.querySelector('[data-composer-id]')!.setAttribute('data-composer-status','generating');});
  await assert.rejects(call('settingsChange',{kind:'model',value:'model-b',revision:(await call('settings')).revision}),/当前回复/);
  await assert.rejects(call('settings',{cwd:'D:/wrong'}),/工作目录/);
  await page.evaluate(()=>{document.querySelector('[data-composer-id]')!.setAttribute('data-composer-status','completed');const dialog=document.createElement('div');dialog.setAttribute('role','dialog');document.body.append(dialog);});
  await assert.rejects(call('settingsChange',{kind:'permission',value:'smart_auto:no-sandbox',revision:(await call('settings')).revision}),/原生确认/);

  const output=path.resolve('.test-data','cursor-settings-ui-'+Date.now());await fs.mkdir(output,{recursive:true});
  const component=path.resolve('src/renderer/cursor-native-settings').replaceAll('\\','/'),styles=path.resolve('src/renderer/styles.css').replaceAll('\\','/');
  await fs.writeFile(path.join(output,'entry.tsx'),`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CursorNativeSettingsControls}from'${component}';import'${styles}';function App(){const[s,set]=useState({id:'session',desktopSyncState:'connected'});window.showSession=set;return <div style={{padding:'450px 20px 30px'}}><CursorNativeSettingsControls session={s}/></div>;}createRoot(document.getElementById('root')).render(<App/>);`);
  await build({entryPoints:[path.join(output,'entry.tsx')],bundle:true,outfile:path.join(output,'ui.js'),platform:'browser',jsx:'automatic'});
  await fs.writeFile(path.join(output,'index.html'),'<meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>');
  const ui=await browser.newPage({viewport:{width:1000,height:850}}),errors:string[]=[];ui.on('pageerror',e=>errors.push(e.message));
  await ui.addInitScript('window.calls=[];window.workbench={call:async(action,payload)=>{window.calls.push({action,payload});return window.catalog;}}');
  await ui.goto(pathToFileURL(path.join(output,'index.html')).href);
  const catalog={state:'ready',revision:'native-revision',model:{id:'auto',label:'Auto',options:[{id:'auto',label:'Auto'},{id:'next',label:'Next native model'},{id:'disabled',label:'Policy disabled model',disabled:true}]},mode:{id:'plan',label:'Plan',options:[{id:'plan',label:'Plan'}]},permission:{id:'ask',label:'Ask Every Time',options:[]}};
  const show=async(extra:object={})=>ui.evaluate(({catalog,extra})=>{(window as any).catalog=catalog;(window as any).showSession({id:'session',desktopSyncState:'connected',cursorSettings:catalog,...extra});},{catalog,extra});
  await show();await ui.getByRole('button',{name:'Cursor 模型',exact:true}).click();await expect(ui.getByRole('button',{name:'Policy disabled model'})).toBeDisabled();await ui.getByRole('button',{name:'Next native model'}).click();
  await expect(ui.getByRole('button',{name:'Cursor 模型',exact:true})).toContainText('Auto');
  const commands=await ui.evaluate(()=>(window as any).calls);assert.deepEqual(commands[1],{action:'session.cursorNative.settings',payload:{id:'session',kind:'model',value:'next',revision:'native-revision'}});
  await show({cursorSettings:{...catalog,pending:{kind:'model',label:'Next native model',state:'waiting'}}});await expect(ui.getByRole('status')).toContainText('等待本轮结束');await expect(ui.getByRole('button',{name:'Cursor 模型',exact:true})).toBeDisabled();await ui.getByRole('button',{name:'取消更改',exact:true}).click();
  await show({cursorSettings:{...catalog,pending:{kind:'permission',state:'error',error:'Native confirmation pending'}}});await expect(ui.getByRole('status')).toContainText('Native confirmation pending');await ui.getByRole('button',{name:'沿用 Cursor 当前设置'}).click();
  await show({desktopSyncState:'disconnected'});await expect(ui.getByRole('button',{name:'Cursor 模式',exact:true})).toBeDisabled();
  await ui.getByRole('button',{name:'在 Cursor 中打开'}).click();assert.deepEqual((await ui.evaluate(()=>(window as any).calls)).at(-1),{action:'session.cursorNative.focus',payload:{id:'session'}});assert.deepEqual(errors,[]);
  console.log('Cursor settings passed: committed native handlers, native catalogs/disabled policies, read-back, stale parameters, Plan, single-executor guard, busy/modal barrier, no optimistic selection, cancellation and scoped UI IPC. Synthetic only.');
 }finally{await browser.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
