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
import { preparationSnapshot } from '../src/core/preparation-snapshot';
import { preparationCheckpoint, preparationDelta, rememberPreparationProgress } from '../src/shared/preparation-progress';
import { applyPreparation } from '../src/core/preparation';
import { DraftDeleteDialog } from '../src/renderer/draft-delete';
import type { AgentSession, Draft } from '../src/shared/types';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
// @ts-expect-error test-only JavaScript fixture
import { authLauncher } from './fixtures/auth-launcher.mjs';

const message = (id: string, text = id) => ({ id, role: 'assistant' as const, text, createdAt: new Date().toISOString() });
async function until(fn: () => boolean) { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw new Error('preparation timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function readyDraft(wb: Workbench, session: AgentSession) {
  const id = randomUUID(), base = path.join(wb.store.root, 'drafts', id), inputDir = path.join(base, 'input');
  const { snapshot, files } = await preparationSnapshot(session, inputDir);
  const draft: Draft = { id, sessionId: session.id, title: '', body: '', files, snapshot, generation: 'ready', preparationVersion: 3, binding: session.binding, createdAt: new Date().toISOString(), inputDir, outputPath: path.join(base, 'draft.md') };
  applyPreparation(draft, JSON.stringify({ artifacts: [{ category: 'finding', title: '已确认结论', fields: { statement: '只保留确认过的结果。' } }] }));
  wb.store.drafts.push(draft); await wb.renameDraftResult(id, '已确认结论', draft.artifacts![0].id);
  await wb.saveDraftPersonal(id, [draft.artifacts![0].id]);
  rememberPreparationProgress(session, [draft]); await wb.store.save(); return draft;
}

test('a persisted legacy empty category result requires confirmation and is not migrated to a project profile',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wb-preparation-legacy-empty-')),wb=new Workbench(path.join(root,'data'),()=>{},()=>{});
  try {
    await wb.store.init();grantTestWorkspace(wb,root);const session=await wb.createSession('codex',root,offlineProjectId);
    session.messages.push(message('old'));const previous=await readyDraft(wb,session);
    session.messages.push(message('new'));const id=randomUUID(),inputDir=path.join(wb.store.root,'drafts',id,'input');
    const{snapshot,files}=await preparationSnapshot(session,inputDir);
    const draft:Draft={id,sessionId:session.id,title:'',body:'',files,snapshot,binding:session.binding,generation:'ready',createdAt:new Date().toISOString(),inputDir,outputPath:path.join(inputDir,'draft.md'),resultRules:{contract:4,categories:['todo']}};
    applyPreparation(draft,JSON.stringify({artifacts:[],sourceReview:{status:'complete',inputCount:snapshot.messageCount,conversationHash:snapshot.conversationHash},emptyReason:{code:'no_reusable_content',explanation:'没有可独立保留的新内容。',existingResultIds:[]}}));
    wb.store.drafts.push(draft);rememberPreparationProgress(session,wb.store.drafts);
    assert.equal(session.preparationCheckpoint?.draftId,previous.id);
    await wb.confirmEmptyPreparation(draft.id);assert.equal(session.preparationCheckpoint?.draftId,draft.id);
    await wb.store.save();const restored=new Store(wb.store.root);await restored.init();
    assert.equal(restored.drafts.find(item=>item.id===id)?.organizationFormat,undefined);
    assert.ok(restored.drafts.find(item=>item.id===id)?.emptyResult?.confirmedAt);
  } finally {await wb.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

for (const deleteRecord of [false, true]) for (const deleteResult of [false, true]) test(`orthogonal deletion: record=${deleteRecord}, result=${deleteResult}, progress and Session references survive`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-matrix-'));
  let wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    const fixture = await authLauncher(path.join(root, 'cli'), { status: 'ready', turn: 'success', preparationResult: { artifacts: [] } });
    await wb.store.init(); grantTestWorkspace(wb, root); wb.store.settings.providerPaths.codex = fixture.launcher;
    const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message('old'));
    const draft = await readyDraft(wb, session), conclusion = wb.conclusions(offlineProjectId)[0];
    const attached = await wb.attachConclusion(session.id, conclusion.id), originalText = await fs.readFile(attached.localPath, 'utf8');
    const progress = structuredClone(session.preparationCheckpoint);
    const now = new Date().toISOString();
    wb.store.settings.contentUpdates = [false, true].map(read => ({ eventId: 'event-' + read, projectId: offlineProjectId, projectName: 'test', id: 'remote-' + read, title: '团队动态', change: 'new' as const, revision: 1, occurredAt: now, detectedAt: now, ...(read ? { readAt: now } : {}) }));
    const events = structuredClone(wb.contentUpdates());
    if (deleteResult) await wb.deleteConclusion(conclusion.id, conclusion.version);
    if (deleteRecord) await wb.deleteDraft(draft.id);
    assert.equal(wb.conclusions(offlineProjectId).length, deleteResult ? 0 : 1);
    assert.deepEqual(session.preparationCheckpoint, progress);
    assert.deepEqual(wb.contentUpdates(), events, 'deleting local task/result never deletes unrelated read or unread remote notifications');
    await wb.deleteContentUpdates(events.map(event => event.eventId));
    assert.equal(wb.conclusions(offlineProjectId).length, deleteResult ? 0 : 1, 'deleting notifications does not delete local results');
    assert.deepEqual(session.preparationCheckpoint, progress, 'deleting notifications does not change preparation progress');
    await wb.close(); wb = new Workbench(path.join(root, 'data'), () => {}, () => {}); wb.detect = async () => []; await wb.init();
    const restored = wb.session(session.id); assert.deepEqual(restored.preparationCheckpoint, JSON.parse(JSON.stringify(progress)));
    assert.equal(wb.conclusions(offlineProjectId).length, deleteResult ? 0 : 1, 'restart never resurrects a deleted result');
    assert.equal(await fs.readFile(restored.sources[0].localPath, 'utf8'), originalText);
    restored.messages.push(message('new'));
    const next = await wb.prepare(restored.id, [], undefined, 'incremental');
    assert.equal(next.baseDraftId, draft.id);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(next.inputDir, 'conversation.json'), 'utf8')).map((item: any) => item.id), ['new']);
    await until(() => next.generation === 'ready');
    assert.equal(next.organizationFormat,'project-profile-v1');
    assert.equal(restored.preparationCheckpoint?.draftId,next.id,'a completed project profile advances its own frozen snapshot');
    await assert.rejects(wb.confirmEmptyPreparation(next.id),/没有新成果/);
    assert.equal(wb.conclusions(offlineProjectId).length, deleteResult ? 0 : 1);
    const full = await wb.reorganizePreparation(next.id,'full');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(full.inputDir, 'conversation.json'), 'utf8')).map((item: any) => item.id), ['old', 'new']);
    await until(() => full.generation === 'ready');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('progress never advances on failed/canceled/running/merge/restored tasks or regresses on late old completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-progress-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message('one'));
    const first = await readyDraft(wb, session), progress = structuredClone(session.preparationCheckpoint);
    const later = { ...first, id: randomUUID(), snapshot: { ...first.snapshot!, capturedAt: '2099-01-01T00:00:00Z' } };
    for (const patch of [{ generation: 'error' }, { generation: 'canceled' }, { generation: 'running' }, { restored: true }, { mergeSources: [{ id: 'x' }] }]) {
      rememberPreparationProgress(session, [{ ...later, ...patch } as Draft]); assert.deepEqual(session.preparationCheckpoint, progress);
    }
    rememberPreparationProgress(session, [later]); rememberPreparationProgress(session, [first]); assert.equal(session.preparationCheckpoint?.draftId, later.id);
    const legacy = structuredClone(session); delete legacy.preparationCheckpoint;
    assert.equal(preparationCheckpoint(legacy, [first, later])?.draftId, later.id);
    legacy.messages = []; assert.match(preparationDelta(legacy, later.snapshot).reason, /无法.*定位/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('incremental snapshot includes a streamed boundary reply and missing legacy length replays conservatively', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-stream-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message('stream', '开头'));
    const first = await readyDraft(wb, session); session.messages[0].text += '，后续的关键结论';
    assert.equal(preparationDelta(session, first.snapshot).start, 0);
    const { snapshot } = await preparationSnapshot(session, path.join(root, 'next'), [], { scope: 'incremental', baseLastMessageId: 'stream', baseLastMessageLength: first.snapshot!.lastMessageLength });
    assert.equal(snapshot.messageCount, 1); assert.equal(preparationDelta(session, snapshot).count, 0);
    assert.equal(preparationDelta(session, { ...snapshot, lastMessageLength: undefined }).count, 1);
    assert.equal(preparationDelta(session, { ...snapshot, lastMessageId: undefined, messageCount: 0, totalMessageCount: 0 }).count, 1);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('delete record preserves shared frozen inputs, all transfer states, and rolls back a failed record save', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-delete-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root); const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message('one'));
    const draft = await readyDraft(wb, session), revision = await wb.reviseDraft(draft.id);
    for (const status of ['queued', 'running', 'error', 'done'] as const) {
      const id = randomUUID(), localPath = path.join(root, 'packages', id); await fs.mkdir(path.dirname(localPath), { recursive: true }); await fs.writeFile(localPath, 'upload');
      wb.store.transfers.push({ id, status, kind: 'upload', name: id, bytes: 0, total: 6, target: '/upload/' + id, projectName: 'test', createdAt: '', binding: session.binding!, localPath });
    }
    draft.submitted = wb.store.transfers[0].id; const transfers = structuredClone(wb.store.transfers), results = structuredClone(wb.conclusions(offlineProjectId));
    const save = wb.store.save.bind(wb.store); wb.store.save = async () => { throw new Error('disk unavailable'); };
    await assert.rejects(wb.deleteDraft(draft.id), /disk unavailable/); assert(wb.store.drafts.includes(draft)); await fs.access(draft.inputDir);
    wb.store.save = save; await wb.deleteDraft(draft.id);
    assert.deepEqual(wb.store.transfers, transfers); assert.deepEqual(wb.conclusions(offlineProjectId), results); await fs.access(revision.inputDir);
    for (const transfer of transfers) await fs.access(transfer.localPath);
    const reopened = new Store(wb.store.root); await reopened.init(); assert(!reopened.drafts.some(item => item.id === draft.id));
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('batch record deletion stops selected tasks, retains failed selections for retry, and preserves independent data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-batch-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message('one'));
    const ready = await readyDraft(wb, session), blocked = await readyDraft(wb, session), running = await readyDraft(wb, session), untouched = await readyDraft(wb, session);
    const helper = await wb.createSession('codex', path.dirname(running.inputDir), undefined, 'prepare', session.id);
    running.prepareSessionId = helper.id; running.generation = 'running';
    let stops = 0; (wb as any).runtimes.set(helper.id, { close: async () => { stops++; } });
    const conclusion = wb.conclusions(offlineProjectId)[0], attached = await wb.attachConclusion(session.id, conclusion.id);
    const content = await fs.readFile(attached.localPath, 'utf8'), progress = structuredClone(session.preparationCheckpoint), conclusions = structuredClone(wb.conclusions(offlineProjectId));
    const uploadPath = path.join(root, 'frozen-upload'); await fs.writeFile(uploadPath, 'upload');
    wb.store.transfers.push({ id: randomUUID(), status: 'error', kind: 'upload', name: 'upload', bytes: 0, total: 6, target: '/upload', projectName: 'test', createdAt: '', binding: session.binding!, localPath: uploadPath });
    const transfers = structuredClone(wb.store.transfers);
    (wb as any).submittingDrafts.add(blocked.id);
    const result = await wb.deleteDrafts([ready.id, blocked.id, running.id, ready.id]);
    assert.deepEqual(result.deletedIds, [ready.id, running.id]);
    assert.deepEqual(result.failures.map(item => item.id), [blocked.id]); assert.match(result.failures[0].message, /正在保存或上传/);
    assert.equal(stops, 1); assert.equal(running.generation, 'canceled'); assert(!wb.store.sessions.some(item => item.id === helper.id));
    assert(wb.store.sessions.includes(session)); assert.deepEqual(wb.store.drafts.map(item => item.id), [blocked.id, untouched.id]);
    assert.deepEqual(session.preparationCheckpoint, progress); assert.deepEqual(wb.conclusions(offlineProjectId), conclusions); assert.deepEqual(wb.store.transfers, transfers);
    assert.equal(await fs.readFile(attached.localPath, 'utf8'), content); await fs.access(uploadPath); await fs.access(blocked.inputDir);
    (wb as any).submittingDrafts.delete(blocked.id);
    const retry = await wb.deleteDrafts([ready.id, blocked.id, running.id]);
    assert.deepEqual(retry, { deletedIds: [ready.id, blocked.id, running.id], failures: [] }, 'retry also succeeds for records deleted before a response was interrupted');
    const restored = new Store(wb.store.root); await restored.init(); assert.deepEqual(restored.drafts.map(item => item.id), [untouched.id]);
    assert.deepEqual(session.preparationCheckpoint, progress); assert.deepEqual(wb.conclusions(offlineProjectId), conclusions); assert.deepEqual(wb.store.transfers, transfers);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('batch record deletion validates the complete selection before deleting any record', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-preparation-batch-invalid-')), wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const session = await wb.createSession('codex', root, offlineProjectId); session.messages.push(message('one'));
    const draft = await readyDraft(wb, session);
    for (const ids of [[], [draft.id, '../invalid'], Array.from({ length: 101 }, () => draft.id)]) {
      await assert.rejects(wb.deleteDrafts(ids)); assert(wb.store.drafts.includes(draft)); await fs.access(draft.inputDir);
    }
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); }
});

test('delete confirmation names the independent data it preserves without invoking deletion during render', () => {
  let calls = 0;
  const draft = { id: 'd', title: '整理记录', generation: 'running' } as Draft;
  const html = renderToStaticMarkup(React.createElement(DraftDeleteDialog, { draft, close: () => {}, remove: async () => { calls++; } }));
  assert.equal(calls, 0); assert.match(html, /并停止这次整理/); assert.match(html, /已保存的个人成果、已提交的团队成果、原 Session 和增量整理进度都会保留/); assert.match(html, /同步到你的其他电脑/);
});
