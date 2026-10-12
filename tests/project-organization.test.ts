import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationEditedMessage, organizationExistsMessage, organizationRefusal, organizationTags, prepareProjectOrganization, type OrganizationDraftRef } from '../src/shared/project-organization';

const draft = (patch: Partial<OrganizationDraftRef> = {}): OrganizationDraftRef => ({
  id: 'draft', binding: { project: { id: 'p' } }, resultRules: { contract: 4 }, generation: 'ready', ...patch,
});

test('a project keeps one automatic organization until a person edits it', () => {
  assert.equal(organizationRefusal([draft()], 'p'), organizationExistsMessage);
  assert.equal(organizationRefusal([draft()], 'p', 'draft'), undefined);
  assert.equal(organizationRefusal([draft({ generation: 'error' })], 'p'), undefined);
  const edited = draft({ organizationEdited: true });
  assert.equal(organizationRefusal([edited], 'p', edited.id), organizationEditedMessage);
  assert.equal(organizationRefusal([draft({ id: 'other', resultRules: { contract: 2 } })], 'p'), undefined);
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
