import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron } from '@playwright/test';

// Isolated hidden renderer fixture: no real workspace, model or network calls.
const require = createRequire(import.meta.url), root = process.cwd();
await fs.mkdir(path.join(root, '.test-data'), { recursive: true });
const out = await fs.mkdtemp(path.join(root, '.test-data', 'side-chat-ui-'));
const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
let app;
const errors = [];
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionTree } from ${modulePath('src/renderer/subsession-chat')};
import { SelectionActions } from ${modulePath('src/renderer/selection-actions')};
import { ProjectInteractionPanel } from ${modulePath('src/renderer/project-interactions')};
import { SideChatPanel } from ${modulePath('src/renderer/side-chat')};
import ${modulePath('src/renderer/styles.css')};
import ${modulePath('src/renderer/subsession-chat.css')};
import ${modulePath('src/renderer/session-transcript.css')};
import ${modulePath('src/renderer/project-interactions.css')};
const parent={id:'parent',provider:'codex',title:'测试主会话',status:'running',messages:[],sources:[],approvals:[],cwd:'C:/fixture',purpose:'work'};
let chats=[],seq=0;window.fixture={parent,subsessions:0,quote:'',calls:[]};
function App(){
 const [tick,update]=useState(0),[active,select]=useState(''),[selectedId,setSelected]=useState('');
 const refresh=async()=>{update(n=>n+1);};
 const api={subscribe:()=>()=>{},call:async(action,data)=>{
   window.fixture.calls.push({action,data});
   const chat=chats.find(c=>c.id===data?.id);
   if(action==='sidechat.draft')chat.draft=data.text;
   else if(action==='sidechat.send'){
     chat.session.messages.push({id:'u'+Date.now(),role:'user',text:data.text,createdAt:''});chat.draft='';
     chat.session.status='running';refresh();
     setTimeout(()=>{chat.session.messages.push({id:'process'+Date.now(),role:'assistant',text:'我先检查一下上下文。',phase:'commentary',createdAt:''},{id:'answer'+Date.now(),role:'assistant',text:'这是侧聊的最终回答。',phase:'final_answer',createdAt:''});chat.session.status='idle';refresh();},120);
   }else if(action==='sidechat.close')chats=chats.filter(c=>c.id!==data.id);
   else if(action!=='session.completion.read')throw Error('Unexpected API: '+action);
   await refresh();return true;
 }};
 const create=(_parent,text='')=>{const id='chat'+(++seq);chats.push({id,parentId:'parent',projectId:'project',parentTitle:parent.title,capturedAt:'',draft:text,session:{...parent,id,nativeId:id,title:'侧边提问',status:'idle',messages:[]}});setSelected(id);select('sidechats');refresh();};
 window.fixture.expire=()=>{chats[0].expired=true;refresh();};
 return <div style={{display:'flex',height:'100vh',width:'100vw'}}>
 <div aria-label="会话入口" style={{width:270,padding:16,borderRight:'1px solid #ddd'}}><SessionTree sessions={[parent]} selectedId="parent" open={()=>{}} create={()=>{window.fixture.subsessions++;}} promote={()=>{}} rename={async()=>{}}/></div>
 <main style={{flex:1,minWidth:0,padding:24}}><h2>主会话持续生成中</h2><SelectionActions sessionId="parent" add={text=>{window.fixture.quote=text;}} sideChat={text=>create(parent,text)}><p id="selection-source">需要进一步解释的原文</p></SelectionActions></main>
 <ProjectInteractionPanel projectName="测试项目" active={active} select={select} close={()=>select('')} team={false} call={api.call} reload={refresh} questionCount={0} questions={null} subsessions={<p>持久子会话</p>} sideChats={<SideChatPanel chats={chats} selectedId={selectedId} select={setSelected} api={api} changed={refresh}/>}/>
 </div>;
}
window.workbench={call:async()=>{throw Error('No native calls allowed');},subscribe:()=>()=>{}};
createRoot(document.getElementById('root')).render(<App/>);
`);
  await build({ entryPoints: [path.join(out, 'entry.tsx')], outdir: out, entryNames: 'renderer', chunkNames: 'chunk-[hash]', bundle: true, splitting: true, minify: true, platform: 'browser', format: 'esm', target: 'chrome130', loader: { '.woff2': 'file' } });
  await fs.copyFile('src/renderer/index.html', path.join(out, 'index.html'));
  await fs.writeFile(path.join(out, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setName('Side chat fixture');app.setPath('userData',${JSON.stringify(path.join(out, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1300,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(path.join(out, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require('electron'), args: [path.join(out, 'main.cjs')], env, timeout: 20000 });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) errors.push('Unexpected network: ' + request.url()); });
  await page.getByRole('button', { name: '展开会话菜单：测试主会话' }).click();
  const tree = page.getByLabel('会话入口');
  await tree.getByRole('button', { name: '＋ 创建子会话', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.subsessions), 1);
  assert.equal(await tree.getByRole('button', { name: '侧边提问', exact: true }).count(), 0);
  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('selection-source')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  const selectionToolbar = page.getByRole('toolbar', { name: '选中文字操作' });
  await selectionToolbar.waitFor();
  assert.equal(await selectionToolbar.getByRole('button', { name: /子会话/ }).count(), 0);
  await selectionToolbar.getByRole('button', { name: '添加到会话', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixture.quote), '需要进一步解释的原文');
  assert.equal(await page.getByRole('textbox', { name: '侧边提问输入' }).count(), 0);
  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('selection-source')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  await selectionToolbar.getByRole('button', { name: '侧边提问', exact: true }).click();
  const input = page.getByRole('textbox', { name: '侧边提问输入' });
  await input.fill('未发送的问题');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  assert.equal(await input.inputValue(), '未发送的问题');
  await input.press('Enter');
  await page.getByText('这是侧聊的最终回答。', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.locator('.turn-activity-group').getAttribute('open'), null);
  await page.locator('.turn-activity-group summary').click();
  assert(await page.getByText('我先检查一下上下文。', { exact: true }).isVisible());
  await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('selection-source')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
  await page.getByRole('toolbar', { name: '选中文字操作' }).getByRole('button', { name: '侧边提问', exact: true }).click();
  assert.equal(await input.inputValue(), '需要进一步解释的原文');
  assert.equal(await page.getByLabel('临时侧聊列表').getByRole('button').count(), 2);
  await page.getByRole('button', { name: '侧聊 1', exact: true }).click();
  await page.getByRole('button', { name: '关闭侧聊', exact: true }).click();
  await page.getByRole('button', { name: '保留', exact: true }).click();
  assert.equal(await page.getByLabel('临时侧聊列表').getByRole('button').count(), 2);
  await page.getByRole('button', { name: '关闭侧聊', exact: true }).click();
  await page.getByRole('button', { name: '关闭并清除', exact: true }).click();
  assert.equal(await page.getByLabel('临时侧聊列表').getByRole('button').count(), 1);
  assert.equal(await input.inputValue(), '需要进一步解释的原文');
  assert.equal(await page.evaluate(() => window.fixture.parent.status), 'running');
  assert.equal(await page.evaluate(() => window.fixture.subsessions), 1);
  await page.screenshot({ path: path.join(out, 'side-chat.png'), fullPage: true });
  await page.evaluate(() => window.fixture.expire());
  assert(await page.getByRole('button', { name: '发送', exact: true }).isDisabled());
  assert.deepEqual(errors, []);
  console.log('PASS: separate subsession/selection entries, text selection, draft retention, multiple chats, final folding, close isolation, expiration');
  console.log('Screenshot: ' + path.join(out, 'side-chat.png'));
} finally { await app?.close(); }
