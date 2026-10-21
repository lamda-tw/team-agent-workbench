import type { Provider, ProviderAuth, ProviderCatalog, SessionNetworkRoute } from '../shared/types';
import type { UserEgressStatus } from '../shared/egress';

export interface ProviderConnectionCheck { auth: ProviderAuth; catalog?: ProviderCatalog; issues: string[] }
type Call = <T = unknown>(action: string, payload?: unknown) => Promise<T>;

export async function checkProviderConnection(call: Call, provider: Provider, cwd: string, configuration?: { enabled: boolean; viaSharedServer?: boolean; inviteCode?: string }, isCurrent = () => true, networkRoute?: SessionNetworkRoute): Promise<ProviderConnectionCheck> {
  const current = () => { if (!isCurrent()) throw new Error('检测范围已改变，请查看当前会话的最新状态'); };
  // A rejected configuration must not be reported as a successful switch.
  if (configuration) await call('egress.configure', configuration);
  current();
  const issues: string[] = [];
  let reachable = true;
  try { const network = await call<UserEgressStatus>('egress.test', networkRoute ? { networkRoute } : undefined); reachable = !network.enabled || network.available === true; }
  catch (error: any) { reachable = false; issues.push('网络出口检测失败：' + error.message); }
  current();
  await call('providers.detect');
  current();
  const auth = await call<ProviderAuth>('provider.auth', { provider, cwd, ...(networkRoute ? { networkRoute } : {}) });
  current();
  let catalog: ProviderCatalog | undefined;
  if (reachable && !auth.connectionIssue && ['authenticated', 'configured', 'not-required'].includes(auth.status)) {
    try { catalog = await call<ProviderCatalog>('provider.catalog', { provider, cwd, ...(networkRoute ? { networkRoute } : {}) }); if (catalog.modelError) issues.push('模型读取失败：' + catalog.modelError); }
    catch (error: any) { issues.push('模型与额度读取失败：' + error.message); }
  }
  current();
  return { auth, catalog, issues };
}
