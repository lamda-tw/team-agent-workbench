import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron, expect } from '@playwright/test';
import { makeFixture } from './handbook-ui-fixture.mjs';

const root = process.cwd(), require = createRequire(import.meta.url);
const out = await fs.mkdtemp(path.join(root, '.test-data', 'central-recovery-'));
const modulePath = name => JSON.stringify(path.join(root, name).replaceAll('\\', '/'));
const data = makeFixture('case-first-session', 6, 1, { actor: 'Bob', screen: '工作会话', status: '就绪' });
data.snapshot.connection.connected = false;
data.snapshot.selectedProjectId = data.project.id;
let app;
try {
  await fs.writeFile(path.join(out, 'entry.tsx'), `
    import { installFixture } from ${modulePath('scripts/handbook-ui-fixture.mjs')};
    import { accountIdentity } from ${modulePath('src/shared/account-data')};
    const data = ${JSON.stringify(data)};
    data.snapshot.reusableConnections = [{key:accountIdentity(data.profile),profile:data.profile}];
    installFixture(data);
    const original = window.workbench, listeners = [], polls = [], calls = [];
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, ms, ...args) => { if(ms === 30000) polls.push(callback); return interval(callback, ms, ...args); };
    Object.defineProperty(document, 'visibilityState', {get:()=> 'visible'});
    window.workbench = {
      subscribe(listener) { listeners.push(listener); const unsubscribe = original.subscribe(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); unsubscribe(); }; },
      async call(action, payload) {
        action = action.replace(/^personal:/, '');
        calls.push({action,payload});
        if(action === 'remote.manifest' && !data.snapshot.connection.connected) throw new Error('中央节点连接已断开，请重新连接后再试');
        if(action === 'remote.connect') { data.snapshot.connection.connected = true; return structuredClone(data.profile); }
        return original.call(action,payload);
      }
    };
    window.centralFixture = {
      calls, poll:()=>polls.forEach(fn=>fn()),
      notice:message=>listeners.forEach(fn=>fn({type:'notice',message})),
      disconnect:()=>{data.snapshot.connection.connected=false;listeners.forEach(fn=>fn({type:'state'}));}
    };
    await import(${modulePath('src/renderer/main.tsx')});
  `);
  await build({entryPoints:[path.join(out,'entry.tsx')],outdir:out,entryNames:'renderer',chunkNames:'chunk-[hash]',splitting:true,bundle:true,minify:true,platform:'browser',format:'esm',target:'chrome130',loader:{'.woff2':'file','.woff':'file','.ttf':'file'}});
  await fs.copyFile('src/renderer/index.html',path.join(out,'index.html'));
  await fs.writeFile(path.join(out,'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    app.setName('Central connection regression');app.setPath('userData',${JSON.stringify(path.join(out,'profile'))});
    app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});
    app.on('window-all-closed',()=>app.quit());
  `);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:require('electron'),args:[path.join(out,'main.cjs')],env,timeout:20000});
  const page=await app.firstWindow(), errors=[], remoteRequests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url()))remoteRequests.push(request.url());});
  await page.locator('.sidebar').waitFor();
  const reconnect=page.locator('.sidebar').getByRole('button',{name:'重新连接中央节点',exact:true});
  // A remembered node must be reachable before the first failing poll runs.
  await expect(reconnect).toBeVisible();
  await reconnect.click();
  await expect(page.getByRole('heading',{name:'重新连接中央节点',exact:true})).toBeVisible();
  await expect(page.getByLabel('中央节点地址',{exact:true})).toHaveValue(data.profile.host);
  await expect(page.getByLabel('成员账号',{exact:true})).toHaveValue(data.profile.username);
  await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await page.evaluate(()=>window.centralFixture.poll());
  const error=page.locator('.sidebar .central-connection-error').filter({hasText:'中央节点连接已断开'});
  await expect(error).toBeVisible();
  await expect(reconnect).toHaveCount(1);
  await error.getByRole('button',{name:'重新连接中央节点',exact:true}).click();
  const modal=page.locator('.modal').filter({has:page.getByRole('heading',{name:'重新连接中央节点',exact:true})});
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('中央节点地址',{exact:true})).toHaveValue(data.profile.host);
  await expect(modal.getByLabel('成员账号',{exact:true})).toHaveValue(data.profile.username);
  await expect(modal.getByLabel('登录密码',{exact:true})).toHaveValue('');
  await modal.getByLabel('登录密码',{exact:true}).fill('fixture-password');
  await modal.getByRole('button',{name:'连接',exact:true}).click();
  await expect(modal).toHaveCount(0);
  await expect(error).toHaveCount(0);
  await expect(reconnect).toHaveCount(0);
  const connections=await page.evaluate(()=>window.centralFixture.calls.filter(c=>c.action==='remote.connect'));
  assert.equal(connections.length,1);
  assert.equal(connections[0].payload.profile.host,data.profile.host);
  assert.equal(connections[0].payload.profile.username,data.profile.username);
  assert.equal(connections[0].payload.password,'fixture-password');
  // A snapshot refresh clears the old error; recovery must still be available.
  await page.evaluate(()=>window.centralFixture.disconnect());
  await expect(error).toHaveCount(0);
  await expect(reconnect).toBeVisible();
  await reconnect.click();
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('登录密码',{exact:true})).toHaveValue('');
  await modal.getByRole('button',{name:'关闭窗口',exact:true}).click();
  await page.evaluate(()=>window.centralFixture.notice('Cursor 连接已断开，点击“在 Cursor 中打开”重新连接'));
  const toast=page.locator('.toast').filter({hasText:'Cursor 连接已断开'});
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button',{name:'重新连接中央节点',exact:true})).toHaveCount(0);
  await page.clock.install();
  await page.evaluate(()=>window.centralFixture.notice('中央节点连接已断开，请重新连接后再试'));
  const centralToast=page.locator('.toast').filter({hasText:'中央节点连接已断开'});
  await expect(centralToast.getByRole('button',{name:'重新连接中央节点',exact:true})).toBeVisible();
  await page.clock.fastForward(9000);
  await expect(centralToast).toBeVisible();
  assert.deepEqual(errors,[]);
  assert.deepEqual(remoteRequests,[]);
  console.log('Central connection UI passed: recovery before errors and after snapshot refresh, no duplicate recovery buttons, saved node/account, forced password despite stale reuse, successful reconnection, native CLI separation, persistent recovery notice. No screenshots or images read.');
} finally { if(app) await app.close(); }
