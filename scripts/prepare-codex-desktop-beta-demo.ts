import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { LocalAdminConnection } from '../src/admin/local-connection';
import { memberProfile } from '../tests/fixtures/member-profile';
import { resolveNativeSession } from '../src/core/native-sessions';
import { WebSocketRpc } from '../src/core/websocket-rpc';
import type { CodexDesktopBridge } from '../src/core/codex-desktop-bridge';

// A dedicated local sharing stub, not the central SSH server or existing user data.
// Preparing the empty test conversation does not send a model request.
export async function prepareCodexDesktopBetaDemo(bridge: CodexDesktopBridge, directory: string) {
  const root = path.join(directory, 'demo'), userData = path.join(root, 'user'), workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(path.join(root, 'share'), { recursive: true });
  const admin = new LocalAdminConnection(() => {}), wb = new Workbench(userData, () => {}, () => {});
  const peer = new WebSocketRpc(bridge.endpoint);
  try {
    await admin.connect({ mode: 'local', localRoot: path.join(root, 'share'), host: 'local', port: 22, username: '', root: '/srv/teamspace', fingerprint: '' }, '', '', async () => false);
    await admin.operation({ op: 'initialize' }); await admin.operation({ op: 'user_create', username: 'sync_beta', name: '同步测试', password: '123' });
    const profile = memberProfile(admin.snapshot.profile!, admin.snapshot.state!, 'sync_beta');
    await wb.store.init(); await wb.configureWorkspace(profile, '123', workspace, async () => false);
    const group = await wb.groupCommand({ action: 'create', label: 'Codex同步测试' });
    const project = await wb.createProject('桌面双向同步', (group as any).id, {
      background: '这是独立的本地打桩工作区，用于验证工作台与 Codex 桌面版连接同一个后台。',
      objectives: '验证两端轮流发言、消息显示和上下文延续。',
      acceptance: '两端依次完成三轮对话，并能准确引用前一端发送的验证内容。',
      scope: '只使用测试会话，不连接中央节点。', deliverables: '同步验证记录', resources: '', constraints: 'Beta 联调；不自动关闭其他聊天。', collaboration: '同一会话依次发送，等待上一轮结束。',
    });
    wb.store.settings.providerPaths.codex = bridge.executable; await wb.store.save();
    await peer.request('initialize', { clientInfo: { name: 'team_agent_beta_demo', version: '1' }, capabilities: { experimentalApi: true } }); peer.notify('initialized');
    const { thread } = await peer.request('thread/start', { cwd: workspace, historyMode: 'paginated' });
    await peer.request('thread/name/set', { threadId: thread.id, name: 'Codex 同步 Beta 验证' });
    const deadline = Date.now() + 10000;
    let native = await resolveNativeSession('codex', thread.id);
    while (!native && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 150)); native = await resolveNativeSession('codex', thread.id); }
    if (!native) throw new Error('测试会话尚未写入，未启动应用');
    const session = await wb.linkNativeSession('codex', thread.id, project.id);
    await wb.store.save();
    const result = { userData, workspace, nativeId: thread.id, sessionId: session.id, title: 'Codex 同步 Beta 验证', localAccount: 'sync_beta', localPassword: '123' };
    await fs.writeFile(path.join(root, 'demo.json'), JSON.stringify(result, null, 2)); return result;
  } finally { await peer.close(); await wb.close(); admin.disconnect(); }
}
