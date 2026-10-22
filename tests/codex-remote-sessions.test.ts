import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addCodexRemoteProjects, codexSshArgs, type CodexRemoteIndex } from '../src/core/codex-remote-sessions';
import { NativeSessionBrowser, orderedNativeSessions } from '../src/renderer/native-sessions';
import { canImportNativeSession, type NativeSessionCatalog } from '../src/shared/native-sessions';

const hostId = 'remote-ssh-discovered:research';
const empty: NativeSessionCatalog = { provider: 'codex', groups: [], sessions: [] };
const chat = (cwd: string, more: Record<string, any> = {}) => ({ id: randomUUID(), name: '远程对话', cwd, updatedAt: 1000, ...more });

async function desktop(state: Record<string, any>, run: (home: string) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-codex-remote-'));
  try { await fs.writeFile(path.join(home, '.codex-global-state.json'), JSON.stringify(state)); await run(home); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

test('desktop remote projects use their saved SSH alias, exact membership and longest unambiguous remote root', async () => {
  const threads = [chat('/workspace'), chat('/workspace/nested'), chat('/elsewhere'), chat('/workspace'), chat('/workspace'), chat('/workspace/nested')];
  const state = {
    'remote-projects': [{ id: 'p', label: '桌面远程项目', hostId, remotePath: '/workspace' }, { id: 'nested', label: '子项目', hostId, remotePath: '/workspace/nested' }],
    'codex-managed-remote-connections': [{ hostId, alias: 'research', displayName: '科研服务器' }],
    'thread-project-assignments': { [threads[2].id]: { projectKind: 'remote', hostId, projectId: 'p' }, [threads[3].id]: { projectKind: 'remote', hostId, projectId: 'deleted' }, [threads[5].id]: { projectKind: 'remote', hostId, projectId: 'p' } },
    'projectless-thread-ids': [threads[4].id],
  };
  await desktop(state, async home => {
    const calls: string[] = [];
    const catalog = await addCodexRemoteProjects(empty, home, async host => { calls.push(host.target); assert.equal(host.name, '科研服务器'); return { sessions: threads }; });
    assert.deepEqual(calls, ['research'], 'projects on one host share one metadata query');
    const groups = new Map(catalog.groups.map(group => [group.id, group]));
    const named = Object.fromEntries(catalog.sessions.map(session => [session.nativeId, groups.get(session.groupId!)?.name]));
    assert.equal(named[threads[0].id], '桌面远程项目');
    assert.equal(named[threads[1].id], '子项目');
    assert.equal(named[threads[2].id], '桌面远程项目', 'explicit membership overrides cwd');
    assert.equal(named[threads[3].id], '其他远程会话', 'deleted assignment never guesses a new project');
    assert.equal(named[threads[4].id], '其他远程会话', 'explicit projectless membership overrides root inference');
    assert.equal(named[threads[5].id], '桌面远程项目');
    assert(catalog.sessions.every(session => session.hostId === hostId && session.hostName === '科研服务器'));
    assert(catalog.sessions.every(canImportNativeSession), 'healthy remote records are selectable for host-aware import');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8')), state, 'discovery never changes desktop projects');
  });
});

test('host identity separates same-name projects and same-ID sessions; remote failure keeps the desktop project visible', async () => {
  const otherHost = 'remote-ssh-discovered:offline', commonId = randomUUID(), localId = randomUUID();
  const local: NativeSessionCatalog = { provider: 'codex', groups: [], sessions: [{ nativeId: localId, name: '本机会话', cwd: 'D:/local', updatedAt: 1 }, { nativeId: commonId, name: '远程旧缓存', cwd: 'D:/stale', updatedAt: 2 }] };
  await desktop({
    'remote-projects': [{ id: 'p', label: '同名项目', hostId, remotePath: '/work' }, { id: 'p', label: '同名项目', hostId: otherHost, remotePath: '/work' }],
    'thread-project-assignments': { [commonId]: { projectKind: 'remote', hostId, projectId: 'p' } },
  }, async home => {
    const catalog = await addCodexRemoteProjects(local, home, async host => {
      if (host.id === otherHost) throw Error('Permission denied (publickey).');
      return { sessions: [chat('/work', { id: commonId })] };
    });
    assert.equal(catalog.groups.length, 2); assert.notEqual(catalog.groups[0].id, catalog.groups[1].id);
    assert.match(catalog.groups[1].error || '', /SSH 登录未通过/);
    assert.equal(catalog.sessions.filter(session => session.nativeId === commonId).length, 1, 'stale local metadata must not impersonate the remote chat');
    assert(catalog.sessions.some(session => session.nativeId === localId && canImportNativeSession(session)));
    assert.equal(orderedNativeSessions(catalog).groups.length, 2, 'unreachable or empty desktop projects stay in navigation');
    const html = renderToStaticMarkup(React.createElement(NativeSessionBrowser, { catalog, selectedIds: [commonId], onChange: () => {}, groupId: catalog.groups[1].id }));
    assert.match(html, /同名项目/); assert.match(html, /offline/); assert.match(html, /SSH 登录未通过/);
  });
});

test('missing SSH configuration is visible without launching arbitrary hosts or suppressing local chats', async () => {
  await desktop({ 'remote-projects': [{ id: 'cloud', label: '桌面云项目', hostId: 'cloud-host', remotePath: '/work' }] }, async home => {
    let reads = 0;
    const catalog = await addCodexRemoteProjects(empty, home, async () => { reads++; return { sessions: [] }; });
    assert.equal(reads, 0); assert.equal(catalog.groups[0].name, '桌面云项目'); assert(catalog.groups[0].error);
  });
});

test('empty and corrupt desktop metadata never changes existing local discovery', async () => {
  await desktop({}, async home => {
    const noRead = async (): Promise<CodexRemoteIndex> => { throw Error('must not connect'); };
    assert.equal(await addCodexRemoteProjects(empty, home, noRead), empty);
    await fs.writeFile(path.join(home, '.codex-global-state.json'), 'invalid');
    assert.equal(await addCodexRemoteProjects(empty, home, noRead), empty);
  });
});

test('SSH invocation reuses known-host verification and rejects shell or option injection', () => {
  const host = { id: hostId, name: 'research', target: 'research', port: 2202, identity: 'C:/keys/id with spaces' };
  const args = codexSshArgs(host);
  assert(args.includes('BatchMode=yes')); assert(args.includes('StrictHostKeyChecking=yes'));
  assert(args.includes('C:/keys/id with spaces')); assert(args.includes('2202'));
  assert.equal(args.at(-2), 'research');
  for (const target of ['-F', 'host;echo unsafe', 'host name', 'host\ncommand', "host'", '$(whoami)']) assert.throws(() => codexSshArgs({ ...host, target }));
  assert.throws(() => codexSshArgs({ ...host, port: 0 }));
  assert.throws(() => codexSshArgs({ ...host, identity: 'key\ncommand' }));
});

test('remote metadata script reads live SQLite safely, supports old schemas and excludes archived and Guardian records', async () => {
  await desktop({}, async home => {
    const workspace = path.join(home, 'workspace'); await fs.mkdir(workspace); await fs.mkdir(path.join(home, 'sessions'));
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)');
    try {
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)');
      for (const [index, id] of ids.entries()) {
        insert.run(id, '历史标题 ' + index, workspace, index === 1 ? JSON.stringify({ subagent: { other: 'guardian' } }) : 'vscode', index === 2 ? 1 : 0, 123);
        if (index !== 3) await fs.writeFile(path.join(home, 'sessions', 'rollout-' + id + '.jsonl.zst'), 'compressed metadata only');
      }
      const command = codexSshArgs({ id: hostId, name: 'research', target: 'research' }).at(-1)!;
      const encoded = command.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)![1];
      const { stdout } = await promisify(execFile)('python', ['-c', Buffer.from(encoded, 'base64').toString('utf8')], { windowsHide: true, env: { ...process.env, CODEX_HOME: home } });
      const result = JSON.parse(stdout.trim().split('WORKBENCH_CODEX_CATALOG=')[1]);
      assert.deepEqual(result.sessions.map((session: any) => session.id), [ids[0], ids[3]], 'uncheckpointed WAL changes are visible');
      assert.equal(result.sessions[0].updatedAt, 123000); assert.equal(result.sessions[0].name, '历史标题 0');
      assert.equal(result.sessions[0].unavailable, null); assert.match(result.sessions[1].unavailable, /历史文件未找到/);
    } finally { db.close(); }
  });
});
