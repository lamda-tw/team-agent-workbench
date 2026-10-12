import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EgressJumpSettings } from '../src/admin/egress-jump';
import { EgressRouteChoice } from '../src/renderer/egress-route';
import { adminEgressConfigSchema } from '../src/core/egress-config';
import type { AdminSnapshot } from '../src/admin/types';

test('jump settings expose the existing SSH port and limit changes to connected Linux administrators', () => {
  const config = adminEgressConfigSchema.parse({ enabled: true, publicHost: 'admin.internal', listenPort: 443 });
  const base: AdminSnapshot = { connected: true, verified: true, busy: false, role: 'administrator', profile: { host: 'shared.internal', port: 2202, username: 'root', fingerprint: '', root: '/srv/teamspace' }, state: { initialized: true, users: {}, groups: {} } };
  const render = (remote: AdminSnapshot) => renderToStaticMarkup(React.createElement(EgressJumpSettings, { remote, config, refresh: async () => {} }));
  const enabled = render(base);
  assert.match(enabled, /2202/); assert.match(enabled, /admin.internal:443/); assert.match(enabled, /测试服务器到出口/);
  assert.doesNotMatch(enabled, /disabled=""/);
  for (const remote of [{ ...base, connected: false }, { ...base, role: undefined, verified: false }, { ...base, profile: { ...base.profile!, mode: 'local' as const } }]) {
    assert.equal((render(remote).match(/disabled=""/g) || []).length, 3);
  }
  const allowed = render({ ...base, state: { ...base.state!, egressJumpTargets: [{ host: config.publicHost, port: config.listenPort }] } });
  assert.match(allowed, /已允许直连中转/); assert.match(allowed, /移除并断开成员连接/); assert.match(allowed, /全体成员/);
  const connected = renderToStaticMarkup(React.createElement(EgressJumpSettings, { remote: base, config, reverse: { enabled: true, state: 'connected', detail: '反向隧道已连接', memberAccessConfigured: true, remotePort: 30123, activeConnections: 2, reconnects: 1, bytesUp: 100, bytesDown: 200 }, refresh: async () => {} }));
  assert.match(connected, /复制中转接入码/); assert.match(connected, /检测完整隧道/); assert.match(connected, /停用中转/); assert.match(connected, /内部端口 30123/);
});

test('users can distinguish direct admin access from shared-server routing', () => {
  const render = (value: boolean) => renderToStaticMarkup(React.createElement(EgressRouteChoice, { value, onChange: () => {} }));
  assert.doesNotMatch(render(false), /checked=""/); assert.match(render(false), /本机直接连接管理端/);
  assert.match(render(true), /checked=""/); assert.match(render(true), /已登录的共享服务器/); assert.match(render(true), /无需新增共享服务器端口/);
});
