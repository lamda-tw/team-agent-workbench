import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

test('shared readiness, renewal and RPC connect directly despite an environment proxy', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-codex-loopback-'));
  const sourceHome = path.join(root, 'personal'), parent = path.join(root, 'managers'), directory = path.join(parent, 'run-test');
  const file = path.join(directory, 'bridge.json'), route = '/rpc/' + 'a'.repeat(64);
  let proxyRequests = 0, readiness = 0, renewals = 0, initializations = 0;
  const proxy = http.createServer((_request, response) => { proxyRequests++; response.writeHead(403); response.end(); });
  proxy.on('connect', (_request, socket) => { proxyRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === route + '/readyz') { readiness++; response.end(); return; }
    if (request.method === 'POST' && request.url === route + '/renew') {
      renewals++;
      void (async () => {
        const bridge = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, JSON.stringify({ ...bridge, expiresAt: new Date(Date.now() + 60000).toISOString() })); response.end();
      })().catch(() => { response.writeHead(500); response.end(); }); return;
    }
    response.writeHead(404); response.end();
  });
  const websocket = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.headers.origin || request.url !== route) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    websocket.handleUpgrade(request, socket, head, connection => connection.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialize') { initializations++; connection.send(JSON.stringify({ id: message.id, result: { userAgent: 'loopback_fixture' } })); }
    }));
  });
  try {
    await fs.mkdir(sourceHome); await fs.mkdir(directory, { recursive: true });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const endpoint = 'ws://127.0.0.1:' + (server.address() as { port: number }).port + route;
    const proxyUrl = 'http://127.0.0.1:' + (proxy.address() as { port: number }).port;
    await fs.writeFile(file, JSON.stringify({ version: 1, endpoint, sourceHome, executable: 'unused.exe', pid: process.pid, approvalRoutingVersion: 1, expiresAt: new Date(0).toISOString() }));
    await fs.writeFile(path.join(parent, 'active.json'), JSON.stringify({ file, managed: true }));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/codex-loopback-client.ts', import.meta.url)), sourceHome, parent, endpoint], {
      windowsHide: true, timeout: 10000, env: { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' },
    });
    assert.equal(readiness, 1); assert.equal(renewals, 1); assert.equal(initializations, 1); assert.equal(proxyRequests, 0);
  } finally {
    for (const socket of websocket.clients) socket.terminate(); websocket.close();
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
