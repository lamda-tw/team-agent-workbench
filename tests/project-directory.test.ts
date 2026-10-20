import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workbench } from '../src/core/workbench';
import { ProjectSettingsDialog, ProjectDirectoryDialog } from '../src/renderer/project-directory';
import { migrateProjectDirectories, projectDirectory, projectDirectoryKey } from '../src/shared/project-directory';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture(run: (wb: Workbench, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-directory-'));
  const wb = new Workbench(path.join(root, 'store'), () => {}, () => {});
  try { await wb.store.init(); grantTestWorkspace(wb, root); await run(wb, root); }
  finally { await wb.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test('project directories and explicit skips survive restart without leaking between projects or accounts', async () => fixture(async (wb, root) => {
  const profile = wb.store.settings.workspaceSnapshot!.profile;
  const other = { ...profile.projects[0], id: 'second-project', name: '第二个项目' }; profile.projects.push(other);
  assert.equal(projectDirectory(wb.store.settings, profile, offlineProjectId), undefined);
  await wb.saveProjectDirectory(offlineProjectId, root, projectDirectoryKey(profile, offlineProjectId));
  await wb.saveProjectDirectory(other.id, '', projectDirectoryKey(profile, other.id));
  const restored = new Workbench(wb.store.root, () => {}, () => {});
  try {
    await restored.store.init();
    assert.equal(projectDirectory(restored.store.settings, profile, offlineProjectId), await fs.realpath(root));
    assert.equal(projectDirectory(restored.store.settings, profile, other.id), '');
    assert.equal(projectDirectory(restored.store.settings, { ...profile, username: 'bob' }, offlineProjectId), undefined);
    assert.equal(projectDirectory(restored.store.settings, { ...profile, host: 'other.invalid' }, offlineProjectId), undefined);
  } finally { await restored.close(); }
}));

test('changing the project default preserves existing sessions and creating sessions cannot overwrite the default', async () => fixture(async (wb, root) => {
  const profile = wb.store.settings.workspaceSnapshot!.profile, key = projectDirectoryKey(profile, offlineProjectId);
  const nextDirectory = path.join(root, 'second-code'); await fs.mkdir(nextDirectory);
  await wb.saveProjectDirectory(offlineProjectId, root, key);
  const prior = await wb.createSession('codex', root, offlineProjectId);
  await wb.saveProjectDirectory(offlineProjectId, nextDirectory, key);
  const next = await wb.createSession('codex', projectDirectory(wb.store.settings, profile, offlineProjectId)!, offlineProjectId);
  assert.equal(prior.cwd, root); assert.equal(next.cwd, await fs.realpath(nextDirectory));
  await wb.saveProjectDirectory(offlineProjectId, '', key);
  const research = await wb.createSession('cursor', '', offlineProjectId);
  assert(research.cwd.startsWith(path.join(wb.store.root, 'workspaces') + path.sep));
  await wb.createSession('codex', root, offlineProjectId);
  assert.equal(projectDirectory(wb.store.settings, profile, offlineProjectId), '');
}));

test('invalid paths, stale account contexts and failed persistence keep the previous choice', async () => fixture(async (wb, root) => {
  const profile = wb.store.settings.workspaceSnapshot!.profile, key = projectDirectoryKey(profile, offlineProjectId);
  await wb.saveProjectDirectory(offlineProjectId, '', key);
  await assert.rejects(wb.saveProjectDirectory(offlineProjectId, path.join(root, 'missing'), key), /已存在/);
  await assert.rejects(wb.saveProjectDirectory(offlineProjectId, 'relative-path', key), /已存在/);
  const file = path.join(root, 'file.txt'); await fs.writeFile(file, 'test');
  await assert.rejects(wb.saveProjectDirectory(offlineProjectId, file, key), /已存在/);
  await assert.rejects(wb.saveProjectDirectory(offlineProjectId, root, projectDirectoryKey({ ...profile, username: 'bob' }, offlineProjectId)), /账号或项目已改变/);
  const save = wb.store.save.bind(wb.store); wb.store.save = async () => { throw new Error('disk failure'); };
  try { await assert.rejects(wb.saveProjectDirectory(offlineProjectId, root, key), /disk failure/); }
  finally { wb.store.save = save; }
  assert.equal(projectDirectory(wb.store.settings, profile, offlineProjectId), '');
}));

test('legacy project paths migrate only for the remembered account and never borrow the global last directory', async () => fixture(async (wb, root) => {
  const settings = wb.store.settings, profile = settings.workspaceSnapshot!.profile;
  settings.lastWorkspace = path.join(root, 'unrelated-project');
  settings.projectDirectories = { [profile.id + ':' + offlineProjectId]: root };
  await wb.store.save();
  const restored = new Workbench(wb.store.root, () => {}, () => {});
  try {
    await restored.store.init();
    assert.equal(projectDirectory(restored.store.settings, profile, offlineProjectId), root);
    assert.equal(restored.store.settings.projectDirectories?.[profile.id + ':' + offlineProjectId], undefined);
    const otherAccount = { ...profile, username: 'bob' };
    restored.store.settings.workspaceSnapshot!.profile = otherAccount;
    migrateProjectDirectories(restored.store.settings);
    assert.equal(projectDirectory(restored.store.settings, otherAccount, offlineProjectId), undefined);
    assert.equal(projectDirectory(restored.store.settings, profile, 'new-project'), undefined);
  } finally { await restored.close(); }
}));

test('ordinary members can edit their local directory even when shared project settings are read-only', async () => fixture(async wb => {
  const profile = wb.store.settings.workspaceSnapshot!.profile, project = profile.projects[0];
  const props = { projectId: project.id, projectName: project.name, contextKey: projectDirectoryKey(profile, project.id), directory: '', saved: async () => {} };
  const initial = renderToStaticMarkup(createElement(ProjectDirectoryDialog, props));
  assert.match(initial, /暂不设置/); assert.match(initial, /保存并进入项目/);
  const settings = renderToStaticMarkup(createElement(ProjectSettingsDialog, { project, admin: false, contextKey: props.contextKey, directory: 'D:/project/code', directorySaved: async () => {}, briefSaved: async () => {}, close: () => {} }));
  assert.match(settings, /只读，仅本组创建者或管理者可修改/);
  assert.match(settings, /<input aria-label="代码目录（选填）"[^>]*value="D:\/project\/code"/);
  assert.doesNotMatch(settings, /<input aria-label="代码目录（选填）"[^>]*disabled/);
  assert.match(settings, /<button class="primary">保存代码目录<\/button>/);
  assert.doesNotMatch(settings, /项目助手/);
  assert.match(settings, /role="tab"[^>]*>AI推荐/);
  assert.doesNotMatch(settings, /暂不设置/);
  const withMembers = renderToStaticMarkup(createElement(ProjectSettingsDialog, { project, admin: false, contextKey: props.contextKey, directorySaved: async () => {}, briefSaved: async () => {}, close() {}, members: { groupId: 'group-test', groupLabel: '研发组', connected: false, call: async () => { throw Error('SSR must not call the server'); }, changed: async () => {} } }));
  assert.match(withMembers, /role="tab"[^>]*>成员与权限/);
  assert.match(withMembers, /成员与权限对项目组「研发组」内所有项目生效/);
  assert.match(withMembers, /连接团队账号后，可查看和管理成员与权限/);
  assert.equal((withMembers.match(/role="dialog"/g) || []).length, 1);
}));
