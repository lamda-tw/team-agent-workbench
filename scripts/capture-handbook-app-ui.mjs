// Capture the same React entry points used by start-admin-dev.cmd / start-user-dev.cmd.
// Only the Electron IPC boundary is replaced with isolated example data.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { makeFixture, installFixture } from './handbook-ui-fixture.mjs';
import { annotateScreenshot } from './handbook-screen-annotations.mjs';

const root=path.resolve(import.meta.dirname,'..');
const source=path.join(root,'docs/handbook/ui-scenarios.json');
const out=path.join(root,'docs/handbook/ui-screens');
const spec=JSON.parse(await fs.readFile(source,'utf8'));
const guideSource=path.join(root,'docs/handbook/screenshot-guides.json');
const guides=JSON.parse(await fs.readFile(guideSource,'utf8'));
const digest=createHash('sha256');
async function hashTree(dir){for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isDirectory())await hashTree(file);else{digest.update(path.relative(root,file));digest.update(await fs.readFile(file));}}}
await hashTree(path.join(root,'src'));
for(const file of [source,guideSource,path.join(root,'package.json'),path.join(root,'scripts/handbook-screen-annotations.mjs'),import.meta.filename,path.join(root,'scripts/handbook-ui-fixture.mjs'),path.join(root,'scripts/handbook-question-fixture.mjs'),path.join(root,'scripts/handbook-activity-fixture.mjs'),path.join(root,'scripts/handbook-sync-fixture.mjs'),path.join(root,'start-admin-dev.cmd'),path.join(root,'start-user-dev.cmd')])digest.update(await fs.readFile(file));
const hash=digest.digest('hex');
const filter=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
const stepFilter=Number(process.argv.find(a=>a.startsWith('--step='))?.slice(7)||0);
const inventoryOnly=process.argv.includes('--inventory');
const inventoryDir=path.join(root,'.test-data/handbook-ui-inventory');
if(inventoryOnly)await fs.mkdir(inventoryDir,{recursive:true});
const screenshotName=(id,i,j,pane)=>pane.image||`${id}-${String(i+1).padStart(2,'0')}-${j+1}.png`;
const expected=new Set(Object.entries(spec).flatMap(([id,s])=>s.steps.flatMap((step,i)=>step.panes.map((pane,j)=>screenshotName(id,i,j,pane)))));
for(const name of ['admin-users.png','admin-groups.png','admin-storage.png'])expected.add(name);
const manifest=path.join(out,'manifest.json');
await fs.mkdir(out,{recursive:true});
const baseCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
let retryFiles;
if(process.argv.includes('--retry-failed')){
 const failed=JSON.parse(await fs.readFile(path.join(out,'capture-failures.json'),'utf8'));
 const previous=JSON.parse(await fs.readFile(manifest,'utf8'));
 retryFiles=new Set(failed.map(item=>item.file));
 for(const name of expected){const item=previous.captures.find(item=>item.file===name);if(!item||item.base_commit!==baseCommit||item.guide_sha256!==createHash('sha256').update(JSON.stringify(guides[name])).digest('hex'))retryFiles.add(name);}
 if(!retryFiles.size){console.log('No failed or outdated screenshot guides.');process.exit(0);}
}
if(!filter&&!inventoryOnly&&!retryFiles){try{const last=JSON.parse(await fs.readFile(manifest,'utf8'));if(last.digest===hash && last.renderer==='production-react' && (await Promise.all([...expected].map(name=>fs.access(path.join(out,name)).then(()=>true,()=>false)))).every(Boolean)){console.log(`Production UI screenshots unchanged (${expected.size})`);process.exit(0);}}catch{}}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'handbook-production-ui-'));
for(const [edition,entry] of Object.entries({user:'src/renderer/main.tsx',admin:'src/admin/renderer.tsx'})){
 const dir=path.join(temp,edition);await fs.mkdir(dir,{recursive:true});
 await build({absWorkingDir:root,entryPoints:[entry],outfile:path.join(dir,'renderer.js'),bundle:true,minify:true,platform:'browser',format:'iife',target:'chrome130',loader:{'.css':'css'},logLevel:'silent'});
 await fs.writeFile(path.join(dir,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script></html>');
}
const browser=await chromium.launch({channel:'msedge',headless:true});
const report=[],failures=[];
const keepGoing=process.argv.includes('--keep-going');
for(const name of expected)if(!guides[name])throw new Error('Screenshot guide missing: '+name);
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const click=async(page,name)=>button(page,name).click();
async function clickResultMore(page,name){
 const card=page.locator('.result-card.is-expanded');
 await card.locator('.result-more > summary').click();
 await card.getByRole('button',{name,exact:true}).click();
}
async function adminScene(page,data){
 const {pane,step,paneIndex}=data;
 if(data.id==='case-member-sync'){
  await page.locator('.admin-shell').waitFor();
  if(data.stage==='concurrent'){
   await page.locator('[data-user="bob"]').getByRole('button',{name:'重置密码',exact:true}).click();
   await page.evaluate(()=>{const d=window.__handbook.data;d.adminSnapshot.state.users.bob.enabled=false;d.adminSnapshot.state.users.bob.revision='member-v2';window.__handbook.emitAdmin();});
   await page.getByText('成员状态已更新',{exact:true}).waitFor();
  }
  return;
 }
 await page.locator('.admin-shell').waitFor();
 if(data.id==='case-team-setup'){
  if(step===1&&paneIndex===1){
   await page.getByRole('heading',{name:'连接中央节点',exact:true}).waitFor();
   await page.getByLabel('服务器地址',{exact:true}).fill('team.example.internal');
   await page.getByLabel('管理账号',{exact:true}).fill('root');
   await page.getByLabel('登录密码',{exact:true}).fill('example-password');
   await page.getByLabel('团队根路径',{exact:true}).fill('/srv/teamspace');
  }
  if(step===2){
   await click(page,'查看服务器修复方式');
   if(paneIndex===2){await click(page,'在服务器执行修复');await page.getByText('远端服务器环境已通过检查。',{exact:true}).waitFor();}
  }
  if(step===3&&paneIndex===2)await click(page,'初始化团队空间');
  if(step===4){
   await click(page,'初始化团队空间');await click(page,'确认执行');
   await page.getByRole('button',{name:'创建项目组',exact:true}).waitFor();
   if(paneIndex===2){await click(page,'创建项目组');await page.getByLabel('项目组名称',{exact:true}).fill('项目一组');}
  }
  return;
 }
 if(pane.screen.includes('共享空间')){
  await click(page,'共享空间');await page.locator('.storage-donut').waitFor();
  if(data.id==='case-project-cleanup'&&step===2){
   await click(page,'清理项目');
   await page.getByLabel('要清理的项目').selectOption(data.project.id);
   await page.getByRole('radio',{name:/保留轨迹的删除/}).click();
  }
  return;
 }
 if(pane.screen.includes('网络出口')){
  await click(page,'网络出口');
  if(pane.screen.includes('出口设置'))await page.getByRole('tab',{name:'出口设置',exact:true}).click();
  if(pane.screen.includes('成员接入')||pane.screen.includes('用户端接入码'))await page.getByRole('tab',{name:'成员接入',exact:true}).click();
  if(pane.screen.includes('直连管理端'))await page.getByRole('radiogroup',{name:'成员接入路线'}).getByText('直连管理端',{exact:true}).click();
  if(pane.screen.includes('经共享服务器')||pane.screen.includes('共享服务器中转')){
   await page.getByRole('tab',{name:'成员接入',exact:true}).click();
   await page.getByRole('radiogroup',{name:'成员接入路线'}).getByText('经共享服务器',{exact:true}).click();
   await page.locator('.egress-jump').scrollIntoViewIfNeeded();
   if(data.stage==='tunnel-ready')await click(page,'检测完整隧道');
  }
  if(pane.screen.includes('连接诊断'))await page.getByRole('tab',{name:'连接诊断',exact:true}).click();
  return;
 }
 if(step===1&&paneIndex===1){await click(page,'创建项目组');await page.getByLabel('项目组名称',{exact:true}).fill('项目一组');}
 else if(step===1&&paneIndex===2){await page.getByRole('tab',{name:'按组查看',exact:true}).click();}
 else if(step===2&&paneIndex===1){const row=page.locator('tr').filter({hasText:'alice'});await row.getByRole('button',{name:'组与角色',exact:true}).click();}
 else if(step===2&&paneIndex===2){await page.getByRole('tab',{name:'按组查看',exact:true}).click();}
}
async function openSession(page){await page.locator('[data-session-id="work-session"]').click();await page.getByLabel('任务输入',{exact:true}).waitFor();}
async function openResults(page,scope='团队'){
 await page.getByRole('button',{name:'项目成果库',exact:true}).first().click();
 await page.getByRole('tab',{name:scope,exact:true}).click();
 await page.locator('.results-library-pane').waitFor();
}
async function openContent(page,index=0){await page.locator('.content-card-summary').nth(index).click();}
async function relativePathsForScreenshot(page,data){
 // Keep valid fixture paths during interaction; only the captured presentation
 // uses directory placeholders and paths relative to the shared root.
 await page.evaluate(({directory})=>{
  const display=value=>value.replaceAll('/srv/teamspace/','').replaceAll('/srv/teamspace','〈团队根目录〉').replaceAll(directory,'〈本机工作目录〉').replaceAll('/opt/workbench-packages','〈离线包目录〉').replace(/[A-Za-z]:[\\/][^\s<>"，；）]*/g,'〈本机工作目录〉');
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walker.nextNode()){const node=walker.currentNode;if(!node.parentElement?.closest('script,style'))node.textContent=display(node.textContent||'');}
  for(const element of document.querySelectorAll('input,textarea'))element.value=display(element.value);
  for(const element of document.querySelectorAll('[placeholder],[title],[aria-label]'))for(const attribute of ['placeholder','title','aria-label']){const value=element.getAttribute(attribute);if(value)element.setAttribute(attribute,display(value));}
  const visible=[document.body.innerText,...[...document.querySelectorAll('input,textarea')].map(element=>element.value+' '+(element.getAttribute('placeholder')||''))].join('\n');
  if(/[A-Za-z]:[\\/]|(?:^|[\s（])\/(?:srv|opt|etc|home|var|run|tmp|usr)\//m.test(visible))throw new Error('Absolute filesystem path remains in screenshot');
 },{directory:data.directory});
}
async function saveInventory(page,name){
 const data=await page.evaluate(()=>({text:document.body.innerText,elements:[...document.querySelectorAll('button,input,textarea,select,summary,[role="tab"],h1,h2,h3,.content-detail,.draft-editor,.project-brief,.modal-body')].filter(el=>el.getClientRects().length).map(el=>({tag:el.tagName,role:el.getAttribute('role'),aria:el.getAttribute('aria-label'),title:el.getAttribute('title'),text:(el.innerText||'').slice(0,160),type:el.getAttribute('type'),id:el.id,cls:el.className,labels:[...(el.labels||[])].map(l=>l.textContent),parent:el.parentElement.className}))}));
 await fs.writeFile(path.join(inventoryDir,name+'.json'),JSON.stringify(data,null,2));
}
async function userScene(page,data){
 const {pane,step,paneIndex,id,beforeProject}=data,screen=pane.screen.replace('项目成果库 › 团队','团队成果').replace('项目成果库 › 个人','个人成果').replace('工作会话 › 网络与登录设置','工作会话 › 模型连接');
 await page.locator('.topbar').waitFor();
 if(id==='case-project-recommendations'){
  await page.locator('[data-project-id="handbook-project"]').click();
  await page.getByLabel('查看AI推荐：'+data.project.name,{exact:true}).click();
  await page.locator('.rsi-detail').waitFor();
  if(data.stage==='review')await page.getByText('推荐依据',{exact:true}).click();
  else{await page.getByLabel('关联会话',{exact:true}).selectOption(data.session.id);await page.getByLabel('推荐反馈',{exact:true}).fill('建议动作具体，请继续保留样本范围和验证口径。');}
  return;
 }
 if(id==='case-project-sync'){
  if(data.stage==='create'){
   await click(page,'创建项目');await page.getByLabel('项目名称',{exact:true}).fill('验证资料整理');
   for(const [label,key] of [['项目背景','background'],['项目目标','objectives'],['验收标准','acceptance']])await page.getByLabel(label,{exact:true}).fill(data.brief[key]);
  }else if(data.stage==='link'){
   await page.locator('[data-project-id="handbook-project"]').first().click();
   await page.getByTitle('项目设置：'+data.project.name,{exact:true}).first().click();
   await page.getByRole('tab',{name:'中央节点',exact:true}).click();
   await page.getByLabel('同步到工作组',{exact:false}).selectOption('team_one');
  }else{
   await page.locator('.topbar-actions > button').first().click();
   await page.getByRole('dialog',{name:'账号资料同步'}).waitFor();
   if(data.stage==='history')await page.getByText('合并记录与恢复',{exact:true}).click();
  }
  return;
 }
 if(screen.includes('连接团队空间')){

  if(!await page.getByRole('heading',{name:'连接项目',exact:true}).count())await click(page,'连接项目');
  await page.getByLabel('登录密码',{exact:true}).fill('example-password');
  if(id==='case-egress-mixed'&&data.username==='member-b'&&step===2)await page.getByLabel('管理端网络出口接入码',{exact:true}).fill('TAE2.handbook-example-access-code');
  return;
 }
 if(await page.getByRole('heading',{name:'登录团队工作台',exact:true}).count())await page.locator('.modal').getByRole('button',{name:'取消',exact:true}).click();
 if(beforeProject){await click(page,'创建项目');await page.getByLabel('所属工作组',{exact:true}).selectOption('team_one');await page.getByLabel('项目名称',{exact:true}).fill(data.project.name);for(const [label,key] of [['项目背景','background'],['项目目标','objectives'],['验收标准','acceptance']])await page.getByLabel(label,{exact:true}).fill(data.brief[key]);return;}
 await page.locator('[data-project-id="handbook-project"]').click();
 if(id==='case-activity-recommendations'||pane.recommendation){
  const recommendationStage=pane.recommendation||data.stage;
  if(recommendationStage==='saved'){await openResults(page,'个人');await openContent(page,0);}
  else{
   await openSession(page);
   await page.getByLabel('任务输入',{exact:true}).fill(data.snapshot.inputs[data.session.id].text);
   if(recommendationStage==='choose'||recommendationStage==='choose-save'){
    const panel=page.getByRole('region',{name:'本会话相关新动态'});
    await panel.getByRole('button',{name:'查看',exact:true}).click();
    const card=panel.locator('.activity-recommendation').first();
    if(recommendationStage==='choose')await card.getByRole('checkbox',{name:'加入当前会话',exact:true}).check();
    await card.getByRole('checkbox',{name:'存入个人成果库',exact:true}).check();
   }
  }
  return;
 }
 if(id==='case-member-questions'){
  if(data.stage==='received'){
   await page.getByRole('button',{name:'团队动态',exact:true}).click();
   await page.getByRole('region',{name:'提问动态'}).waitFor();
  }else{
   await openSession(page);
   await click(page,'提问');
   if(data.stage==='compose'){
    await page.getByLabel('问题标题',{exact:true}).fill(data.question.title);
    await page.getByLabel('需要补充什么',{exact:true}).fill(data.question.body);
    await page.getByLabel('补充资料（可选）',{exact:true}).fill(data.question.context);
    await click(page,'添加附件');
    await page.getByRole('checkbox',{name:'Carol carol',exact:true}).check();
   }else{
    await page.locator('.team-question-card').filter({hasText:data.question.title}).click();
    if(data.stage==='reply')await page.getByLabel('回复Bob',{exact:true}).fill('需要增加大输入样本。沿用本轮设备与代码版本，分别记录普通输入和大输入的耗时，并标明未验证项。');
   }
  }
  return;
 }
 if(id==='case-session-routes'){
  await page.getByTitle('新建会话',{exact:true}).click();
  if(data.stage==='management-direct'||data.stage==='management-shared'){
   await page.getByLabel('通过管理端访问模型服务',{exact:true}).check();
   await page.getByLabel('管理端网络出口接入码',{exact:true}).fill(data.stage==='management-shared'?'TAE2.handbook-example-access-code':'TAE1.handbook-example-access-code');
  }
  return;
 }
 if(screen.includes('我的工作组')||screen.includes('项目资料')){await page.getByTitle('项目设置：'+data.project.name,{exact:true}).click();return;}
 if(screen.includes('任务')||screen.includes('验收结果')){
  await page.getByRole('button',{name:data.admin?'项目任务':'我的任务',exact:true}).click();
  if(data.admin)await page.getByRole('button',{name:/^我派发的/}).click();
  if(screen.includes('派发任务')){await click(page,'派发任务');await page.getByLabel('任务负责人').selectOption('bob');await page.getByLabel('任务标题',{exact:true}).fill(data.task.title);await page.getByLabel('任务目标与工作范围',{exact:true}).fill(data.task.description);await page.getByLabel('任务验收要求').fill(data.task.acceptance);await page.locator('.modal input[type="checkbox"]').first().check();}
  else if(screen.includes('新建工作会话'))await click(page,'开始工作');
  else if(screen.includes('提交验收')){await click(page,'提交验收');await page.getByLabel('任务结果说明').fill('已完成样本复核，详见复核清单与日志。待确认项已列入结论。');await page.locator('.modal summary').filter({hasText:'关联成果或共享文件'}).click();await page.locator('.modal label').filter({hasText:'票据漏检复核结论'}).getByRole('checkbox').check();await click(page,'添加验收附件');}
  return;
 }
 if(screen.includes('新建工作会话')){await page.getByTitle('新建会话',{exact:true}).click();if(data.username==='carol')await page.locator('.provider-picker').getByRole('button',{name:'Cursor',exact:true}).click();await page.getByLabel((data.username==='carol'?'Cursor':'Codex')+' 登录状态').getByText('已登录',{exact:true}).waitFor();return;}
 if(id==='example'&&data.stage==='prepare'){
  await openSession(page);
  if(paneIndex===2){
   await page.getByRole('button',{name:'整理成果',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'整理成果',exact:true});
   await dialog.getByRole('button',{name:'开始整理对话',exact:true}).waitFor();
   await dialog.getByRole('heading',{name:'整理哪些方面',exact:true}).waitFor();
   for(const checkbox of await dialog.locator('.preparation-category-choices input[type="checkbox"]').all())await checkbox.uncheck();
   await dialog.getByLabel('探索记录',{exact:false}).check();
   await dialog.locator('.preparation-category-choice.selected summary').click();
   await dialog.getByLabel('探索记录的整理方向',{exact:true}).fill('保留本轮的测试输入、设备、证据和适用范围；未验证的内容单独列出。');
  }
  return;
 }
 if(screen.includes('成果整理')||screen.includes('整理成果')||screen.includes('综合结果确认')||screen.includes('个人成果处理')){
  await page.getByRole('button',{name:'打开成果整理',exact:true}).click();await page.locator('.draft-task-open').first().click();return;
 }
 if(screen.includes('工作会话')||screen.includes('模型连接')){
  await openSession(page);
  const input=page.getByLabel('任务输入',{exact:true});
  if(!(await input.inputValue()))await input.fill(id==='example'&&data.stage==='retest'?'请统一设备、输入规模和代码版本，对照格式 A 基线与 Bob 的格式 B 反例复测，记录证据和适用范围。':id==='case-egress-mixed'?'请读取 data/input-samples.csv 中的样本，按项目要求比较两种格式，记录依据与待确认项。':'请按项目验收标准继续验证，记录实验条件、结果与待确认项。');
  if(screen.includes('AI 参考内容')){await click(page,'更多会话操作');await click(page,'AI 参考内容');}
  if(screen.includes('模型连接'))await page.getByRole('button',{name:'网络与登录设置',exact:true}).click();
  return;
 }
 if(screen.includes('团队动态')){await page.getByRole('button',{name:'团队动态',exact:true}).click();if(screen.includes('动态结果'))await page.getByRole('button',{name:'查看结果',exact:true}).first().click();return;}
 if(screen.includes('个人成果')){
  await openResults(page,'个人');
  if(screen.includes('历史成果'))await page.getByLabel('成果范围',{exact:true}).selectOption('history');
  if(screen.includes('新建成果')){await click(page,'新建成果');await page.getByLabel('项目成果标题',{exact:true}).fill('格式 B 大输入复测');await page.getByLabel('项目成果内容',{exact:true}).fill(data.content[1].description);return;}
  await openContent(page,screen.includes('格式 B')?1:0);
  if(screen.includes('设置本地别名')){await clickResultMore(page,'设置本地别名');await page.getByLabel('成果本地别名').fill('格式 A 对照基线');}
  if(screen.includes('选择使用成果的会话')){await clickResultMore(page,'加入会话');await page.locator('.modal input[type="checkbox"]').first().check();}
  if(screen.includes('删除确认'))await page.locator('.result-card.is-expanded').getByRole('button',{name:'删除成果',exact:true}).click();
  if(screen.includes('选择处理')){await page.locator('.content-card input[type="checkbox"]').nth(0).check();await page.locator('.content-card input[type="checkbox"]').nth(1).check();await page.getByRole('button',{name:/处理选中的/}).click();await page.getByLabel('成果处理要求').fill('对比适用范围，保留分歧与证据。');}
  return;
 }
 await openResults(page,'团队');
 if(screen.includes('合并整理')){await click(page,'合并整理');await page.locator('.content-card input[type="checkbox"]').nth(0).check();await page.locator('.content-card input[type="checkbox"]').nth(1).check();return;}
 if(screen.includes('批量删除')){await click(page,'批量删除团队成果');await page.getByLabel('全选当前可删除的团队成果').check();await page.getByRole('button',{name:/删除选中的/}).click();return;}
 await openContent(page,screen.includes('格式 B')||screen.includes('Bob')||screen.includes('编辑成果')||(id==='example'&&data.stage==='feedback'&&paneIndex===2)?1:0);
 if(screen.includes('编辑成果')){await clickResultMore(page,'编辑成果');await page.getByLabel('团队成果标题').fill('格式 B 在大输入下的性能反例');}
}
try{
 for(const [id,scenario] of Object.entries(spec)){
  if(filter&&filter!==id)continue;
  for(let i=0;i<scenario.steps.length;i++){
   if(stepFilter&&stepFilter!==i+1)continue;
   for(let j=0;j<scenario.steps[i].panes.length;j++){
    const pane=scenario.steps[i].panes[j],capture=pane.capture||{step:i+1,pane:j+1},data=makeFixture(capture.case||id,capture.step,capture.pane,pane,pane.stage||scenario.steps[i].stage),edition=pane.actor.includes('总管理员')?'admin':'user';
    const name=screenshotName(id,i,j,pane);
    if(!/^[a-z0-9-]+\.png$/.test(name))throw new Error(`Invalid screenshot filename: ${name}`);
    if(retryFiles&&!retryFiles.has(name))continue;
    const page=await browser.newPage({viewport:{width:1440,height:pane.captureHeight||1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Shanghai'});
    page.setDefaultTimeout(4000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(installFixture,data);
    await page.context().setOffline(true);
    try{
     await page.goto(pathToFileURL(path.join(temp,edition,'index.html')).href);
     await (edition==='admin'?adminScene(page,data):userScene(page,data));
     const dismiss=page.getByRole('button',{name:'关闭本轮动态提示',exact:true});if(await dismiss.count())await dismiss.click();
     await page.evaluate(()=>document.fonts.ready);
     await page.waitForTimeout(400);
     const unhandled=await page.evaluate(()=>window.__handbook.unhandled);
     if(errors.length||unhandled.length)throw new Error(JSON.stringify({errors,unhandled}));
     await relativePathsForScreenshot(page,data);
     let annotation;
     if(inventoryOnly)await saveInventory(page,name);
     else{annotation=await annotateScreenshot(page,guides[name]);await page.screenshot({path:path.join(out,name),animations:'disabled'});}
     report.push({file:name,edition,entry:edition==='admin'?'start-admin-dev.cmd':'start-user-dev.cmd',screen:pane.screen,viewport:page.viewportSize(),annotation,guide_sha256:createHash('sha256').update(JSON.stringify(guides[name])).digest('hex'),image_sha256:inventoryOnly?null:createHash('sha256').update(await fs.readFile(path.join(out,name))).digest('hex'),source_digest:hash,base_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()});
     console.log(`Captured ${name}`);
    }catch(error){await page.screenshot({path:path.join(temp,'failure.png')});console.error('FAILED',name,error.message,'\nDOM:',(await page.locator('body').innerText()).slice(-5500),'\nErrors:',errors,'\nUnhandled:',await page.evaluate(()=>window.__handbook?.unhandled),'\nDebug:',temp);failures.push({file:name,error:error.message});if(!keepGoing)throw error;}
    finally{await page.close();}
   }
  }
 }
 if(!filter){
  for(const [name,screen,paneIndex] of [['admin-users.png','管理员版 › 用户管理 › 全部用户',3],['admin-groups.png','管理员版 › 用户管理 › 按组查看',2],['admin-storage.png','管理员版 › 共享空间',3]]){
   if(retryFiles&&!retryFiles.has(name))continue;
   const pane={actor:'总管理员',screen,status:'已连接',rows:[],action:''},data=makeFixture('case-first-session',2,paneIndex,pane);
   const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Shanghai'});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(5000);
   try{await page.addInitScript(installFixture,data);await page.context().setOffline(true);await page.goto(pathToFileURL(path.join(temp,'admin/index.html')).href);await adminScene(page,data);await page.evaluate(()=>document.fonts.ready);if(errors.length)throw new Error(errors.join('\n'));await relativePathsForScreenshot(page,data);let annotation;if(inventoryOnly)await saveInventory(page,name);else{annotation=await annotateScreenshot(page,guides[name]);await page.screenshot({path:path.join(out,name),animations:'disabled'});}report.push({file:name,edition:'admin',entry:'start-admin-dev.cmd',screen,annotation,guide_sha256:createHash('sha256').update(JSON.stringify(guides[name])).digest('hex'),image_sha256:inventoryOnly?null:createHash('sha256').update(await fs.readFile(path.join(out,name))).digest('hex'),source_digest:hash});}finally{await page.close();}
  }
  for(const item of report)item.base_commit=baseCommit;
  if(!inventoryOnly&&!failures.length&&!retryFiles){
   for(const name of await fs.readdir(out)){if(name.endsWith('.png')&&!expected.has(name))await fs.unlink(path.join(out,name));}
   await fs.writeFile(manifest,JSON.stringify({digest:hash,count:report.length,renderer:'production-react',path_display:'relative-with-directory-placeholders',base_commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),viewport:{width:1440,height:1000},fixtures:'scripts/handbook-ui-fixture.mjs',captures:report},null,2));
  }
 }
 for(const item of report)item.base_commit=baseCommit;
 if((filter||failures.length||retryFiles)&&!inventoryOnly){
  const previous=JSON.parse(await fs.readFile(manifest,'utf8'));
  const changed=new Map(report.map(item=>[item.file,item]));
  previous.captures=previous.captures.filter(item=>expected.has(item.file)).map(item=>changed.get(item.file)||item);
  for(const item of report)if(!previous.captures.some(old=>old.file===item.file))previous.captures.push(item);
  previous.count=previous.captures.length;
  // A partial refresh must not claim that every screenshot matches this source.
  previous.digest=null;
  if(previous.captures.every(item=>item.base_commit===baseCommit))previous.base_commit=baseCommit;
  await fs.writeFile(manifest,JSON.stringify(previous,null,2));
 }
 await fs.writeFile(path.join(out,'capture-failures.json'),JSON.stringify(failures,null,2));if(failures.length)process.exitCode=1;
 console.log(`Captured ${report.length} images; ${failures.length} annotation failures.`);
}finally{await browser.close();}
