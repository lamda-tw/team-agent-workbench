import { Duplex } from 'node:stream';
import { Agent } from 'node:http';
import type { Socket } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnCLI, stopCLI } from './rpc';
import { WebSocketRpc } from './websocket-rpc';

/** Native Codex proxy carries WebSocket frames, not newline JSON, over SSH. */
export class CodexSshRpc extends WebSocketRpc {
  private proxy?: ChildProcessWithoutNullStreams;
  constructor(args: string[], cwd: string, executable = 'ssh') {
    const agent = new Agent({ keepAlive: false });
    super('ws://codex-app-server/rpc', {
      agent,
      headers: { 'x-codex-websocket-max-unfragmented-message-bytes': String(16 * 1024 * 1024) },
    });
    agent.createConnection = () => {
        const child = this.proxy = spawnCLI(executable, args, cwd);
        const stream = new Duplex({
          read() { child.stdout.resume(); },
          write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
          final(callback) { child.stdin.end(callback); },
          destroy(error, callback) { child.stdin.destroy(); child.stdout.destroy(); callback(error); },
        });
        child.stdout.on('data', chunk => { if (!stream.push(chunk)) child.stdout.pause(); });
        child.stdout.on('end', () => stream.push(null));
        child.stdin.on('error', error => stream.destroy(error));
        child.stderr.on('data', data => this.emit('diagnostic', data.toString()));
        child.on('error', error => stream.destroy(error));
        child.on('exit', () => stream.destroy());
        Object.assign(stream, { setTimeout: () => stream, setNoDelay: () => stream, setKeepAlive: () => stream });
        return stream as Socket;
    };
  }
  async close() {
    await super.close();
    if (this.proxy) { const child = this.proxy; this.proxy = undefined; await stopCLI(child); }
  }
}
