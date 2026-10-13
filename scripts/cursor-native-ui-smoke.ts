import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { _electron as electron, type Browser } from 'playwright';
import { CursorNativeUi } from './cursor-native-ui';

async function main() {
  const directory=path.resolve('.test-data/cursor-native-ui-smoke');await fs.mkdir(directory,{recursive:true});
  const appFile=path.join(directory,'app.cjs');
  await fs.writeFile(appFile,`const {app,BrowserWindow}=require('electron');
    app.whenReady().then(()=>{const w=new BrowserWindow({show:false});w.loadURL('data:text/html,<html></html>');});`);
  const app=await electron.launch({args:[appFile],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
  try {
    const page=await app.firstWindow();
    const ui=new CursorNativeUi({contexts:()=>[{pages:()=>[page]}]} as unknown as Browser,'native-test');
    const html=`<div data-composer-id="native-test" data-composer-status="completed"><div contenteditable="true" role="textbox"></div></div>
      <div data-message-id="old" data-message-kind="assistant">old reply</div>
      <div data-message-id="hidden" data-message-kind="assistant" style="display:none">must not read</div>
      <div data-message-id="thinking" data-message-kind="thinking">must not read</div>
      <script>window.sent=0;document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();window.sent++;const d=document.createElement('div');d.dataset.messageId='new';d.dataset.messageKind='human';d.innerText=e.target.innerText;document.body.append(d);e.target.innerText='';});</script>`;
    await page.setContent(html);
    assert.deepEqual((await ui.snapshot()).messages.map(x=>x.id),['old']);
    await page.locator('[contenteditable]').fill('my native draft');
    await assert.rejects(ui.send('other'),/草稿/);assert.equal(await page.locator('[contenteditable]').innerText(),'my native draft');assert.equal(await page.evaluate(()=> (window as any).sent),0);
    await page.locator('[contenteditable]').fill('');
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-status','generating'));
    await assert.rejects(ui.send('other'),/正在运行/);assert.equal(await page.evaluate(()=> (window as any).sent),0);
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-status','completed'));
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-id','wrong'));
    await assert.rejects(ui.send('other'),/关联的测试会话/);assert.equal(await page.evaluate(()=> (window as any).sent),0);
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-id','native-test'));
    await page.evaluate(()=>{const d=document.createElement('div');d.dataset.composerId='other';d.innerText='second';document.body.append(d)});
    await assert.rejects(ui.send('other'),/只显示关联会话/);assert.equal(await page.evaluate(()=> (window as any).sent),0);
    await page.locator('[data-composer-id="other"]').evaluate(node=>node.remove());
    assert.deepEqual(await ui.send('actual message'),{submitted:true});assert.equal(await page.evaluate(()=> (window as any).sent),1);
    assert.deepEqual((await ui.snapshot()).messages.map(x=>x.text),['old reply','actual message']);
    await page.evaluate(()=>{(window as any).stopped=0;document.querySelector('[contenteditable]')!.addEventListener('keydown',((e:KeyboardEvent)=>{if(e.key==='Backspace'&&e.ctrlKey&&e.shiftKey){e.preventDefault();(window as any).stopped++;}}) as EventListener);});
    await ui.stop();assert.equal(await page.evaluate(()=> (window as any).stopped),0,'idle cancel must not reject native edits');
    await page.locator('[data-composer-id]').evaluate(node=>node.setAttribute('data-composer-status','generating'));
    await ui.stop();assert.equal(await page.evaluate(()=> (window as any).stopped),1);
    console.log('Native UI guards passed: transcript scope, draft, busy, wrong chat, split panes, one native send. No real account or model used.');
  }finally{await app.close();}
}
void main().catch(error=>{console.error(error);process.exitCode=1});
