import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AgentRuntime } from '../src/core/agents';
import { WebSocketRpc } from '../src/core/websocket-rpc';
import { startCodexSharedBackend, privateBridgeDirectory, installedCodexDesktopExecutable } from '../src/core/codex-shared-backend';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { resolveProvider } from '../src/core/providers';
import type { AgentSession } from '../src/shared/types';
import { prepareCodexDesktopBetaDemo } from './prepare-codex-desktop-beta-demo';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) { const end = Date.now() + 12000; while (!predicate()) { if (Date.now() > end) throw new Error('local beta fixture timed out'); await delay(20); } }
async function main() {
  const root = path.resolve('.test-data', 'desktop-beta-' + Date.now()), personal = path.join(root, 'personal');
  await fs.mkdir(personal, { recursive: true });
  let requests = 0, releaseThird: (() => void) | undefined;
  const inputs: string[] = [];
  const responses = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
    inputs.push(body); const ordinal = ++requests;
    if (ordinal === 3) await new Promise<void>(resolve => { releaseThird = resolve; });
    const text = 'BETA_LOCAL_REPLY_' + ordinal, itemId = 'msg_' + randomUUID().replaceAll('-', '');
    const part = { type: 'output_text', text, annotations: [] }, item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] };
    const completed = { id: 'resp_' + randomUUID().replaceAll('-', ''), object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'beta-local', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, data: any) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    emit('response.created', { response: { ...completed, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit('response.content_part.added', { output_index: 0, item_id: itemId, content_index: 0, part: { ...part, text: '' } });
    emit('response.output_text.delta', { output_index: 0, item_id: itemId, content_index: 0, delta: text });
    emit('response.output_text.done', { output_index: 0, item_id: itemId, content_index: 0, text });
    emit('response.content_part.done', { output_index: 0, item_id: itemId, content_index: 0, part });
    emit('response.output_item.done', { output_index: 0, item }); emit('response.completed', { response: completed }); response.end();
  });
  await new Promise<void>(resolve => responses.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(personal, 'config.toml'), `model="beta-local"\nmodel_provider="beta_local"\n[model_providers.beta_local]\nname="Local fixture"\nbase_url="http://127.0.0.1:${(responses.address() as any).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const directory = await privateBridgeDirectory(path.join(root, 'state'));
  const backend = await startCodexSharedBackend({ executable: process.env.SYNC_DESKTOP_EXE || await installedCodexDesktopExecutable(await resolveProvider('codex')), sourceHome: personal, cwd: root, stateDirectory: directory, configArgs: process.env.BETA_CODE_MODE === '1' ? undefined : [], env: { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
  const peer = new WebSocketRpc(backend.descriptor.endpoint), prior = process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE, priorHome = process.env.CODEX_HOME;
  let runtime: AgentRuntime | undefined;
  const turn = async (text: string, nativeId: string) => {
    let completed = false;
    const listener = (message: any) => { if (message.method === 'turn/completed' && message.params.threadId === nativeId) completed = true; };
    peer.on('message', listener);
    try { await peer.request('turn/start', { threadId: nativeId, input: [{ type: 'text', text }] }); await until(() => completed); }
    finally { peer.off('message', listener); }
  };
  try {
    const route = new URL(backend.descriptor.endpoint); route.protocol = 'http:'; route.pathname += '/readyz';
    assert.equal((await fetch(route, { headers: { Origin: 'https://example.test' } })).status, 403);
    const wrong = new URL(route); wrong.pathname = wrong.pathname.replace(/\/rpc\/[a-f0-9]{64}/, '/rpc/' + '0'.repeat(64));
    assert.equal((await fetch(wrong)).status, 403);
    const unauthorized = new WebSocketRpc('ws://127.0.0.1:' + backend.backendPort);
    await assert.rejects(unauthorized.request('initialize', { clientInfo: { name: 'unauthorized', version: '1' } }), /连接/); await unauthorized.close();
    await peer.request('initialize', { clientInfo: { name: 'desktop_fixture', version: '1' }, capabilities: { experimentalApi: true } }); peer.notify('initialized');
    const { thread } = await peer.request('thread/start', { cwd: root, model: 'beta-local', historyMode: 'paginated', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    await turn('desktop first', thread.id);
    process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE = path.join(directory, 'bridge.json');
    const session: AgentSession = { id: randomUUID(), nativeId: thread.id, nativePath: thread.path, nativeLive: true, provider: 'codex', purpose: 'work', model: 'beta-local', permissionMode: 'inherit', cwd: root, title: 'Beta test', status: 'idle', createdAt: new Date().toISOString(), messages: [], approvals: [], sources: [], autoUpload: false, handoffPath: path.join(root, 'handoff.md') };
    const storage = await prepareCodexStorage(path.join(root, 'workbench'), session, personal);
    const events: any[] = []; let done = 0;
    runtime = new AgentRuntime(session, 'NO_SECOND_CLI_PROCESS', { changed: () => {}, event: value => events.push(value), done: () => done++ }, storage);
    let desktopReceivedWorkbench = false;
    peer.on('message', (message: any) => { if (message.params?.threadId === thread.id && JSON.stringify(message.params).includes('BETA_LOCAL_REPLY_2')) desktopReceivedWorkbench = true; });
    assert.equal(await runtime.prompt('workbench second'), true); await until(() => done === 1);
    assert.equal(desktopReceivedWorkbench, true);
    const third = turn('desktop third', thread.id); void third.catch(() => {});
    await until(() => !!releaseThird && session.status === 'running');
    await assert.rejects(runtime.prompt('must not be queued'), /运行/); assert.equal(requests, 3);
    releaseThird!(); await third; await until(() => done === 2);
    assert.ok(inputs[2].includes('BETA_LOCAL_REPLY_2'));
    assert.ok(session.messages.some(message => message.role === 'assistant' && message.text === 'BETA_LOCAL_REPLY_3'));
    await runtime.close(); await turn('desktop after closing workbench', thread.id);
    const history = (await peer.request('thread/read', { threadId: thread.id, includeTurns: true })).thread;
    assert.equal(history.turns.length, 4);
    for (const number of [1, 2, 3, 4]) assert.ok(JSON.stringify(history).includes('BETA_LOCAL_REPLY_' + number));
    const source = await fs.readFile(storage.resumePath!, 'utf8'), seen = new Set<number>();
    for (const line of source.trim().split('\n')) { const record = JSON.parse(line); if (typeof record.ordinal === 'number') { assert.ok(!seen.has(record.ordinal), 'shared history ordinals cannot overlap'); seen.add(record.ordinal); } }
    process.env.CODEX_HOME = personal;
    const demo = await prepareCodexDesktopBetaDemo(backend.descriptor, directory);
    assert.ok(demo.sessionId); assert.equal(requests, 4, 'demo creation does not invoke a model');
    let userInterfaceVerified = false;
    if (process.env.BETA_UI === '1') {
      const { _electron } = await import('playwright');
      const application = await _electron.launch({ args: [path.resolve('dist/user')], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, WORKBENCH_TEST: '1', WORKBENCH_DATA_DIR: demo.userData }, timeout: 30000 });
      try {
        const page = await application.firstWindow();
        await page.waitForFunction(async () => {
          const snapshot = await (window as any).workbench.call('snapshot');
          return snapshot.sessions.some((session: any) => session.title === 'Codex 同步 Beta 验证');
        }, undefined, { timeout: 30000 });
        const state: any = await page.evaluate(() => (window as any).workbench.call('snapshot'));
        const linked = state.sessions.find((session: any) => session.id === demo.sessionId);
        assert.ok(linked?.nativeLive); assert.equal(state.settings.workspaceSnapshot.profile.mode, 'local');
        if (await page.locator('.modal-backdrop').count()) {
          await page.getByLabel('登录密码', { exact: true }).fill('123');
          await page.getByRole('button', { name: '连接', exact: true }).click();
          await page.locator('.modal-backdrop').waitFor({ state: 'hidden', timeout: 15000 });
        }
        await page.locator('[data-session-id="' + demo.sessionId + '"]').click();
        await page.getByRole('textbox', { name: '任务输入', exact: true }).fill('只回复 BETA_LOCAL_REPLY_5。');
        await page.getByRole('textbox', { name: '任务输入', exact: true }).press('Enter');
        await page.waitForFunction(async id => {
          const snapshot = await (window as any).workbench.call('snapshot');
          const session = snapshot.sessions.find((session: any) => session.id === id);
          return session?.status === 'idle' && session.messages.some((message: any) => message.role === 'assistant' && message.text === 'BETA_LOCAL_REPLY_5');
        }, demo.sessionId, { timeout: 30000 });
        let nativeDemo = (await peer.request('thread/read', { threadId: demo.nativeId, includeTurns: true })).thread;
        const persistedBy = Date.now() + 5000;
        while (!JSON.stringify(nativeDemo).includes('BETA_LOCAL_REPLY_5') && Date.now() < persistedBy) {
          await delay(100); nativeDemo = (await peer.request('thread/read', { threadId: demo.nativeId, includeTurns: true })).thread;
        }
        assert.ok(JSON.stringify(nativeDemo).includes('BETA_LOCAL_REPLY_5'), 'the shared backend must persist the UI reply for the same native id');
        userInterfaceVerified = true;
      } finally { await application.close(); }
    }
    const pending = new WebSocketRpc(backend.descriptor.endpoint);
    await pending.request('initialize', { clientInfo: { name: 'close_fixture', version: '1' } }); pending.notify('initialized');
    await backend.close(); await assert.rejects(pending.request('account/read'), /连接|断开/); await pending.close();
    const result = { passed: true, root, nativeId: thread.id, turns: history.turns.length, requests, externalModelRequests: 0, userInterfaceVerified,
      cases: ['broker rejects wrong capability and browser Origin', 'native backend rejects unauthorized connections', 'production AgentRuntime uses one backend', 'desktop receives workbench reply', 'external desktop turn reaches workbench', 'busy turn cannot send another prompt', 'model request includes preceding other-client reply', 'client close leaves backend running', 'four turns survive with unique history ordinals', 'demo uses local sharing and creates no model request', 'backend loss fails without starting a second writer'] };
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally {
    releaseThird?.(); await runtime?.close(); await peer.close(); await backend.close();
    if (prior === undefined) delete process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE; else process.env.WORKBENCH_CODEX_DESKTOP_BRIDGE = prior;
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
    responses.closeAllConnections(); await new Promise<void>(resolve => responses.close(() => resolve()));
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
