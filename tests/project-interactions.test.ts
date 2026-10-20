import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectInteractionPanel, RsiRecommendations, pendingRecommendations } from '../src/renderer/project-interactions';
import { QuestionPanel } from '../src/renderer/team-questions';
import type { RsiInbox } from '../src/shared/rsi';

const inbox: RsiInbox = { projectId: 'p', enabled: true, busy: false, queued: false, sessions: [{ id: 's', title: '误差分析' }], items: [{
  id: 'r', projectId: 'p', sessionId: 's', runId: 'run', policyId: 'policy', createdAt: '2026-10-19T00:00:00Z', fingerprint: 'fp',
  title: '定位误差', action: '先检查边界样本', reason: '平均误差可能掩盖边界问题', evidenceIds: [], evidence: [], conditions: [], uncertainty: '', priority: .8,
  review: { decision: 'pending', closed: false, feedback: '', linkedSessionId: undefined },
}] };
const call = async <T,>(): Promise<T> => { throw new Error('SSR must not call IPC'); };
const reload = async () => {};
test('shared project panel has two accessible tabs and one close action', () => {
  const html = renderToStaticMarkup(React.createElement(ProjectInteractionPanel, { projectName: '比赛', active: 'recommendations', select() {}, close() {}, inbox, call, reload, questionCount: 2, questions: React.createElement('div', null, '问题内容') }));
  assert.match(html, /role="tablist"/); assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.match(html, /aria-label="收起侧栏"[^>]*aria-expanded="true"/); assert.match(html, /定位误差/);
  assert.doesNotMatch(html, /问题内容/); // Questions are lazy-mounted and not marked read just by viewing recommendations.
});
test('collapsed project panel keeps explicit reopen controls and children share the same tabs', () => {
  const props = { projectName: '比赛', select() {}, close() {}, inbox, call, reload, questionCount: 2, questions: React.createElement('div', null, '问题草稿'), subsessions: React.createElement('div', null, '子会话内容') };
  const collapsed = renderToStaticMarkup(React.createElement(ProjectInteractionPanel, { ...props, active: '' }));
  assert.match(collapsed, /class="icon interaction-toggle" aria-label="展开侧栏"[^>]*aria-expanded="false" aria-controls="project-interaction-panel"/);
  assert.match(collapsed, /aria-label="展开 AI推荐"/);
  assert.match(collapsed, /aria-label="展开提问"/); assert.match(collapsed, /aria-label="展开子会话"/);
  assert.match(collapsed, /<aside[^>]+hidden=""/);
  assert.doesNotMatch(collapsed, /role="separator"/);
  const expanded = renderToStaticMarkup(React.createElement(ProjectInteractionPanel, { ...props, active: 'subsessions' }));
  assert.equal((expanded.match(/role="tab"/g) || []).length, 3);
  assert.match(expanded, /id="project-subsessions-tab" role="tab" aria-selected="true"/);
  assert.match(expanded, /class="icon interaction-toggle" aria-label="收起侧栏"[^>]*aria-expanded="true" aria-controls="project-interaction-panel"/);
  assert.equal((expanded.match(/class="icon interaction-toggle"/g) || []).length, 1);
  assert.match(expanded, /role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="project-interaction-panel"/);
  assert.match(expanded, /子会话内容/);
  assert.doesNotMatch(expanded, /展开侧栏宽度|加宽侧栏|恢复宽度/);
  assert.doesNotMatch(expanded, /aria-label="展开侧栏"/);
});
test('accepted optional supplements, rejected feedback, and independent closure render correctly', () => {
  const render = (decision: 'accepted' | 'rejected', closed = false) => renderToStaticMarkup(React.createElement(RsiRecommendations, { inbox: { ...inbox, items: [{ ...inbox.items[0], review: { ...inbox.items[0].review, decision, closed } }] }, call, reload }));
  assert.match(render('accepted'), /关联会话/); assert.match(render('accepted'), /推荐反馈/); assert.doesNotMatch(render('accepted'), /required=/);
  assert.doesNotMatch(render('rejected'), /<select/); assert.match(render('rejected'), /推荐反馈/);
  assert.match(render('accepted'), /评价这条推荐/); assert.match(render('rejected'), /背景是否充分/);
  assert.match(render('accepted'), /改为拒绝/); assert.match(render('rejected'), /改为接受/);
  assert.match(render('accepted', true), /已关闭 · 已接受/); assert.match(render('accepted', true), /重新打开/);
  assert.equal(pendingRecommendations(inbox), 1); assert.equal(pendingRecommendations({ ...inbox, items: [{ ...inbox.items[0], review: { ...inbox.items[0].review, closed: true } }] }), 0);
});
test('embedded questions reuse the shared panel without an extra header or close control', () => {
  const html = renderToStaticMarkup(React.createElement(QuestionPanel, { embedded: true, active: false, projectId: 'p', selectedId: 'session', username: 'alice', sessions: [], connected: false, select() {}, close() {}, changed: reload }));
  assert.match(html, /本项目的提问/); assert.doesNotMatch(html, /关闭提问窗口/);
});
