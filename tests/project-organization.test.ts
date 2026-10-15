import test from 'node:test';
import assert from 'node:assert/strict';
import { isProjectOrganizationDraft, organizationEditedMessage, organizationExistsMessage, organizationRefusal, organizationTags, prepareProjectOrganization, type OrganizationDraftRef } from '../src/shared/project-organization';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/core/store';

test('legacy category drafts and earlier project profiles with the same contract retain their own format after restart',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-profile-migration-'));
  try {
    const store=new Store(root);await store.init();
    store.drafts=[{id:'legacy',resultRules:{contract:4},generation:'ready',artifacts:[{fields:{statement:'旧分类成果'}}]},{id:'profile',resultRules:{contract:4},generation:'ready',artifacts:[{fields:{sentence:'这是项目。',technologies:'技术',achievements:'成果',criteria:'标准'}}]},{id:'pending-profile',resultRules:{contract:4},generation:'error',prepareSessionId:'prepare'}] as any;
    store.sessions=[{id:'prepare',title:'整理',provider:'codex',purpose:'prepare',status:'idle',cwd:root,createdAt:'',sources:[],approvals:[],autoUpload:false,handoffPath:'',messages:[{id:'prompt',role:'user',createdAt:'',text:'preparationContractVersion:4。只返回一个 JSON 对象：{"sentence":"说明"}'}]}];
    await store.save();const reopened=new Store(root);await reopened.init();
    assert.equal(isProjectOrganizationDraft(reopened.drafts[0]),false);
    assert.equal(reopened.drafts[1].organizationFormat,'project-profile-v1');assert.equal(reopened.drafts[2].organizationFormat,'project-profile-v1');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

const draft = (patch: Partial<OrganizationDraftRef> = {}): OrganizationDraftRef => ({
  id: 'draft', binding: { project: { id: 'p' } }, organizationFormat: 'project-profile-v1', resultRules: { contract: 4 }, generation: 'ready', ...patch,
});

test('a project keeps one automatic organization until a person edits it', () => {
  assert.equal(organizationRefusal([draft()], 'p'), organizationExistsMessage);
  assert.equal(organizationRefusal([draft()], 'p', 'draft'), undefined);
  assert.equal(organizationRefusal([draft({ generation: 'error' })], 'p'), undefined);
  const edited = draft({ organizationEdited: true });
  assert.equal(organizationRefusal([edited], 'p', edited.id), organizationEditedMessage);
  assert.equal(organizationRefusal([draft({ id: 'other', organizationFormat: undefined, resultRules: { contract: 2 } })], 'p'), undefined);
  assert.equal(organizationRefusal([draft({ organizationFormat: undefined })], 'p'), undefined,'a legacy category draft must not reserve the project profile');
});

test('the project sentence stays one sentence and the other fields stay readable', () => {
  const profile = prepareProjectOrganization({
    sentence: '  这是一个检索项目。 ',
    technologies: '倒排索引用在查询，表格组件用在导出。',
    achievements: '已经能按标签检索。',
    criteria: '抽查通过才算达到。',
  });
  assert.equal(profile.sentence, '这是一个检索项目。');
  assert.throws(() => prepareProjectOrganization({ ...profile, sentence: '这是检索项目。它还要导出。' }), /恰好是一句话/);
  assert.throws(() => prepareProjectOrganization({ ...profile, achievements: '{"ok":true}' }), /结构化数据/);
});

test('technology and achievement text becomes short scan tags', () => {
  assert.deepEqual(organizationTags('倒排索引·查询、表格组件·导出、材料未说明'), ['倒排索引·查询', '表格组件·导出']);
  assert.deepEqual(organizationTags('已经能按标签检索，导出当前结果。'), ['已经能按标签检索', '导出当前结果']);
  assert.deepEqual(organizationTags('材料未说明'), []);
  assert.deepEqual(organizationTags('这是一段没有分隔并且明显超过十四个字的说明'), ['这是一段没有分隔并且明显超过']);
});
