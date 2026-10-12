export type McpConnectionState = 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled' | 'unknown';
export interface McpServerView {
  name: string; title: string; enabled: boolean; state: McpConnectionState;
  authStatus: string; source: string; canToggle: boolean;
  tools: { name: string; description: string }[];
  loginPending?: boolean; loginError?: string;
  canLogin?: boolean;
}
export interface McpCatalog { servers: McpServerView[]; checkedAt: string }
export interface McpServerInput {
  name: string; transport: 'http' | 'stdio'; url?: string; command?: string;
  args?: string[]; bearerTokenEnvVar?: string;
}
export type McpMutation = McpServerInput | { name: string; enabled: boolean } | { operation: 'remove'; name: string } | { operation: 'update'; server: McpServerInput };
