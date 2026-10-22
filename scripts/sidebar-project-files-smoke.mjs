import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

// Real application renderer with isolated fixture IPC: no SSH or model calls.
const root=process.cwd();
await fs.mkdir(path.join(root,'.test-data'),{recursive:true});
const out=await fs.mkdtemp(path.join(root,'.test-data','sidebar-project-files-'));
const modulePath=name=>JSON.stringify(path.join(root,name).replaceAll('\\','/'));
const data=makeFixture('case-first-session',6,1,{actor:'Bob',screen:'工作会话',status:'就绪'});
data.snapshot.selectedProjectId=data.project.id;
let browser, server, page;
const errors=[], requests=[];
try {
  await fs.writeFile(path.join(out,'entry.tsx'),`
    import {installFixture} from ${modulePath('scripts/handbook-ui-fixture.mjs')};
    const data=${JSON.stringify(data)}; installFixture(data);
    const original=window.workbench, listeners=[], polls=[];
    const setInterval=window.setInterval.bind(window);
    window.setInterval=(fn,ms,...args)=>{if(ms===30000)polls.push(fn);return setInterval(fn,ms,...args);};
    Object.defineProperty(document,'visibilityState',{get:()=> 'visible'});
    window.workbench={...original,subscribe(listener){listeners.push(listener);return original.subscribe(listener);},call:original.call};
    window.sidebarFixture={poll:()=>polls.forEach(fn=>fn()),setConnected:value=>{data.snapshot.connection.connected=value;listeners.forEach(fn=>fn({type:'state'}));}};
    await import(${modulePath('src/renderer/main.tsx')});
  `);
  await build({entryPoints:[path.join(out,'entry.tsx')],outdir:out,entryNames:'renderer',chunkNames:'chunk-[hash]',bundle:true,splitting:true,format:'esm',platform:'browser',target:'chrome130',loader:{'.woff2':'file','.woff':'file','.ttf':'file'}});
  await fs.copyFile('src/renderer/index.html',path.join(out,'index.html'));
  server=http.createServer(async(req,res)=>{try{
    const name=path.basename(new URL(req.url,'http://localhost').pathname)||'index.html';
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[path.extname(name)]||'application/octet-stream');
    res.end(await fs.readFile(path.join(out,name)));
  }catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:'))requests.push(request.url());});
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.locator('.sidebar').waitFor();
  await page.locator('[data-project-id="'+data.project.id+'"]').click();
  const check=async()=>{
    await expect(page.locator('.sidebar .path-row, #sidebar-file-list, .sidebar input[placeholder="筛选当前目录"]')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'上传文件到当前目录',exact:true})).toHaveCount(0);
    await expect(page.getByRole('separator',{name:'调整项目文件高度',exact:true})).toHaveCount(0);
    await expect(page.getByRole('separator',{name:'调整会话列表高度',exact:true})).toHaveCount(0);
    await expect(page.locator('[data-session-id="'+data.session.id+'"]').first()).toBeVisible();
    await expect(page.locator('.rail').getByRole('button',{name:'项目成果库',exact:true})).toBeEnabled();
    const bounds=await page.locator('.sidebar').evaluate(sidebar=>{
      const a=sidebar.getBoundingClientRect(),list=sidebar.querySelector('#sidebar-session-list').getBoundingClientRect();
      return {height:sidebar.clientHeight,scroll:sidebar.scrollHeight,top:list.top,bottom:list.bottom,outerTop:a.top,outerBottom:a.bottom,flex:getComputedStyle(sidebar.querySelector('#sidebar-session-list')).flexGrow};
    });
    assert(bounds.scroll<=bounds.height+1 && bounds.top>=bounds.outerTop && bounds.bottom<=bounds.outerBottom+1,JSON.stringify(bounds));
    assert.equal(bounds.flex,'1');
  };
  for(const [width,height] of [[1440,960],[1100,720]]){
    await page.setViewportSize({width,height});await check();
    await page.screenshot({path:path.join(out,`sidebar-${width}.png`),timeout:10000});
  }
  await page.evaluate(()=>window.sidebarFixture.poll());
  await expect.poll(()=>page.evaluate(()=>window.__handbook.calls.filter(action=>action==='remote.manifest').length)).toBeGreaterThan(0);
  assert.equal(await page.evaluate(()=>window.__handbook.calls.filter(action=>action==='remote.list').length),0,'hidden browser must not poll the remote filesystem');
  await page.evaluate(()=>window.sidebarFixture.setConnected(false));await check();
  await page.evaluate(()=>window.sidebarFixture.setConnected(true));await check();
  await page.reload();await page.locator('[data-project-id="'+data.project.id+'"]').click();await check();
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  const result={passed:true,cases:['remote directory controls hidden','session list fills available height','project results entry remains usable','normal and narrow windows','refresh does not request remote files','disconnect and reconnect','reload'],output:out};
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} catch(error){await page?.screenshot({path:path.join(out,'failure.png'),timeout:10000}).catch(()=>{});console.error('Fixture:',out);throw error;}
finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
