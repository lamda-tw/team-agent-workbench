import { syncedProject } from './fixtures/synced-project';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { packageDraft, packageHistory } from '../src/core/artifacts';
import { memberProfile } from './fixtures/member-profile';
import { memberReadiness } from '../src/admin/member-readiness';
import type { AdminState } from '../src/admin/types';
import { grantTestWorkspace } from './fixtures/offline-workspace';
// @ts-expect-error Protocol fixture shared with Electron tests.
import { teamServer } from './fixtures/team-server.mjs';
const readZip = (file: string) => JSON.parse(execFileSync('python', ['-c', 'import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', file], { encoding: 'utf8' }));
const waitTransfer = async (task: any) => { const end = Date.now() + 10000; while (['queued', 'running'].includes(task.status) && Date.now() < end) await new Promise(r => setTimeout(r, 20)); assert.equal(task.status, 'done', task.error); };

test('#1 contributions are readable by teammates, cannot be overwritten, uploaded trajectories are public; canonical files stay server-owned', async () => {
  const server = await teamServer(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-permissions-'));
  const alice = new Workbench(path.join(root, 'alice'), () => {}, () => {}), bob = new Workbench(path.join(root, 'bob'), () => {}, () => {}), carol = new Workbench(path.join(root, 'carol'), () => {}, () => {});
  try {
    for (const w of [alice, bob, carol]) await w.store.init();
    await alice.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    const project = await syncedProject(alice, '协作验证'), binding = alice.remote.binding(project.id);
    const file = path.join(root, 'result.txt'); await fs.writeFile(file, 'shared-result');
    const upload = await alice.queue.enqueue(file, binding, project.uploadPath, 'upload'); await waitTransfer(upload);
    assert.equal(server.nodes.get(project.uploadPath).mode & 0o7777, 0o2750); assert.equal(server.nodes.get(upload.target).mode & 0o777, 0o640);
    await bob.configureWorkspace(server.profile('bob'), 'test-password', root, async () => true);
    const bobBinding = bob.remote.binding(project.id);
    assert.equal((await bob.remote.preview(bobBinding, upload.target)).content, 'shared-result');
    await assert.rejects(bob.remote.upload(bobBinding, file, upload.target, () => {}), /拒绝访问|自己的提交/);
    await assert.rejects(bob.remote.upload(bobBinding, file, project.uploadPath + '/forged.txt', () => {}), /拒绝访问|自己的提交/);
    const session = await alice.createSession('codex', root, project.id), history = await alice.archive(session.id); await waitTransfer(history);
    assert.equal((await bob.remote.preview(bobBinding, history.target)).type, 'binary');
    assert.equal(server.nodes.get(history.target).mode & 0o777, 0o640);
    assert.equal(server.nodes.get(upload.target).uid, 0, 'canonical files are server-owned');
    await carol.configureWorkspace(server.profile('carol'), 'test-password', root, async () => true);
    assert.equal(carol.remote.profile!.projects.length, 0);
  } finally { await Promise.all([alice.close(), bob.close(), carol.close()]); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('#2/#3/#5 session inputs, handoffs and drafts persist independently and offline; failed saves can retry', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-state-')), server = await teamServer();
  let wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  try {
    await wb.store.init(); await wb.restoreLocalWorkspace(); assert.equal(wb.workspaceReady, false);
    await wb.configureWorkspace(server.profile('alice'), 'test-password', root, async () => true);
    const project = await syncedProject(wb, '本地状态'); const a = await wb.createSession('codex', root, project.id), b = await wb.createSession('cursor', root, project.id);
    assert.notEqual(a.handoffPath, b.handoffPath);
    await Promise.all([wb.saveHandoff(a.id, 'A only'), wb.saveHandoff(b.id, 'B only'), wb.saveHandoff(a.id, 'A newest')]);
    const source = path.join(root, 'reference.txt'); await fs.writeFile(source, 'local secret reference');
    const [ref] = await wb.attachLocal(a.id, [source]);
    await wb.saveInput(a.id, { text: 'unsent secret A', sourceIds: [ref.id], answers: { question: 'A' } });
    await wb.saveInput(b.id, { text: 'unsent B', sourceIds: [], answers: { question: 'B' } });
    assert.throws(() => wb.saveInput(b.id, { text: 'bad', sourceIds: [ref.id], answers: {} }), /不属于/);
    const draft = { id: a.id, sessionId: a.id, title: 'A', body: '', files: [ref], inputDir: root, outputPath: path.join(root, 'draft.md'), createdAt: new Date().toISOString() };
    wb.store.drafts.push(draft);
    await Promise.all([wb.saveDraft(a.id, 'first', 'first body', ''), wb.saveDraft(a.id, 'final', 'final body', 'https://github.com/a/b', '/target')]);
    assert.equal(wb.draft(a.id).body, 'final body');
    await fs.rm(draft.outputPath); await fs.mkdir(draft.outputPath);
    await assert.rejects(wb.saveDraft(a.id, 'failed', 'do not lose this text', '', '/target'));
    assert.equal(wb.draft(a.id).body, 'final body');
    await assert.rejects(wb.flushEdits()); // Quit must be blocked while the failed destination remains unavailable.
    wb.changed(); await assert.rejects(wb.close());
    a.title = '继续工作仍然保存'; wb.changed();
    await new Promise(r => setTimeout(r, 400));
    assert.equal(JSON.parse(await fs.readFile(path.join(wb.store.root, 'sessions.json'), 'utf8')).find((s: any) => s.id === a.id).title, a.title);
    await fs.rmdir(draft.outputPath); await wb.saveDraft(a.id, 'recovered', 'saved after retry', 'https://github.com/a/b', '/target');
    const archive = readZip(await packageHistory(a, wb.store.sessionDir(a.id), root));
    assert(!JSON.stringify(archive).includes('unsent secret A'));
    await wb.close(); wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
    await wb.store.init(); await wb.restoreLocalWorkspace();
    assert.equal(wb.workspaceReady, true); assert.equal(wb.remote.connected, false);
    assert.equal(wb.store.inputs[a.id].text, 'unsent secret A'); assert.deepEqual(wb.store.inputs[a.id].sourceIds, [ref.id]); assert.equal(wb.store.inputs[b.id].answers.question, 'B');
    assert.equal(await wb.readHandoff(a.id), 'A newest'); assert.equal(await wb.readHandoff(b.id), 'B only');
    assert.equal(wb.draft(a.id).body, 'saved after retry'); assert.equal(wb.draft(a.id).target, '/target');
    await wb.createSession('codex', root, project.id);
    await assert.rejects(wb.configureWorkspace(server.profile('alice'), 'wrong-password', root, async () => true));
    assert.equal(wb.workspaceReady, true); await wb.createSession('cursor', root, project.id);
    const offline = await wb.createProject('offline'); assert.equal(wb.projectSync.states()[offline.id].pending, true);
  } finally { await wb.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('#6 contribution ZIP accepts conclusions and optional repository links, never code or local paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-reference-'));
  try {
    const draft: any = { id: 'draft', sessionId: 'session', title: 'change', body: 'Fix extraction; commit abc; tested 42 cases.', repoUrl: 'https://github.com/owner/repo', files: [{ localPath: 'C:/secrets/code.py', sourcePath: '/private/code.py', name: 'code.py' }] };
    const file = await packageDraft(draft, root), zip = readZip(file);
    assert.deepEqual(Object.keys(zip).sort(), ['README.md', 'manifest.json']);
    assert.equal(JSON.parse(zip['manifest.json']).repoUrl, draft.repoUrl); assert.match(zip['README.md'], /tested 42 cases/);
    assert(!JSON.stringify(zip).includes('code.py')); assert(!JSON.stringify(zip).includes('/private'));
    draft.body = 'changed later'; assert.match(readZip(file)['README.md'], /tested 42 cases/);
    for (const repoUrl of [undefined, '', '   ']) {
      const notes = readZip(await packageDraft({ ...draft, repoUrl, repoUrlOverride: '  ', title: '方向性结论', body: '建议先验证数据覆盖率，再考虑替换方案。', supplement: '这是待验证的方向，不是性能提升结论。' }, root));
      const manifest = JSON.parse(notes['manifest.json']);
      assert.equal(manifest.schemaVersion, 3); assert.equal(manifest.kind, 'project-contribution'); assert.equal('repoUrl' in manifest, false);
      assert.match(notes['README.md'], /建议先验证数据覆盖率/); assert.match(notes['README.md'], /待验证的方向/); assert(!notes['README.md'].includes('GitHub 仓库：'));
      assert.deepEqual(Object.keys(notes).sort(), ['README.md', 'manifest.json']); assert(!JSON.stringify(notes).includes('C:/secrets'));
    }
    await assert.rejects(packageDraft({ ...draft, repoUrl: 'not-a-link' }, root), /GitHub/);
    await assert.rejects(packageDraft({ ...draft, repoUrlOverride: 'https://example.com/owner/repo' }, root), /github.com/);
    await assert.rejects(packageDraft({ ...draft, body: '' }, root), /成果说明/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('#8 test profile fixture uses actual member access and chroot path, excludes credentials and keeps one identity across groups', () => {
  const state: AdminState = { initialized: true, teamId: 'test', sftpConfigured: true, storageVersion: 1, users: { alice: { username: 'alice', name: 'Alice', enabled: true, groups: ['wb_t_ocr', 'wb_t_nlp'] } }, groups: { wb_t_ocr: { name: 'wb_t_ocr', label: 'ocr', adminGroup: 'wb_t_ocr_admin', workspace: '/projects/ocr' }, wb_t_nlp: { name: 'wb_t_nlp', label: 'nlp', adminGroup: 'wb_t_nlp_admin', workspace: '/projects/nlp' } } };
  const profile = { host: 'host', port: 2222, username: 'root', fingerprint: 'SHA256:verified', root: '/srv/teamspace', password: 'never-export' };
  const result = memberProfile(profile, state, 'alice', 'wb_t_ocr');
  assert.equal(result.username, 'alice'); assert.equal(result.workPath, ''); assert.equal(result.port, 2222); assert.equal(result.fingerprint, profile.fingerprint);
  assert(!JSON.stringify(result).includes('never-export')); assert(!JSON.stringify(result).includes('/srv/teamspace'));
  assert.equal(memberProfile(profile, state, 'alice', 'wb_t_nlp').id, result.id);
  state.users.alice.groups = []; assert.equal(memberProfile(profile, state, 'alice').workPath, '');
  state.users.alice.groups = ['wb_t_ocr']; assert.throws(() => memberProfile(profile, state, 'alice', 'wb_t_nlp'), /授权/);
  state.sftpConfigured = false; assert(memberReadiness(state, state.users.alice).includes('服务器成员登录配置异常')); assert.throws(() => memberProfile(profile, state, 'alice', 'wb_t_ocr'), /尚未开通/);
  state.sftpConfigured = true; state.users.alice.provisioning = true; assert.throws(() => memberProfile(profile, state, 'alice', 'wb_t_ocr'), /未完成/);
  state.users.alice.provisioning = false; state.users.alice.enabled = false; assert.throws(() => memberProfile(profile, state, 'alice', 'wb_t_ocr'), /未启用/);
});

test('#3/#6 an in-flight submission locks its draft and duplicate submit; rejected edits do not block later saves or quit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-submit-lock-')), wb = new Workbench(root, () => {}, () => {});
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
  try {
    await wb.store.init(); grantTestWorkspace(wb, root);
    const profile = wb.store.settings.workspaceSnapshot!.profile;
    const binding = { connectionId: profile.id, host: profile.host, port: profile.port, username: profile.username, fingerprint: profile.fingerprint, project: profile.projects[0] };
    const d: any = { id: 'draft', sessionId: 'session', title: 'original', body: 'reviewed notes', repoUrl: 'https://github.com/a/b', files: [], inputDir: root, outputPath: path.join(root, 'draft.md'), binding };
    wb.store.drafts.push(d);
    t.mock.method(wb.remote, 'channel', () => ({} as any));
    t.mock.method(wb.queue, 'enqueue', async (file: string, _binding: any, _folder: string, _kind: string, _sessionId: string, metadata: any) => { assert.match(readZip(file)['README.md'], /reviewed notes/); assert.equal(metadata.sourceSessionTitle, undefined); entered(); await gate; return { id: 'transfer' } as any; });
    const submit = wb.submitDraft(d.id); await started;
    assert.throws(() => wb.saveDraft(d.id, 'changed', 'late edit', 'https://github.com/a/b'), /正在提交/);
    await assert.rejects(wb.submitDraft(d.id), /正在提交/);
    release(); await submit;
    assert.equal(d.body, 'reviewed notes'); assert.equal(d.submitted, 'transfer');
    assert.throws(() => wb.saveDraft(d.id, 'bad', 'edit submitted', ''), /已提交/);
    await wb.flushEdits();
  } finally { release?.(); t.mock.restoreAll(); await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
});
