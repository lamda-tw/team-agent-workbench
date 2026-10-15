import test from 'node:test';
import assert from 'node:assert/strict';
import { taskbarAttention, taskbarShouldAlert } from '../src/shared/taskbar-attention';

const questions = { read: { seen: 2 }, items: [{ id: 'seen', activityRevision: 2 }, { id: 'fresh', activityRevision: 1 }] };
const updates = [{ readAt: '2026-10-15T00:00:00.000Z' }, {}];
const idle = { purpose: 'work', status: 'idle', completion: { id: 'done-1' } };

test('taskbar attention watches unread dynamics and finished sessions', () => {
  assert.deepEqual(taskbarAttention(questions, updates, [idle]), { dynamics: 2, completions: ['done-1'] });
  assert.deepEqual(taskbarAttention(undefined, [], [{ ...idle, completion: { id: 'done-1', readAt: '2026-10-15T00:00:00.000Z' } }]), { dynamics: 0, completions: [] });
});

test('taskbar turns orange only when something new arrives', () => {
  const first = taskbarAttention(questions, updates, []);
  assert.equal(taskbarShouldAlert(undefined, first), false);
  assert.equal(taskbarShouldAlert(first, first), false);
  assert.equal(taskbarShouldAlert(first, taskbarAttention(questions, [{}, {}], [])), true);
  assert.equal(taskbarShouldAlert(first, taskbarAttention(questions, updates, [idle])), true);
  const seen = taskbarAttention(questions, updates, [idle]);
  assert.equal(taskbarShouldAlert(seen, taskbarAttention(questions, updates, [{ ...idle, completion: { id: 'done-2' } }])), true);
});
