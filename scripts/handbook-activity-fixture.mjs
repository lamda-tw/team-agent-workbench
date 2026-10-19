// Example recommendation states for the production conversation UI.
export function activityFixture(data) {
  if(data.id!=='case-activity-recommendations'&&!data.pane.recommendation)return data;
  const {snapshot,session,content,conclusions,at}=data;
  const stage=data.pane.recommendation||data.stage;
  snapshot.drafts=[];
  if(data.id==='case-activity-recommendations')session.title='复核两种格式的验证方案';
  const event={...data.updates[0],category:'exploration'};
  const job={id:'activity-match',owner:'handbook-account',sessionId:session.id,event,status:'matched',attempts:1,
    reason:'当前会话正在核对正确性与输入规模，这条成果提供了已验证的样例范围和测试条件。',
    excerpt:'格式 A 在本轮样例下通过正确性检查；记录了设备、输入规模和代码版本，大输入仍需补测。',body:content[0].description};
  snapshot.activity={jobs:[job],busy:false};
  const input=snapshot.inputs[session.id]||{text:'',sourceIds:[],answers:{}};
  input.text=data.pane.recommendationInput||'请按目前的验证条件，补充下一轮测试清单。';
  snapshot.inputs[session.id]=input;
  if(stage==='attached'||stage==='saved'){
    const source={id:'recommended-reference',name:event.title,sourcePath:content[0].path,localPath:data.directory+'\\推荐参考.md',sha256:'7'.repeat(64),size:2400,fetchedAt:at};
    session.sources.push(source);input.sourceIds=[...(input.sourceIds||[]),source.id];
    Object.assign(job,{attachedSourceId:source.id,savedConclusionId:'adopted-result',availableConclusionId:'adopted-result',presentedAt:at});
    const conclusion={...conclusions[0],id:'adopted-result',title:content[0].title,content:content[0].description,category:'exploration',archived:false};
    data.conclusions=[conclusion];
  }
  return data;
}
