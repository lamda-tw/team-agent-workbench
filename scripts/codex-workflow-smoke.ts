import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../src/core/workbench';
import { CodexDesktopService } from '../src/core/codex-desktop-service';
import { installedCodexDesktopExecutable } from '../src/core/codex-shared-backend';
import { resolveProvider } from '../src/core/providers';
import { WebSocketRpc } from '../src/core/websocket-rpc';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';
import { authLauncher } from '../tests/fixtures/auth-launcher.mjs';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>|boolean){const end=Date.now()+35000;while(!await check()){if(Date.now()>end)throw new Error('workflow fixture timed out');await pause(50);}}
async function main(){
  const root=path.resolve('.test-data','codex-workflow-'+Date.now()),personal=path.join(root,'personal'),userData=path.join(root,'user'),share=path.join(root,'share');
  await fs.mkdir(personal,{recursive:true});await fs.mkdir(share,{recursive:true});
  const requests:string[]=[],priorHome=process.env.CODEX_HOME,priorBridge=process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  let concurrent=0,maxConcurrent=0,release:undefined|(()=>void),hold=false,starts=0;
  const responses=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    if(req.method!=='POST'||!req.url?.endsWith('/responses')){res.writeHead(404);res.end();return;}
    requests.push(body);concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
    if(hold)await new Promise<void>(resolve=>{release=resolve;});else await pause(400);
    const tag=[...body.matchAll(/WF_TASK_[ABC](?:_[A-Z]+)?/g)].at(-1)?.[0]||'BACKGROUND';
    const text='WF_REPLY_'+tag,itemId='msg_'+randomUUID().replaceAll('-',''),part={type:'output_text',text,annotations:[]};
    const item={id:itemId,type:'message',role:'assistant',status:'completed',content:[part]};
    const done={id:'resp_'+randomUUID().replaceAll('-',''),object:'response',created_at:Math.floor(Date.now()/1000),model:'beta-local',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit=(type:string,value:any)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...value})+'\n\n');
    emit('response.created',{response:{...done,status:'in_progress',output:[]}});emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});emit('response.content_part.added',{output_index:0,item_id:itemId,content_index:0,part:{...part,text:''}});emit('response.output_text.delta',{output_index:0,item_id:itemId,content_index:0,delta:text});emit('response.output_text.done',{output_index:0,item_id:itemId,content_index:0,text});emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:done});res.end();concurrent--;
  });
  await new Promise<void>(resolve=>responses.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(personal,'config.toml'),`model="beta-local"\nmodel_provider="beta_local"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[model_providers.beta_local]\nname="Local workflow fixture"\nbase_url="http://127.0.0.1:${(responses.address() as any).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  process.env.CODEX_HOME=personal;delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;
  const executable=await installedCodexDesktopExecutable(await resolveProvider('codex'));
  const service=new CodexDesktopService({sourceHome:personal,workerFile:path.resolve('dist/user/codex-desktop-worker.cjs'),running:async()=>false,discover:async()=>{starts++;return{app:'NOT_OPENED.exe',executable};}});
  const environment=()=>({HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'});
  let wb=new Workbench(userData,()=>{},console.log,undefined,environment,undefined,service),peer:WebSocketRpc|undefined,application:any;
  const admin=new LocalAdminConnection(()=>{});let bridge:any;
  try{
    await admin.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',root:'/srv/teamspace',fingerprint:''},'','',async()=>false);await admin.operation({op:'initialize'});await admin.operation({op:'user_create',username:'codex_workflow',name:'Codex工作流联调',password:'123'});
    const profile=memberProfile(admin.snapshot.profile!,admin.snapshot.state!,'codex_workflow');
    await wb.store.init();await wb.configureWorkspace(profile,'123','',async()=>false);
    const group:any=await wb.groupCommand({action:'create',label:'Codex工作流'});
    const cli=await authLauncher(path.join(root,'cli'),{status:'ready',turn:'success'});wb.store.settings.providerPaths.codex=cli.launcher;
    await wb.setBetaFeature('codexDesktopSync',true);
    const sessions=[];
    for(const tag of ['A','B','C']){
      const cwd=path.join(root,'workspace-'+tag);await fs.mkdir(cwd,{recursive:true});
      const project=await wb.createProject('独立项目'+tag,group.id,{background:'本地工作流验证',objectives:'验证独立会话',acceptance:'单一共享后台，上下文隔离',scope:'本机空目录',deliverables:'验证记录',resources:'',constraints:'本地模型打桩',collaboration:'独立推进'});
      sessions.push(await wb.createSession('codex',cwd,project.id,'work',undefined,'beta-local','inherit',false,'direct',true));
    }
    assert.equal(starts,0);assert.equal(requests.length,0);console.log('Created three native-linked sessions; no backend or desktop started.');
    await Promise.all(sessions.map((s,i)=>wb.send(s.id,'WF_TASK_'+['A','B','C'][i])));
    await until(()=>sessions.every(s=>s.status==='idle'&&s.messages.some(m=>m.role==='assistant')));
    assert.equal(starts,1);assert.equal(new Set(sessions.map(s=>s.nativeId)).size,3);assert(maxConcurrent>=2,'independent sessions must run concurrently');
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
    wb=new Workbench(userData,()=>{},console.log,undefined,environment,undefined,new CodexDesktopService({sourceHome:personal,workerFile:path.resolve('dist/user/codex-desktop-worker.cjs'),running:async()=>{throw Error('existing manager must be reused');}}));
    await wb.store.init();await wb.configureWorkspace(profile,'123','',async()=>false);
    await wb.send(sessions[1].id,'WF_TASK_B_RESUMED');await until(()=>wb.session(sessions[1].id).status==='idle');assert.equal(wb.session(sessions[1].id).nativeId,nativeId);assert.equal(starts,1);
    assert(requests.at(-1)!.includes('WF_REPLY_WF_TASK_B_NATIVE'));assert(!requests.at(-1)!.includes('WF_TASK_A'));assert(!requests.at(-1)!.includes('WF_TASK_C'));
    await wb.store.save();await wb.close();console.log('Core workflow passed: one backend, three independent threads, parallel execution, desktop peer, client close, restart resume.');
    if(process.argv.includes('--ui')){
      const { _electron }=await import('playwright');
      application=await _electron.launch({args:[path.resolve('dist/user')],env:{...process.env,...environment(),ELECTRON_RUN_AS_NODE:undefined,WORKBENCH_TEST:'1',WORKBENCH_DATA_DIR:userData},timeout:30000});
      const page=await application.firstWindow();const snapshot=()=>page.evaluate(()=>window.workbench.call('snapshot')) as Promise<any>;
      page.on('crash',()=>console.log('Test UI renderer crashed'));
      console.log('UI opened; waiting for login.');
      await until(async()=>!!(await snapshot()).settings.workspaceSnapshot);
      await page.getByLabel('登录密码',{exact:true}).waitFor({state:'visible',timeout:20000});
      await page.getByLabel('登录密码',{exact:true}).fill('123');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByLabel('登录密码',{exact:true}).waitFor({state:'hidden',timeout:20000});
      await pause(300);
      if(await page.locator('.modal-backdrop').count())console.log('Post-login modal:',await page.locator('.modal-backdrop').innerText());
      console.log('UI logged in; selecting shared session.');
      await page.locator('[data-session-id="'+sessions[1].id+'"]').click();assert.equal(await page.getByRole('button',{name:'在 Codex 中打开',exact:false}).count(),1);
      console.log('UI native entry present; testing Beta off.');
      await page.getByRole('button',{name:'Beta 功能',exact:false}).click();await page.getByRole('switch',{name:'开启 Codex 桌面联动',exact:true}).uncheck();await page.getByRole('button',{name:'完成',exact:true}).click();
      await page.getByRole('button',{name:'新建会话',exact:true}).click();assert(await page.getByRole('checkbox',{name:'此会话联动 Codex 桌面版',exact:true}).isDisabled());await page.getByRole('button',{name:'取消',exact:true}).click();
      await page.getByRole('button',{name:'Beta 功能',exact:false}).click();await page.getByRole('switch',{name:'开启 Codex 桌面联动',exact:true}).check();await page.getByRole('button',{name:'完成',exact:true}).click();
      console.log('UI Beta on; creating ordinary-flow session.');
      const before=(await snapshot()).sessions.length;
      await page.getByRole('button',{name:'新建会话',exact:true}).click();assert(await page.getByRole('checkbox',{name:'此会话联动 Codex 桌面版',exact:true}).isChecked());await page.getByRole('checkbox',{name:'默认引用项目资料（已完善时）',exact:true}).uncheck();await page.getByRole('button',{name:'创建会话',exact:true}).click();await until(async()=>(await snapshot()).sessions.length===before+1);
      const created=(await snapshot()).sessions.find((s:any)=>!sessions.some(old=>old.id===s.id));assert(created.codexDesktop);assert.equal(created.nativeId,undefined);
      await page.locator('[data-session-id="'+created.id+'"]').click();
      await page.locator('.session-title-row h2').filter({hasText:'新会话'}).waitFor({state:'visible'});
      await page.getByRole('textbox',{name:'任务输入',exact:true}).fill('WF_TASK_B_UI');await page.getByRole('button',{name:'发送任务',exact:true}).click();
      await until(async()=>{const s=(await snapshot()).sessions.find((s:any)=>s.id===created.id);if(s.error)throw new Error(s.error);return s.status==='idle'&&s.messages.some((m:any)=>m.text==='WF_REPLY_WF_TASK_B_UI');});
      await page.screenshot({path:path.join(root,'workflow-ui.png')});assert.equal((await service.ensure()).pid,bridge.pid);console.log('Existing User UI passed: Beta switch, disabled option, new-session binding, native-open entry and sending.');
    }
    const result={passed:true,root,backendStarts:starts,nativeThreadCount:3,maxConcurrent,requests:requests.length,externalModelRequests:0,ui:process.argv.includes('--ui'),cases:['lazy creation','single shared manager','independent native thread IDs','parallel model requests','no cross-thread messages','closing one does not close others','native peer receives shared context','closing Workbench preserves native turn','resume after restart','UI entry and Beta gating']};
    await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{
    release?.();await application?.close();await wb.close();admin.disconnect();await peer?.close();
    if(bridge){const url=new URL(bridge.endpoint);url.protocol='http:';url.pathname+='/stop';await fetch(url,{method:'POST'}).catch(()=>{});}else{const record=await fs.readFile(path.join(service.parent,'active.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(record){const d=JSON.parse(await fs.readFile(record.file,'utf8'));const url=new URL(d.endpoint);url.protocol='http:';url.pathname+='/stop';await fetch(url,{method:'POST'}).catch(()=>{});}}
    if(priorHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=priorHome;if(priorBridge===undefined)delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE;else process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE=priorBridge;
    responses.closeAllConnections();await new Promise<void>(resolve=>responses.close(()=>resolve()));
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1});
