// Isolated examples rendered by the production synchronization components.
export function syncFixture(data) {
  const {id, stage, snapshot, adminSnapshot, project, at}=data;
  if(id==='case-project-sync'){
    snapshot.drafts=[];
    const local=structuredClone(snapshot);
    local.settings.workspaceSnapshot.profile.projects=[{...project,localOnly:true}];
    snapshot.personal=local;
    data.profile.projects=[];
    snapshot.connection.profile.projects=[];
    snapshot.settings.workspaceSnapshot.profile.projects=[];
    for(const profile of snapshot.settings.connections)profile.projects=[];
    snapshot.projectSync={[project.id]:{localOnly:stage==='create'||stage==='link',pending:stage==='link'}};
    const localBody='保留当前样例的验证结果，并补充大输入复测。';
    const remoteBody='保留当前样例的验证结果，并记录运行设备。';
    const conflict={key:'material:personal-0',token:'example-sync-token',local:{title:'验证记录',content:localBody},remote:{title:'验证记录',content:remoteBody},base:{title:'验证记录',content:'保留当前样例的验证结果。'},fields:[{path:['content'],base:'保留当前样例的验证结果。',local:localBody,remote:remoteBody}],ai:{status:'ready',summary:'双方新增了不同的验证要求，可共同保留。',unresolved:[],fields:[{path:['content'],text:'保留当前样例的验证结果，补充大输入复测并记录运行设备。',reason:'保留双方新增要求，未改写样例结论。'}]}};
    snapshot.accountSync={status:stage==='conflict'?'conflict':'synced',syncedAt:at,conflicts:stage==='conflict'?[conflict]:[],history:stage==='history'?[{id:'merge-example',at,method:'manual'}]:[]};
  }
  if(id==='case-project-recommendations'){
    data.rsiInbox={projectId:project.id,enabled:true,busy:false,queued:false,sessions:[{id:data.session.id,title:data.session.title}],items:[{id:'project-next-step',title:'补充大输入的复测记录',action:'沿用当前验证条件增加一组大输入样例，记录耗时和失败项。',reason:'当前项目已有普通样例结果，大输入的适用范围尚未覆盖。',conditions:['沿用本轮设备与代码版本'],uncertainty:'更大样本上的结果仍待实测。',createdAt:at,evidence:[{id:'evidence-example',text:'当前验证记录：普通样例已通过，大输入仍需补测。'}],review:{decision:stage==='accepted'?'accepted':'pending',closed:false,feedback:'',decisionEventId:stage==='accepted'?'decision-example':undefined}}]};
  }
  if(id==='case-member-sync'){
    const users=Object.values(adminSnapshot.state.users);
    for(const u of users)u.revision='member-v1';
    adminSnapshot.memberSync={teamId:'example-team',lastSyncedAt:at,pending:stage==='pending'?[{id:'pending-member',status:'pending',command:{username:'david',name:'David'}}]:[]};
    if(stage==='pending'){adminSnapshot.connected=false;adminSnapshot.verified=false;}
  }
  return data;
}
