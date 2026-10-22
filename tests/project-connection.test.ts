import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { accountIdentity } from '../src/shared/account-data';
import { connectionProject, connectedProjectSelection, reusableProjectConnections, separateProjectWindow, projectCreationInputSchema, projectConnectionError } from '../src/shared/project-connection';
import { ProjectRefreshButton } from '../src/renderer/project-refresh';
import { ProjectBriefEditor } from '../src/renderer/project-brief-editor';
import { ProjectCentralConnection } from '../src/renderer/project-connection';
import { ProjectSettingsDialog } from '../src/renderer/project-directory';
import type { ConnectionProfile } from '../src/shared/types';

const project = { id: 'same-id', name: '同名项目', remoteRoot: '/projects/p', uploadPath: '/projects/p/results', historyPath: '/projects/p/trajectories' };
const profile: ConnectionProfile = { id: 'first', name: '节点', host: 'node-a', port: 22, username: 'alice', fingerprint: 'SHA256:a', manifestPath: '', projects: [project] };

test('reuse keys include server, port, account and identity; login record ids do not fork a connection', () => {
  const choices = reusableProjectConnections([profile, { ...profile, id: 'other-record' }, { ...profile, host: 'node-b' }, { ...profile, port: 2222 }, { ...profile, username: 'bob' }, { ...profile, fingerprint: 'SHA256:b' }]);
  assert.equal(choices.length, 5);
  assert.equal(new Set(choices.map(item => item.key)).size, 5);
  assert.equal(choices[0].key, accountIdentity(profile));
  assert.equal(separateProjectWindow(undefined, profile), false);
  assert.equal(separateProjectWindow(profile, { ...profile, id: 'other-record', host: 'NODE-A' }), false);
  for (const choice of choices.slice(1)) assert.equal(separateProjectWindow(profile, choice.profile), true);
});

test('project reuse rejects missing or revoked projects instead of falling back to another same-name project', () => {
  assert.equal(connectionProject(profile, 'same-id'), 'same-id');
  assert.equal(connectionProject(profile), 'same-id');
  assert.throws(() => connectionProject(profile, 'unknown'), /访问权限/);
  assert.throws(() => connectionProject({ ...profile, projects: [] }, 'same-id'), /访问权限/);
  assert.equal(connectionProject({ ...profile, projects: [] }), undefined);
});

test('successful login survives a stale project selection without selecting another project or granting access', () => {
  assert.deepEqual(connectedProjectSelection(profile, project.id), { projectId: project.id });
  assert.deepEqual(connectedProjectSelection(profile), { projectId: project.id });
  assert.deepEqual(connectedProjectSelection({ ...profile, projects: [] }), { projectId: undefined });
  for (const projects of [profile.projects, []]) {
    const selection = connectedProjectSelection({ ...profile, projects }, 'removed-id');
    assert.equal(selection.projectId, undefined);
    assert.match(selection.notice!, /已登录.*未出现在当前账号/);
    assert.doesNotMatch(selection.notice!, /此账号没有/);
    assert.throws(() => connectionProject({ ...profile, projects }, 'removed-id'));
  }
});

test('project discovery failure is reported separately from account permission denial', () => {
  const selection = connectedProjectSelection({ ...profile, projects: [] }, project.id, [{ groupName: 'research', groupLabel: '研究组', path: '/projects/research', canonicalPath: '/projects/research', canCreateProject: false, accessError: '读取目录超时' }]);
  assert.equal(selection.projectId, undefined);
  assert.match(selection.notice!, /研究组（读取目录超时）/);
  assert.doesNotMatch(selection.notice!, /没有.*权限/);
});

test('project refresh remains usable while disconnected and only disables for an in-flight refresh or account change', () => {
  for (const connected of [false, true]) {
    const html = renderToStaticMarkup(createElement(ProjectRefreshButton, { connected, busy: false, refresh() {} }));
    assert.doesNotMatch(html, /disabled/);
    assert.match(html, /aria-label="刷新工作组、项目和文件"/);
    if (!connected) assert.match(html, /连接中央节点并刷新/);
    const busy = renderToStaticMarkup(createElement(ProjectRefreshButton, { connected, busy: true, refresh() {} }));
    assert.match(busy, /disabled/);
  }
});

test('project settings show the actual server and account with a distinct reconnect action', () => {
  const central = createElement(ProjectCentralConnection, { profile, connected: false, configure() {} });
  const html = renderToStaticMarkup(createElement(ProjectSettingsDialog, { project, contextKey: 'scope', admin: false, central, close() {}, directorySaved: async () => {}, briefSaved: async () => {} }));
  assert.match(html, /role="tab"[^>]*>中央节点/);
  assert.match(html, /node-a:22/); assert.match(html, /成员账号：alice/); assert.match(html, /连接中央节点/);
  const connected = renderToStaticMarkup(createElement(ProjectCentralConnection, { profile, connected: true, configure() {} }));
  assert.match(connected, /已连接/); assert.match(connected, /查看连接/);
  assert.doesNotMatch(connected, /type="password"/);
});

test('project creation accepts a name before authentication without accepting passwords into the continuation', () => {
  assert.deepEqual(projectCreationInputSchema.parse({ name: ' 新项目 ', password: 'must-not-transfer' }), { name: '新项目' });
  assert.throws(() => projectCreationInputSchema.parse({ name: '   ' }));
  assert.throws(() => projectCreationInputSchema.parse({ name: 'x'.repeat(181) }));
});

test('creation after login retains its name, displays its destination and offers a new group to an unassigned member', () => {
  const html = renderToStaticMarkup(createElement(ProjectBriefEditor, { groups: [], initialName: '算法实验', connectionLabel: 'node-b:22 · alice', admin: true, close() {}, saved: async () => {} }));
  assert.match(html, /value="算法实验"/);
  assert.match(html, /node-b:22 · alice/);
  assert.match(html, /value="local" selected/);
  assert.match(html, /仅在本机创建/);
  assert.doesNotMatch(html, /登录密码/);
});

test('SSH connection errors explain how to continue and retain server identity warnings', () => {
  assert.match(projectConnectionError(new Error('All configured authentication methods failed')), /账号或密码/);
  assert.match(projectConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:22')), /地址、端口/);
  assert.match(projectConnectionError(new Error('Timed out while waiting for handshake')), /超时/);
  assert.match(projectConnectionError(new Error('getaddrinfo ENOTFOUND missing')), /服务器地址/);
  assert.equal(projectConnectionError(new Error('服务器身份发生变化')), '服务器身份发生变化');
});
