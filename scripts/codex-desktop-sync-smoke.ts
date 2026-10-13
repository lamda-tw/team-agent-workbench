import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { JsonRpc, type RpcMessage } from '../src/core/rpc';
import { prepareCodexStorage } from '../src/core/codex-storage';
import { sameNativePath } from '../src/core/native-transcript';
import { resolveProvider } from '../src/core/providers';
import type { AgentSession } from '../src/shared/types';

interface Peer extends EventEmitter {
  request(method: string, params?: unknown, timeout?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

// Test-only WebSocket transport. It does not connect to the installed desktop
// application: the endpoint belongs to the disposable backend spawned below.
class SocketPeer extends EventEmitter implements Peer {
  private seq = 0;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private socket: WebSocket) {
    super();
    socket.addEventListener('message', event => {
      const message: RpcMessage = JSON.parse(String(event.data));
      if (message.method) {
        if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This fixture does not approve tool operations' } }));
        this.emit('message', message);
      } else {
        const id = String(message.id), call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id); clearTimeout(call.timer);
        message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => this.finish());
    socket.addEventListener('error', () => this.finish());
  }
  private finish() {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('Local fixture socket closed')); }
    this.pending.clear();
  }
  request(method: string, params: unknown = {}, timeout = 15000) {
    return new Promise<any>((resolve, reject) => {
      const id = 'fixture-' + ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params: unknown = {}) { this.socket.send(JSON.stringify({ method, params })); }
  async close() { this.finish(); this.socket.close(); }
}

async function connectSocket(url: string): Promise<SocketPeer> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Local backend not ready')), { once: true });
      });
      const peer = new SocketPeer(socket);
      await peer.request('initialize', { clientInfo: { name: 'team_agent_sync_socket_fixture', version: '1' }, capabilities: { experimentalApi: true } });
      peer.notify('initialized'); return peer;
    } catch { socket.close(); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('The disposable local WebSocket backend did not start');
}

async function freeLocalPort() {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

// Real Codex processes, temporary profiles, and a localhost Responses fixture.
// This verifies native history persistence without login, shared-server access,
// external inference, or changes to the user's desktop session database.
async function main() {
  const root = path.join(process.cwd(), '.test-data', 'native-desktop-sync-' + Date.now());
  const personal = path.join(root, 'personal');
  await fs.mkdir(personal, { recursive: true });
  let requests = 0;
  const requestBodies: string[] = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404); response.end(); return;
    }
    requestBodies.push(body);
    const text = 'LOCAL_SYNC_REPLY_' + ++requests;
    const responseId = 'resp_' + randomUUID().replaceAll('-', '');
    const itemId = 'msg_' + randomUUID().replaceAll('-', '');
    const part = { type: 'output_text', text, annotations: [] };
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] };
    const completed = {
      id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'sync-local',
      status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, value: unknown) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...(value as object) }) + '\n\n');
    emit('response.created', { response: { ...completed, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    emit('response.content_part.added', { output_index: 0, item_id: itemId, content_index: 0, part: { ...part, text: '' } });
    emit('response.output_text.delta', { output_index: 0, item_id: itemId, content_index: 0, delta: text });
    emit('response.output_text.done', { output_index: 0, item_id: itemId, content_index: 0, text });
    emit('response.content_part.done', { output_index: 0, item_id: itemId, content_index: 0, part });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: completed }); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await fs.writeFile(path.join(personal, 'config.toml'), `model="sync-local"\nmodel_provider="sync_local"\n[model_providers.sync_local]\nname="Local sync test"\nbase_url="http://127.0.0.1:${port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const clients: Peer[] = [];
  const open = async (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
    const rpc = new JsonRpc(executable, args, root, false, { ...env,
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' });
    clients.push(rpc);
    rpc.on('message', (message: RpcMessage) => {
      if (message.id !== undefined) rpc.reject(message.id, 'This fixture does not approve tool operations');
    });
    await rpc.request('initialize', { clientInfo: { name: 'team_agent_sync_smoke', version: '1' }, capabilities: { experimentalApi: true } }, 15000);
    rpc.notify('initialized'); return rpc;
  };
  const turn = async (rpc: Peer, id: string) => {
    let timer: NodeJS.Timeout | undefined;
    let listener: (message: RpcMessage) => void;
    const completed = new Promise<any>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Local test turn timed out')), 30000);
      listener = message => { if (message.method === 'turn/completed' && message.params?.threadId === id) resolve(message.params); };
      rpc.on('message', listener);
    });
    // Attach rejection handling before awaiting the request acknowledgement.
    void completed.catch(() => {});
    try {
      await rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Return the local test reply.' }] }, 20000);
      const result = await completed;
      assert.equal(result.turn.status, 'completed');
    } finally { clearTimeout(timer); rpc.off('message', listener!); }
  };
  const read = async (rpc: Peer, id: string) => (await rpc.request('thread/read', { threadId: id, includeTurns: true }, 15000)).thread;
  try {
    const desktopExecutable = process.env.SYNC_DESKTOP_EXE || await resolveProvider('codex');
    const clientExecutable = process.env.SYNC_CLIENT_EXE || desktopExecutable;
    const desktop = await open(desktopExecutable, ['app-server'], { CODEX_HOME: personal, CODEX_SQLITE_HOME: personal });
    const started = await desktop.request('thread/start', { cwd: root, model: 'sync-local', approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated' }, 20000);
    const id = started.thread.id;
    await turn(desktop, id);
    await new Promise(resolve => setTimeout(resolve, 500));
    const session = { id: randomUUID(), nativeId: id, nativeLive: true, cwd: root, provider: 'codex', purpose: 'work' } as AgentSession;
    const storage = await prepareCodexStorage(path.join(root, 'data'), session, personal);
    // Candidate-only override. Sharing a SQLite index is intentionally NOT a
    // product fix: this diagnostic reproduces the stale context on return.
    storage.env.CODEX_SQLITE_HOME = personal;
    storage.args = ['app-server', '-c', 'sqlite_home=' + JSON.stringify(personal), '-c', 'cli_auth_credentials_store="ephemeral"'];
    const runtime = await open(clientExecutable, storage.args, storage.env);
    const resumed = await runtime.request('thread/resume', { threadId: id, path: storage.resumePath, cwd: root, model: 'sync-local', approvalPolicy: 'never', sandbox: 'read-only' }, 20000);
    assert.equal(resumed.thread.id, id);
    assert.ok(storage.resumePath && sameNativePath(resumed.thread.path, storage.resumePath));
    await turn(runtime, id);
    await new Promise(resolve => setTimeout(resolve, 700));
    const loaded = await read(desktop, id);
    assert.equal(loaded.turns.length, 2);
    assert.ok(JSON.stringify(loaded.turns).includes('LOCAL_SYNC_REPLY_2'));
    // The original process still owns a loaded model context. A resume rejoins
    // that context rather than ingesting the other process's newly written turn.
    await desktop.request('thread/resume', { threadId: id, path: storage.resumePath }, 20000);
    await turn(desktop, id);
    await new Promise(resolve => setTimeout(resolve, 700));
    const afterReturn = await read(desktop, id);
    const returnContextHasClientReply = requestBodies[2]?.includes('LOCAL_SYNC_REPLY_2') || false;
    await desktop.close();
    const reopened = await open(desktopExecutable, ['app-server'], { CODEX_HOME: personal, CODEX_SQLITE_HOME: personal });
    const persisted = await read(reopened, id);
    assert.equal(requests, 3);
    assert.equal(returnContextHasClientReply, false, 'separate loaded runtimes must not be mistaken for a shared model context');
    const records = (await fs.readFile(storage.resumePath!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const ordinals = new Set<number>();
    let repeatedOrdinals = 0;
    for (const record of records) if (typeof record.ordinal === 'number') {
      if (ordinals.has(record.ordinal)) repeatedOrdinals++; else ordinals.add(record.ordinal);
    }
    // Positive control: two clients subscribe to ONE backend and ONE in-memory
    // thread. This verifies the proposed transport direction, not desktop access.
    const endpoint = 'ws://127.0.0.1:' + await freeLocalPort();
    const socketServer = new JsonRpc(desktopExecutable, ['app-server', '--listen', endpoint], root, false,
      { CODEX_HOME: personal, CODEX_SQLITE_HOME: personal, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' });
    clients.push(socketServer);
    const first = await connectSocket(endpoint); clients.push(first);
    const second = await connectSocket(endpoint); clients.push(second);
    const shared = await first.request('thread/start', { cwd: root, model: 'sync-local', approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated' });
    const sharedId = shared.thread.id;
    await turn(first, sharedId);
    await second.request('thread/resume', { threadId: sharedId });
    let firstClientSawSecondReply = false;
    first.on('message', (message: RpcMessage) => {
      if (message.params?.threadId === sharedId && JSON.stringify(message.params).includes('LOCAL_SYNC_REPLY_5')) firstClientSawSecondReply = true;
    });
    await turn(second, sharedId);
    await turn(first, sharedId);
    await new Promise(resolve => setTimeout(resolve, 700));
    const sharedHistory = await read(first, sharedId);
    const sharedContextHasClientReply = requestBodies[5]?.includes('LOCAL_SYNC_REPLY_5') || false;
    assert.equal(sharedContextHasClientReply, true, 'one backend must include the other client turn in its next model request');
    assert.equal(firstClientSawSecondReply, true, 'the subscribed client must receive the other client reply');
    assert.equal(sharedHistory.turns.length, 3);
    for (const number of [4, 5, 6]) assert.ok(JSON.stringify(sharedHistory).includes('LOCAL_SYNC_REPLY_' + number));
    assert.equal(requests, 6);
    const result = { diagnosisVerified: true, installedDesktopSyncVerified: false, root, requests,
      separateBackends: { nativeId: id, loadedTurns: loaded.turns.length, afterReturnTurns: afterReturn.turns.length,
        persistedTurns: persisted.turns.length, returnContextHasClientReply, repeatedOrdinals },
      sharedBackend: { nativeId: sharedId, turns: sharedHistory.turns.length, contextHasClientReply: sharedContextHasClientReply,
        firstClientSawSecondReply }, externalModelRequests: 0 };
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
