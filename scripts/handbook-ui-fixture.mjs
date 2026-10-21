// Example data for screenshots of the production renderers. No server or model calls.
import { syncFixture } from './handbook-sync-fixture.mjs';
import { questionFixture } from './handbook-question-fixture.mjs';
import { activityFixture } from './handbook-activity-fixture.mjs';
export function makeFixture(id, step, paneIndex, pane, stage = '') {
  const at = '2026-10-16T01:30:00.000Z';
  const ocr = id === 'case-first-session';
  const username = pane.actor.includes('Alice') ? 'alice' : pane.actor.includes('Carol') ? 'carol' : pane.actor.includes('成员 A') ? 'member-a' : pane.actor.includes('成员 B') ? 'member-b' : 'bob';
  const admin = username === 'alice';
  const name = username === 'alice' ? 'Alice' : username === 'carol' ? 'Carol' : username === 'bob' ? 'Bob' : pane.actor;
  const project = { id: 'handbook-project', name: ocr ? '票据 OCR 优化' : '量化转换项目', groupName: 'team_one', groupLabel: ocr ? '项目一组' : '算法研发', remoteRoot: '/srv/teamspace/projects/example', uploadPath: '/srv/teamspace/projects/example/成果', historyPath: '/srv/teamspace/projects/example/轨迹', managed: true, briefRevision: 1 };
  const beforeProject = ocr && (step <= 3 || step === 4 && paneIndex === 1);
  const profile = { id: 'handbook-team', mode: 'sftp', name: name + ' · 团队账号', host: 'team.example.internal', port: 22, username, fingerprint: 'SHA256:handbook-example', manifestPath: '', workPath: '', projects: beforeProject ? [] : [project] };
  const workspace = { path: '/srv/teamspace/projects', canonicalPath: '/srv/teamspace/projects', canCreateProject: admin, groupName: project.groupName, groupLabel: project.groupLabel, isEmpty: beforeProject };
  const directory = 'D:\\work\\' + username + (ocr ? '\\ocr' : '\\quantization');
  const binding = { connectionId: profile.id, host: profile.host, port: 22, username, fingerprint: profile.fingerprint, project };
  const source = { id: 'project-brief', name: '项目说明 · v1', localPath: directory + '\\项目说明.md', sourcePath: project.remoteRoot + '/项目说明.md', sha256: 'a'.repeat(64), size: 2400, fetchedAt: at };
  const brief = { background: ocr ? '票据识别存在字段漏检，需要统一复核方法。' : '比较格式 A 与格式 B 的正确性及性能。', objectives: ocr ? '复核漏检样本，建立可重复的验证基线。' : '复现两种方案，保留实验依据并确定适用范围。', acceptance: '提交样本清单、代码版本、测试日志和结论，由 Alice 复核。', scope: '固定数据集与运行设备，记录实验差异。', resources: '基线说明.md、样本清单.csv、测试脚本。', deliverables: '验证报告与复核记录。', constraints: '使用脱敏样本，记录未确认项。', collaboration: 'Bob 复核漏检样本；Carol 检查标注质量；Alice 汇总并复核。' };
  const sessionTitle = ocr ? username === 'bob' ? '复核票据 OCR 漏检样本' : username === 'carol' ? '票据样本标注质量检查' : '票据 OCR 验证方案' : admin ? '格式 A 验证' : '格式 B 验证';
  const session = { id: 'work-session', title: sessionTitle, provider: username === 'carol' ? 'cursor' : 'codex', model: '', cwd: directory, purpose: 'work', createdAt: at, status: 'idle', messages: [], approvals: [], sources: [source], binding, permissionMode: 'review', autoUpload: false, handoffPath: '', projectBrief: { revision: 1, sourceId: source.id, capturedAt: at } };
  const firstInput = pane.screen.includes('首次输入');
  if (!firstInput) session.messages = [
    { id: 'question', role: 'user', text: ocr ? '请核对本轮样本并记录复核方法、结果和限制。' : '请使用统一样例验证方案，记录运行设备、输入规模与结果。', createdAt: at },
    { id: 'answer', role: 'assistant', text: ocr ? '已完成样本复核。\n\n- 复核清单记录了字段与漏检原因。\n- 标注差异已列入待确认项。\n- 测试日志与结果表已保存，供团队复核。' : '已完成本轮验证。\n\n- 两种格式在统一样例下均通过正确性检查。\n- 大输入时格式 B 耗时更低，需要按输入规模区分适用范围。\n- 设备、代码版本与测试日志已记录。', createdAt: at }
  ];
  if (id === 'case-egress-mixed' || id === 'case-session-routes') {
    session.title = '分析项目资料';
    session.messages = [
      { id: 'question', role: 'user', text: '请读取 data/input-samples.csv 中的样本，按项目要求比较两种格式，记录依据与待确认项。', createdAt: at },
      { id: 'answer', role: 'assistant', text: '已根据所选样本完成本轮比较。\n\n- 比较记录列出了输入条件及两种格式的差异。\n- 待确认项已单独列出，供后续复核。\n- 请核对结果是否覆盖本次指定的资料范围。', createdAt: at }
    ];
  }
  const content = [
    { title: ocr ? '票据 OCR 基线说明' : '格式 A 验证结论', author: 'alice', description: '## 验证结果\n统一样例下结果正确。\n\n## 证据\n设备 GPU-1，固定测试样本，代码版本 a16。\n\n## 适用范围\n当前数据规模内有效；大输入需要补测。' },
    { title: ocr ? '票据样本标注质量检查' : '格式 B 大输入性能反例', author: ocr ? 'carol' : 'bob', description: '## 复核结论\n大输入下出现性能差异。\n\n## 实验记录\n设备 GPU-2，代码版本 b17，输入规模与测试日志已记录。\n\n## 下一步\n按相同条件复测，并保留不同输入下的结论。' }
  ].map((item, i) => ({ ...item, id: 'shared-' + i, path: project.uploadPath + '/result-' + i + '.md', kind: 'contribution', category: 'verification', state: 'submitted', revision: 1, createdAt: at, updatedAt: at, updatedBy: item.author, sha256: String(i+1).repeat(64), size: 2800, attachments: [], sourceSessionTitle: i ? '格式 B 验证' : '格式 A 验证' }));
  if (ocr) {
    content[0].description = '## 验证口径\n按票据编号核对金额、日期与抬头字段，记录漏检和识别错误。\n\n## 复核记录\n每项记录样本编号、模型版本、预期值、识别值和复核人。\n\n## 验收材料\n提交复核清单、运行日志、结论与待确认项。';
    content[0].sourceSessionTitle = '票据 OCR 验证方案';
    content[1].description = '## 检查结果\n已检查票据样本的字段标注，发现 2 处日期格式不一致。\n\n## 证据\n标注复核清单记录了样本编号、原标注及建议修正值。\n\n## 待确认项\n请 Alice 确认日期字段采用的统一格式，再更新标注。';
    content[1].sourceSessionTitle = '票据样本标注质量检查';
    if(step>=9)content.push({...content[0],id:'shared-bob',title:'票据漏检复核结论',author:'bob',updatedBy:'bob',path:project.uploadPath+'/bob-review.md',description:'## 复核结果\n已完成漏检样本复核，按字段归类原因。\n\n## 证据\n复核清单与运行日志保留样本编号和模型版本。\n\n## 待确认项\n部分模糊图像需补充清晰样本后复测。',sourceSessionTitle:sessionTitle});
  }
  if (id === 'case-admin-results' && (step > 2 || step === 2 && paneIndex === 2)) { content[1].title='格式 B 在大输入下的性能反例'; content[1].state = 'curated'; content[1].revision = 2; content[1].updatedBy = 'alice'; }
  if (id === 'case-admin-results' && step === 5) {
    content[0].title='过期基线说明'; content[1].title='旧样本测试记录';
    for(const item of content)item.description='这条旧记录已由新基线和综合结果替代，组管理员核对后清理。';
  }
  const conclusions = [
    { id: 'personal-0', title: '格式 A 验证结论', titleAlias: step >= 3 && id === 'case-personal-results' ? '格式 A 对照基线' : '', content: content[0].description, sources: [{ id: content[0].id, kind: 'remote', title: content[0].title, path: content[0].path, revision: 1, updatedAt: at, content: content[0].description }] },
    { id: 'personal-1', title: '格式 B 大输入复测', content: content[1].description, sources: [{ id: 'manual-note', kind: 'manual', title: '手工记录', updatedAt: at }] }
  ].map(item => ({ ...item, category: 'verification', projectId: project.id, updatedAt: at, version: 1, archived: id === 'case-personal-results' && step === 6 && paneIndex === 1 }));
  const visibleUpdates = id === 'example' ? ['align', 'explore', 'prepare'].includes(stage) ? [] : ['publish', 'adopt'].includes(stage) ? [content[0]] : content : ocr ? step >= 10 ? [content[1]] : [] : content;
  const updates = visibleUpdates.map((item, i) => ({ eventId: 'activity-' + i, projectId: project.id, projectName: project.name, id: item.id, path: item.path, title: item.title, author: item.author, updatedBy: item.updatedBy, revision: item.revision, category: item.category, change: 'new', detectedAt: at, occurredAt: at, actions: [] }));
  if ((id === 'case-admin-results' && step >= 4)||(id==='example'&&stage==='synthesize')) { const deleted=id==='case-admin-results'&&step===5; if(deleted){for(const update of updates)update.change='deleted';}else{updates[0].change='merged';updates[0].title='格式 A/B 的适用范围';updates[0].sourceTitles=content.map(item=>item.title);} }
  const task = { id: 'example-task', projectId: project.id, title: '复核票据 OCR 漏检样本', description: '复核票据字段漏检，记录样本、代码版本、方法与结果。', acceptance: '提交复核清单、日志、结论与未确认项。', assignee: 'bob', assigneeName: 'Bob', createdBy: 'alice', createdAt: at, updatedAt: at, revision: 1, status: step >= 10 ? 'pending_review' : step >= 9 ? 'in_progress' : 'assigned', references: [{ id: content[0].id, title: content[0].title, revision: 1, content: content[0].description, author: 'alice', updatedAt: at }], files: [], history: [], submissions: [] };
  const submissionFiles=['复核清单.csv','复核运行日志.txt'].map((name,i)=>({id:'review-file-'+i,name,sha256:'e'.repeat(64),md5:'f'.repeat(32),size:2048,path:project.remoteRoot+'/验收/'+name,source:'task'}));
  if (ocr && step >= 10) task.submissions = [{ summary: '已完成漏检复核，复核清单、证据与未确认项见关联成果。', references: [{...content[2],content:content[2].description}], files: submissionFiles, submittedBy: 'bob', submittedAt: at }];
  if (ocr && username === 'bob' && step >= 7 && !(step===7 && paneIndex===1)) session.assignment = { id: task.id, revision: 1, title: task.title, sourceIds: [source.id] };
  const merge = pane.screen.includes('语义合并') && pane.screen.includes('成果整理') || pane.screen.includes('综合结果确认');
  const personalMerge = pane.screen.includes('个人成果处理');
  const draftTitle = ocr ? '票据样本标注质量检查' : merge ? '格式 A/B 的适用范围' : personalMerge ? 'A/B 方案对比' : admin ? '格式 A 验证结论' : '格式 B 大输入性能反例';
  const draft = { id: 'example-draft', sessionId: session.id, sourceSessionTitle: session.title, generation: pane.status === '正在生成' ? 'running' : 'ready', generationStartedAt: at, generationStage: 'agent', createdAt: at, title: draftTitle, body: content[1].description, files: [], inputDir: directory, outputPath: directory + '\\成果.md', binding, destinations: [{ id: 'team', path: project.uploadPath, description: '项目团队成果' }], target: project.uploadPath, artifacts: [{ id: 'artifact-1', category: 'verification', title: draftTitle, body: content[1].description, fields: { result: '完成本轮复核', evidence: '测试清单与日志', limitations: '待补测大输入' }, target: project.uploadPath, selected: true }], ...(merge ? { mergeProjectId: project.id, mergeSources: content.map(item => ({ id: item.id, revision: 1, title: item.title, author: item.author, updatedAt: at })), mergeAnalysis: { overview: '格式 A/B 在统一样例下均正确，性能随输入规模变化。', consensus: ['保留正确性验证与统一测试口径。'], conflicts: [], evidence: [{ claim: '大输入下格式 B 更快。', sourceIds: ['shared-1'] }], scope: '当前设备与测试输入。', unresolved: ['补测其他设备。'] } } : {}), ...(personalMerge ? { conclusionMergeProjectId: project.id } : {}) };
  if(personalMerge)draft.mergeSources=conclusions.map(item=>({id:item.id,revision:item.version,title:item.title,author:username,updatedAt:at}));
  if(merge||personalMerge)draft.body='## 共同结论\n两种格式在统一样例下均通过正确性验证。\n\n## 适用范围\n常规输入采用格式 A；大输入按本轮复测结果评估格式 B。\n\n## 证据与后续验证\n保留 Alice 与 Bob 的输入规模、设备和代码版本记录；下一轮在同一设备上复测性能差异。';
  for(const item of content)item.category='exploration';
  for(const item of conclusions){item.category='exploration';item.localFiles=[];}
  const sampleFile={id:'handbook-evidence',name:ocr?'标注复核清单.csv':'格式对照记录.csv',localPath:directory+'\\对照记录.csv',sourcePath:directory+'\\对照记录.csv',sha256:'9'.repeat(64),size:2048,fetchedAt:at,userAttachment:true};
  draft.resultCategory='exploration';draft.requestedCategories=['exploration'];draft.resultRules={contract:4,categories:['exploration']};
  draft.files=[sampleFile];
  for(const item of draft.artifacts){item.category='exploration';item.attachments=[{fileId:sampleFile.id,selected:true}];}
  if(merge||personalMerge)draft.attachments=[{fileId:sampleFile.id,selected:true}];
  if(id==='example'&&stage==='publish'&&username==='alice'){draft.body=content[0].description;draft.artifacts[0].body=content[0].description;}
  if((id==='example'&&stage==='retest'&&paneIndex===2)||pane.screen.includes('AI 参考内容')){
    session.sources.push({...source,id:'personal-reference',name:'格式 A 对照基线',sourcePath:'conclusion:personal-0',sha256:'c'.repeat(64)});
    if(id==='example')session.sources.push({...source,id:'bob-reference',name:'Bob · 格式 B 大输入性能反例',sha256:'d'.repeat(64)});
    const userMessage=session.messages.find(message=>message.role==='user');if(userMessage)userMessage.context={nativeId:'example-turn',accepted:true,workRecord:true,sourceHashes:Object.fromEntries(session.sources.map(item=>[item.id,item.sha256]))};
  }
  const showSessions = !ocr || step >= 6;
  const settings = { connections: [profile], providerPaths: { codex: '', cursor: '', claude: '' }, lastWorkspace: directory, localWorkspace: directory, verifiedLocalWorkspace: directory, projectDirectories: { [JSON.stringify(['sftp',profile.host,22,'',username,profile.fingerprint,project.id])]: directory }, workspaceSnapshot: { profile, workspaces: [workspace] }, contentUpdates: updates, dismissedContentUpdateIds:updates.map(u=>u.eventId), contentAliases: {} };
  const enabled = id === 'case-egress-mixed' && username === 'member-b' && step >= 2;
  settings.egress = { enabled, host:'admin-pc',port:18443,certificateFingerprint:'abcdef0123456789'.repeat(4) };
  const snapshot = { settings, sessions: showSessions ? [session] : [], inputs: { [session.id]: { text: firstInput ? pane.rows.find(row => row[0] === '输入草稿')?.[1] || '请复核当前样本。' : '', sourceIds: [source.id], answers: {} } }, drafts: [draft], transfers: [], connection: { profile, connected: true, workspace, workspaces: [workspace] }, workspaceReady: true, providers: ['codex','cursor','claude'].map(provider => ({ provider, available: true, path: provider + '.cmd', version: '已安装', detail: '' })), auth: Object.fromEntries(['codex','cursor','claude'].map(provider => [provider,{status:'authenticated',detail:'已登录',identity:name+' 的模型账号',cwd:directory,checkedAt:at}])), accountSync: {status:'synced',syncedAt:at}, egress: { enabled, configured: enabled, available: enabled, running: enabled, hasAccessCode: enabled, endpoint: 'admin-pc:18443', detail: enabled ? '管理端网络出口可用' : '使用本机网络' } };
  if(enabled){
    settings.egress.viaSharedServer=true;
    settings.egress.sharedServer={host:profile.host,port:profile.port,fingerprint:profile.fingerprint,relayPort:41843};
    snapshot.egress.viaSharedServer=true;
    snapshot.egress.detail='经共享服务器中转，管理端网络出口可用';
  }
  if(ocr && step<9){snapshot.drafts=[];snapshot.settings.contentUpdates=[];}
  if(id==='example'&&['align','explore','prepare'].includes(stage)){
    snapshot.drafts=[];
    if(username==='alice')session.messages=[
      {id:'question',role:'user',text:'请按项目的统一样例验证格式 A，记录正确性、设备、输入和适用范围。',createdAt:at},
      {id:'answer',role:'assistant',text:'格式 A 在当前样例下通过正确性检查。\n\n- 已记录测试输入、设备与代码版本。\n- 当前结论适用于本轮样例，大输入仍需补测。\n- 请结合测试日志核对结果，再将本轮记录整理为团队可查看的成果。',createdAt:at}
    ];
  }
  if(ocr && pane.screen.includes('新建工作会话'))snapshot.sessions=[];
  const users = Object.fromEntries(['alice','bob','carol'].map(n => [n,{username:n,name:n[0].toUpperCase()+n.slice(1),enabled:true,groups:['team_one'],contentAdminGroups:n==='alice'?['team_one']:[]}]));
  const group = {name:'team_one',label:'项目一组',adminGroup:'team_one_admin',workspace:'/srv/teamspace/projects/team-one'};
  const adminSnapshot = { connected:true,verified:true,busy:false,role:'administrator',profile:{mode:'sftp',host:profile.host,port:22,username:'root',root:'/srv/teamspace',fingerprint:profile.fingerprint},state:{initialized:true,storageVersion:5,sftpConfigured:true,users: ocr && step===1 ? {} : users,groups: ocr && step===1 && paneIndex===1 ? {} : {team_one:group}},missingCommands:[],setupIssues:[],egress:{config:{enabled:true,listenHost:'0.0.0.0',listenPort:18443,publicHost:'admin-pc',upstreamMode:'direct',upstreamHost:'',upstreamPort:8080,upstreamUsername:'',codex:true,cursor:true,claude:true},running:true,fingerprint:'abcdef0123456789'.repeat(4),inviteCode:'TAE1.handbook-example-access-code',hasUpstreamPassword:false,activeConnections:0,events:[]} };
  if(id==='case-egress-mixed'){
    const connected=step>=2;
    adminSnapshot.egress.reverse={enabled:connected,state:connected?'connected':'disabled',detail:connected?'反向隧道已连接，成员可经共享服务器访问本机出口':'未启用反向隧道',server:profile.host+':'+profile.port,remotePort:connected?41843:undefined,memberAccessConfigured:connected,activeConnections:0,reconnects:0,bytesUp:0,bytesDown:0};
    adminSnapshot.state.egressJumpTargets=connected?[{host:'127.0.0.1',port:41843}]:[];
  }
  if(id==='case-team-setup'){
    adminSnapshot.state={initialized:false,users:{},groups:{}};
    adminSnapshot.egress.config.enabled=false;
    adminSnapshot.egress.running=false;
    adminSnapshot.egress.inviteCode='';
    if(step===1&&paneIndex===1){
      adminSnapshot.connected=false;adminSnapshot.verified=false;
      adminSnapshot.profile={mode:'sftp',host:'',port:22,username:'',root:'/srv/teamspace',fingerprint:''};
    }else if(step<=2){
      adminSnapshot.missingCommands=['setfacl'];
      adminSnapshot.setupIssues=['缺少 ACL 支持，需要安装 acl 软件包以设置团队目录权限。'];
    }
  }
  return syncFixture(activityFixture(questionFixture({id,step,paneIndex,pane,stage,at,project,profile,workspace,directory,binding,source,brief,session,content,conclusions,updates,task,submissionFiles,draft,snapshot,adminSnapshot,beforeProject,admin,username})));
}

export function installFixture(data) {
  const listeners = [];
  const emit = () => listeners.forEach(listener => listener({ type: 'state' }));
  window.__handbook = { data, calls: [], unhandled: [] };
  const copy = value => structuredClone(value);
  const catalog = { models:[{id:'default',name:'CLI 默认模型',isDefault:true}],quota:{windows:[],detail:'使用个人模型账号',url:''},checkedAt:data.at };
  const call = async (action, payload={}) => {
    action=action.replace(/^personal:/,'');
    if(action==='workspace.select'||action==='activity.project')return;
    if(action==='rsi.inbox')return copy(data.rsiInbox||{enabled:true,items:[],sessions:[],queued:false,busy:false});
    if(action==='rsi.settings')return {config:{enabled:true,quiet:false},cwd:data.directory};
    window.__handbook.calls.push(action);
    if(action==='snapshot') return copy(data.snapshot);
    if(action==='activity.project') return;
    if(action==='activity.presented') {for(const job of data.snapshot.activity.jobs)if(payload.jobIds.includes(job.id))job.presentedAt=data.at;return;}
    if(action==='question.members') return [{username:'bob',name:'Bob'},{username:'carol',name:'Carol'}].filter(member=>member.username!==data.username);
    if(action==='question.read') {data.snapshot.questions.read[payload.id]=payload.revision;return;}
    if(action==='question.files.stage') return [{id:'sample-list',name:'样本清单.csv',size:2300}];
    if(action==='assignment.list') return copy(data.id==='case-first-session' && data.step>=5 ? [data.task] : []);
    if(action==='assignment.members') return [{username:'alice',name:'Alice'},{username:'bob',name:'Bob'},{username:'carol',name:'Carol'}];
    if(action==='content.list') return copy(data.id==='case-first-session' && data.step<10 ? data.content.filter((item,i)=>i===0 || data.step===9 && data.username==='bob' && item.author==='bob') : data.content);
    if(action==='content.history') return [];
    if(action==='assignment.files.pick') return copy(data.submissionFiles);
    if(action==='conclusion.list') return copy(data.pane.screen.includes('个人成果')||data.pane.screen.includes('项目成果库 › 个人')||data.pane.screen.includes('AI 参考内容') ? data.conclusions : []);
    if(action==='content.sync' || action==='content.updates') return copy(data.updates);
    if(action==='project.brief') return {brief:copy(data.brief),revision:1,updatedAt:data.at};
    if(action==='result.rules') return {owner:data.username,version:'example-1',preferences:{combinations:[],projects:{}},combination:{id:'research',name:'算法研究',categories:['finding','project_standard','method_exploration','verification','issue','baseline_change_proposal']}};
    if(action==='remote.manifest') return copy(data.profile);
    if(action==='remote.list') return [{name:'项目说明.md',path:data.project.remoteRoot+'/项目说明.md',kind:'file',size:2400,modified:Date.parse(data.at)},{name:'samples',path:data.project.remoteRoot+'/samples',kind:'directory',size:0,modified:Date.parse(data.at)}];
    if(action==='workspace.research' || action==='choose.directory') return data.directory;
    if(action==='provider.catalog') return copy(catalog);
    if(action==='provider.permissions') return {provider:payload.provider,checkedAt:data.at,source:'config',sandbox:'workspace-write',approval:'on-request',warnings:[],allowedModes:['inherit','review','auto','full']};
    if(action==='provider.capabilities') return {provider:payload.provider,skills:[],plugins:[],checkedAt:data.at};
    if(action==='provider.auth') { data.snapshot.auth[payload.provider].cwd=payload.cwd||data.directory; emit(); return copy(data.snapshot.auth[payload.provider]); }
    if(action==='session.input') {data.snapshot.inputs[payload.id]=payload.input;return;}
    if(action==='session.materials') return {conclusions:copy(data.conclusions),sources:[]};
    if(action==='content.updates.read' || action==='content.updates.dismiss') return;
    if(action==='conclusion.match') return [];
    if(action==='content.deletion.conclusions') return [];
    if(action==='handoff.read') return '本轮已完成验证，待复核大输入下的差异。';
    if(action==='remote.preview') return {name:'项目说明.md',path:payload.path,type:'text',content:data.content[0].description,size:2400,truncated:false};
    if(action==='session.create' || action==='assignment.start') {data.session.provider=payload.provider;data.snapshot.sessions=[data.session];emit();return copy(data.session);}
    if(action==='content.merge.prepare' || action==='conclusion.merge.prepare' || action==='draft.prepare') return copy(data.draft);
    if(action==='egress.configure' || action==='remote.connect' || action==='settings.save' || action==='open.link') return;
    window.__handbook.unhandled.push(action); throw new Error('Screenshot fixture missing action: '+action);
  };
  window.workbench={call,subscribe(listener){listeners.push(listener);return()=>{const i=listeners.indexOf(listener);if(i>=0)listeners.splice(i,1);};}};
  const adminListeners=[];window.__handbook.emitAdmin=()=>adminListeners.forEach(listener=>listener());
  window.admin={subscribe(listener){adminListeners.push(listener);return()=>{};},async call(action,payload={}){
    window.__handbook.calls.push('admin:'+action);
    if(action==='snapshot')return copy(data.adminSnapshot);
    if(action==='project.catalog')return {projects:[{id:data.project.id,name:data.project.name,groupLabel:'项目一组'}]};
    if(action==='egress.test' || action==='egress.copy' || action==='egress.reverse.test' || action==='egress.reverse.copy')return;
    if(action==='storage.scan')return {path:'',scannedAt:data.at,total:{bytes:786432000,files:124,directories:18,directBytes:0},volume:{totalBytes:536870912000,freeBytes:343597383680},categories:[{key:'submissions',label:'成员成果',bytes:314572800},{key:'trajectories',label:'会话轨迹',bytes:262144000},{key:'curated',label:'团队整理',bytes:104857600},{key:'project',label:'项目公共文件',bytes:104857600}],groups:[{id:'team_one',label:'项目一组',members:3,projects:1,bytes:786432000,submissionsBytes:314572800,trajectoriesBytes:262144000,curatedBytes:104857600,projectBytes:104857600,unassignedBytes:0}],users:['alice','bob','carol'].map(username=>({username,name:username[0].toUpperCase()+username.slice(1),groups:['team_one'],bytes:192238933,submissionsBytes:104857600,trajectoriesBytes:87381333,files:30,modifiedAt:data.at})),warnings:[],warningCount:0,children:[],childCount:0};
    if(action==='operation'){
      if(data.id==='case-team-setup'&&payload.op==='environment_prepare'){
        data.adminSnapshot.missingCommands=[];data.adminSnapshot.setupIssues=[];
        return {environment:{setupIssues:[],setupNotes:['ACL 支持和文件服务运行条件已通过检查。']}};
      }
      if(data.id==='case-team-setup'&&payload.op==='initialize'){
        data.adminSnapshot.state={initialized:true,storageVersion:5,users:{},groups:{}};
      }
      return copy(data.adminSnapshot.state);
    }
    window.__handbook.unhandled.push('admin:'+action);throw new Error('Screenshot fixture missing admin action: '+action);
  }};
}
