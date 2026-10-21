import type { Provider, ProviderAuth, SessionNetworkRoute } from '../shared/types';
import { JsonRpc, spawnCLI, stopCLI } from './rpc';
import { resolveProvider } from './providers';

export const authReady = (auth: ProviderAuth) => ['authenticated', 'configured', 'not-required'].includes(auth.status);
const state = (status: ProviderAuth['status'], detail: string): ProviderAuth => ({ status, detail });
const identityText = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 254 && !/[\x00-\x1f]/.test(value) ? value.trim() : undefined;
// Network diagnostics take precedence: some CLIs describe a failed network request as invalid auth.
export function authFailure(error: unknown): ProviderAuth {
  const message = error instanceof Error ? error.message : String(error);
  if (/workspace routing discovery timed out/i.test(message))
    return state('error', 'Codex 工作区路由发现超时（workspace routing discovery timed out）。请检查当前网络；这不表示账号未登录。');
  if (/certificate|tls|ssl|证书/i.test(message))
    return state('error', 'CLI 无法验证服务证书，请检查本机或所选出口的证书配置；这不表示账号未登录。');
  if (/network|fetch failed|error sending request|econn|enotfound|eai_again|dns|socket|proxy|timed? ?out|timeout|超时|网络/i.test(message))
    return state('error', '无法完成登录检测，请检查网络、代理或证书后重试；这不表示账号未登录。');
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|unauthorized|\b401\b|please (?:log|sign) in|authentication required|refresh_token_(?:expired|reused|invalidated)|token (?:has )?expired|invalid (?:access |refresh )?token|未登录|登录已过期/i.test(message))
    return state('unauthenticated', '尚未登录或登录已过期，请登录个人账号后重新检测。');
  return state('error', '无法确认登录状态，请检查 CLI 路径、版本和配置后重试。');
}
// Unlike account/read, this endpoint reads the native credential store without
// requiring workspace routing discovery. Never request tokens for a status check.
export function codexLocalAuth(result: any): ProviderAuth | undefined {
  if (typeof result?.requiresOpenaiAuth !== 'boolean') return;
  if (!result.requiresOpenaiAuth) return state('not-required', '当前 CLI 服务配置不要求 OpenAI 登录，将沿用该配置。');
  if (result.authMethod === 'chatgpt' || result.authMethod === 'chatgptAuthTokens')
    return { ...state('authenticated', '本机 Codex 已保存 ChatGPT 登录。模型服务连通性将在读取模型或执行任务时单独确认。'), verifiedLocally: true };
  if (result.authMethod === 'apikey')
    return { ...state('configured', '本机 Codex 已配置 API 凭据，尚未验证模型服务连通性。'), verifiedLocally: true };
  if (result.authMethod === null) return state('unauthenticated', '尚未登录 Codex，请先登录个人账号。');
}

export function codexLoginStatus(output: string, code: number | null): ProviderAuth | undefined {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (code === 0 && /^Logged in using ChatGPT\s*$/im.test(clean)) return codexLocalAuth({ requiresOpenaiAuth: true, authMethod: 'chatgpt' });
  if (code === 0 && /^Logged in using (?:an? )?API key\b/im.test(clean)) return codexLocalAuth({ requiresOpenaiAuth: true, authMethod: 'apikey' });
  if (code === 1 && /^Not logged in\s*$/im.test(clean)) return state('unauthenticated', '尚未登录 Codex，请先登录个人账号。');
}

async function inspectSavedCodexLogin(executable: string, cwd: string, signal: AbortSignal | undefined, timeout: number, env: NodeJS.ProcessEnv) {
  if (signal?.aborted) return;
  return new Promise<ProviderAuth | undefined>(resolve => {
    const child = spawnCLI(executable, ['login', 'status'], cwd, env);
    let output = '', settled = false;
    const finish = (auth?: ProviderAuth, stop = false) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stop) void stopCLI(child).then(() => resolve(auth)); else resolve(auth);
    };
    const abort = () => finish(undefined, true), timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const read = (data: Buffer) => { output += data.toString(); if (output.length > 65536) finish(undefined, true); };
    // Codex prints login status on stderr. Parse it in memory; never forward raw
    // output, which may include an API-key preview, to UI, logs or saved sessions.
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => finish()); child.on('close', code => finish(codexLoginStatus(output, code)));
    if (signal?.aborted) abort();
  });
}

const unsupportedAuthMethod = (error: any) => error?.code === -32601 || /method not found|unknown method|unsupported method/i.test(error?.message || '');
const transientAuthError = (error: unknown) => /network|fetch failed|error sending request|econn|enotfound|eai_again|dns|socket|proxy|certificate|tls|ssl|timed? ?out|timeout|超时|网络/i.test(error instanceof Error ? error.message : String(error));
export function codexAuth(result: any): ProviderAuth {
  if (!result || typeof result.requiresOpenaiAuth !== 'boolean') return state('error', 'CLI 返回了无法识别的认证状态，请检查版本后重试。');
  if (result.account?.type) return { ...state(result.account.type === 'chatgpt' ? 'authenticated' : 'configured', result.account.type === 'chatgpt' ? '正在使用 CLI 已登录的个人 ChatGPT 账号。' : '沿用 CLI 的认证凭据；此认证方式未提供个人账号身份。'), identity: result.account.type === 'chatgpt' ? identityText(result.account.email) : undefined, plan: identityText(result.account.planType) };
  if (!result.requiresOpenaiAuth) return state('not-required', '当前 CLI 服务配置不要求 OpenAI 登录，将沿用该配置。');
  return state('unauthenticated', '尚未登录 Codex，请先登录个人账号。');
}
export function cursorAuth(output: string, code: number | null, environmentCredential = false): ProviderAuth {
  let result: any;
  try { result = JSON.parse(output); } catch { return state('error', '无法读取 Cursor 登录状态，请使用支持 status --format json 的 Cursor Agent CLI。'); }
  if (code !== 0 || result.status === 'error') return authFailure(result.message || 'Status check failed');
  if (result.status === 'authenticated' && result.isAuthenticated === true)
    return { ...state('authenticated', /unable to fetch/i.test(result.message || '') ? 'CLI 已保存登录凭据，但当前无法读取在线账号信息；可检查网络后重新检测。' : '正在使用 CLI 已登录的个人 Cursor 账号。'), identity: identityText(result.userInfo?.email) };
  if (['unauthenticated', 'partially-authenticated'].includes(result.status) && result.isAuthenticated === false) {
    if (environmentCredential) return state('configured', '已配置 Cursor 环境变量凭据，尚未在线验证；实际服务可用性以任务结果为准。');
    return state('unauthenticated', result.status === 'partially-authenticated' ? 'Cursor 登录凭据不完整，请重新登录个人账号。' : '尚未登录 Cursor，请先登录个人账号。');
  }
  return state('error', 'CLI 返回了无法识别的认证状态，请检查版本后重试。');
}

export function claudeAuth(output: string, code: number | null, environmentCredential = false): ProviderAuth {
  let result: any;
  try { result = JSON.parse(output); } catch { return state('error', '无法读取 Claude Code 登录状态，请更新 CLI 后重试。'); }
  if (code === 0 && result?.loggedIn === true) return { ...state('authenticated', '正在使用本机 Claude Code 已登录的账号。'), identity: identityText(result.email), plan: identityText(result.subscriptionType) };
  if (code === 1 && result?.loggedIn === false) return environmentCredential ? state('configured', '已配置 Claude Code 环境凭据，尚未在线验证。') : state('unauthenticated', '尚未登录 Claude Code，请先登录个人账号。');
  return authFailure(result?.error || 'Claude Code auth status failed');
}

export async function inspectAuth(provider: Provider, executable: string, cwd: string, signal?: AbortSignal, timeout = 20000, env: NodeJS.ProcessEnv = {}): Promise<ProviderAuth> {
  if (signal?.aborted) return state('error', '登录检测已取消。');
  if (provider === 'codex') {
    const rpc = new JsonRpc(executable, ['app-server'], cwd, false, env);
    const abort = () => { void rpc.close(); }; signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
    let failure: unknown;
    try {
      await rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench_auth', version: '0.3.0' } }, timeout);
      rpc.notify('initialized');
      try {
        const result = codexLocalAuth(await rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }, timeout));
        if (result) return result;
      } catch (error) { if (!unsupportedAuthMethod(error)) throw error; }
      // Compatibility with versions that only expose the account API. This is a
      // read, never a forced refresh of the desktop app's shared login.
      return codexAuth(await rpc.request('account/read', { refreshToken: false }, timeout));
    } catch (error) { failure = timedOut ? new Error('timeout') : error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await rpc.close(); }
    if (signal?.aborted) return state('error', '登录检测已取消。');
    const failed = authFailure(failure);
    if (transientAuthError(failure)) {
      const saved = await inspectSavedCodexLogin(executable, cwd, signal, Math.min(timeout, 3000), env);
      if (signal?.aborted) return state('error', '登录检测已取消。');
      if (saved && authReady(saved)) return { ...saved, connectionIssue: failed.detail };
      if (saved?.status === 'unauthenticated') return saved;
    }
    return failed;
  }
  return new Promise(resolve => {
    const child = spawnCLI(executable, provider === 'claude' ? ['auth', 'status'] : ['status', '--format', 'json'], cwd, env);
    let output = '', settled = false;
    const finish = (auth: ProviderAuth, stop = false) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stop) void stopCLI(child).then(() => resolve(auth)); else resolve(auth);
    };
    const abort = () => finish(state('error', '登录检测已取消。'), true);
    const timer = setTimeout(() => finish(authFailure('timeout'), true), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 65536) finish(state('error', 'CLI 状态输出异常，请检查配置。'), true); });
    // Do not surface raw stderr, which may contain tokens or account data.
    child.stderr.resume();
    child.on('error', () => finish(state('error', '无法启动 CLI，请检查程序路径。')));
    child.on('close', code => finish(provider === 'claude' ? claudeAuth(output, code, Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_FOUNDRY)) : cursorAuth(output, code, Boolean(process.env.CURSOR_API_KEY || process.env.CURSOR_AUTH_TOKEN))));
  });
}

// Login URLs live only in memory. Never forward raw CLI login output into notices or session archives.
export function loginUrl(provider: Provider, output: string): string | undefined {
  for (const candidate of output.match(/https:\/\/[^\s<>"\x1b]+/g) || []) {
    try {
      const url = new URL(candidate);
      const allowed = provider === 'codex' ? ['auth.openai.com', 'auth0.openai.com'] : provider === 'claude' ? ['claude.ai', 'www.claude.ai', 'auth.anthropic.com', 'console.anthropic.com', 'platform.claude.com'] : ['cursor.com', 'www.cursor.com', 'authenticator.cursor.sh'];
      if (allowed.includes(url.hostname) && !url.username && !url.password) return url.href;
    } catch {}
  }
}

export class ProviderAccounts {
  states: Record<Provider, ProviderAuth> = { codex: state('unknown', '尚未检测登录状态'), cursor: state('unknown', '尚未检测登录状态'), claude: state('unknown', '尚未检测登录状态') };
  private jobs = new Map<string, { provider: Provider; key: string; controller: AbortController; promise: Promise<ProviderAuth> }>();
  private latest = new Map<Provider, string>();
  private logins = new Map<Provider, () => void>();
  private stopping = new Set<Promise<void>>();
  private closed = false;
  constructor(private configuredPath: (p: Provider) => string, private changed: () => void, private loggedIn: (p: Provider) => void = () => {}, private environment: (route?: SessionNetworkRoute) => NodeJS.ProcessEnv = () => ({})) {}
  private set(provider: Provider, auth: ProviderAuth) { this.states[provider] = auth; if (!this.closed) this.changed(); return auth; }
  async check(provider: Provider, cwd: string, route?: SessionNetworkRoute): Promise<ProviderAuth> {
    if (this.closed) return state('error', '工作台正在关闭');
    if (this.logins.has(provider)) return this.states[provider];
    const configured = this.configuredPath(provider), key = JSON.stringify([provider, configured, cwd, route]);
    const previous = this.jobs.get(key); if (previous) return previous.promise;
    // A background preparation has a different cwd. Its check must not cancel a working session.
    this.latest.set(provider, key);
    const controller = new AbortController();
    this.set(provider, { ...state('checking', '正在检测登录状态…'), cwd, networkRoute: route });
    const job = { provider, key, controller, promise: Promise.resolve(this.states[provider]) };
    this.jobs.set(key, job);
    job.promise = (async () => {
      let result: ProviderAuth;
      try { result = await inspectAuth(provider, await resolveProvider(provider, configured), cwd, controller.signal, 20000, this.environment(route)); }
      catch { result = state('error', '无法启动 CLI，请检查程序路径和安装状态。'); }
      if (controller.signal.aborted || this.configuredPath(provider) !== configured) return state('error', 'CLI 配置或工作目录已改变，请重新检测。');
      result = { ...result, cwd, checkedAt: new Date().toISOString(), networkRoute: route };
      if (this.jobs.get(key) === job && this.latest.get(provider) === key && !this.closed && this.configuredPath(provider) === configured) this.set(provider, result);
      return result;
    })().finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); });
    return job.promise;
  }
  private cancelChecks(provider: Provider) { for (const [key, job] of this.jobs) if (job.provider === provider) { job.controller.abort(); this.jobs.delete(key); } this.latest.delete(provider); }
  invalidate(provider: Provider) {
    this.cancelChecks(provider);
    this.logins.get(provider)?.();
    this.set(provider, state('unknown', 'CLI 配置已改变，请重新检测登录状态。'));
  }
  failed(provider: Provider, error: unknown, cwd: string, route?: SessionNetworkRoute) {
    const auth = authFailure(error);
    if (auth.status === 'unauthenticated') { this.cancelChecks(provider); this.set(provider, { ...auth, cwd, checkedAt: new Date().toISOString(), networkRoute: route }); }
  }
  async login(provider: Provider, cwd: string, route?: SessionNetworkRoute) {
    if (this.closed || this.logins.has(provider)) return;
    this.cancelChecks(provider);
    // Reserve synchronously so repeated clicks cannot start competing browser flows.
    let canceled = false;
    const reservation = () => { canceled = true; this.logins.delete(provider); if (!this.closed) this.set(provider, { ...state('unknown', '登录已取消，可重新登录或检测。'), networkRoute: route }); };
    this.logins.set(provider, reservation);
    this.set(provider, { ...state('logging-in', '请在 CLI 打开的浏览器中完成登录；完成后会自动重新检测。'), cwd, networkRoute: route });
    let executable: string;
    try { executable = await resolveProvider(provider, this.configuredPath(provider)); }
    catch { reservation(); this.set(provider, state('error', '无法启动 CLI，请检查程序路径。')); return; }
    if (canceled || this.closed) return;
    const child = spawnCLI(executable, provider === 'claude' ? ['auth', 'login'] : ['login'], cwd, this.environment(route)); let output = '', settled = false;
    const finish = (kind: 'exit' | 'cancel' | 'timeout' | 'error', code?: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); this.logins.delete(provider);
      if (kind !== 'exit') { const stopped = stopCLI(child); this.stopping.add(stopped); void stopped.finally(() => this.stopping.delete(stopped)); }
      if (this.closed) return;
      if (kind === 'exit' && code === 0) { this.loggedIn(provider); void this.check(provider, cwd, route); }
      else this.set(provider, { ...state(kind === 'cancel' ? 'unknown' : 'error', kind === 'cancel' ? '登录已取消，可重新登录或检测。' : kind === 'timeout' ? '登录等待超时，可重新登录或检测。' : '登录未完成，请检查浏览器授权和网络后重试。'), cwd, networkRoute: route });
    };
    const timer = setTimeout(() => finish('timeout'), 5 * 60 * 1000);
    this.logins.set(provider, () => finish('cancel'));
    const read = (data: Buffer) => {
      output = (output + data.toString()).slice(-16000);
      const url = loginUrl(provider, output);
      if (url && !settled) this.set(provider, { ...this.states[provider], loginUrl: url });
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => finish('error')); child.on('close', code => finish('exit', code));
  }
  cancel(provider: Provider) { this.logins.get(provider)?.(); }
  async close() {
    this.closed = true;
    const jobs = [...this.jobs.values()]; for (const job of jobs) job.controller.abort();
    for (const cancel of this.logins.values()) cancel();
    await Promise.all([...jobs.map(job => job.promise), ...this.stopping]);
  }
}
