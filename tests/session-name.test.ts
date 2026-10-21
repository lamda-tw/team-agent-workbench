import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionName } from '../src/renderer/session-name';
import { Workbench } from '../src/core/workbench';
import { grantTestWorkspace, offlineProjectId } from './fixtures/offline-workspace';

test('the conversation title exposes renaming in place without opening a dialog', () => {
  const html = renderToStaticMarkup(React.createElement(SessionName, { title: '量化误差分析', save: async () => {} }));
  assert.match(html, /aria-label="修改会话名称：量化误差分析"/);
  assert.match(html, /点击修改名称/);
  assert.doesNotMatch(html, /dialog|modal|保存名称/);
});

test('renaming persists only the title, keeping conversation context, input and child links intact', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-rename-')));
  const wb = new Workbench(path.join(root, 'data'), () => {}, () => {});
  await wb.store.init(); grantTestWorkspace(wb, root);
  t.after(async () => {
    await wb.close();
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert(path.basename(root).startsWith('workbench-rename-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const session = await wb.createSession('codex', root, offlineProjectId);
  session.nativeId = 'existing-native-session';
  session.messages.push({ id: 'message', role: 'user', text: '继续比较量化误差', createdAt: session.createdAt });
  const child = await wb.createSession('codex', root, offlineProjectId, 'work', session.id);
  await wb.saveInput(session.id, { text: '还没发送的问题', sourceIds: [], answers: {} });
  const before = structuredClone(session), childBefore = structuredClone(child), inputs = structuredClone(wb.store.inputs);
  await wb.renameSession(session.id, '  边界样本分析  ');
  assert.deepEqual(session, { ...before, title: '边界样本分析' });
  assert.deepEqual(child, childBefore); assert.deepEqual(wb.store.inputs, inputs);
  const saved = JSON.parse(await fs.readFile(path.join(wb.store.root, 'sessions.json'), 'utf8'));
  assert.deepEqual(saved.find((item: { id: string }) => item.id === session.id), JSON.parse(JSON.stringify(session)));
  for (const title of ['', '   ', '字'.repeat(121)]) await assert.rejects(wb.renameSession(session.id, title), /名称/);
  assert.equal(session.title, '边界样本分析');
});
