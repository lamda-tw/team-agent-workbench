import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RsiRecommendationToggle } from '../src/renderer/rsi-recommendation-toggle';
import { SidebarProjectItem } from '../src/renderer/sidebar-project-item';
import { MembershipDialog } from '../src/admin/people';

test('project AI control is an accessible switch, with its own project label and no checkbox or save form', () => {
  const html = renderToStaticMarkup(React.createElement(RsiRecommendationToggle, { projectId: 'ocr', projectName: 'OCR', call: async () => { throw Error('SSR must not call IPC'); } }));
  assert.match(html, /role="switch"/); assert.match(html, /aria-label="AI推荐：OCR"/); assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /type="checkbox"|保存|项目助手设置/);
});

test('only the selected project expands AI controls, while every project retains its settings action', () => {
  const props = { project: { id: 'ocr', name: 'OCR' }, select() {}, settings() {}, call: async () => { throw Error('SSR must not call IPC'); } };
  const collapsed = renderToStaticMarkup(React.createElement(SidebarProjectItem, { ...props, selected: false }));
  assert.match(collapsed, /aria-expanded="false"/); assert.match(collapsed, /aria-label="项目设置：OCR"/);
  assert.doesNotMatch(collapsed, /role="switch"|AI推荐|workgroup-project-details/);
  const expanded = renderToStaticMarkup(React.createElement(SidebarProjectItem, { ...props, selected: true }));
  assert.match(expanded, /aria-expanded="true"/); assert.match(expanded, /aria-controls="project-controls-ocr"/);
  assert.match(expanded, /id="project-controls-ocr"/); assert.match(expanded, /role="switch"/);
});
test('admin membership dialog shows the group name without exposing the generated Linux group identifier', () => {
  const group = { name: 'wb_random_internal_7a91', label: '算法研究组', workspace: '/projects/算法研究组' };
  const user = { username: 'alice', name: 'Alice', enabled: true, groups: [], contentAdminGroups: [] };
  const html = renderToStaticMarkup(React.createElement(MembershipDialog, { form: { kind: 'membership', group, user } as any, snapshot: { state: { groups: { [group.name]: group }, users: { alice: user } }, profile: { mode: 'local' } } as any, close() {}, done: async () => {} }));
  const text = html.replace(/<[^>]+>/g, '');
  assert.match(text, /目标用户组：.*算法研究组/); assert.doesNotMatch(text, /wb_random_internal_7a91/);
});
