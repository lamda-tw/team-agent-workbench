export type EgressUpstreamMode = 'direct' | 'http' | 'socks5';

export interface AdminEgressConfig {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  publicHost: string;
  upstreamMode: EgressUpstreamMode;
  upstreamHost: string;
  upstreamPort: number;
  upstreamUsername: string;
  codex: boolean;
  cursor: boolean;
  claude: boolean;
}

export interface EgressConnectionEvent {
  id: string;
  at: string;
  username: string;
  provider: 'codex' | 'cursor' | 'claude' | 'control';
  target: string;
  status: 'connected' | 'closed' | 'rejected' | 'error';
  bytesUp: number;
  bytesDown: number;
  detail?: string;
  clientAddress?: string;
  endedAt?: string;
}

export interface EgressTrafficSample {
  at: string;
  upPerSecond: number;
  downPerSecond: number;
}

export interface EgressMonitor {
  startedAt: string;
  sampledAt: string;
  bytesUp: number;
  bytesDown: number;
  upPerSecond: number;
  downPerSecond: number;
  connections: number;
  failures: number;
  rejections: number;
  activeTunnels: number;
  members: { username: string; address: string; connections: number; bytesUp: number; bytesDown: number; targets: string[] }[];
  history: EgressTrafficSample[];
  cliReports: import('./cli-connection').CliConnectionReport[];
  process?: { pid: number; cpuPercent: number; memoryBytes: number; heapBytes: number };
}

export type EgressRelaySnapshot = { running: boolean; activeConnections: number; lastError?: string; events: EgressConnectionEvent[]; fingerprint: string; monitor?: EgressMonitor };

export interface AdminEgressSnapshot {
  standalone?: boolean;
  config: AdminEgressConfig;
  running: boolean;
  fingerprint: string;
  inviteCode: string;
  hasUpstreamPassword: boolean;
  activeConnections: number;
  lastError?: string;
  events: EgressConnectionEvent[];
  monitor?: EgressMonitor;
  reverse?: ReverseEgressSnapshot;
}

export interface SharedServerRoute {
  host: string;
  port: number;
  fingerprint: string;
  relayPort: number;
}
export interface ReverseEgressSnapshot {
  enabled: boolean;
  state: 'disabled' | 'waiting-login' | 'paused' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  detail: string;
  server?: string;
  remotePort?: number;
  activeConnections: number;
  reconnects: number;
  bytesUp: number;
  bytesDown: number;
  memberAccessConfigured?: boolean;
}

export interface UserEgressSettings {
  enabled: boolean;
  viaSharedServer?: boolean;
  sharedServer?: SharedServerRoute;
  host: string;
  port: number;
  certificateFingerprint: string;
}

export interface UserEgressStatus {
  enabled: boolean;
  viaSharedServer?: boolean;
  configured: boolean;
  running: boolean;
  available?: boolean;
  endpoint?: string;
  checkedAt?: string;
  detail: string;
  hasAccessCode: boolean;
}

export type EgressInvite = {
  host: string;
  port: number;
  fingerprint: string;
  accessCode: string;
} & ({ version: 1 } | { version: 2; sharedServer: SharedServerRoute });
