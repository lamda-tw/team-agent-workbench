import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { AgentRuntime } from '../src/core/agents';
import { subsessionFamily, subsessionParentId } from '../src/shared/subsessions';
import { sessionContext } from '../src/core/session-context';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';
import { forkWorkspace, removeForkWorkspace } from '../src/core/subsession-workspace';

test('Codex forks while streaming, freezes visible deltas and sources, and publishes a complete child', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, cwd);
    const parent = await wb.createSession('codex', cwd, offlineProjectId);
    const referencePath = path.join(cwd, 'reference.md'); await fs.writeFile(referencePath, '已验证的测试条件');
    const referenceId = randomUUID(), referenceHash = createHash('sha256').update('已验证的测试条件').digest('hex');
    parent.sources.push({ id: referenceId, name: '测试条件', localPath: referencePath, sourcePath: '/project/reference.md', sha256: referenceHash, size: Buffer.byteLength('已验证的测试条件'), fetchedAt: new Date().toISOString() });
    parent.nativeId = 'parent-native'; parent.status = 'running';
    parent.messages.push({ id: randomUUID(), role: 'user', text: '比较两种实现', createdAt: new Date().toISOString(), context: { nativeId: 'parent-native', accepted: true, workRecord: true, sourceHashes: { [referenceId]: referenceHash } } });
    parent.messages.push({ id: randomUUID(), role: 'assistant', text: '已生成的半句', createdAt: new Date().toISOString() });
    let finish!: () => void;
    const native = new Promise<void>(resolve => { finish = resolve; });
    let captured!: () => void; const ready = new Promise<void>(resolve => { captured = resolve; });
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.forkCodexThread = async (capture: () => void) => { capture(); captured(); await native; return { id: 'child-native', path: '/fake/child.jsonl', desktop: false }; };
    (wb as any).runtime = async () => runtime;
    const selectedText = '  选中的原文\n保留换行和缩进。';
    const pending = wb.forkSubsession(parent.id, '方案 A', selectedText);
    await ready;
    assert.equal(wb.store.sessions.length, 1, 'no provisional session before fork succeeds');
    parent.messages.at(-1)!.text += '——创建以后才生成'; finish();
    const child = await pending;
    assert.equal(child.parentId, parent.id); assert.equal(child.fork?.parentMessageCount, 2);
    assert.equal(child.nativeId, 'child-native'); assert.equal(child.fork?.nativeFork, true);
    assert.equal(parent.nativeId, 'parent-native'); assert.equal(parent.status, 'running');
    assert.equal(child.cwd, parent.cwd); assert.notEqual(child.handoffPath, parent.handoffPath);
    assert.equal(child.approvals.length, 0); assert.equal(child.status, 'idle');
    const snapshot = await fs.readFile(child.sources.find(source => source.id === child.fork?.sourceId)!.localPath, 'utf8');
    assert.match(snapshot, /比较两种实现/); assert.match(snapshot, /已生成的半句/);
    assert.doesNotMatch(snapshot, /创建以后才生成/);
    assert.equal((await wb.subsessionHistory(child.id)).at(-1)!.text, '已生成的半句');
    assert.equal(wb.store.inputs[child.id].text, selectedText, 'selection is the editable message body, with no added quotation syntax');
    assert.equal(sessionContext(child, '开始探索', []).sources.some(source => source.id === child.fork?.sourceId), true);
    assert.equal(child.fork?.inheritedSourceIds.length, 1);
    assert.equal(await fs.readFile(child.sources.find(source => source.id === child.fork?.inheritedSourceIds[0])!.localPath, 'utf8'), '已验证的测试条件');
    assert.equal(parent.sources.length, 1, 'creating a child never injects into the parent');
    await wb.store.save();
    const persisted = JSON.parse(await fs.readFile(path.join(wb.store.root, 'sessions.json'), 'utf8'));
    assert.equal(persisted.find((value: any) => value.id === child.id).fork.nativeFork, true);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('nested forks retain independent snapshots; promotion excludes a subtree from cascading deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-tree-'));
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const parent = await wb.createSession('codex', root, offlineProjectId);
    parent.messages.push({ id: randomUUID(), role: 'user', text: '最初问题', createdAt: new Date().toISOString() });
    const [keep, remove] = await Promise.all([wb.forkSubsession(parent.id, '保留'), wb.forkSubsession(parent.id, '删除')]);
    const grandchild = await wb.forkSubsession(keep.id, '第三层');
    const doomed = await wb.forkSubsession(remove.id, '同时删除');
    assert.equal(subsessionFamily(wb.store.sessions, parent.id).length, 5);
    assert.equal(grandchild.fork?.inheritedSourceIds.length, 1, 'inherits the unsent snapshot even before its parent starts a new turn');
    const inherited = grandchild.sources.find(source => source.id === grandchild.fork!.inheritedSourceIds[0])!;
    assert.match(await fs.readFile(inherited.localPath, 'utf8'), /最初问题/);
    await wb.journal.commit(remove, '', 1, '待删除的摘要', { turnId: randomUUID(), at: new Date().toISOString(), text: '待删除的日志' });
    await wb.promoteSubsession(keep.id);
    assert.equal(subsessionParentId(keep), undefined); assert.equal(keep.parentId, undefined);
    assert.equal(subsessionFamily(wb.store.sessions, parent.id).length, 3);
    assert.equal(subsessionParentId(grandchild), keep.id);
    let stopped = 0;
    remove.status = 'running';
    await wb.closeSession(parent.id);
    (wb as any).runtimes.set(remove.id, { cancel: async () => { throw new Error('cancel failed'); }, close: async () => {} });
    await assert.rejects(wb.deleteSession(parent.id), /cancel failed/);
    assert.equal(wb.store.sessions.length, 5, 'failed cancellation must retain the tree and its controls');
    (wb as any).runtimes.set(remove.id, { cancel: async () => { stopped++; }, close: async () => {} });
    const result = await wb.deleteSession(parent.id);
    assert.equal(stopped, 1);
    assert.deepEqual(new Set(result.deletedIds), new Set([parent.id, remove.id, doomed.id]));
    assert.deepEqual(new Set(wb.store.sessions.map(value => value.id)), new Set([keep.id, grandchild.id]));
    assert.doesNotMatch((await wb.projectJournal(keep.id)).text, /待删除的日志/);
    await assert.rejects(fs.stat(path.join(root, 'project-journals', remove.id + '.json')), { code: 'ENOENT' });
    assert.match(await fs.readFile(inherited.localPath, 'utf8'), /最初问题/, 'retained snapshot is owned by the child');
    assert.equal(wb.store.inputs[doomed.id], undefined);
    assert(await fs.stat(keep.handoffPath));
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('failed native fork and failed persistence never publish a partial child or mutate the parent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-failure-'));
  const wb = new Workbench(root, () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const parent = await wb.createSession('codex', root, offlineProjectId);
    parent.nativeId = 'parent-native';
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.forkCodexThread = async () => { throw new Error('native-fork-failed'); };
    (wb as any).runtime = async () => runtime;
    await assert.rejects(wb.forkSubsession(parent.id, '失败'), /native-fork-failed/);
    assert.equal(wb.store.sessions.length, 1); assert.equal(parent.nativeId, 'parent-native');
    await (wb as any).eventWrites.get(parent.id);
    const records = (await fs.readFile(path.join(wb.store.sessionDir(parent.id), 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).event);
    assert(records.some(event => event.method === 'subsession/fork/failed' && event.stage === 'fork' && event.error === 'native-fork-failed'));
    assert.equal(parent.messages.length, 0, 'failure diagnostics do not become conversation context');
    runtime.forkCodexThread = async (capture: () => void) => { capture(); return { id: 'child-native', path: '/fake/child.jsonl' }; };
    const save = wb.store.save.bind(wb.store);
    wb.store.save = async () => { throw new Error('disk-full'); };
    await assert.rejects(wb.forkSubsession(parent.id, '保存失败'), /disk-full/);
    wb.store.save = save;
    assert.equal(wb.store.sessions.length, 1); assert.equal(Object.keys(wb.store.inputs).length, 0);
    assert.equal(parent.nativeId, 'parent-native'); assert.equal(parent.sources.length, 0);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('reports are frozen versions; parent must explicitly select them before the model sees them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-report-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, cwd); await wb.setBetaFeature('subsessions', true);
    const parent = await wb.createSession('codex', cwd, offlineProjectId);
    const child = await wb.forkSubsession(parent.id, '量化方案');
    child.messages.push({ id: randomUUID(), role: 'assistant', text: '初测精度下降 0.2。', createdAt: new Date().toISOString() });
    await wb.saveHandoff(child.id, '# 阶段摘要\n\n方案 A 初测，尚未独立复核。');
    const preview = await wb.previewSubsessionReport(child.id);
    assert.match(preview.body, /尚未独立复核/); assert.match(preview.latestReply, /0.2/);
    await assert.rejects(wb.publishSubsessionReport(child.id, '0'.repeat(64), preview.body), /已有更新/);
    const first = await wb.publishSubsessionReport(child.id, preview.sourceHash, preview.body);
    assert.equal(first.version, 1); assert.equal(parent.sources.length, 0);
    assert.equal((await wb.publishSubsessionReport(child.id, preview.sourceHash, preview.body)).id, first.id);
    const source = await wb.attachSubsessionReport(parent.id, child.id, first.id);
    assert.equal(sessionContext(parent, '继续', []).sources.length, 0);
    assert.deepEqual(sessionContext(parent, '继续', [source.id]).sources.map(item => item.id), [source.id]);
    assert.equal((await wb.attachSubsessionReport(parent.id, child.id, first.id)).id, source.id);
    parent.autoUpload = true;
    await wb.setBetaFeature('subsessions', false);
    await assert.rejects(wb.attachSubsessionReport(parent.id, child.id, first.id), /Beta 功能/);
    assert.equal(parent.sources.length, 1);
    await wb.setBetaFeature('subsessions', true);
    await wb.saveHandoff(child.id, '# 阶段摘要\n\n方案 A 已复核。');
    child.messages.push({ id: randomUUID(), role: 'assistant', text: '复核通过。', createdAt: new Date().toISOString() });
    const next = await wb.previewSubsessionReport(child.id);
    const second = await wb.publishSubsessionReport(child.id, next.sourceHash, next.body);
    assert.equal(second.version, 2); assert.notEqual(second.id, first.id);
    assert.match(await fs.readFile(source.localPath, 'utf8'), /尚未独立复核/);
    assert.doesNotMatch(await fs.readFile(source.localPath, 'utf8'), /已复核/);
    const newer = await wb.attachSubsessionReport(parent.id, child.id, second.id);
    assert.notEqual(newer.id, source.id); assert.equal(parent.autoUpload, false);
    await wb.reviewSubsessionReport(parent.id, child.id, second.id);
    assert(child.reports?.[1].reviewedAt);
    await wb.closeSession(parent.id);
    assert.equal(wb.session(child.id).closedAt, undefined, 'closing the parent does not stop the child');
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cross-project, wrong parent and running-turn report operations are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-scope-'));
  const cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); grantTestWorkspace(wb, cwd); await wb.setBetaFeature('subsessions', true);
    const parent = await wb.createSession('codex', cwd, offlineProjectId);
    const cursor = await wb.createSession('cursor', cwd, offlineProjectId);
    await assert.rejects(wb.forkSubsession(cursor.id, '不支持'), /仅支持.*Codex/);
    const child = await wb.forkSubsession(parent.id, '精度探索');
    child.status = 'running'; await assert.rejects(wb.previewSubsessionReport(child.id), /当前回复结束/); child.status = 'idle';
    const preview = await wb.previewSubsessionReport(child.id), report = await wb.publishSubsessionReport(child.id, preview.sourceHash, '仅为探索记录');
    const another = await wb.createSession('codex', cwd, offlineProjectId);
    await assert.rejects(wb.attachSubsessionReport(another.id, child.id, report.id), /直接子会话/);
    const otherProjectId = 'project_' + 'b'.repeat(32);
    wb.store.settings.workspaceSnapshot!.profile.projects.push({ ...parent.binding!.project, id: otherProjectId, name: '另一项目' });
    const foreign = await wb.createSession('codex', cwd, otherProjectId);
    await assert.rejects(wb.attachSubsessionReport(foreign.id, child.id, report.id), /直接子会话/);
  } finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Git Subsession worktrees include dirty and untracked files without changing the parent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-subsession-git-'));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'code.py'), 'VALUE = 1\n');
  execFileSync('git', ['-C', repo, 'add', 'code.py']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  await fs.writeFile(path.join(repo, 'code.py'), 'VALUE = 2\n');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'untracked\n');
  const workspace = await forkWorkspace(repo, path.join(root, 'app-data'), randomUUID());
  try {
    assert.equal(workspace.kind, 'git-worktree'); assert.notEqual(workspace.cwd, repo);
    assert.equal(await fs.readFile(path.join(workspace.cwd, 'code.py'), 'utf8'), 'VALUE = 2\n');
    assert.equal(await fs.readFile(path.join(workspace.cwd, 'notes.txt'), 'utf8'), 'untracked\n');
    await fs.writeFile(path.join(workspace.cwd, 'code.py'), 'VALUE = 3\n');
    assert.equal(await fs.readFile(path.join(repo, 'code.py'), 'utf8'), 'VALUE = 2\n');
  } finally { await removeForkWorkspace(workspace, repo); await fs.rm(root, { recursive: true, force: true }); }
});
