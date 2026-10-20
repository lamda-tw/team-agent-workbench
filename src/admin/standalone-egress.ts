import fs from 'node:fs/promises';
import path from 'node:path';
import { EgressRelay } from '../core/egress';
import { ReverseEgressTunnel } from './reverse-egress';
import { standaloneEgressSchema, type StandaloneEgressState } from './standalone-egress-state';

export class StandaloneEgress {
  private relay: EgressRelay;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private retrying = false;
  constructor(private state: StandaloneEgressState, private changed: () => void, readonly tunnel = new ReverseEgressTunnel()) {
    this.relay = new EgressRelay(state.config, state.secret, { ...state.certificate, pfx: Buffer.from(state.certificate.pfx, 'base64') });
    this.relay.on('changed', changed); tunnel.on('changed', changed);
  }
  snapshot() { return { running: this.relay.snapshot().running, reverse: this.state.reverse ? this.tunnel.snapshot().state : undefined, updatedAt: new Date().toISOString() }; }
  async start() {
    if (this.state.reverse && !this.state.reverse.password) throw new Error('安装时需提供反向隧道凭据');
    await this.relay.start();
    // Reuse the exact published remote port; never allocate a new invitation.
    if (this.state.reverse) {
      const { relayPort, ...options } = this.state.reverse;
      const host = this.state.config.listenHost;
      void this.tunnel.start({ ...options, password: options.password!, remotePort: relayPort, localHost: host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host, localPort: this.state.config.listenPort }).catch(() => {});
    }
    this.timer = setInterval(() => {
      this.changed();
      if (this.stopped || this.retrying || this.relay.snapshot().running) return;
      this.retrying = true;
      void this.relay.start().catch(() => {}).finally(() => { this.retrying = false; this.changed(); });
    }, 5000);
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.tunnel.stop(); await this.relay.stop(); }
}

export async function runStandaloneEgress(input: NodeJS.ReadableStream, directory: string) {
  let data = '', runtime: StandaloneEgress | undefined;
  for await (const chunk of input) { data += chunk.toString(); if (data.length > 4 * 1024 * 1024) throw new Error('配置过大'); }
  const state = standaloneEgressSchema.parse(JSON.parse(data)); data = '';
  // Public status contains neither credentials nor forwarded content.
  let writing = Promise.resolve();
  const publish = () => {
    const status = runtime?.snapshot(); if (!status) return;
    writing = writing.catch(() => {}).then(async () => {
      const pending = path.join(directory, 'status.pending.json');
      await fs.writeFile(pending, JSON.stringify(status)); await fs.rename(pending, path.join(directory, 'status.json'));
    }).catch(() => {});
  };
  runtime = new StandaloneEgress(state, publish);
  const stopWatcher = setInterval(() => { void fs.access(path.join(directory, 'stop.request')).then(async () => { clearInterval(stopWatcher); await runtime!.stop(); await writing; process.exit(0); }, () => {}); }, 1000);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void runtime!.stop().then(() => writing).finally(() => process.exit(0)); });
  try { await runtime.start(); publish(); } catch (error) { clearInterval(stopWatcher); await runtime.stop(); await writing; throw error; }
}
