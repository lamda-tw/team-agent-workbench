import type { AgentSession, SessionNetworkRoute } from '../shared/types';

/** Check the execution identity, including cached runtimes and background summaries. */
export function assertPersonalRelay(route: SessionNetworkRoute | undefined, central: boolean | undefined,
  account: string | undefined, session?: Pick<AgentSession, 'relayAccount'>) {
  if (route !== 'management' || !central) return;
  if (!account) throw new Error('此网络方式经中央节点转发，请先连接中央节点');
  if (session?.relayAccount && session.relayAccount !== account) throw new Error('请登录此会话原来使用的中央账号，或在空闲时切换为本机直连');
}
