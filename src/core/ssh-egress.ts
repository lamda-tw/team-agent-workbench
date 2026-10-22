import type { Client, ClientChannel } from 'ssh2';

const disconnectWatchers = new WeakMap<Client, { callbacks: Set<() => void>; notify: () => void }>();
function onDisconnect(client: Client, callback: () => void) {
  let entry = disconnectWatchers.get(client);
  if (!entry) {
    const callbacks = new Set<() => void>();
    entry = { callbacks, notify: () => { for (const notify of [...callbacks]) notify(); } };
    disconnectWatchers.set(client, entry); client.on('close', entry.notify); client.on('error', entry.notify);
  }
  entry.callbacks.add(callback);
  return () => {
    entry.callbacks.delete(callback);
    if (!entry.callbacks.size) { client.off('close', entry.notify); client.off('error', entry.notify); disconnectWatchers.delete(client); }
  };
}

// Only the pinned admin gateway is requested by the caller. The SSH server also
// enforces its root-owned PermitOpen list; this is not a general-purpose proxy.
export function forwardEgress(client: Client, host: string, port: number, signal: AbortSignal): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('中转连接已取消'));
    let settled = false;
    const finish = (error?: Error, channel?: ClientChannel) => {
      if (settled) { channel?.destroy(); return; }
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); unsubscribe();
      if (error) reject(error); else {
        channel!.on('error', () => channel!.destroy());
        const unwatch = onDisconnect(client, () => channel!.destroy());
        channel!.once('close', unwatch);
        resolve(channel!);
      }
    };
    const cancel = () => finish(new Error('中转连接已取消'));
    const closed = () => finish(new Error('中央节点连接已断开，请重新连接'));
    const timer = setTimeout(() => finish(new Error('共享服务器连接管理端超时，请检查中转地址和网络')), 15000);
    signal.addEventListener('abort', cancel, { once: true }); const unsubscribe = onDisconnect(client, closed);
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
        if (error) finish(new Error((error as Error & { reason?: number }).reason === 1
          ? '共享服务器未允许此管理端中转，请管理员在“网络出口”启用后重新登录'
          : '共享服务器无法连接管理端，请检查允许的地址、端口和管理端出口是否运行'));
        else finish(undefined, channel);
      });
    } catch { finish(new Error('共享服务器连接不可用，请重新登录')); }
  });
}
