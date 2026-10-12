import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncCodexDesktopHistory } from '../src/core/codex-desktop-history';

const threadId = '01a12dde-ef6e-7922-a374-0d11a8c6b524';

function history(file: string, turns: string, items: string) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE thread_turns (${turns}, PRIMARY KEY (thread_id, turn_id));
    CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal);
    CREATE TABLE thread_items (${items}, PRIMARY KEY (thread_id, turn_id, item_id));
    CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);`);
  db.close();
}

test('a user-client turn is copied into the desktop Codex history without rewinding it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-desktop-history-'));
  try {
    const personal = path.join(root, 'personal'), isolated = path.join(root, 'sqlite');
    await fs.mkdir(personal, { recursive: true });
    await fs.mkdir(isolated, { recursive: true });
    history(path.join(personal, 'thread_history_1.sqlite'),
      'thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT',
      "thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0, started_at_ms INTEGER, completed_at_ms INTEGER");
    history(path.join(isolated, 'thread_history_1.sqlite'),
      'thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER',
      "thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0");
    const seed = (file: string, offset: number, ordinal: number, turn?: { id: string; ordinal: number; end: number; itemOrdinal: number }) => {
      const db = new DatabaseSync(file);
      db.prepare('INSERT INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)').run(threadId, offset, ordinal);
      if (turn) {
        db.prepare('INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, rollout_byte_offset, rollout_end_ordinal, rollout_end_byte_offset) VALUES (?, ?, ?, ?, ?, ?, ?)').run(threadId, turn.id, turn.ordinal, 'completed', offset, turn.end, 206378);
        db.prepare('INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(threadId, turn.id, 'old', turn.itemOrdinal, 10, JSON.stringify({ type: 'agentMessage', text: '旧回复' }), 'agentMessage', turn.itemOrdinal);
      }
      db.close();
    };
    seed(path.join(personal, 'thread_history_1.sqlite'), 206378, 89, { id: 'old-turn', ordinal: 61, end: 88, itemOrdinal: 84 });
    seed(path.join(isolated, 'thread_history_1.sqlite'), 333848, 133, { id: 'old-turn', ordinal: 61, end: 88, itemOrdinal: 84 });
    const isolatedDb = new DatabaseSync(path.join(isolated, 'thread_history_1.sqlite'));
    isolatedDb.prepare('INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, rollout_byte_offset, rollout_end_ordinal, rollout_end_byte_offset) VALUES (?, ?, ?, ?, ?, ?, ?)').run(threadId, 'new-turn', 90, 'completed', 206378, 132, 333848);
    isolatedDb.prepare('INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(threadId, 'new-turn', 'new-item', 100, 20, JSON.stringify({ type: 'agentMessage', text: '用户端新回复' }), 'agentMessage', 100);
    isolatedDb.close();
    for (const directory of [personal, isolated]) {
      const db = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER, preview TEXT)');
      db.prepare('INSERT INTO threads (id, updated_at, updated_at_ms, recency_at, recency_at_ms, preview) VALUES (?, ?, ?, ?, ?, ?)').run(threadId, directory === personal ? 100 : 200, directory === personal ? 1000 : 5000, 100, directory === personal ? 1000 : 5000, '旧预览');
      db.close();
    }
    assert.equal(await syncCodexDesktopHistory(threadId, personal, isolated), 'copied');
    assert.equal(await syncCodexDesktopHistory(threadId, personal, isolated), 'current');
    const desktop = new DatabaseSync(path.join(personal, 'thread_history_1.sqlite'), { readOnly: true });
    const turns = desktop.prepare('SELECT turn_id, root_turn_id FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal').all(threadId) as { turn_id: string; root_turn_id: string | null }[];
    assert.deepEqual(turns.map(turn => turn.turn_id), ['old-turn', 'new-turn']);
    assert.equal(turns[1].root_turn_id, null);
    const item = desktop.prepare('SELECT item_json, started_at_ms FROM thread_items WHERE item_id = ?').get('new-item') as { item_json: string; started_at_ms: number | null };
    assert.equal(JSON.parse(item.item_json).text, '用户端新回复');
    assert.equal(item.started_at_ms, null);
    const cursor = desktop.prepare('SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id = ?').get(threadId) as { next_rollout_byte_offset: number; next_rollout_ordinal: number };
    assert.equal(cursor.next_rollout_byte_offset, 333848);
    assert.equal(cursor.next_rollout_ordinal, 133);
    desktop.close();
    const state = new DatabaseSync(path.join(personal, 'state_5.sqlite'), { readOnly: true });
    const thread = state.prepare('SELECT updated_at_ms, preview FROM threads WHERE id = ?').get(threadId) as { updated_at_ms: number; preview: string };
    assert.equal(thread.updated_at_ms, 5000);
    assert.equal(thread.preview, '用户端新回复');
    state.close();
    const ahead = new DatabaseSync(path.join(personal, 'thread_history_1.sqlite'));
    ahead.prepare('UPDATE thread_history_projection_state SET next_rollout_byte_offset = ?, next_rollout_ordinal = ? WHERE thread_id = ?').run(400000, 200, threadId);
    ahead.close();
    assert.equal(await syncCodexDesktopHistory(threadId, personal, isolated), 'current');
    const kept = new DatabaseSync(path.join(personal, 'thread_history_1.sqlite'), { readOnly: true });
    const keptCursor = kept.prepare('SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id = ?').get(threadId) as { next_rollout_byte_offset: number };
    assert.equal(keptCursor.next_rollout_byte_offset, 400000);
    kept.close();
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true }); break; }
      catch (error: any) { if (error.code !== 'EBUSY' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    }
  }
});
