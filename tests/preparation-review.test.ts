import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { Store } from '../src/core/store';
import { preparationSnapshot, prepareReadableInputs } from '../src/core/preparation-snapshot';
import { applyPreparation } from '../src/core/preparation';
import { preparationCheckpoint, preparationDelta } from '../src/shared/preparation-progress';
import { contributionStatus } from '../src/shared/contribution-status';
import { needsPreparationConfirmation } from '../src/shared/preparation-review';
import { PreparationOptionsModal } from '../src/renderer/preparation-options';
import { EmptyPreparationReview } from '../src/renderer/preparation-empty';
import type { AgentSession, Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

const message = { id: '中文消息', role: 'assistant' as const, text: '候选已实现，尚未完成运行验证。引号“中文”与 emoji 🧪 不应损坏。', createdAt: '2026-09-22' };
const snapshot = { capturedAt: '2026-09-22', messageCount: 1, totalMessageCount: 1, lastMessageId: message.id, lastMessageLength: message.text.length, conversationHash: 'frozen-hash' };
const ready = (): Draft => ({ id: randomUUID(), sessionId: 'session', title: '整理', body: '', files: [], generation: 'ready', inputDir: '', outputPath: '', createdAt: '2026-09-22', snapshot,
  binding: { connectionId: 'c', username: 'alice', host: 'local', port: 22, fingerprint: 'local', project: { id: 'p', name: '项目', remoteRoot: '/p', uploadPath: '/p/submissions/alice', historyPath: '/p/history' } },
  resultRules: { contract: 3, categories: ['finding', 'method_exploration'] }, preparationEvidenceIds: ['message:' + message.id], preparationExistingResults: [{ id: 'existing', title: '已有方法探索' }] });
const reviewed = (patch: Record<string, unknown> = {}) => JSON.stringify({ artifacts: [], sourceReview: { status: 'complete', inputCount: 1, conversationHash: snapshot.conversationHash }, emptyReason: { code: 'already_saved', explanation: '本次方法及验证边界已在已有成果中保留，没有新增证据。', existingResultIds: ['existing'] }, ...patch });

test('application normalizes legacy Chinese snapshots and material chunks without changing source bytes or content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-readable-'));
  try {
    const handoffPath = path.join(root, '原阶段摘要.md'), reference = path.join(root, '参考.txt');
    const text = '中文“方法”与实验🧪，保留原始信息。'.repeat(1200);
    await fs.writeFile(handoffPath, text); await fs.writeFile(reference, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF16 的旧资料', 'utf16le')]));
    const session = { id: 's', messages: [message, { ...message, id: 'long-tool', role: 'tool', text }], sources: [], handoffPath, cwd: root } as unknown as AgentSession;
    const input = path.join(root, 'input');
    const captured = await preparationSnapshot(session, input, [reference]);
    // Reproduce the old BOM-less UTF-8 files, then normalize through the runtime path.
    const originalConversation = JSON.parse(await fs.readFile(path.join(input, 'conversation.json'), 'utf8'));
    await fs.writeFile(path.join(input, 'conversation.json'), JSON.stringify(originalConversation));
    const { index } = await prepareReadableInputs(input);
    const ansiRead = async (relative: string) => { const bytes = await fs.readFile(path.join(input, relative)); assert(bytes.every(byte => byte < 128)); return JSON.parse(bytes.toString('latin1')); };
    assert.deepEqual(await ansiRead('conversation.json'), originalConversation);
    assert.equal((await ansiRead('source-index.json')).conversationHash, captured.snapshot.conversationHash);
    const pages = (await Promise.all(index.conversationPages.map(ansiRead))).flat();
    assert(index.conversationPages.length > 1);
    assert.equal(pages.filter(item => item.id === 'long-tool').map(item => item.text).join(''), text);
    assert.equal(pages.find(item => item.id === message.id).text, message.text);
    assert(pages.every(item => item.text.length <= 4000));
    const parts = await Promise.all(index.handoff.readPaths.map(ansiRead));
    assert(parts.length > 1); assert.equal(parts.map(part => part.text).join(''), text);
    assert.equal((await ansiRead(index.files[0].readPaths[0])).text, 'UTF16 的旧资料');
    assert.equal(await fs.readFile(index.handoff.localPath, 'utf8'), text);
    await prepareReadableInputs(input); assert.deepEqual(await ansiRead('conversation.json'), originalConversation);
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('empty output needs a completed matching source review and a verifiable reason', () => {
  const draft = ready();
  for (const raw of [JSON.stringify({ artifacts: [] }), reviewed({ sourceReview: { status: 'incomplete', explanation: '读取失败' } }), reviewed({ sourceReview: { status: 'complete', inputCount: 0, conversationHash: snapshot.conversationHash } }), reviewed({ sourceReview: { status: 'complete', inputCount: 1, conversationHash: 'another-snapshot' } }), reviewed({ emptyReason: undefined }), reviewed({ emptyReason: { code: 'already_saved', explanation: '已存在', existingResultIds: ['invented'] } }), reviewed({ emptyReason: { code: 'already_saved', explanation: '已存在' } })]) assert.throws(() => applyPreparation(draft, raw));
  applyPreparation(draft, reviewed());
  assert.equal(draft.artifacts?.length, 0); assert.equal(draft.emptyResult?.code, 'already_saved');
  assert.deepEqual(draft.emptyResult?.existingResults, [{ id: 'existing', title: '已有方法探索' }]);
  assert.equal(contributionStatus(draft), '无新成果 · 待确认');
  applyPreparation(draft, reviewed({ artifacts: [{ category: 'method_exploration', topic: '候选方法', origin: 'project', title: '候选实现待验证', body: message.text, evidenceIds: ['message:' + message.id] }] }));
  assert.equal(draft.artifacts?.length, 1); assert.equal(draft.emptyResult, undefined, 'real project work survives an unverified runtime boundary');
});

test('filtered candidates are distinguished from an explicit empty model response', () => {
  const draft = ready();
  applyPreparation(draft, reviewed({ artifacts: [{ category: 'finding', topic: '安装', origin: 'local_environment', title: '本机依赖修复', body: '本机安装失败后重新配置。', evidenceIds: ['message:' + message.id] }] }));
  assert.equal(draft.emptyResult?.code, 'filtered'); assert.match(draft.emptyResult!.explanation, /不代表原会话没有项目成果/);
});

test('empty confirmation is durable, idempotent, rollback-safe and never creates results or uploads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-empty-confirm-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message);
    const draft = { ...ready(), sessionId: session.id, binding: session.binding }; applyPreparation(draft, reviewed()); wb.store.drafts.push(draft);
    assert.equal(wb.store.drafts.filter(needsPreparationConfirmation).length, 1);
    assert.equal(preparationCheckpoint(session, [draft]), undefined);
    const save = wb.store.save.bind(wb.store); wb.store.save = async () => { throw new Error('disk failure'); };
    await assert.rejects(wb.confirmEmptyPreparation(draft.id), /disk failure/); assert(!draft.emptyResult?.confirmedAt); assert.equal(Boolean(session.preparationCheckpoint), false);
    assert.equal(wb.store.drafts.filter(needsPreparationConfirmation).length, 1, 'failed confirmation keeps its reminder');
    wb.store.save = save; await wb.confirmEmptyPreparation(draft.id);
    const confirmedAt = draft.emptyResult!.confirmedAt; await wb.confirmEmptyPreparation(draft.id); assert.equal(draft.emptyResult!.confirmedAt, confirmedAt);
    assert.equal(session.preparationCheckpoint?.draftId, draft.id); assert.equal(preparationDelta(session, session.preparationCheckpoint?.snapshot).count, 0);
    assert.equal(wb.store.conclusions.length, 0); assert.equal(wb.store.transfers.length, 0); assert.equal(contributionStatus(draft), '已确认无需保留');
    assert.equal(wb.store.drafts.filter(needsPreparationConfirmation).length, 0, 'retaining the confirmed empty record must not keep a pending badge');
    const reopened = new Store(root); await reopened.init(); assert.equal(reopened.drafts[0].emptyResult?.confirmedAt, confirmedAt);
    assert.equal(reopened.drafts.filter(needsPreparationConfirmation).length, 0, 'the reminder stays cleared after restarting');
    draft.generation = 'error'; await assert.rejects(wb.confirmEmptyPreparation(draft.id), /只有已完成/); draft.generation = 'ready'; await wb.confirmEmptyPreparation(draft.id);
    await wb.deleteDraft(draft.id); assert.equal(session.preparationCheckpoint?.draftId, draft.id);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('preparation reminders distinguish reviewable results from completed, stopped and running records', () => {
  const result = { ...ready(), body: '待核对的成果' };
  const pending = [ready(), result, { ...result, conclusionMergeProjectId: 'p' }, { ...result, mergeProjectId: 'p' }];
  const completed: Draft[] = [
    { ...ready(), emptyResult: { code: 'already_saved', explanation: '已有成果覆盖', confirmedAt: '2026-09-23T02:01:35Z' } },
    { ...result, submitted: 'upload' },
    { ...result, conclusionMergeProjectId: 'p', mergeCompletedAt: '2026-09-23' },
    { ...result, mergeProjectId: 'p', mergeCompletedAt: '2026-09-23' },
    ...(['running', 'error', 'canceled'] as const).map(generation => ({ ...result, generation })),
  ];
  assert.deepEqual([...pending, ...completed].filter(needsPreparationConfirmation), pending);
  assert.equal(completed.filter(needsPreparationConfirmation).length, 0);
});

test('old automatically advanced empty checkpoints fall back to the last retained nonempty result', () => {
  const old = { ...ready(), id: 'old', body: '原成果', snapshot: { ...snapshot, capturedAt: '2026-09-21' } }, empty = ready();
  const session = { id: 'session', messages: [message], preparationCheckpoint: { draftId: empty.id, snapshot } } as AgentSession;
  assert.equal(preparationCheckpoint(session, [old, empty])?.draftId, 'old');
  empty.emptyResult = { code: 'legacy_unknown', explanation: '用户核对过旧结果', confirmedAt: 'now' };
  assert.equal(preparationCheckpoint(session, [old, empty])?.draftId, empty.id);
});

test('legacy progress recovers its exact boundary from verified frozen content instead of inventing a new message', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-legacy-boundary-')), wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message);
    const inputDir = path.join(root, 'drafts', randomUUID(), 'input'), captured = await preparationSnapshot(session, inputDir);
    const draft = { ...ready(), body: '已有成果', sessionId: session.id, inputDir, snapshot: captured.snapshot };
    delete draft.snapshot.lastMessageLength;
    session.preparationCheckpoint = { draftId: draft.id, snapshot: structuredClone(draft.snapshot) }; wb.store.drafts.push(draft); await wb.store.save();
    const reopened = new Store(root); await reopened.init();
    assert.equal(reopened.sessions[0].preparationCheckpoint?.snapshot.lastMessageLength, message.text.length);
    assert.equal(preparationDelta(reopened.sessions[0], reopened.sessions[0].preparationCheckpoint?.snapshot).count, 0);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('initial and repeated preparation show the same category choices; empty review names existing results and has a confirmation action', () => {
  const draft = ready(); applyPreparation(draft, reviewed());
  const session = { id: 'session', title: '工作会话', messages: [message], binding: draft.binding } as AgentSession;
  for (const again of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(PreparationOptionsModal, { session, again, close: () => {}, started: async () => {} }));
    for (const caption of ['整理哪些方面', '已有能力', '探索记录', '待办事项', '补充整理要求（选填）']) assert(html.includes(caption), caption);
    assert(!html.includes('每个项目整理一条'));
    assert(!html.includes('调整分类组合')); assert(!html.includes('项目目标')); assert(!html.includes('项目资料'));
    if (again) { assert(html.includes('aria-label="整理对话"')); assert(html.includes('只看新增内容')); assert(!html.includes('重新整理整个会话')); }
  }
  let calls = 0;
  const html = renderToStaticMarkup(React.createElement(EmptyPreparationReview, { draft, busy: false, confirm: () => { calls++; }, viewConclusion: () => {} }));
  assert.equal(calls, 0); assert(html.includes('确认本次无需保留')); assert(html.includes('已有方法探索')); assert(html.includes('本次 1 条消息'));
});
