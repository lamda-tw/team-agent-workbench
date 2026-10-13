import { JsonRpc, type AgentRpc } from './rpc';

type Credential = { type: 'apiKey'; apiKey: string } | { type: 'chatgptAuthTokens'; accessToken: string; chatgptAccountId: string; chatgptPlanType?: string };

// Personal Codex owns login and token refresh. The isolated runtime only receives
// access credentials in memory; refresh tokens never enter workbench storage or events.
export class CodexAuthBridge {
  private source?: JsonRpc;
  private accountId?: string;
  private closed = false;
  private closeOperation?: Promise<void>;
  constructor(private executable: string, private cwd: string, private sourceHome: string, private networkEnv: NodeJS.ProcessEnv = {}) {}
  private async credential(): Promise<Credential | undefined> {
    if (this.closed) throw new Error('登录连接已关闭');
    if (!this.source) {
      this.source = new JsonRpc(this.executable, ['app-server'], this.cwd, false, { ...this.networkEnv, CODEX_HOME: this.sourceHome });
      this.source.on('message', m => { if (m.id !== undefined) this.source?.reject(m.id, '登录检测不执行操作'); });
      await this.source.request('initialize', { clientInfo: { name: 'team_agent_account_bridge', version: '0.7.0' } }); this.source.notify('initialized');
    }
    const auth = await this.source.request('getAuthStatus', { includeToken: true, refreshToken: true }, 15000);
    if (auth.requiresOpenaiAuth === false) return undefined;
    if (!auth.authToken) throw new Error('尚未登录或登录已过期，请登录个人 Codex 账号后重试');
    if (auth.authMethod === 'apikey') return { type: 'apiKey', apiKey: auth.authToken };
    if (!['chatgpt', 'chatgptAuthTokens'].includes(auth.authMethod)) throw new Error('当前 Codex 登录方式暂不支持独立会话存储');
    let claims: any;
    try { claims = JSON.parse(Buffer.from(auth.authToken.split('.')[1], 'base64url').toString('utf8'))['https://api.openai.com/auth']; } catch {}
    if (typeof claims?.chatgpt_account_id !== 'string' || !claims.chatgpt_account_id) throw new Error('无法确认个人 Codex 账号，请重新登录后重试');
    if (this.accountId && this.accountId !== claims.chatgpt_account_id) throw new Error('个人 Codex 账号已切换，请重新打开此会话后继续');
    this.accountId = claims.chatgpt_account_id;
    return { type: 'chatgptAuthTokens', accessToken: auth.authToken, chatgptAccountId: this.accountId!, ...(typeof claims.chatgpt_plan_type === 'string' ? { chatgptPlanType: claims.chatgpt_plan_type } : {}) };
  }
  async login(runtime: AgentRpc) {
    try { const credential = await this.credential(); if (credential) await runtime.request('account/login/start', credential, 15000); }
    catch { throw new Error('无法沿用个人 Codex 登录，请检查登录状态和网络后重试'); }
  }
  async configuration(method: 'config/read' | 'config/value/write' | 'skills/config/write', params: unknown) {
    if (!this.source) await this.credential();
    if (!this.source || this.closed) throw new Error('个人 Codex 配置连接已关闭');
    return this.source.request(method, params, 20000);
  }
  async refresh(runtime: AgentRpc, requestId: string | number) {
    try {
      const credential = await this.credential();
      if (credential?.type !== 'chatgptAuthTokens') throw new Error('No ChatGPT credential');
      const { type, ...tokens } = credential; runtime.respond(requestId, tokens);
    } catch { try { runtime.reject(requestId, '无法刷新个人 Codex 登录，请重新登录后继续'); } catch { /* The user may have stopped the runtime during refresh. */ } }
  }
  close() {
    this.closed = true;
    if (this.closeOperation) return this.closeOperation;
    const source = this.source; this.source = undefined;
    return this.closeOperation = source?.close() || Promise.resolve();
  }
}
