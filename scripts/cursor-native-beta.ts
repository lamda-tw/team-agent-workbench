import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { CursorNativeUi } from './cursor-native-ui';
import { privateBridgeDirectory } from '../src/core/codex-shared-backend';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';

async function serve() {
  const repo = process.cwd();
  const active = JSON.parse(await fs.readFile('.test-data/cursor-native-beta/active.json', 'utf8'));
  if (!/^[a-f0-9-]{36}$/.test(active.sessionId)) throw new Error('请先在原生测试窗口创建会话');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + active.port);
  const ui = new CursorNativeUi(browser, active.sessionId);
  await ui.snapshot();
  const directory = await privateBridgeDirectory(path.join(process.env.LOCALAPPDATA!, 'TeamAgentWorkbench/cursor-native-beta'));
  const route = '/native/' + randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    const target = request.url?.split('/').slice(0, 3).join('/') || '';
    const a = Buffer.from(target), b = Buffer.from(route);
    const authorized = !request.headers.origin && a.length === b.length && timingSafeEqual(a,b);
    const reply = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (!authorized) { reply(403, { message: '连接不属于当前原生联调' }); return; }
    try {
      if (request.method === 'GET' && request.url === route + '/snapshot') { reply(200, await ui.snapshot()); return; }
      if (request.method !== 'POST') { reply(405, { message: '不支持此操作' }); return; }
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 256 * 1024) { reply(413, { message: '消息过长，未发送' }); return; } }
      if (request.url === route + '/send') {
        const value = JSON.parse(body);
        if (typeof value.text !== 'string' || !value.text.trim()) { reply(400, { message: '请输入消息' }); return; }
        reply(200, await ui.send(value.text));
      } else if (request.url === route + '/focus') reply(200, await ui.focus());
      else if (request.url === route + '/stop') reply(200, await ui.stop());
      else if (request.url === route + '/shutdown') { reply(200, {}); setTimeout(()=>process.exit(0),200).unref(); }
      else reply(404, { message: '不支持此操作' });
    } catch (error: any) { reply(409, { message: /^[\u4e00-\u9fff]/.test(error.message) ? error.message : 'Cursor 原生窗口暂时不可用，请打开关联会话后再试' }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const descriptorFile = path.join(directory,'bridge.json');
  await fs.writeFile(descriptorFile, JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:' + (server.address() as any).port + route, sessionId: active.sessionId, workspace: active.workspace, expiresAt: new Date(Date.now()+86400000).toISOString() }));
  const previous = await fs.readFile('.test-data/cursor-native-beta/demo.json','utf8').then(JSON.parse).catch(()=>undefined);
  const reuse = previous?.nativeId === active.sessionId && await fs.stat(previous.userData).then(s=>s.isDirectory()).catch(()=>false);
  const fixtureDirectory = reuse ? previous.fixtureDirectory || previous.directory : directory;
  const userData = reuse ? previous.userData : path.join(directory, 'user'), share = path.join(fixtureDirectory, 'share');
  const portServer = net.createServer(); await new Promise<void>(resolve => portServer.listen(0,'127.0.0.1',resolve));
  const workbenchPort=(portServer.address() as any).port; await new Promise<void>(resolve=>portServer.close(()=>resolve()));
  await fs.mkdir(share,{recursive:true});
  const admin = new LocalAdminConnection(()=>{}), wb = new Workbench(userData,()=>{},()=>{});
  try {
    await admin.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',root:'/srv/teamspace',fingerprint:''},'','',async()=>false);
    await admin.operation({op:'initialize'});
    if (!reuse) await admin.operation({op:'user_create',username:'sync_cursor',name:'Cursor 原生联调',password:'123'});
    const profile=memberProfile(admin.snapshot.profile!,admin.snapshot.state!,'sync_cursor');
    await wb.store.init(); await wb.configureWorkspace(profile,'123',active.workspace,async()=>false);
    let session = reuse ? wb.store.sessions.find(s=>s.id===previous.sessionId) : undefined;
    if (!session) {
      const group: any=await wb.groupCommand({action:'create',label:'Cursor原生同步'});
      const project=await wb.createProject('原生会话联调',group.id,{background:'使用 Cursor 原生窗口验证双向消息与上下文。',objectives:'同一条原生会话在工作台与 Cursor 之间轮流推进。',acceptance:'两端显示消息且能回忆前一端的验证词。',scope:'独立本地共享区和空测试目录。',deliverables:'联调记录',resources:'',constraints:'模型、权限与工具在 Cursor 原生窗口内控制。',collaboration:'同一会话轮流发送。'});
      session=await wb.createSession('cursor',active.workspace,project.id,'work',undefined,undefined,'inherit',false,'direct');
    }
    session.nativeId=active.sessionId; session.title='Cursor 原生同步 Beta 验证'; session.cursorNative={descriptorFile};
    await wb.store.save();
    await fs.writeFile('.test-data/cursor-native-beta/demo.json',JSON.stringify({directory,fixtureDirectory,userData,descriptorFile,sessionId:session.id,nativeId:active.sessionId,workbenchPort,managerPid:process.pid},null,2));
  } finally { await wb.close(); admin.disconnect(); }
  openWorkbench(repo,userData,workbenchPort);
  browser.on('disconnected', () => { server.close(); process.exit(0); });
  console.log('Cursor 原生联调工作台已打开。账号 sync_cursor，密码 123。');
  const timer=setTimeout(()=>{server.close();process.exit(0)},86400000);timer.unref();
}
function openWorkbench(repo:string,userData:string,port:number) {
  spawn(process.execPath,[require.resolve('electron/cli.js'),path.join(repo,'dist/user'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{cwd:repo,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,WORKBENCH_DATA_DIR:userData},detached:true,stdio:'ignore',windowsHide:true}).unref();
}
async function readDemo() { return fs.readFile('.test-data/cursor-native-beta/demo.json','utf8').then(JSON.parse).catch(()=>undefined); }
async function existingConnection(operation:string) {
  const demo=await readDemo(); if (!demo?.managerPid) return false;
  try {
    const descriptor=JSON.parse(await fs.readFile(demo.descriptorFile,'utf8'));
    const endpoint=new URL(descriptor.endpoint);
    if (endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:'||!/^\/native\/[a-f0-9]{64}$/.test(endpoint.pathname))return false;
    const result=await fetch(descriptor.endpoint+'/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000),redirect:'error'});
    if(!result.ok)return false;
    if(operation==='focus') {
      let workbench;
      try {
        workbench=await chromium.connectOverCDP('http://127.0.0.1:'+demo.workbenchPort,{timeout:2000});
        const page=workbench.contexts().flatMap(c=>c.pages())[0];
        if(!page)throw new Error('not ready');
        await page.bringToFront();
        const client=await workbench.newBrowserCDPSession();
        const windows=await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds',{windowId:windows.windowId,bounds:{windowState:'normal'}});
      }catch{openWorkbench(process.cwd(),demo.userData,demo.workbenchPort);}
      // Do not keep CDP clients alive in the short-lived launcher.
      console.log('已打开当前 Cursor 原生同步 Beta。');
      process.exit(0);
    }
    return true;
  }catch{return false;}
}
async function launch() {
  if (await existingConnection('focus')) {console.log('已打开当前 Cursor 原生同步 Beta。');return;}
  const root=path.resolve('.test-data/cursor-native-beta'),workspace=path.join(root,'workspace');
  await fs.mkdir(workspace,{recursive:true});
  const executable=path.join(process.env.LOCALAPPDATA!,'Programs/cursor/Cursor.exe');
  await fs.access(executable);
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','@(Get-Process Cursor -ErrorAction SilentlyContinue).Count'],{windowsHide:true});
  if(Number(stdout.trim()))throw new Error('请保存工作并完全退出 Cursor，再打开此 Beta 入口。Codex 可以保持打开。');
  // A prior manager may still be idle after its user-owned Cursor window exited.
  await existingConnection('shutdown');
  const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as any).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const child=spawn(executable,['--classic','--new-window','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,workspace],{detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});child.unref();
  const deadline=Date.now()+90000;
  let browser;
  while(Date.now()<deadline){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});break;}catch{await new Promise(resolve=>setTimeout(resolve,300));}}
  if(!browser)throw new Error('Cursor 未能打开原生同步连接，请退出 Cursor 后重试。');
  let sessionId='';
  while(Date.now()<deadline){
    for(const page of browser.contexts().flatMap(c=>c.pages())){
      if((await page.title())!==path.basename(workspace)+' - Cursor')continue;
      const composers=page.locator('[data-composer-id]').filter({visible:true});
      if(await composers.count()===1){sessionId=(await composers.getAttribute('data-composer-id'))||'';break;}
      if(await composers.count()===0)await page.keyboard.press('Control+Shift+L');
    }
    if(sessionId)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!sessionId)throw new Error('请在刚打开的 Cursor 测试工作区显示一条原生 Agent 会话，再退出并重试。');
  await fs.writeFile(path.join(root,'active.json'),JSON.stringify({port,pid:child.pid,workspace,sessionId}));
  // Disconnect only this launcher. The user-owned native Cursor must stay open.
  const launcher=path.join(root,'launcher.cjs');
  const log=await fs.open(path.join(root,'manager.log'),'a');
  const manager=spawn(process.execPath,[launcher,'serve'],{cwd:process.cwd(),env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});manager.unref();await log.close();
  const readyDeadline=Date.now()+45000;
  while(Date.now()<readyDeadline){
    const demo=await readDemo();
    if(demo?.managerPid===manager.pid){
      console.log('Cursor 原生同步 Beta 已打开。工作台测试账号：sync_cursor，密码：123。');
      process.exit(0);
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw new Error('原生同步工作台启动未完成，请查看 .test-data/cursor-native-beta/manager.log。');
}
async function main() {
  const mode=process.argv[2]||'serve';
  if(mode==='serve')await serve();
  else if(mode==='launch')await launch();
  else if(mode==='stop'){console.log(await existingConnection('shutdown')?'已停止原生同步后台；Cursor 的原生会话会继续保留。':'原生同步后台未运行。');}
  else if(mode==='check'){await fs.access(path.join(process.env.LOCALAPPDATA!,'Programs/cursor/Cursor.exe'));console.log('已找到 Cursor 桌面程序。');}
  else throw new Error('无效的启动操作');
}
void main().catch(error=>{console.error(error.message);process.exit(1)});
