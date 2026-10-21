import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { adminProfileSchema, type AdminProfile } from './types';

export function isAdminWindowSource(value: string | undefined, entry: string) {
  try {
    const url = new URL(value || '');
    if (url.protocol !== 'file:' || url.search || url.hash) return false;
    const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    return normalize(fileURLToPath(url)) === normalize(entry);
  } catch { return false; }
}

export function adminNodeKey(profile: AdminProfile) {
  if (profile.mode === 'local') {
    const root = path.resolve(profile.localRoot || '');
    return JSON.stringify(['local', process.platform === 'win32' ? root.toLowerCase() : root]);
  }
  return JSON.stringify(['ssh', profile.host.trim().toLowerCase(), profile.port, profile.username.trim(), path.posix.normalize(profile.root)]);
}

export function adminNodeLabel(profile?: AdminProfile) {
  return !profile ? '未连接中央节点' : profile.mode === 'local' ? `本地 · ${profile.localRoot}` : `${profile.username}@${profile.host}:${profile.port}`;
}

async function portAvailable(port: number) {
  const server = net.createServer();
  return new Promise<boolean>(resolve => {
    server.once('error', () => resolve(false));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// Slot 1 keeps the original data directory and credentials intact. Later slots
// have their own connection, certificate, access code and reverse-tunnel files.
export class AdminWindowStore {
  private active = new Set<number>();
  private bindings = new Map<number, AdminProfile>();
  private ports = new Map<number, number>();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, private available = portAvailable) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.catch(() => {}).then(operation); this.operations = task; return task;
  }
  directory(slot: number) {
    if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('管理窗口标识无效');
    return slot === 1 ? this.root : path.join(this.root, 'nodes', String(slot));
  }
  async slots() {
    const names = await fs.readdir(path.join(this.root, 'nodes')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
    return [1, ...names.filter(name => /^[2-9]\d*$|^1\d+$/.test(name)).map(Number).filter(Number.isSafeInteger)].sort((a, b) => a - b);
  }
  async profile(slot: number) {
    const inMemory = this.bindings.get(slot); if (inMemory) return inMemory;
    try { return adminProfileSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory(slot), 'connection.json'), 'utf8'))); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw new Error('中央节点连接记录无法读取，请检查本机管理端数据'); }
  }
  async find(profile: AdminProfile) {
    const key = adminNodeKey(profile);
    for (const slot of new Set([...await this.slots(), ...this.active])) {
      const candidate = await this.profile(slot);
      if (candidate && adminNodeKey(candidate) === key) return slot;
    }
  }
  claim(preferred?: number, fresh = false) { return this.serial(() => this.claimSlot(preferred, fresh)); }
  private async claimSlot(preferred?: number, fresh = false) {
    const slots = await this.slots();
    let slot = preferred;
    if (slot !== undefined && this.active.has(slot)) throw new Error('此中央节点窗口已打开');
    if (slot === undefined && !fresh) slot = slots.find(value => !this.active.has(value));
    if (slot === undefined) slot = Math.max(0, ...slots, ...this.active) + 1;
    this.directory(slot); this.active.add(slot);
    try { await fs.mkdir(this.directory(slot), { recursive: true }); } catch (error) { this.active.delete(slot); throw error; }
    return slot;
  }
  saveProfile(slot: number, profile: AdminProfile) { return this.serial(() => this.writeProfile(slot, profile)); }
  private async writeProfile(slot: number, profile: AdminProfile) {
    profile = adminProfileSchema.parse(profile);
    const previous = await this.profile(slot);
    if (previous && adminNodeKey(previous) !== adminNodeKey(profile)) throw new Error('不同中央节点必须使用独立窗口');
    const file = path.join(this.directory(slot), 'connection.json'), pending = file + '.pending';
    await fs.writeFile(pending, JSON.stringify(profile, null, 2)); await fs.rename(pending, file);
    this.bindings.set(slot, profile);
  }
  release(slot: number) { this.active.delete(slot); }
  defaultPort(slot: number) { return this.serial(() => this.allocatePort(slot)); }
  private async allocatePort(slot: number) {
    if (this.ports.has(slot)) return this.ports.get(slot)!;
    const used = new Set(this.ports.values());
    for (const other of await this.slots()) {
      try {
        const config = JSON.parse(await fs.readFile(path.join(this.directory(other), 'egress.json'), 'utf8'));
        if (Number.isInteger(config.listenPort)) {
          if (other === slot) { this.ports.set(slot, config.listenPort); return config.listenPort; }
          used.add(config.listenPort);
        }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    for (let port = 18443; port <= 65535; port++) {
      if (!used.has(port) && await this.available(port)) { this.ports.set(slot, port); return port; }
    }
    throw new Error('没有可用的管理端转发端口');
  }
  reservePort(slot: number, port: number) { return this.serial(() => this.keepPort(slot, port)); }
  private async keepPort(slot: number, port: number) {
    this.directory(slot);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('出口端口无效');
    for (const other of new Set([...await this.slots(), ...this.ports.keys()])) {
      if (other === slot) continue;
      let reserved = this.ports.get(other);
      if (reserved === undefined) {
        try { reserved = JSON.parse(await fs.readFile(path.join(this.directory(other), 'egress.json'), 'utf8')).listenPort; }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      if (reserved === port) throw new Error(`端口 ${port} 已分配给另一中央节点，请使用其他端口`);
    }
    this.ports.set(slot, port);
  }
}
