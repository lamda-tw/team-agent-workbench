import { _electron as electron, expect as baseExpect, type ElectronApplication, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { Workbench } from '../src/core/workbench';
import { memberProfile } from '../tests/fixtures/member-profile';

const expect = baseExpect.configure({ timeout: 15000 });
const call = (page: Page, action: string, payload?: unknown): Promise<any> => page.evaluate(([a,p]) => (window as any).workbench.call(a,p), [action,payload]);
const adminCall = (page: Page, action: string, payload?: unknown): Promise<any> => page.evaluate(([a,p]) => (window as any).admin.call(a,p), [action,payload]);

async function main() {
  const root=process.cwd(), data=path.join(root,'.test-data','team-groups-'+Date.now()), share=path.join(data,'share');
  await fs.mkdir(share,{recursive:true});
  const backend=new LocalAdminConnection(()=>{}), apps:ElectronApplication[]=[], errors:string[]=[], members:Workbench[]=[];
  let current:Page|undefined;
  const launch=async(kind:'user'|'admin',store:string)=>{
    const entry=path.join(data,kind+'-'+path.basename(store)+'.cjs');
    await fs.writeFile(entry,`require('electron').dialog.showErrorBox=(t,m)=>require('node:fs').appendFileSync(${JSON.stringify(path.join(data,'startup-errors.log'))},t+'\\n'+m+'\\n');\nrequire(${JSON.stringify(path.join(root,'dist',kind,'main.cjs'))});`);
    const env={...process.env,WORKBENCH_TEST:'1',...(kind==='user'?{WORKBENCH_DATA_DIR:store}:{WORKBENCH_ADMIN_DATA_DIR:store})}; delete env.ELECTRON_RUN_AS_NODE;
    const app=await electron.launch({args:[entry],cwd:root,env,timeout:60000});apps.push(app);
    const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.waitForLoadState('domcontentloaded');current=page;return page;
  };
  const dialog=(page:Page)=>page.getByRole('dialog',{name:'项目组管理',exact:true});
  const close=(page:Page)=>dialog(page).getByRole('button',{name:'关闭',exact:true}).click();
  const dismissDirectory=async(page:Page)=>{const skip=page.getByRole('button',{name:'暂不设置',exact:true});await skip.waitFor({timeout:1500}).catch(()=>{});if(await skip.isVisible())await skip.click();};
  try {
    await backend.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',root:'/srv/teamspace',fingerprint:''},'','',async()=>false);
    await backend.operation({op:'initialize'});
    for(const username of ['alice','bob','carol'])await backend.operation({op:'user_create',username,name:username,password:'123'});
    const profiles:any={};
    for(const username of ['alice','bob','carol']){
      profiles[username]=memberProfile(backend.snapshot.profile!,backend.snapshot.state!,username);
      const wb=new Workbench(path.join(data,username),()=>{},()=>{});members.push(wb);await wb.store.init();await wb.configureWorkspace(profiles[username],'123',data,async()=>false);await wb.close();
    }
    const ap=await launch('admin',path.join(data,'admin'));
    await ap.getByLabel('共享区类型').selectOption('local');await ap.getByLabel('本地共享区根目录').fill(share);
    await ap.getByRole('button',{name:'打开共享目录',exact:true}).click();await expect(ap.locator('.modal')).toHaveCount(0);
    await expect(ap.locator('.people-global [data-user]')).toHaveCount(3);
    await expect(ap.getByRole('button',{name:'项目内容管理',exact:true})).toHaveCount(0);
    const login=async(username:string)=>{
      const page=await launch('user',path.join(data,username));
      const modal=page.locator('.modal').filter({hasText:'登录团队工作台'});await modal.waitFor({timeout:1500}).catch(()=>{});
      await call(page,'remote.connect',{profile:profiles[username],password:'123',localPath:data});
      if(await modal.isVisible())await modal.getByRole('button',{name:'取消',exact:true}).click();await dismissDirectory(page);return page;
    };
    const alice=await login('alice');
    await alice.getByRole('button',{name:'创建项目组',exact:true}).click();
    const create=alice.getByRole('dialog',{name:'创建项目组',exact:true});await create.getByLabel('项目组名称').fill('竞赛优化组');
    await create.getByRole('button',{name:'创建项目组',exact:true}).click();await expect(create).toHaveCount(0);
    const guide=alice.getByRole('dialog',{name:'完善项目资料',exact:true});
    await expect(guide).toBeVisible();await guide.getByLabel('引导项目名称').fill('NVFP4转HiF4');
    for(const [label,value]of[['项目背景','算法比赛'],['项目目标','降低量化误差'],['验收标准','官方样例通过']])await guide.getByLabel(label,{exact:true}).fill(value);
    await guide.getByRole('button',{name:'保存并创建项目',exact:true}).click();await expect(guide).toHaveCount(0);
    await dismissDirectory(alice);
    const workspace=alice.locator('.workgroup').filter({hasText:'竞赛优化组'});await expect(workspace).toContainText('创建者');
    await alice.getByTitle('项目组管理：竞赛优化组',{exact:true}).click();
    await dialog(alice).getByLabel('选择已有成员').selectOption('bob');await dialog(alice).getByLabel('添加成员角色').selectOption('manager');
    await dialog(alice).getByRole('button',{name:'添加到项目组',exact:true}).click();await expect(dialog(alice)).toContainText('bob');
    await dialog(alice).getByLabel('选择已有成员').selectOption('carol');await dialog(alice).getByLabel('添加成员角色').selectOption('member');
    await dialog(alice).getByRole('button',{name:'添加到项目组',exact:true}).click();await expect(dialog(alice).locator('tbody tr')).toHaveCount(3);
    await alice.screenshot({path:path.join(data,'creator.png')});await close(alice);
    const bob=await login('bob');await expect(bob.locator('.workgroup')).toContainText('管理者');
    await bob.getByTitle('项目组管理：竞赛优化组',{exact:true}).click();await expect(dialog(bob).locator('tbody tr')).toHaveCount(3);
    await expect(dialog(bob).getByLabel('选择已有成员')).toHaveCount(0);await expect(dialog(bob).getByRole('button',{name:'删除项目组',exact:true})).toHaveCount(0);
    await bob.screenshot({path:path.join(data,'manager.png')});await close(bob);
    const carol=await login('carol');await carol.getByTitle('项目组管理：竞赛优化组',{exact:true}).click();
    await expect(dialog(carol).getByLabel('选择已有成员')).toHaveCount(0);await expect(dialog(carol)).toContainText('成员');await close(carol);
    await expect(carol.getByTitle('在 竞赛优化组 创建项目',{exact:true})).toHaveCount(0);
    const group=(await call(alice,'group.control',{action:'list'}))[0];
    await assert.rejects(call(carol,'group.control',{action:'delete',group:group.id,revision:group.revision}),/创建者/);
    await alice.getByTitle('项目组管理：竞赛优化组',{exact:true}).click();await dialog(alice).getByLabel('接任创建者').selectOption('bob');
    await dialog(alice).getByRole('button',{name:'确认移交',exact:true}).click();await dialog(alice).getByRole('button',{name:'确认移交创建者权限',exact:true}).click();
    await expect(dialog(alice).getByRole('button',{name:'删除项目组',exact:true})).toHaveCount(0);await close(alice);
    await call(bob,'remote.manifest');await bob.getByTitle('项目组管理：竞赛优化组',{exact:true}).click();
    await dialog(bob).getByRole('button',{name:'删除项目组',exact:true}).click();
    await expect(dialog(bob).getByLabel('项目组操作确认')).toContainText('1 个项目、3 位成员');
    await dialog(bob).getByRole('button',{name:'取消操作',exact:true}).click();assert.equal((await call(bob,'group.control',{action:'details',group:group.id})).deletedAt,undefined);
    await dialog(bob).getByRole('button',{name:'删除项目组',exact:true}).click();await dialog(bob).getByRole('button',{name:'确认删除项目组',exact:true}).click();await expect(dialog(bob)).toHaveCount(0);
    await expect(bob.locator('.setup-gate')).toBeVisible();
    await ap.getByRole('button',{name:'项目组管理',exact:true}).click();await ap.getByRole('button',{name:'项目组回收站',exact:true}).click();
    await expect(ap.locator('.admin-group-overview')).toContainText('竞赛优化组');await ap.getByLabel('管理项目组：竞赛优化组').click();
    await expect(dialog(ap)).toContainText('bob');await ap.screenshot({path:path.join(data,'admin-recycle.png')});
    await dialog(ap).getByRole('button',{name:'恢复项目组',exact:true}).click();await expect(dialog(ap)).toHaveCount(0);
    await call(bob,'remote.manifest');await expect(bob.locator('.workgroup')).toContainText('NVFP4转HiF4');
    await ap.getByRole('button',{name:'当前项目组',exact:true}).click();await expect(ap.locator('.admin-group-overview')).toContainText('竞赛优化组');
    await ap.getByLabel('管理项目组：竞赛优化组').click();await dialog(ap).getByLabel('接任创建者').selectOption('carol');
    await dialog(ap).getByRole('button',{name:'确认移交',exact:true}).click();await dialog(ap).getByRole('button',{name:'确认移交创建者权限',exact:true}).click();
    await expect(dialog(ap).locator('tbody tr').filter({hasText:'carol'})).toContainText('创建者');await close(ap);
    assert.deepEqual(errors,[]);assert.equal(await fs.readFile(path.join(data,'startup-errors.log'),'utf8').catch(()=>''),'');
    await fs.writeFile(path.join(data,'result.json'),JSON.stringify({passed:true,cases:['three user roles','user creation and project initialization','server rejects member deletion','explicit ownership transfer','cancel deletion','admin global view and recycle restore','system ownership recovery'],screenshots:['creator.png','manager.png','admin-recycle.png']},null,2));
    console.log(JSON.stringify({passed:true,data}));
  }catch(error){console.error(error);if(current)await current.screenshot({path:path.join(data,'failure.png')}).catch(()=>{});throw error;}
  finally{for(const app of apps.reverse()){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{});}backend.disconnect();for(const member of members)await member.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
