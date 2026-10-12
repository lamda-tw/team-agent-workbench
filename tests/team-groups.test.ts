import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from './fixtures/member-profile';
import { readRegistry, writeRegistry } from '../src/core/local-space';
import type { TeamGroup, GroupCommand } from '../src/shared/team-groups';

test('members create groups, scoped roles govern content and membership; creator transfer, deletion and system recovery preserve data', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-team-groups-')), share=path.join(root,'share'); await fs.mkdir(share);
  const admin=new LocalAdminConnection(()=>{}), alice=new Workbench(path.join(root,'alice'),()=>{},()=>{}), bob=new Workbench(path.join(root,'bob'),()=>{},()=>{}), carol=new Workbench(path.join(root,'carol'),()=>{},()=>{});
  const act=async(wb:Workbench,command:GroupCommand)=>await wb.groupCommand(command) as TeamGroup;
  const details=(wb:Workbench,group:string)=>act(wb,{action:'details',group});
  try {
    await admin.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',fingerprint:'',root:'/srv/teamspace'},'','',async()=>false);
    await admin.operation({op:'initialize'});
    for(const username of ['alice','bob','carol']) await admin.operation({op:'user_create',username,name:username,password:'123'});
    for(const [username,wb] of [['alice',alice],['bob',bob],['carol',carol]] as const) { await wb.store.init(); await wb.configureWorkspace(memberProfile(admin.snapshot.profile!,admin.snapshot.state!,username),'123',root,async()=>false); }
    assert.equal(alice.workspaceReady,false);
    const group=await act(alice,{action:'create',label:'算法组'});
    assert.equal(group.creator,'alice'); assert.equal(group.role,'creator'); assert.equal(alice.workspaceReady,true);
    const other=await act(carol,{action:'create',label:'软件组'});
    await assert.rejects(details(bob,group.id),/没有.*权限/);
    await assert.rejects(act(alice,{action:'create',label:'冒用创建',creator:'bob'}),/登录身份/);
    await assert.rejects(act(alice,{action:'create',label:'算法组'}),/已存在/);
    const joined=await act(alice,{action:'member',group:group.id,revision:group.revision,username:'bob',role:'manager'});
    await bob.refreshGroups(); assert.equal(bob.remote.workspaces[0].role,'manager');
    await assert.rejects(act(bob,{action:'member',group:group.id,revision:joined.revision,username:'carol',role:'member'}),/创建者/);
    await assert.rejects(act(bob,{action:'delete',group:group.id,revision:joined.revision}),/创建者/);
    const project=await bob.createProject('实体抽取',group.id,{background:'背景',objectives:'目标',acceptance:'验收',scope:'',deliverables:'',resources:'',constraints:'',collaboration:''});
    const source=path.join(root,'result.md'); await fs.writeFile(source,'研究结果');
    await alice.refreshGroups(); const binding=alice.remote.binding(project.id);
    const item=await alice.remote.upload(binding,source,binding.project.uploadPath+'/result.md',()=>{},{kind:'contribution',title:'结果',description:'验证结果'});
    const published=(await bob.remote.contentList(bob.remote.binding(project.id)))[0];
    await bob.remote.contentEdit(bob.remote.binding(project.id),{id:published.id,revision:published.revision,action:'save',title:'整理结果',description:'整理后的内容',curate:true,merge:[]});
    let current=await details(alice,group.id);
    await assert.rejects(act(alice,{action:'member',group:group.id,revision:current.revision,username:'alice',role:'remove'}),/移交/);
    await assert.rejects(admin.operation({op:'group_member',username:'alice',group:group.id,role:'member'}),/移交/);
    await assert.rejects(act(alice,{action:'member',group:group.id,revision:group.revision,username:'carol',role:'member'}),/已变化/);
    const moved=await act(alice,{action:'transfer',group:group.id,revision:current.revision,username:'bob'});
    assert.equal(moved.creator,'bob'); assert.equal(moved.createdBy,'alice'); assert.equal(moved.role,'manager');
    await assert.rejects(act(alice,{action:'delete',group:group.id,revision:moved.revision}),/创建者/);
    const bobView=await details(bob,group.id);
    await act(bob,{action:'delete',group:group.id,revision:bobView.revision});
    await admin.operation({op:'user_groups',username:'alice',groups:[],contentAdminGroups:[]});
    assert((await readRegistry(share)).state.users.alice.groups?.includes(group.id),'editing active memberships preserves recycled group membership for restoration');
    await assert.rejects(alice.remote.contentList(binding),/不属于|权限/);
    await assert.rejects(act(bob,{action:'restore',group:group.id,revision:bobView.revision}),/权限|管理端/);
    const all=await admin.operation({op:'group_control',command:{action:'list'}}) as TeamGroup[];
    assert.equal(all.length,2); const deleted=all.find(value=>value.id===group.id)!; assert(deleted.deletedAt); assert.equal(deleted.projects.length,1);
    await admin.operation({op:'group_control',command:{action:'restore',group:group.id,revision:deleted.revision}});
    await bob.refreshGroups(); const restored=await bob.remote.contentList(bob.remote.binding(project.id)); assert.equal(restored[0].description,'整理后的内容');
    const carolView=await details(carol,other.id); assert.equal(carolView.role,'creator');
    await assert.rejects(act(bob,{action:'member',group:other.id,revision:carolView.revision,username:'bob',role:'manager'}),/权限/);
    current=await details(bob,group.id); await act(bob,{action:'delete',group:group.id,revision:current.revision});
    const trash=(await admin.operation({op:'group_control',command:{action:'list'}}) as TeamGroup[]).find(value=>value.id===group.id)!;
    await admin.operation({op:'group_control',command:{action:'purge',group:group.id,revision:trash.revision}});
    assert.equal((await admin.operation({op:'group_control',command:{action:'list'}}) as TeamGroup[]).length,1);
    assert.equal((await readRegistry(share)).state.users.bob.groups?.includes(group.id),false);
    const replacement=await act(alice,{action:'create',label:'算法组'});
    assert.notEqual(replacement.id,group.id);
    const newProject=await alice.createProject('新项目',replacement.id,{background:'背景',objectives:'目标',acceptance:'验收',scope:'',deliverables:'',resources:'',constraints:'',collaboration:''});
    const newBinding=alice.remote.binding(newProject.id);
    await alice.remote.upload(newBinding,source,newBinding.project.uploadPath+'/new.md',()=>{},{kind:'contribution',title:'新结果',description:'新验证'});
    assert.equal((await alice.remote.contentList(newBinding)).length,1,'purged tombstones cannot intercept a reused visible folder name');
    assert.deepEqual((await admin.projectCatalog()).projects.map(item=>item.group),[replacement.id]);
  } finally { admin.disconnect(); await Promise.all([alice.close(),bob.close(),carol.close()]); await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
});

test('creator grants are tied to account identity, not a reused username or a password change', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-group-identity-')),share=path.join(root,'share');await fs.mkdir(share);
  const admin=new LocalAdminConnection(()=>{}),wb=new Workbench(path.join(root,'alice'),()=>{},()=>{});
  try{
    await admin.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',fingerprint:'',root:'/srv/teamspace'},'','',async()=>false);await admin.operation({op:'initialize'});await admin.operation({op:'user_create',username:'alice',name:'Alice',password:'123'});
    const profile=memberProfile(admin.snapshot.profile!,admin.snapshot.state!,'alice');await wb.store.init();await wb.configureWorkspace(profile,'123',root,async()=>false);
    const group=await wb.groupCommand({action:'create',label:'身份组'}) as TeamGroup;
    await admin.operation({op:'user_password',username:'alice',password:'new'});await wb.configureWorkspace(profile,'new',root,async()=>false);
    assert.equal((await wb.groupCommand({action:'details',group:group.id}) as TeamGroup).role,'creator');
    const registry=await readRegistry(share);registry.state.users.alice.accountId='recreated-account';await writeRegistry(share,registry);await wb.refreshGroups();
    const view=await wb.groupCommand({action:'details',group:group.id}) as TeamGroup;assert.equal(view.role,'manager');
    await assert.rejects(wb.groupCommand({action:'delete',group:group.id,revision:view.revision}),/创建者/);
  }finally{admin.disconnect();await wb.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('system administration can recover a disabled creator without granting a manager ownership powers',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-owner-recovery-')),share=path.join(root,'share');await fs.mkdir(share);
  const admin=new LocalAdminConnection(()=>{}),alice=new Workbench(path.join(root,'alice'),()=>{},()=>{}),bob=new Workbench(path.join(root,'bob'),()=>{},()=>{});
  try{
    await admin.connect({mode:'local',localRoot:share,host:'local',port:22,username:'',fingerprint:'',root:'/srv/teamspace'},'','',async()=>false);await admin.operation({op:'initialize'});
    for(const name of ['alice','bob'])await admin.operation({op:'user_create',username:name,name,password:'123'});
    for(const [name,wb]of [['alice',alice],['bob',bob]]as const){await wb.store.init();await wb.configureWorkspace(memberProfile(admin.snapshot.profile!,admin.snapshot.state!,name),'123',root,async()=>false);}
    const group=await alice.groupCommand({action:'create',label:'负责人移交组'})as TeamGroup;
    await alice.groupCommand({action:'member',group:group.id,revision:group.revision,username:'bob',role:'manager'});
    await admin.operation({op:'user_enabled',username:'alice',enabled:false});
    await assert.rejects(alice.groupCommand({action:'list'}),/停用|身份/);
    const view=await bob.groupCommand({action:'details',group:group.id})as TeamGroup;
    await assert.rejects(bob.groupCommand({action:'transfer',group:group.id,revision:view.revision,username:'bob'}),/创建者/);
    const recovered=await admin.operation({op:'group_control',command:{action:'transfer',group:group.id,revision:view.revision,username:'bob'}})as TeamGroup;
    assert.equal(recovered.creator,'bob');assert.equal(recovered.createdBy,'alice');await bob.refreshGroups();assert.equal(bob.remote.workspaces[0].role,'creator');
  }finally{admin.disconnect();await Promise.all([alice.close(),bob.close()]);await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
