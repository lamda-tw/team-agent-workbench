import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { needsCentralConnection } from '../src/shared/central-connection';
import { CentralConnectionError } from '../src/renderer/central-connection-error';

test('central node disconnections offer recovery while native agent and ordinary file errors do not', () => {
  for (const message of ['中央节点连接已断开，请重新连接后再试', '请先连接中央节点', '中央节点连接不可用，请重新连接并验证成员身份', '连接已断开，请重新登录后再试']) {
    assert(needsCentralConnection(message));
    const html = renderToStaticMarkup(React.createElement(CentralConnectionError, { message, reconnect() {} }));
    assert.match(html, /role="alert"/);
    assert.match(html, /<button[^>]*>查看连接<\/button>/);
  }
  for (const message of ['Cursor 连接已断开，点击“在 Cursor 中打开”重新连接', 'Codex 尚未登录，请先登录个人账号', '连接已断开；请恢复同步并核对已有结果，不会自动重发任务', '文件不存在', '服务器拒绝了连接，请检查地址、端口和 SSH 服务']) {
    assert.equal(needsCentralConnection(message), false);
    const html = renderToStaticMarkup(React.createElement(CentralConnectionError, { message, reconnect() {} }));
    assert(!html.includes('<button'));
  }
});
