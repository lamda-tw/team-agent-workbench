import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentSession, PermissionIssue, PermissionMode, PermissionReport, Provider } from '../shared/types';
import { JsonRpc } from './rpc';
import { atomicJson } from './store';

const stamp = () => new Date().toISOString();
const scalar = (value: unknown, fallback = 'unknown') => typeof value === 'string' ? value.slice(0, 100) : fallback;
export function permissionIssue(value: unknown): PermissionIssue | undefined {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  if (/sandbox|沙盒|landlock|seatbelt|bwrap|CreateProcessAsUser|restricted token/i.test(message)) return { kind: 'sandbox', message: message.slice(0, 1500), at: stamp() };
  if (/denied by (?:policy|permissions)|blocked by (?:policy|permissions)|not allowed by|approval.*(?:disabled|never)|permissions? policy|allowedSandboxModes|allowedApprovalPolicies|权限策略|权限模式.*不允许/i.test(message)) return { kind: 'policy', message: message.slice(0, 1500), at: stamp() };
  if (/permission denied|access (?:is )?denied|EACCES|EPERM|read.only file system|拒绝访问|只读文件系统/i.test(message)) return { kind: 'filesystem', message: message.slice(0, 1500), at: stamp() };
}
export function codexPermissionParams(s: Pick<AgentSession, 'purpose' | 'permissionMode'>) {
  if (s.purpose === 'background') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only' };
  if (s.purpose === 'prepare' || s.permissionMode === 'full') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' };
  if (s.permissionMode === 'review') return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
  if (s.permissionMode === 'auto') return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' };
  return {};
}
export function cursorPermissionArgs(s: Pick<AgentSession, 'purpose' | 'permissionMode'>) {
  if (s.purpose === 'background') return ['acp'];
  if (s.purpose === 'work' && s.permissionMode === 'auto') throw new Error('当前 Cursor 接入方式暂不支持切换 Auto-review，请选择其他模式');
  return s.purpose === 'prepare' || s.permissionMode === 'full' ? ['--force', '--sandbox', 'disabled', 'acp'] : ['acp'];
}
export function codexPermissions(raw: any, source: PermissionReport['source'] = 'config', requirements?: any): PermissionReport {
  const c = raw?.config || raw || {}, sandbox = source === 'runtime' ? scalar(c.sandbox?.type) : scalar(c.sandbox_mode), policy = c.approvalPolicy ?? c.approval_policy, approval = scalar(policy, policy && typeof policy === 'object' ? 'granular' : 'unknown');
  const reviewer = scalar(c.approvalsReviewer ?? c.approvals_reviewer), warnings: string[] = [];
  if (['read-only', 'readOnly'].includes(sandbox)) warnings.push('当前只读：可分析资料，但不能按普通工具权限修改文件。');
  if (approval === 'never' && !['danger-full-access', 'dangerFullAccess'].includes(sandbox)) warnings.push('沙盒外操作被限制，且审批已关闭；受限操作可能直接失败，无法弹出授权请求。');
  if (['auto_review', 'guardian_subagent'].includes(reviewer)) warnings.push('当前由 Codex 自动审查批准请求；若需要自己审核，请选择“请求批准”。');
  if (sandbox === 'unknown' || approval === 'unknown') warnings.push('CLI 未返回完整权限信息；不能据此认定拥有完全权限。实际生效值将在会话启动后更新。');
  const modes: PermissionMode[] = ['inherit'];
  const r = requirements?.requirements;
  const accepts = (field: string, value: string) => !Array.isArray(r?.[field]) || r[field].includes(value);
  if (accepts('allowedSandboxModes', 'workspace-write') && accepts('allowedApprovalPolicies', 'on-request')) {
    if (accepts('allowedApprovalsReviewers', 'user')) modes.push('review');
    if (accepts('allowedApprovalsReviewers', 'auto_review')) modes.push('auto');
  }
  if (accepts('allowedSandboxModes', 'danger-full-access') && accepts('allowedApprovalPolicies', 'never') && accepts('allowedApprovalsReviewers', 'user')) modes.push('full');
  if (r && modes.length < 4) warnings.push('管理员策略限制了可选权限模式；工作台不能绕过该限制。');
  if (source === 'runtime' && c.sandbox?.networkAccess === false) warnings.push('沙盒内网络关闭；下载依赖等操作可能需要额外授权。');
  return { provider: 'codex', checkedAt: stamp(), source, sandbox, approval, reviewer, warnings, allowedModes: modes };
}
export function cursorConfigPaths(cwd: string) {
  const base = process.env.CURSOR_CONFIG_DIR || (process.platform !== 'win32' && process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor'));
  return [path.join(base, 'cli-config.json'), path.join(cwd, '.cursor', 'cli.json')];
}
export async function cursorPermissions(cwd: string): Promise<PermissionReport> {
  const files = cursorConfigPaths(cwd), warnings = ['Cursor ACP 未提供完整的沙盒执行自检接口；此处是配置检测，执行受限时会另行提示。'], configs: any[] = [];
  let readable = true;
  for (const file of files) {
    try { const info = await fs.stat(file); if (info.size > 1024 * 1024) throw new Error('配置文件过大'); const config = JSON.parse(await fs.readFile(file, 'utf8')); if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置格式无效'); configs.push(config); }
    catch (e: any) { configs.push({}); if (e.code !== 'ENOENT') { readable = false; warnings.push('无法读取 Cursor 权限配置：' + file); } }
  }
  const allow = configs.flatMap(c => Array.isArray(c.permissions?.allow) ? c.permissions.allow.filter((x: any) => typeof x === 'string') : []);
  const deny = configs.flatMap(c => Array.isArray(c.permissions?.deny) ? c.permissions.deny.filter((x: any) => typeof x === 'string') : []);
  const approval = readable ? scalar(configs[0].approvalMode, 'allowlist') : 'unknown', sandbox = scalar(configs[0].sandbox?.mode);
  if (approval !== 'allowlist') warnings.push('选择 Allowlist 时需先修改 Cursor 的批准设置。');
  if (allow.some(x => /^(Shell|Write)\(/.test(x))) warnings.push('配置中有允许执行或修改的白名单；这些操作可能不会请求人工授权。可在下方清除自动允许项。');
  if (deny.length) warnings.push('存在明确拒绝规则；即使选择 Run Everything，Cursor 仍可能拒绝匹配的操作。');
  return { provider: 'cursor', checkedAt: stamp(), source: 'config', sandbox, approval, warnings, allowedModes: ['inherit', 'review', 'full'], execution: 'unknown', cursorConfig: { files, allow: allow.slice(0, 300), deny: deny.slice(0, 300) } };
}
// This is an explicit UI action. Preserve unrelated settings and deny rules,
// back up exact originals, and refuse concurrent/symlink edits.
export async function setCursorManualReview(cwd: string) {
  const files = cursorConfigPaths(cwd);
  const edits: { file: string; raw?: string; config: any }[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i]; let raw: string | undefined, config: any = {};
    try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('不能修改此权限配置文件'); raw = await fs.readFile(file, 'utf8'); config = JSON.parse(raw); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (i === 1 && raw === undefined) continue;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Cursor 配置格式无效');
    config.permissions = { ...config.permissions, allow: [], deny: config.permissions?.deny || [] };
    if (i === 0) { config.version ??= 1; config.editor ??= { vimMode: false }; config.approvalMode = 'allowlist'; }
    edits.push({ file, raw, config });
  }
  // Validate both files before touching either, so malformed project settings
  // cannot cause an unnoticed partial change to the account-wide policy.
  for (const { file, raw, config } of edits) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (raw !== undefined) {
      await fs.writeFile(file + '.workbench-' + randomUUID() + '.bak', raw, { flag: 'wx', mode: 0o600 });
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || await fs.readFile(file, 'utf8') !== raw) throw new Error('配置已被其他程序修改，请重新检测');
      await atomicJson(file, config);
    } else await fs.writeFile(file, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  }
  return cursorPermissions(cwd);
}
export async function inspectPermissions(provider: Provider, executable: string, cwd: string, env: NodeJS.ProcessEnv = {}): Promise<PermissionReport> {
  if (provider === 'cursor') return cursorPermissions(cwd);
  if (provider === 'claude') return { provider, checkedAt: new Date().toISOString(), source: 'config', sandbox: 'claude-code', approval: 'inherit', warnings: ['实际权限由 Claude Code 的用户、项目和组织设置决定；会话启动时按所选模式运行。'] };
  const rpc = new JsonRpc(executable, ['app-server'], cwd, false, env), timeout = 8000;
  const timer = setTimeout(() => void rpc.close(), timeout + 1000);
  rpc.on('message', m => { if (m.id !== undefined) rpc.reject(m.id, '权限检测不执行 Agent 请求'); });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'team_agent_permissions', version: '0.6.3' } }, timeout); rpc.notify('initialized');
    const [config, requirements] = await Promise.allSettled([rpc.request('config/read', { cwd, includeLayers: false }, timeout), rpc.request('configRequirements/read', {}, timeout)]);
    const result = codexPermissions(config.status === 'fulfilled' ? config.value : {}, 'config', requirements.status === 'fulfilled' ? requirements.value : undefined);
    if (requirements.status === 'rejected') result.warnings.push('无法读取管理员约束，模式能否生效以 CLI 启动结果为准。');
    return result;
  } finally { clearTimeout(timer); await rpc.close(); }
}
export async function probeCodexCommand(rpc: JsonRpc, report: PermissionReport, cwd: string, sandbox: any) {
  if (!sandbox?.type || sandbox.type === 'externalSandbox') return;
  try {
    const command = process.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'echo WORKBENCH_PERMISSION_OK'] : ['/bin/sh', '-c', 'printf WORKBENCH_PERMISSION_OK'];
    const r = await rpc.request('command/exec', { command, cwd, sandboxPolicy: sandbox, timeoutMs: 5000, ...(process.platform === 'win32' ? {} : { outputBytesCap: 4096 }) }, 7000);
    report.execution = r.exitCode === 0 && String(r.stdout).includes('WORKBENCH_PERMISSION_OK') ? 'passed' : 'blocked';
    report.executionDetail = report.execution === 'passed' ? 'CLI 沙盒内的无副作用命令执行成功；这不代表所有目录、网络和命令均已获授权。' : String(r.stderr || r.stdout || '命令未执行成功').slice(0, 1200);
  } catch (e: any) { report.execution = permissionIssue(e) ? 'blocked' : 'unknown'; report.executionDetail = String(e.message).slice(0, 1200); }
}
