import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listNativeSessions, resolveNativeSession } from '../src/core/native-sessions';
import { codexSshArgs } from '../src/core/codex-remote-sessions';
import type { CodexSessionOrigin } from '../src/core/codex-session-origin';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

async function fixture(run: (value: { root: string; home: string; workspace: string; visible: string[]; hidden: string[] }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-codex-origin-'));
  const home = path.join(root, 'codex'), workspace = path.join(root, 'workspace');
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true }); await fs.mkdir(workspace);
    const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    const visible: string[] = [], hidden: string[] = [];
    try {
      db.exec(`CREATE TABLE thread_sections (id TEXT, name TEXT);
        CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT,
          project_id TEXT, thread_section_id TEXT, archived INTEGER, recency_at_ms INTEGER, model TEXT,
          source TEXT, thread_source TEXT, agent_role TEXT, agent_nickname TEXT, agent_path TEXT, forked_from_id TEXT);
        CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);`);
      const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const add = async (name: string, allowed: boolean, origin: CodexSessionOrigin = {}, forkedFrom?: string, spawnParent?: string) => {
        const id = randomUUID(); (allowed ? visible : hidden).push(id);
        insert.run(id, name, '', '', workspace, null, null, 0, 1000, null,
          origin.source ?? null, origin.thread_source ?? null, origin.agent_role ?? null, origin.agent_nickname ?? null, origin.agent_path ?? null, forkedFrom ?? null);
        if (spawnParent) db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(spawnParent, id, 'closed');
        await fs.writeFile(path.join(home, 'sessions', 'rollout-' + id + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace, forked_from_id: forkedFrom } }) + '\n');
        return id;
      };
      const user = await add('研究 agent 和 subagent 的普通用户会话', true, { source: 'vscode', thread_source: 'user', agent_path: '/root' });
      const fork = await add('用户手动创建的子会话', true, { source: 'cli', thread_source: 'user' }, user);
      await add('用户手动创建的多级子会话', true, { source: 'vscode' }, fork);
      await add('旧版用户会话', true);
      await add('未知来源仍可见', true, { source: '{incomplete', thread_source: 'future_user_source' });
      await add('JSON 用户来源', true, { source: '"vscode"', thread_source: '"user"' });
      await add('非来源标记的 JSON 数组', true, { source: '["subagent"]' });
      for (const source of ['subagent', ' SUBAGENT ', '"subagent"', '{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}', '{"subagent":{"other":"guardian"}}', 'agent']) {
        await add('旧版 agent 来源', false, { source });
      }
      for (const thread_source of ['subagent', 'agent', 'agent_created_thread', '"subagent"', '{"subagent":{}}']) {
        await add('新版 agent 来源', false, { source: 'vscode', thread_source });
      }
      await add('角色元数据', false, { source: 'vscode', agent_role: 'worker' });
      await add('代理名字元数据', false, { agent_nickname: 'Explorer' });
      await add('代理路径元数据', false, { source: 'vscode', agent_path: '/root/research' });
      const child = await add('来源缺失但有派生关系', false, {}, undefined, user);
      await add('来源被改写的已关闭多级代理', false, { source: 'vscode', thread_source: 'user' }, undefined, child);
    } finally { db.close(); }
    await run({ root, home, workspace, visible, hidden });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('local discovery and direct resolution exclude agent origins and spawn descendants without hiding user forks', async () => {
  await fixture(async ({ visible, hidden }) => {
    const catalog = await listNativeSessions('codex', new Map([[hidden[0], 'previously-linked-agent']]));
    assert.deepEqual(catalog.sessions.map(session => session.nativeId), visible);
    for (const id of visible) assert.equal((await resolveNativeSession('codex', id))?.nativeId, id);
    for (const id of hidden) assert.equal(await resolveNativeSession('codex', id), undefined);
  });
});

test('SSH metadata query applies the same origin and spawn filters as local discovery', async () => {
  await fixture(async ({ home, visible }) => {
    const command = codexSshArgs({ id: 'remote-test', name: 'test', target: 'test' }).at(-1)!;
    const encoded = command.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)![1];
    const { stdout } = await promisify(execFile)('python', ['-c', Buffer.from(encoded, 'base64').toString('utf8')], {
      windowsHide: true, env: { ...process.env, CODEX_HOME: home },
    });
    const result = JSON.parse(stdout.trim().split('WORKBENCH_CODEX_CATALOG=')[1]);
    assert.deepEqual(result.sessions.map((session: { id: string }) => session.id), visible);
  });
});

test('a stale agent selection cannot register a session or partially import a mixed batch', async () => {
  await fixture(async ({ root, workspace, visible, hidden }) => {
    const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
    try {
      await wb.store.init(); grantTestWorkspace(wb, workspace);
      await assert.rejects(wb.linkNativeSession('codex', hidden[0], offlineProjectId), /找不到这条 Codex 会话/);
      await assert.rejects(wb.linkNativeSelections('codex', [visible[0], hidden.at(-1)!].map(nativeId => ({ nativeId })), offlineProjectId), /找不到这条 Codex 会话/);
      assert.equal(wb.store.sessions.length, 0);
    } finally { await wb.close(); }
  });
});
