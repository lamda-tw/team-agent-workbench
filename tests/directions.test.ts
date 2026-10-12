import test from 'node:test';
import assert from 'node:assert/strict';
import { directionGroups, matchingMembers, mergeDirectionUpdates, prepareDirectionSave, sortMembers, type MemberDirections } from '../src/shared/directions';

const id = (value: string) => `00000000-0000-4000-8000-${value.padStart(12, '0')}`;
const members = (): MemberDirections[] => [
  { username: 'alice', updatedAt: '2026-10-12T00:00:00Z', directions: [
    { id: id('1'), title: '检索召回', summary: '在做召回实验', updatedAt: '2026-10-12T00:00:00Z' },
    { id: id('2'), title: '评测集', summary: '整理失败样本', updatedAt: '2026-10-12T00:00:00Z' },
  ] },
  { username: 'bob', updatedAt: '2026-10-11T00:00:00Z', directions: [
    { id: id('3'), title: '检索召回', summary: '可以请教线上延迟', updatedAt: '2026-10-11T00:00:00Z' },
  ] },
  { username: 'carol', updatedAt: '', directions: [] },
];

test('directions group people by title and keep members searchable as the list grows', () => {
  const grouped = directionGroups(members(), '');
  assert.deepEqual(grouped.map(group => [group.title, group.people.map(person => person.username)]), [
    ['检索召回', ['alice', 'bob']],
    ['评测集', ['alice']],
  ]);
  assert.deepEqual(directionGroups(members(), '延迟').map(group => group.title), ['检索召回']);
  assert.deepEqual(directionGroups(members(), 'bob').map(group => group.people.map(person => person.username)), [['bob']]);
  assert.deepEqual(matchingMembers(members(), 'carol').map(member => member.username), ['carol']);
  assert.deepEqual(sortMembers(members(), 'bob').map(member => member.username), ['bob', 'alice', 'carol']);
});

test('a person can keep several directions and cannot duplicate a title', () => {
  const first = prepareDirectionSave([{ id: id('4'), title: ' 接入码 ', summary: '管理端出口' }, { id: id('5'), title: '评测集', summary: '' }]);
  assert.equal(first[0].title, '接入码');
  const merged = mergeDirectionUpdates([{ ...first[0], updatedAt: 'earlier' }], first, 'later');
  assert.equal(merged[0].updatedAt, 'earlier');
  assert.equal(merged[1].updatedAt, 'later');
  assert.throws(() => prepareDirectionSave([{ id: id('6'), title: '评测集', summary: '' }, { id: id('7'), title: '评测集', summary: '另一条' }]), /方向名称不能重复/);
  assert.throws(() => prepareDirectionSave(Array.from({ length: 13 }, (_, index) => ({ id: id(String(index + 1)), title: '方向' + index, summary: '' }))), /最多登记 12 条/);
});
