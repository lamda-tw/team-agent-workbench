import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CursorDesktopCdp, cursorWorkspacePath } from '../src/core/cursor-desktop-client';

const panelSelector = '[data-agent-panel-conversation-shell][data-glass-agent-id]';
const workspace = (cwd: string) => ({ id: randomUUID(), uri: { scheme: 'file', path: decodeURIComponent(pathToFileURL(cwd).pathname) } });
type Message = { id: string; role: string; text: string; nested?: boolean };

// Native-shaped Agents view props and multiple project panels. The real renderer adapter
// runs inside a VM; no installed app or real desktop is touched.
async function fixture() {
  const cwd = path.resolve('one/same name #100%'), otherCwd = path.resolve('two/same name #100%');
  const calls: string[] = [], panels: any[] = [], sections: any[] = [];
  const document: any = { activeElement: undefined, querySelectorAll(selector: string) {
    if (selector === panelSelector) return panels.filter(p => p.open).flatMap(p => Array(p.copies).fill(p.root));
    if (selector === '[data-sidebar-workspace-section-root]') return sections;
    if (selector === '[data-sidebar-item-key]') return panels.map(p => p.row);
    return [];
  } };
  const visible = { getClientRects: () => [1] };
  function addPanel(directory: string, source = 'local') {
    const p: any = { open: true, copies: 1, draft: '', messages: [] as Message[], status: 'completed',
      header: { id: randomUUID(), name: { value: 'Native Agent' }, source, status: { value: 'done' }, environment: { value: workspace(directory) }, isArchived: { value: false } } };
    p.header.targetEnvironment = { type: 'existing', environment: p.header.environment.value };
    p.anchor = { isConnected: true, querySelectorAll: () => p.open ? Array(p.copies).fill(p.root) : [] };
    p.input = { ...visible, get innerText() { return p.draft; }, closest: () => p.root, focus() { document.activeElement = p.input; } };
    p.root = { ...visible, __reactFiber$fixture: { memoizedProps: { agentReference: { header: p.header } } },
      getAttribute: (key: string) => key === 'data-glass-agent-id' ? p.header.id : null,
      closest: (selector: string) => selector === panelSelector ? p.root : p.anchor,
      querySelectorAll: (selector: string) => {
        if (selector.startsWith('[contenteditable')) return [p.input];
        if (selector === '[data-component="agent-conversation-composer"]') return [{ ...visible, closest: () => p.root, getAttribute: () => p.status }];
        if (selector.startsWith('[data-message-id]')) return p.messages.map((m: Message) => ({ ...visible, closest: () => m.nested ? {} : p.root, getAttribute: (key: string) => key === 'data-message-id' ? m.id : m.role === 'user' ? 'human' : 'assistant', innerText: m.text }));
        if (selector.includes('Send message')) return [{ ...visible, closest: () => p.root, disabled: false, click() {
          calls.push('submit');
          if (state.switchOnEnter) { p.anchor.querySelectorAll = () => [other.root]; }
          else {
            if (p.header.source === 'draft') { p.header.id = randomUUID(); p.header.source = 'local'; }
            p.messages.push({ id: randomUUID(), role: 'user', text: p.draft }, { id: randomUUID(), role: 'assistant', text: 'reply' }); p.draft = '';
          }
        } }];
        if (selector.includes('Stop generation')) return [{ ...visible, closest: () => p.root, click() { calls.push('stop:' + p.header.id); p.status = 'aborted'; p.header.status.value = 'done'; } }];
        return [];
      } };
    p.row = { ...visible, __reactFiber$fixture: { memoizedProps: { header: p.header } }, contains: () => false, click() { p.open = true; calls.push('reveal:' + p.header.id); } };
    panels.push(p); return p;
  }
  for (const directory of [cwd, otherCwd]) {
    const section = { projects: [{ workspaceIdentifier: workspace(directory) }], get headers() { return panels.filter(p => p.header.environment.value.uri.path === decodeURIComponent(pathToFileURL(directory).pathname)).map(p => p.header); } };
    sections.push({ ...visible, __reactFiber$fixture: { memoizedProps: { section } }, querySelectorAll: () => [{ ...visible, disabled: false, click() { calls.push('new:' + directory); addPanel(directory, 'draft'); } }] });
  }
  const primary = addPanel(cwd), other = addPanel(otherCwd);
  const state = { glass: true, switchOnInput: false, switchOnEnter: false, dropAcknowledgement: false };
  const context = { window: { vscode: { context: { resolveConfiguration: async () => ({ glass: state.glass }) } } }, getComputedStyle: () => ({ visibility: 'visible' }), document };
  let endpoint = '', replaceBrowser = false;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/json/version' ? { webSocketDebuggerUrl: replaceBrowser ? endpoint + '-changed' : endpoint } : [{ id: 'page', type: 'page', url: 'vscode-file://vscode-app/out/vs/code/electron-sandbox/workbench/workbench.html', webSocketDebuggerUrl: endpoint.replace('/browser/identity', '/page/page') }]));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => socket.on('message', async raw => {
    const request = JSON.parse(raw.toString()); calls.push(request.method);
    let result: any = {};
    if (request.method === 'Runtime.evaluate') {
      try { result = { result: { value: await runInNewContext(request.params.expression, context) } }; }
      catch (error: any) { result = { exceptionDetails: { exception: { description: error.message } } }; }
    }
    const focused = panels.find(p => p.input === document.activeElement);
    if (request.method === 'Input.insertText') { focused.draft = request.params.text; if (state.switchOnInput) document.activeElement = other.input; }
    if (state.dropAcknowledgement && calls.includes('submit')) { socket.close(); return; }
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); endpoint = 'ws://127.0.0.1:' + (server.address() as any).port + '/devtools/browser/identity';
  const client = new CursorDesktopCdp(endpoint);
  return { client, state, primary, other, panels, cwd, otherCwd, calls, addPanel, replace: () => { replaceBrowser = true; }, async close() {
    client.close(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('Agents scopes native IDs to each full project path and isolates messages and sends across panels', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.client.hasWorkspace(f.cwd), true);
    assert.equal(await f.client.hasWorkspace(path.resolve('three/same name #100%')), false);
    assert.equal((await f.client.list()).length, 2);
    f.primary.messages.push({ id: 'own', role: 'assistant', text: 'own reply' }, { id: 'nested', role: 'assistant', text: 'subagent', nested: true });
    f.other.messages.push({ id: 'elsewhere', role: 'assistant', text: 'other project' });
    f.other.draft = 'keep my draft'; f.other.status = 'generating';
    const text = 'literal dollar $ and backtick ' + String.fromCharCode(96) + '\n第二行';
    assert.equal((await f.client.send(f.primary.header.id, f.cwd, text)).submitted, true);
    const snapshot = await f.client.snapshot(f.primary.header.id, f.cwd);
    assert.deepEqual(snapshot.messages.map(m => m.text), ['own reply', text, 'reply']);
    assert.equal('draft' in snapshot, false); assert.equal(f.other.draft, 'keep my draft'); assert.equal(f.other.messages.length, 1);
    await assert.rejects(f.client.send(f.primary.header.id, f.otherCwd, 'wrong project'), /原工作目录/);
    f.replace(); await assert.rejects(f.client.snapshot(f.primary.header.id, f.cwd), /窗口已经更换/);
    assert.equal(f.calls.filter(x => x === 'submit').length, 1);
  } finally { await f.close(); }
});

test('native per-project New Agent creates a draft and its first delivery returns the promoted local ID', async () => {
  const f = await fixture();
  try {
    const chat = await f.client.create(f.cwd);
    const draft = f.panels.find(p => p.header.id === chat.nativeId);
    assert.equal(draft.header.source, 'draft'); assert.equal(f.calls.filter(x => x === 'new:' + f.cwd).length, 1);
    const reply = await f.client.send(chat.nativeId, f.cwd, 'first turn');
    assert.notEqual(reply.sessionId, chat.nativeId); assert.equal(reply.sessionId, draft.header.id);
    assert.equal((await f.client.snapshot(reply.sessionId!, f.cwd)).messages[0].text, 'first turn'); assert.equal(f.other.messages.length, 0);
  } finally { await f.close(); }
});

test('Agents preserves drafts/running turns, refuses duplicate panels and stops before submit if focus changes', async () => {
  const f = await fixture();
  try {
    const id = f.primary.header.id;
    f.primary.draft = 'native draft'; await assert.rejects(f.client.send(id, f.cwd, 'override'), /草稿/);
    await assert.rejects(f.client.create(f.cwd), /草稿/); assert.ok(!f.calls.some(x => x.startsWith('new:')));
    f.primary.draft = ''; f.primary.status = 'generating'; await assert.rejects(f.client.send(id, f.cwd, 'concurrent'), /正在回复/);
    f.primary.status = 'completed'; f.primary.copies = 2; await assert.rejects(f.client.send(id, f.cwd, 'ambiguous'), /只能显示在一个面板/);
    f.primary.copies = 1; f.state.switchOnInput = true; await assert.rejects(f.client.send(id, f.cwd, 'race'), /输入状态已改变/);
    assert.ok(!f.calls.includes('submit')); assert.equal(f.primary.draft, 'race');
  } finally { await f.close(); }
});

test('a draft cannot adopt an existing adjacent conversation, even when the message text matches', async () => {
  const f = await fixture();
  try {
    const chat = await f.client.create(f.cwd);
    f.other.header.environment.value = workspace(f.cwd);
    f.other.messages.push({ id: 'old-user', role: 'user', text: 'same text' }); f.state.switchOnEnter = true;
    await assert.rejects(f.client.send(chat.nativeId, f.cwd, 'same text'), /送达状态未确认/);
    assert.equal(f.calls.filter(x => x === 'submit').length, 1);
  } finally { await f.close(); }
});

test('lost acknowledgement does not repeat submit or resend the message', async () => {
  const f = await fixture();
  try {
    f.state.dropAcknowledgement = true;
    await assert.rejects(f.client.send(f.primary.header.id, f.cwd, 'once'), /送达状态未确认/);
    assert.equal(f.calls.filter(x => x === 'submit').length, 1);
    assert.equal(f.primary.messages.filter((m: Message) => m.role === 'user').length, 1);
  } finally { await f.close(); }
});

test('only explicit focus reveals hidden chats; explicit stop targets one panel; detach never stops or closes the app', async () => {
  const f = await fixture();
  try {
    const id = f.primary.header.id;
    f.primary.open = false; await assert.rejects(f.client.snapshot(id, f.cwd), /打开关联会话/);
    assert.ok(!f.calls.includes('reveal:' + id)); await f.client.focus(id, f.cwd);
    assert.ok(f.calls.includes('reveal:' + id)); assert.ok(f.calls.includes('Page.bringToFront'));
    f.primary.status = 'generating'; f.other.status = 'generating'; await f.client.stop(id, f.cwd);
    assert.equal(f.primary.status, 'aborted'); assert.equal(f.other.status, 'generating');
    f.client.close(); assert.deepEqual(f.calls.filter(x => x.startsWith('stop:')), ['stop:' + id]);
    assert.ok(!f.calls.includes('Browser.close')); assert.ok(!f.calls.some(x => x.startsWith('key:')));
  } finally { await f.close(); }
});

test('IDE windows, cloud/remote/archived agents and unknown panel identities are not control targets', async () => {
  const f = await fixture();
  try {
    f.state.glass = false; assert.deepEqual(await f.client.list(), []); assert.equal(await f.client.hasWorkspace(f.cwd), false);
    f.state.glass = true; f.primary.header.source = 'cloud'; f.other.header.environment.value.uri.scheme = 'vscode-remote';
    f.addPanel(f.cwd).header.isArchived.value = true; assert.deepEqual(await f.client.list(), []);
    f.primary.header.source = 'local'; delete f.primary.root.__reactFiber$fixture;
    await assert.rejects(f.client.send(f.primary.header.id, f.cwd, 'unknown'), /无法核对/); assert.ok(!f.calls.includes('Input.insertText'));
  } finally { await f.close(); }
});

test('workspace identity rejects remote and multi-root folders and retains special characters', () => {
  const cwd = path.resolve('same name #100%');
  assert.equal(cursorWorkspacePath(workspace(cwd)), cwd);
  assert.equal(cursorWorkspacePath({ uri: { scheme: 'vscode-remote', path: '/workspace' } }), undefined);
  assert.equal(cursorWorkspacePath({ configPath: { scheme: 'file', path: '/example.code-workspace' } }), undefined);
  assert.equal(cursorWorkspacePath({ uri: { scheme: 'file', authority: 'server', path: '/workspace' } }), undefined);
});
