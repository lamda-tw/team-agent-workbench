import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BetaFeaturesModal, betaFeatureStates } from '../src/renderer/beta-features';

test('legacy combined Beta choice remains enabled for both abilities', () => {
  assert.deepEqual(betaFeatureStates({ sessionHandoff: true }), { sessionHandoff: true, subsessions: true, codexDesktopSync: false, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ sessionHandoff: true, subsessions: false }), { sessionHandoff: true, subsessions: false, codexDesktopSync: false, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ sessionHandoff: false, subsessions: true }), { sessionHandoff: false, subsessions: true, codexDesktopSync: false, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ codexDesktopSync: true }), { sessionHandoff: false, subsessions: false, codexDesktopSync: true, cursorDesktopSync: false });
  assert.deepEqual(betaFeatureStates({ cursorDesktopSync: true }), { sessionHandoff: false, subsessions: false, codexDesktopSync: false, cursorDesktopSync: true });
});

test('the Beta dialog shows independent switches', () => {
  const html = renderToStaticMarkup(React.createElement(BetaFeaturesModal, { features: { sessionHandoff: true, subsessions: false }, close: () => {}, changed: async () => {} }));
  assert.equal((html.match(/role="switch"/g) || []).length, 4);
  assert.match(html, /aria-label="开启跨会话引用" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Subsession" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Codex 桌面联动" checked=""/);
  assert.doesNotMatch(html, /aria-label="开启 Cursor Agents 联动" checked=""/);
  assert.match(html, /关闭后不能新建 Subsession 或回报/);
  const desktopOnly = renderToStaticMarkup(React.createElement(BetaFeaturesModal, { features: { codexDesktopSync: true }, close: () => {}, changed: async () => {} }));
  assert.match(desktopOnly, /aria-label="开启 Codex 桌面联动" checked=""/);
  assert.doesNotMatch(desktopOnly, /aria-label="开启跨会话引用" checked=""|aria-label="开启 Subsession" checked=""/);
});
