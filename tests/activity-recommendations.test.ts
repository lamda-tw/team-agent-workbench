import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityRecommendations, ActivityRecommendationCard } from '../src/renderer/activity-recommendations';
import { SummaryUpdateStatus } from '../src/renderer/summary-update-status';
import type { AgentSession } from '../src/shared/types';
import type { ActivityJob } from '../src/shared/activity-assistant';

const session = { id: 'session-a', status: 'idle', purpose: 'work' } as AgentSession;
const job = (i: number): ActivityJob => ({ id: 'job-' + i, owner: 'account', sessionId: session.id, status: 'matched', attempts: 0, reason: '提供当前性能验证的实测结果。', excerpt: '批大小增加后吞吐提升。', event: { eventId: 'event-' + i, projectId: 'p', projectName: '测试', id: 'result-' + i, title: '性能结果 ' + i, revision: 2, change: 'updated', author: '张三', occurredAt: '2026-10-12T10:00:00Z', detectedAt: '' } });
const callbacks = { changed: async () => {}, view: () => {}, sourcesAdded: () => {}, send: async () => {} };
const summaryFailed = { ...session, handoffState: { messageCount: 0, hash: '', version: 0, error: '日志必须只有一行' } };

test('many recommendations use one aggregate entry, show new/pending counts and never interrupt a running or archived session', () => {
  const jobs = Array.from({ length: 8 }, (_, i) => ({ ...job(i), ...(i < 6 ? { presentedAt: 'earlier' } : {}) }));
  const html = renderToStaticMarkup(createElement(ActivityRecommendations, { session, jobs, ...callbacks }));
  assert.match(html, /新增 2 条可能相关的动态/); assert.match(html, /另有 6 条待处理/);
  assert.equal((html.match(/aria-label="本会话相关新动态"/g) || []).length, 1);
  assert(!html.includes('性能结果'), 'details stay collapsed until requested');
  for (const state of [{ status: 'running' }, { status: 'approval' }, { closedAt: 'closed' }]) assert.equal(renderToStaticMarkup(createElement(ActivityRecommendations, { session: { ...session, ...state } as AgentSession, jobs, ...callbacks })), '');
  assert.equal(renderToStaticMarkup(createElement(ActivityRecommendations, { session, jobs: jobs.map(j => ({ ...j, sessionId: 'other' })), ...callbacks })), '');
});

test('each card offers two independent checkboxes, a reason and verbatim excerpt, with no model scores or radio selection', () => {
  const html = renderToStaticMarkup(createElement(ActivityRecommendationCard, { job: job(1), attach: true, save: true, busy: false, choose: () => {}, view: () => {}, ignore: () => {} }));
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2); assert.equal((html.match(/checked=""/g) || []).length, 2);
  assert.match(html, /提供当前性能验证的实测结果/); assert.match(html, /<blockquote>批大小增加后吞吐提升。<\/blockquote>/);
  assert(!/type="radio"|置信度|相关性分数/.test(html));
  const saved = renderToStaticMarkup(createElement(ActivityRecommendationCard, { job: { ...job(1), availableConclusionId: 'personal' }, attach: false, save: false, busy: false, choose: () => {}, view: () => {}, ignore: () => {} }));
  assert.match(saved, /已存入个人成果库/); assert.equal((saved.match(/disabled=""/g) || []).length, 1, 'saving elsewhere does not disable attaching to this session');
});

test('summary or log failure alone never opens the activity panel or claims that new updates failed', () => {
  const pending: ActivityJob = { ...job(1), status: 'pending' };
  for (const jobs of [[], [pending], [{ ...pending, sessionId: 'other', error: 'other session failed' }], [{ ...pending, ignoredAt: 'ignored', error: 'ignored failure' }]]) {
    assert.equal(renderToStaticMarkup(createElement(ActivityRecommendations, { session: summaryFailed, jobs, ...callbacks })), '');
  }
  const html = renderToStaticMarkup(createElement(ActivityRecommendations, { session: summaryFailed, jobs: [job(1)], ...callbacks }));
  assert.match(html, /新增 1 条可能相关的动态/);
  assert.doesNotMatch(html, /activity-background-error|阶段摘要更新失败|日志必须只有一行|重试后台任务/);
});

test('pending activity errors describe automatic recovery without a manual retry action', () => {
  const failed: ActivityJob = { ...job(1), status: 'pending', error: '原文暂不可读' };
  const jobs = [failed, { ...failed, id: 'other', sessionId: 'other' }, { ...failed, id: 'ignored', ignoredAt: 'ignored' }];
  const html = renderToStaticMarkup(createElement(ActivityRecommendations, { session: summaryFailed, jobs, ...callbacks }));
  assert.match(html, /新动态判断暂未完成/); assert.match(html, /有 1 条新动态暂未完成判断/); assert.match(html, /新动态到达、资料或连接恢复后自动继续/);
  assert.doesNotMatch(html, /0 条相关动态待处理|阶段摘要|日志|>查看<|重试|<button/);
  const recovered = renderToStaticMarkup(createElement(ActivityRecommendations, { session: summaryFailed, jobs: [{ ...failed, status: 'unrelated' }], ...callbacks }));
  assert.equal(recovered, '', 'a remaining summary error must not keep a recovered activity warning visible');
});

test('summary diagnostics show their reason and lifecycle recovery without any retry button', () => {
  const render = (value: AgentSession) => renderToStaticMarkup(createElement(SummaryUpdateStatus, { session: value }));
  assert.equal(render(session), '');
  const html = render(summaryFailed);
  assert.match(html, /阶段摘要和会话日志暂未更新/); assert.match(html, /日志必须只有一行/); assert.match(html, /下一轮结束或服务恢复后自动补齐/);
  assert.doesNotMatch(html, /新动态|相关动态|重试|<button/);
  assert.doesNotMatch(render({ ...summaryFailed, status: 'running' }), /重试|<button/);
  assert.match(render({ ...summaryFailed, closedAt: 'closed' }), /重新打开会话后自动补齐/);
});
