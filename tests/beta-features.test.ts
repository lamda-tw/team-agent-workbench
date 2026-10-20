import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BetaFeaturesModal, betaFeatureStates } from '../src/renderer/beta-features';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';

test('Cursor Beta selection survives saving settings and restarting the store', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-beta-persistence-'));
  try {
    const store=new Store(root);await store.init();
    store.settings.betaFeatures={account:{cursorDesktopSync:true,codexDesktopSync:false}};
    await store.save();const reopened=new Store(root);await reopened.init();
    assert.equal(reopened.settings.betaFeatures?.account.cursorDesktopSync,true);
    assert.equal(reopened.settings.betaFeatures?.account.codexDesktopSync,false);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('legacy combined Beta choice remains enabled for both abilities', () => {
  assert.deepEqual(betaFeatureStates({ sessionHandoff: true }), { sessionHandoff: true, subsessions: true, codexDesktopSync: false, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ sessionHandoff: true, subsessions: false }), { sessionHandoff: true, subsessions: false, codexDesktopSync: false, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ sessionHandoff: false, subsessions: true }), { sessionHandoff: false, subsessions: true, codexDesktopSync: false, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ codexDesktopSync: true }), { sessionHandoff: false, subsessions: false, codexDesktopSync: true, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ cursorDesktopSync: true }), { sessionHandoff: false, subsessions: false, codexDesktopSync: false, cursorDesktopSync: true });
});

test('the Beta dialog shows independent switches', () => {
  const html = renderToStaticMarkup(React.createElement(BetaFeaturesModal, { features: { sessionHandoff: true, subsessions: false }, close: () => {}, changed: async () => {} }));
  assert.equal((html.match(/role="switch"/g) || []).length, 3);
  assert.match(html, /aria-label="开启跨会话引用" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Subsession" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Codex 桌面联动" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Cursor Agents 联动" checked=""/);
  assert.doesNotMatch(html, /开启 Subsession|关闭后不能新建 Subsession/);
  const desktopOnly = renderToStaticMarkup(React.createElement(BetaFeaturesModal, { features: { codexDesktopSync: true }, close: () => {}, changed: async () => {} }));
  assert.match(desktopOnly, /aria-label="开启 Codex 桌面联动" checked=""/);
  assert.doesNotMatch(desktopOnly, /aria-label="开启跨会话引用" checked=""|aria-label="开启 Subsession" checked=""/);
});
