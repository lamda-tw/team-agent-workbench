import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { CodexDesktopService } from '../src/core/codex-desktop-service';
import { installedCodexDesktopExecutable } from '../src/core/codex-shared-backend';
import { resolveProvider } from '../src/core/providers';
import { WebSocketRpc } from '../src/core/websocket-rpc';
import { AgentRuntime } from '../src/core/agents';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { processAlive } from '../src/core/codex-process';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function stopBridge(endpoint:string) {
  const url=new URL(endpoint);url.protocol='http:';url.pathname+='/stop';
  return new Promise<void>(resolve=>{const request=http.request(url,{method:'POST',agent:false,signal:AbortSignal.timeout(5000)},response=>{response.on('error',()=>resolve());response.resume();resolve();});request.on('error',()=>resolve());request.end();});
}
async function until(check:()=>Promise<boolean>|boolean){const end=Date.now()+35000;while(!await check()){if(Date.now()>end)throw new Error('workflow fixture timed out');await pause(50);}}
async function main(){
  const root=path.resolve('.test-data','codex-workflow-'+Date.now()),personal=path.join(root,'personal'),userData=path.join(root,'user'),share=path.join(root,'share');
  await fs.mkdir(personal,{recursive:true});await fs.mkdir(share,{recursive:true});
  const requests:string[]=[],priorHome=process.env.CODEX_HOME,priorBridge=process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  let concurrent=0,maxConcurrent=0,release:undefined|(()=>void),hold=false,starts=0,halfHold=false,desktopOpens=0,desktopRunning=false;
  const openedThreads:string[]=[];
  const requestedTools = new Set<string>();
  const responses=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.method!=='POST'||!req.url?.endsWith('/responses')){res.writeHead(404);res.end();return;}
    requests.push(body);concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
    if (process.argv.includes('--extended') && requests.length === 1) {
      const tools = JSON.parse(body).tools || [];
      await fs.writeFile(path.join(root, 'model-tools.json'), JSON.stringify(tools.map((tool: any) => ({ type: tool.type, name: tool.name, tools: tool.tools?.map((inner: any) => ({ type: inner.type, name: inner.name })) })), null, 2));
    }
    if(hold)await new Promise<void>(resolve=>{release=resolve;});else await pause(400);
    // Project journal references follow the user's request. Echo that request's
    // marker, not the last marker found in another session's quoted journal.
    const payload=JSON.parse(body),latestUser=(payload.input||[]).filter((item:any)=>item.role==='user').at(-1);
    const userText=typeof latestUser?.content==='string'?latestUser.content:(latestUser?.content||[]).map((item:any)=>item.text||'').join('\n');
    const tag=userText.match(/WF_TASK_[ABC](?:_[A-Z]+)*/)?.[0]||[...body.matchAll(/WF_TASK_[ABC](?:_[A-Z]+)*/g)].at(-1)?.[0]||'BACKGROUND';
    const text='WF_REPLY_'+tag,itemId='msg_'+randomUUID().replaceAll('-',''),part={type:'output_text',text,annotations:[]};
    if (tag.endsWith('APPROVALWB') || tag.endsWith('APPROVALNATIVE')) {
      if (!requestedTools.has(tag)) {
        requestedTools.add(tag);
        const item = { type: 'function_call', id: 'fc_' + randomUUID().replaceAll('-', ''), call_id: 'call_' + randomUUID().replaceAll('-', ''), name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo WORKBENCH_APPROVAL_FIXTURE', sandbox_permissions: 'require_escalated', justification: '本机审批测试，仅执行 echo' }), status: 'completed' };
        const response = { id: 'resp_' + randomUUID().replaceAll('-', ''), object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'beta-local', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
        res.end(); concurrent--; return;
      }
    }
    const item={id:itemId,type:'message',role:'assistant',status:'completed',content:[part]};
    const done={id:'resp_'+randomUUID().replaceAll('-',''),object:'response',created_at:Math.floor(Date.now()/1000),model:'beta-local',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(type:string,value:any)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...value})+'\n\n');
    emit('response.created',{response:{...done,status:'in_progress',output:[]}});emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});emit('response.content_part.added',{output_index:0,item_id:itemId,content_index:0,part:{...part,text:''}});
    if(halfHold){const split=Math.floor(text.length/2);emit('response.output_text.delta',{output_index:0,item_id:itemId,content_index:0,delta:text.slice(0,split)});await new Promise<void>(resolve=>{release=resolve;});emit('response.output_text.delta',{output_index:0,item_id:itemId,content_index:0,delta:text.slice(split)});}
    else emit('response.output_text.delta',{output_index:0,item_id:itemId,content_index:0,delta:text});
    emit('response.output_text.done',{output_index:0,item_id:itemId,content_index:0,text});emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:done});res.end();concurrent--;
  });
  await new Promise<void>(resolve=>responses.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(personal,'config.toml'),`model="beta-local"\nmodel_provider="beta_local"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[model_providers.beta_local]\nname="Local workflow fixture"\nbase_url="http://127.0.0.1:${(responses.address() as any).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  process.env.CODEX_HOME=personal;delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  const executable=await installedCodexDesktopExecutable(await resolveProvider('codex'));
  const serviceOptions={sourceHome:personal,running:async()=>desktopRunning,discover:async()=>({app:'NOT_OPENED.exe',executable}),launchWorker:async(file:string,env:NodeJS.ProcessEnv)=>{
    starts++;
    const child=spawn(process.execPath,[path.resolve('dist/user/codex-desktop-worker.cjs'),file],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,...env,CODEX_APP_SERVER_WS_URL:undefined,WORKBENCH_CODEX_DESKTOP_BRIDGE:undefined}});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
  },launchDesktop:async(_target:unknown,args:string[],env:NodeJS.ProcessEnv)=>{
    assert.equal(args.length,1);assert.match(args[0],/^codex:\/\/threads\/[a-f0-9-]+$/);assert(env.CODEX_APP_SERVER_WS_URL);
    desktopOpens++;desktopRunning=true;openedThreads.push(args[0]);return process.pid;
  }};
  const service=new CodexDesktopService(serviceOptions);
  const environment=()=>({HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'});
  let wb=new Workbench(userData,()=>{},console.log,undefined,environment,undefined,service),peer:WebSocketRpc|undefined,application:any;
  const admin=new LocalAdminConnection(()=>{});let bridge:any;
  try{
    await admin.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',root:'/srv/teamspace',fingerprint:''},'','',async()=>false);await admin.operation({op:'initialize'});await admin.operation({op:'user_create',username:'codex_workflow',name:'Codex工作流联调',password:'123'});
    const profile=memberProfile(admin.snapshot.profile!,admin.snapshot.state!,'codex_workflow');
    await wb.store.init();await wb.configureWorkspace(profile,'123','',async()=>false);
    const group:any=await wb.groupCommand({action:'create',label:'Codex工作流'});
    const cli=await authLauncher(path.join(root,'cli'),{status:'ready',turn:'success'});wb.store.settings.providerPaths.codex=cli.launcher;
    const sessions=[];
    for(const tag of ['A','B','C']){
      const cwd=path.join(root,'workspace-'+tag);await fs.mkdir(cwd,{recursive:true});
      const project=await wb.createProject('独立项目'+tag,group.id,{background:'本地工作流验证',objectives:'验证独立会话',acceptance:'单一共享后台，上下文隔离',scope:'本机空目录',deliverables:'验证记录',resources:'',constraints:'本地模型打桩',collaboration:'独立推进'});
      sessions.push(await wb.createSession('codex',cwd,project.id,'work',undefined,'beta-local','inherit',false,'direct',true));
    }
    assert.equal(starts,0);assert.equal(desktopOpens,0);assert.equal(requests.length,0);console.log('Created three native-linked sessions; no backend or desktop started.');
    await Promise.all(sessions.map((s,i)=>wb.send(s.id,'WF_TASK_'+['A','B','C'][i])));
    await until(()=>sessions.every(s=>s.status==='idle'&&s.messages.some(m=>m.role==='assistant')));
    assert.equal(starts,1);assert.equal(new Set(sessions.map(s=>s.nativeId)).size,3);assert(maxConcurrent>=2,'independent sessions must run concurrently');
    assert.equal(desktopOpens,1,'concurrent first sends automatically open one linked window');assert(sessions.some(s=>openedThreads[0]==='codex://threads/'+s.nativeId));
    const beforeRestore=requests.length,{file:bridgeFile}=JSON.parse(await fs.readFile(path.join(service.parent,'active.json'),'utf8'));
    const desktopFile=path.join(path.dirname(bridgeFile),'desktop.json'),attachment=JSON.parse(await fs.readFile(desktopFile,'utf8'));
    await fs.writeFile(desktopFile,JSON.stringify({...attachment,pid:99999999}));desktopRunning=false;
    await wb.reconnectCodexDesktop(sessions[1].id);
    assert.equal(desktopOpens,2);assert.equal(openedThreads.at(-1),'codex://threads/'+sessions[1].nativeId);assert.equal(requests.length,beforeRestore,'restoring the desktop must not resend a task');
    for(let i=0;i<3;i++){const tag=['A','B','C'][i];assert(sessions[i].messages.some(m=>m.role==='assistant'&&m.text==='WF_REPLY_WF_TASK_'+tag));for(const other of ['A','B','C'].filter(x=>x!==tag))assert(!sessions[i].messages.some(m=>m.text.includes('WF_TASK_'+other)),'other conversation leaked');}
    bridge=await service.ensure();peer=new WebSocketRpc(bridge.endpoint);await peer.request('initialize',{clientInfo:{name:'native_peer_fixture',version:'1'},capabilities:{experimentalApi:true}});peer.notify('initialized');
    await peer.request('thread/resume',{threadId:sessions[1].nativeId});
    const initialNative=sessions[1].nativeId;
    await wb.changePermissions(sessions[1].id,'full');await wb.changeModel(sessions[1].id,'beta-local');
    assert.equal(sessions[2].permissionMode,'inherit');
    await wb.closeSession(sessions[0].id);await wb.send(sessions[1].id,'WF_TASK_B_TWO');await until(()=>sessions[1].status==='idle');assert.equal(starts,1);assert.equal(sessions[1].nativeId,initialNative);
    hold=true;let completed=false;
    peer.on('message',(m:any)=>{if(m.method==='turn/completed'&&m.params.threadId===sessions[1].nativeId)completed=true;});
    await peer.request('turn/start',{threadId:sessions[1].nativeId,input:[{type:'text',text:'WF_TASK_B_NATIVE'}]});await until(()=>!!release&&sessions[1].status==='running');
    await assert.rejects(wb.send(sessions[1].id,'SHOULD_NOT_SEND'),/正在运行/);
    await wb.close();release!();hold=false;await until(()=>completed);
    const history=(await peer.request('thread/read',{threadId:sessions[1].nativeId,includeTurns:true})).thread;
    assert(JSON.stringify(history).includes('WF_REPLY_WF_TASK_B_TWO'));assert(JSON.stringify(history).includes('WF_REPLY_WF_TASK_B_NATIVE'));
    const nativeId=sessions[1].nativeId;
    wb=new Workbench(userData,()=>{},console.log,undefined,environment,undefined,new CodexDesktopService(serviceOptions));
    await wb.store.init();await wb.configureWorkspace(profile,'123','',async()=>false);
    await wb.send(sessions[1].id,'WF_TASK_B_RESUMED');await until(()=>wb.session(sessions[1].id).status==='idle');assert.equal(wb.session(sessions[1].id).nativeId,nativeId);assert.equal(starts,1);assert.equal(desktopOpens,2,'later sends and Workbench restart must not refocus the native window');
    assert(requests.at(-1)!.includes('WF_REPLY_WF_TASK_B_NATIVE'));assert(!requests.at(-1)!.includes('WF_TASK_A'));assert(!requests.at(-1)!.includes('WF_TASK_C'));
    // Migrate a real private CLI thread, including native compaction, into the
    // same backend. All inference still goes to the local Responses fixture.
    const existing=await wb.createSession('codex',sessions[2].cwd,sessions[2].binding!.project.id,'work',undefined,'beta-local','inherit',false,'direct',false);
    existing.title='已有会话同步验证';
    const privateStorage=await prepareCodexStorage(userData,existing,personal);
    const privateRuntime=new AgentRuntime(existing,executable,{changed:()=>{},event:()=>{},done:()=>{}},privateStorage,environment());
    (wb as any).runtimes.set(existing.id,privateRuntime);
    let privateRecord='';
    try {
      await privateRuntime.prompt('WF_TASK_C_PRIVATE');await until(()=>existing.status==='idle');
      await privateRuntime.rpc.request('thread/compact/start',{threadId:existing.nativeId});
      await until(async()=>!!existing.nativePath&&(await fs.readFile(existing.nativePath,'utf8')).includes('"type":"compacted"'));
      await until(()=>existing.status==='idle');
      // Simulate a normal desktop in this isolated profile; never touch the
      // actual user's desktop or its connection record.
      await fs.rm(desktopFile);desktopRunning=true;
      const beforeQueue=requests.length;await wb.syncCodexDesktop(existing.id);
      assert(existing.codexSyncRequest);assert(!existing.codexDesktop);assert.equal(requests.length,beforeQueue);
      assert.equal((wb as any).runtimes.get(existing.id),privateRuntime,'queuing must retain the private executor');
      await wb.send(existing.id,'WF_TASK_C_WAITING');await until(()=>existing.status==='idle');
      assert(existing.messages.some(m=>m.text==='WF_REPLY_WF_TASK_C_WAITING'));
      privateRecord=await fs.readFile(existing.nativePath!,'utf8');
    } catch(error) {await privateRuntime.close();throw error;}
    const privateId=existing.nativeId!,privateFile=existing.nativePath!;
    wb.store.inputs[existing.id]={text:'还没发送的草稿',sourceIds:[],answers:{}};
    const beforeAttach=requests.length;desktopRunning=false;
    await (wb as any).drainDeferredCodexSync();
    assert.equal(requests.length,beforeAttach,'association must not run another model turn');
    assert.equal(existing.codexSyncRequest,undefined);assert.equal(desktopOpens,2,'completing background sync must not open the desktop');
    assert.equal(existing.nativeId,privateId);assert.equal(existing.codexDesktop,true);assert.notEqual(existing.nativePath,privateFile);
    assert((await fs.readFile(existing.nativePath!,'utf8')).startsWith(privateRecord),'native tools and compaction remain intact');
    assert.equal(wb.store.inputs[existing.id].text,'还没发送的草稿');
    const linkedHistory=(await peer.request('thread/read',{threadId:privateId,includeTurns:true})).thread;
    assert(JSON.stringify(linkedHistory).includes('WF_TASK_C_PRIVATE'));assert(JSON.stringify(linkedHistory).includes('WF_TASK_C_WAITING'));
    await (wb as any).drainDeferredCodexSync();assert.equal(desktopOpens,2,'a repeated background scan must not open the desktop');
    await wb.openCodexDesktop(existing.id);assert.equal(desktopOpens,3,'only the explicit open action opens this synchronized conversation');
    await wb.send(existing.id,'WF_TASK_C_AFTER_ATTACH');await until(()=>existing.status==='idle');
    assert.equal(existing.nativeId,privateId);assert(requests.at(-1)!.includes('WF_REPLY_WF_TASK_C_PRIVATE'),'next turn must use the native compacted context');
    assert(requests.at(-1)!.includes('WF_REPLY_WF_TASK_C_WAITING'),'work done while waiting must also reach the next turn');
    assert.equal(await fs.readFile(privateFile,'utf8'),privateRecord,'the old private record is no longer written');
    await wb.store.save();await wb.close();console.log('Core workflow passed, including existing-session attachment and compacted context.');
    if(process.argv.includes('--ui')){
      const { _electron }=await import('playwright');
      application=await _electron.launch({args:[path.resolve('dist/user')],env:{...process.env,...environment(),ELECTRON_RUN_AS_NODE:undefined,WORKBENCH_TEST:'1',WORKBENCH_DATA_DIR:userData},timeout:30000});
      const page=await application.firstWindow();const snapshot=()=>page.evaluate(()=>window.workbench.call('snapshot')) as Promise<any>;
      page.on('crash',()=>console.log('Test UI renderer crashed'));
      console.log('UI opened; connecting the isolated fixture account.');
      await until(async()=>!!(await snapshot()).settings.workspaceSnapshot);
      await page.evaluate(profile=>window.workbench.call('remote.connect',{profile,password:'123',newPassword:'123'}),profile);
      await until(async()=>!!(await snapshot()).connection?.connected);
      await pause(300);
      if(await page.locator('.modal-backdrop').count())console.log('Post-login modal:',await page.locator('.modal-backdrop').innerText());
      console.log('UI logged in; selecting shared session.');
      await page.locator('[data-session-id="'+sessions[1].id+'"]').click();
      assert(!(await page.getByRole('button',{name:'在 Codex 中打开',exact:true}).isVisible()));
      assert(await page.getByRole('button',{name:'提问',exact:true}).isVisible());assert(await page.getByRole('button',{name:'整理成果',exact:true}).isVisible());
      await page.getByRole('button',{name:'更多会话操作',exact:true}).click();assert(await page.getByRole('button',{name:'在 Codex 中打开',exact:true}).isVisible());await page.screenshot({path:path.join(root,'sync-menu.png')});await page.keyboard.press('Escape');
      await page.getByRole('button',{name:'Beta 功能',exact:false}).click();assert.equal(await page.getByRole('switch',{name:'开启 Codex 桌面联动',exact:true}).count(),0);await page.getByRole('button',{name:'完成',exact:true}).click();
      console.log('UI sync menu and ordinary option passed; creating a new linked session.');
      const before=(await snapshot()).sessions.length;
      await page.getByRole('button',{name:'新建会话',exact:true}).click();assert.equal(await page.getByRole('switch',{name:'与 Codex 桌面版同步',exact:true}).getAttribute('aria-checked'),'true');await page.screenshot({path:path.join(root,'new-sync-session.png')});await page.getByRole('checkbox',{name:'默认引用项目资料（已完善时）',exact:true}).uncheck();await page.getByRole('button',{name:'创建会话',exact:true}).click();await until(async()=>(await snapshot()).sessions.length===before+1);
      const created=(await snapshot()).sessions.find((s:any)=>s.id!==existing.id&&!sessions.some(old=>old.id===s.id));assert(created.codexDesktop);assert.equal(created.nativeId,undefined);
      await page.locator('[data-session-id="'+created.id+'"]').click();
      await page.locator('.session-title-row').filter({hasText:'新会话'}).waitFor({state:'visible'});
      await page.getByRole('textbox',{name:'任务输入',exact:true}).fill('WF_TASK_B_UI');await page.getByRole('button',{name:'发送任务',exact:true}).click();
      await until(async()=>{const s=(await snapshot()).sessions.find((s:any)=>s.id===created.id);if(s.error)throw new Error(s.error);return s.status==='idle'&&s.messages.some((m:any)=>m.text==='WF_REPLY_WF_TASK_B_UI');});
      await page.screenshot({path:path.join(root,'workflow-ui.png')});assert.equal((await service.ensure()).pid,bridge.pid);console.log('User UI passed: no Codex Beta gate, sync in more menu, new-session binding and sending.');
      const priorIds=new Set((await snapshot()).sessions.map((s:any)=>s.id));
      await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByRole('switch',{name:'与 Codex 桌面版同步',exact:true}).click();
      await page.getByRole('checkbox',{name:'默认引用项目资料（已完善时）',exact:true}).uncheck();await page.getByRole('button',{name:'创建会话',exact:true}).click();
      await until(async()=>(await snapshot()).sessions.some((s:any)=>!priorIds.has(s.id)));
      const ordinary=(await snapshot()).sessions.find((s:any)=>!priorIds.has(s.id));assert(!ordinary.codexDesktop);
      await page.locator('[data-session-id="'+ordinary.id+'"]').click();await page.getByRole('button',{name:'更多会话操作',exact:true}).click();
      assert(await page.getByRole('button',{name:'同步到 Codex',exact:true}).isVisible());assert.equal(await page.getByRole('button',{name:'恢复同步',exact:true}).count(),0);
      await page.screenshot({path:path.join(root,'existing-sync-menu.png')});await page.getByRole('button',{name:'同步到 Codex',exact:true}).click();
      await until(async()=>{const s=(await snapshot()).sessions.find((s:any)=>s.id===ordinary.id);if(s.desktopSyncError)throw Error(s.desktopSyncError);return s.codexDesktop&&s.desktopSyncState==='connected';});
      await page.getByRole('textbox',{name:'任务输入',exact:true}).fill('WF_TASK_C_UI_ATTACH');await page.getByRole('button',{name:'发送任务',exact:true}).click();
      await until(async()=>{const s=(await snapshot()).sessions.find((s:any)=>s.id===ordinary.id);if(s.error)throw Error(s.error);return s.status==='idle'&&s.messages.some((m:any)=>m.text==='WF_REPLY_WF_TASK_C_UI_ATTACH');});
      console.log('Existing ordinary session attached through the real menu and continued successfully.');
    }
    const extendedCases:string[]=[];
    if(process.argv.includes('--extended')){
      await application?.close();application=undefined;
      await wb.close();wb=new Workbench(userData,()=>{},console.log,undefined,environment,undefined,service);await wb.store.init();await wb.configureWorkspace(profile,'123','',async()=>false);
      const a=wb.store.sessions.find(s=>s.id===sessions[2].id)!,id=a.nativeId!;
      halfHold=true;release=undefined;
      await peer!.request('turn/start',{threadId:id,input:[{type:'text',text:'WF_TASK_A_MIDJOIN'}]});await until(()=>!!release);
      await wb.reconnectCodexDesktop(a.id);assert(a.desktopSyncPending||a.messages.some(m=>m.text.includes('WF_REPLY_WF_TASK')));
      halfHold=false;release!();release=undefined;await until(()=>a.status==='idle'&&a.messages.some(m=>m.text==='WF_REPLY_WF_TASK_A_MIDJOIN'));
      assert.equal(a.messages.filter(m=>m.text==='WF_REPLY_WF_TASK_A_MIDJOIN').length,1);extendedCases.push('mid-turn hydration with authoritative completion');
      const managerDirectory=path.dirname(JSON.parse(await fs.readFile(path.join(service.parent,'active.json'),'utf8')).file);
      assert.equal(bridge.sourceHome,personal);
      await fs.writeFile(path.join(managerDirectory,'bridge.json'), JSON.stringify({...bridge,expiresAt:new Date(0).toISOString()}));
      assert.equal((await service.ensure(environment())).pid,bridge.pid); extendedCases.push('real broker lease renewal without ending a task');
      hold=true;release=undefined;
      await peer!.request('turn/start',{threadId:id,input:[{type:'text',text:'WF_TASK_C_RECOVERLIVE'}]});await until(()=>!!release&&a.status==='running');
      const originalBackend=JSON.parse(await fs.readFile(path.join(managerDirectory,'backend.json'),'utf8'));
      const before=requests.length;process.kill(bridge.pid,'SIGKILL');await until(()=>processAlive(bridge.pid)===false);await peer!.close();
      await until(()=>a.status==='error');
      const recovered=await Promise.all([service.ensure(environment()),service.ensure(environment())]);bridge=recovered[0];assert.equal(bridge.endpoint,recovered[1].endpoint);assert.equal(requests.length,before);
      const adoptedBackend=JSON.parse(await fs.readFile(path.join(managerDirectory,'backend.json'),'utf8'));
      assert.equal(adoptedBackend.process.pid,originalBackend.process.pid,'surviving model backend must be adopted');
      await wb.reconnectCodexDesktop(a.id);assert.equal(a.nativeId,id);assert.equal(a.status,'running');assert(a.messages.some(m=>m.text==='WF_REPLY_WF_TASK_A_MIDJOIN'));
      hold=false;release!();release=undefined;await until(()=>a.status==='idle'&&a.messages.some(m=>m.text==='WF_REPLY_WF_TASK_C_RECOVERLIVE'));assert.equal(requests.length,before);
      extendedCases.push('hard manager exit during generation, surviving backend adopted once, preserved native identity and no resend');
      await wb.send(a.id,'WF_TASK_A_RECOVERED');await until(()=>a.status==='idle'&&a.messages.some(m=>m.text==='WF_REPLY_WF_TASK_A_RECOVERED'));
      assert(requests.at(-1)!.includes('WF_REPLY_WF_TASK_A_MIDJOIN'));
      const state=JSON.parse(await fs.readFile(path.join(managerDirectory,'backend.json'),'utf8'));
      if(processAlive(state.process.pid)===true)process.kill(state.process.pid,'SIGKILL');await until(()=>processAlive(state.process.pid)===false);
      await until(()=>processAlive(bridge.pid)===false&&a.status==='error');
      const priorEndpoint=bridge.endpoint;bridge=await service.ensure(environment());assert.equal(bridge.endpoint,priorEndpoint);
      await wb.reconnectCodexDesktop(a.id);assert.equal(a.nativeId,id);assert(a.messages.some(m=>m.text==='WF_REPLY_WF_TASK_A_RECOVERED'));extendedCases.push('manager and model backend exit, recovered persisted conversation');
      const originalFile=a.nativePath!,original=await fs.readFile(originalFile,'utf8');
      const copy={...a,id:randomUUID(),messages:[],approvals:[],nativeLive:true,codexDesktop:false,codexStorage:undefined,status:'idle' as const};
      const storage=await prepareCodexStorage(path.join(root,'independent'),copy,personal);
      const runtime=new AgentRuntime(copy,executable,{changed:()=>{},event:()=>{},done:()=>{}},storage,environment());
      try{await runtime.ensureStarted();assert.notEqual(copy.nativeId,id);assert.equal(copy.nativeSourceId,id);assert.equal(requests.length,before+1);await runtime.prompt('WF_TASK_A_COPY');await until(()=>copy.status==='idle');assert.equal(await fs.readFile(originalFile,'utf8'),original);}
      finally{await runtime.close();}
      extendedCases.push('ordinary continuation forks privately without changing the personal rollout');
      peer = new WebSocketRpc(bridge.endpoint); await peer.request('initialize', { clientInfo: { name: 'native_approval_fixture', version: '1' }, capabilities: { experimentalApi: true } }); peer.notify('initialized');
      await peer.request('thread/resume', { threadId: id });
      const nativeApprovals: any[] = [];
      peer.on('message', (message: any) => { if (message.id !== undefined && message.method?.includes('requestApproval')) nativeApprovals.push(message); });
      await wb.changePermissions(a.id, 'review');
      await wb.send(a.id, 'WF_TASK_C_APPROVALWB'); await until(() => a.approvals.length > 0 || a.status === 'idle');
      assert.equal(a.approvals.length, 1, 'real CLI must request approval at the initiating Workbench'); assert.equal(nativeApprovals.length, 0);
      const denial = a.approvals[0].options.find(option => option.kind === 'deny')!;
      assert(denial); await wb.answer(a.id, a.approvals[0].id, denial.id, {}); await until(() => a.status === 'idle');
      await peer.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'WF_TASK_C_APPROVALNATIVE' }] });
      await until(() => nativeApprovals.length === 1); assert.equal(a.approvals.length, 0); assert.equal(a.desktopWaitingApproval, true);
      peer.respond(nativeApprovals[0].id, { decision: nativeApprovals[0].params.availableDecisions?.includes('cancel') ? 'cancel' : 'decline' }); await until(() => a.status === 'idle'); assert.equal(a.desktopWaitingApproval, false);
      extendedCases.push('real CLI approvals route only to the initiating client and observers never reject');
    }
    const result={passed:true,root,backendStarts:starts,nativeThreadCount:process.argv.includes('--ui')?6:4,maxConcurrent,requests:requests.length,externalModelRequests:0,ui:process.argv.includes('--ui'),cases:['lazy creation','single shared manager','automatic window launch on concurrent first sends','automatic reopen on restore without resending','later sends reuse the window without refocusing','independent native thread IDs','parallel model requests','no cross-thread messages','closing one does not close others','native peer receives shared context','closing Workbench preserves native turn','resume after restart','ordinary desktop queues sync without closing the private executor','continue a real CLI turn while waiting','desktop exit completes queued sync without opening the window','explicit user action opens the synchronized conversation','existing private native history attaches without inference','compacted context continues after attachment','input draft and original native ID preserved',...(process.argv.includes('--ui')?['sync only in more menu', 'new-session option without Beta', 'ordinary session attaches and continues through UI']:[]),...extendedCases]};
    await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }catch(error){
    if(application){const page=await application.firstWindow();await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.txt'),await page.locator('body').innerText()).catch(()=>{});}
    console.error('Workflow artifacts:',root);throw error;
  }finally{
    release?.();await application?.close();await wb.close();admin.disconnect();await peer?.close();
    if(bridge)await stopBridge(bridge.endpoint);else{const record=await fs.readFile(path.join(service.parent,'active.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(record){const d=JSON.parse(await fs.readFile(record.file,'utf8'));await stopBridge(d.endpoint);}}
    if(priorHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=priorHome;if(priorBridge===undefined)delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;else process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE=priorBridge;
    responses.closeAllConnections();await new Promise<void>(resolve=>responses.close(()=>resolve()));
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1});
