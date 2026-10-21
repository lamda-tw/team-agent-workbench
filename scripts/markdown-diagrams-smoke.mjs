import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron } from '@playwright/test';

const require = createRequire(import.meta.url), root = process.cwd();
const out = await fs.mkdtemp(path.join(root, '.test-data', 'markdown-diagrams-'));
const source = await fs.readFile('tests/fixtures/extraction-flowchart.mmd', 'utf8');
const errors = [], remoteRequests = [];
let app;
async function closeFixture() {
  if(!app)return;
  const current=app;app=undefined;
  await current.close();
}
try {
  const entry = path.join(out, 'entry.tsx');
  const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
  await fs.writeFile(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Markdown } from ${modulePath('src/renderer/markdown')};
    import { renderMermaid } from ${modulePath('src/renderer/mermaid-renderer')};
    import ${modulePath('src/renderer/styles.css')};
    const root=createRoot(document.getElementById('root'));
    window.diagramFixture={render:text=>root.render(<Markdown text={text} sessionId="fixture"/>),renderMermaid};
    window.workbench={call:async()=>{throw Error('Diagram rendering must not read local images or invoke a model');}};
  `);
  // Match production ESM splitting and CSP so lazy imports are actually exercised.
  await build({ entryPoints:[entry],outdir:out,entryNames:'renderer',chunkNames:'chunk-[hash]',splitting:true,bundle:true,minify:true,platform:'browser',format:'esm',target:'chrome130' });
  await fs.copyFile('src/renderer/index.html', path.join(out, 'index.html'));
  await fs.writeFile(path.join(out, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    app.setName('Markdown diagram fixture');app.setPath('userData',${JSON.stringify(path.join(out,'profile'))});
    app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});
    app.on('window-all-closed',()=>app.quit());
  `);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:require('electron'),args:[path.join(out,'main.cjs')],env,timeout:20000});
  const page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url()))remoteRequests.push(request.url());});
  await page.waitForFunction(()=>!!window.diagramFixture);
  const render=text=>page.evaluate(text=>window.diagramFixture.render(text),text);
  const loaded=count=>page.waitForFunction(count=>{
    const images=[...document.querySelectorAll('.mermaid-diagram-image')];
    return images.length===count&&images.every(image=>image.complete&&image.naturalWidth>0);
  },count,{timeout:20000});

  for(const text of [source,'```mermaid\n'+source+'\n```','```\n'+source+'\n```']){
    await render(text);await loaded(1);
    const diagram=await page.evaluate(()=>{
      const image=document.querySelector('.mermaid-diagram-image');
      const svg=decodeURIComponent(image.getAttribute('src').split(',').slice(1).join(','));
      const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
      return {nodes:doc.querySelectorAll('g.node').length,clusters:doc.querySelectorAll('g.cluster').length,text:doc.documentElement.textContent};
    });
    assert.equal(diagram.nodes,16);assert.equal(diagram.clusters,1);
    for(const label of ['输入原文与本体 Schema','跨块去重合并','采用修正结果','回退初次结果并重新执行清理','最终实体、关系、统计及调用记录'])assert(diagram.text.replace(/\s+/g,'').includes(label.replace(/\s+/g,'')),label);
  }
  const image=page.locator('.mermaid-diagram-image');
  await page.getByRole('button',{name:'放大',exact:true}).click();
  assert.equal(await image.evaluate(element=>element.style.width),'125%');
  await page.getByRole('button',{name:'适应宽度',exact:true}).click();
  assert.equal(await image.evaluate(element=>element.style.width),'100%');

  await render('```mermaid\nflowchart TD\n A[未完成\n```');
  await page.getByText('图表语法尚未完整或有误，可展开源码查看。',{exact:true}).waitFor();
  assert.equal(await page.locator('.mermaid-diagram details').getAttribute('open'),'');
  await render('```mermaid\nflowchart TD\n A[完成] --> B[继续]\n```');await loaded(1);
  assert.equal(await page.locator('.mermaid-diagram [role="status"]').count(),0);

  await render('```mermaid\nflowchart TD\n A-->B\n```\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: hello\n```');await loaded(2);
  await render('```text\nflowchart TD\n A-->B\n```');
  await page.waitForFunction(()=>document.querySelector('code.language-text')?.textContent.includes('flowchart TD'));
  assert.equal(await page.locator('.mermaid-diagram').count(),0);

  const sanitized=await page.evaluate(()=>window.diagramFixture.renderMermaid('%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart TD\n A[安全] --> B[结束]\n click A "javascript:alert(1)"'));
  assert(!/<script\b|\son\w+\s*=|(?:href|xlink:href)=["']javascript:/i.test(sanitized));
  await assert.rejects(page.evaluate(()=>window.diagramFixture.renderMermaid('a'.repeat(50001))),/图表内容过长/);
  assert.deepEqual(errors,[]);assert.deepEqual(remoteRequests,[]);
  await closeFixture();

  const result={passed:true,screenshots:0,realImageFilesRead:0,externalRequests:remoteRequests.length,cases:['provided extraction flowchart: 16 nodes and one subgraph','fenced and standalone source','zoom and fit width','invalid and incomplete syntax fallback and recovery','multiple diagram types in one reply','explicit source examples stay as code','strict rendering and text limits','lazy chunks under production CSP'],fixture:out};
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(error){
  console.error(JSON.stringify({errors,remoteRequests,fixture:out}));throw error;
}finally{await closeFixture();}
