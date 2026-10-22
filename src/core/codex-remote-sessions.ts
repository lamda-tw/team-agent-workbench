import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeSelectionKey, type NativeSessionCatalog, type NativeSessionEntry, type NativeSessionGroup } from '../shared/native-sessions';
import type { AgentSession, Message } from '../shared/types';
import type { AgentRpc } from './rpc';
import { CodexSshRpc } from './codex-ssh-rpc';
import { mergeSharedThread } from './codex-live-thread';
import { codexAgentSources, codexOriginFields } from './codex-session-origin';

const exec = promisify(execFile);
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sshTarget = /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,254}$/;

export interface CodexSshHost { id: string; name: string; target: string; port?: number; identity?: string }
interface RemoteThread { id: string; name: string; cwd: string; projectId?: string; updatedAt: number; unavailable?: string; nativePath?: string; model?: string }
export interface CodexRemoteIndex { home?: string; sessions: RemoteThread[] }
export type CodexRemoteReader = (host: CodexSshHost) => Promise<CodexRemoteIndex>;

// Query metadata in place: no SQLite copies (which would lose WAL changes), no
// credentials, history writes, remote task execution or model requests.
const remoteQuery = String.raw`
import os, re, json, glob, sqlite3, pathlib
home = os.path.abspath(os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'))
indexes = glob.glob(os.path.join(home, 'state_*.sqlite'))
indexes = [p for p in indexes if re.fullmatch(r'state_\d+\.sqlite', os.path.basename(p))]
if not indexes:
    raise RuntimeError('Codex session index not found')
index = max(indexes, key=lambda p: int(re.search(r'state_(\d+)', p).group(1)))
db = sqlite3.connect(pathlib.Path(index).as_uri() + '?mode=ro', uri=True, timeout=2)
db.row_factory = sqlite3.Row
columns = {r[1] for r in db.execute('pragma table_info(threads)')}
fields = ['id', 'name', 'title', 'first_user_message', 'cwd', 'project_id', 'archived', 'recency_at_ms', 'updated_at_ms', 'updated_at', 'rollout_path', 'model'] + ${JSON.stringify(codexOriginFields)}
sql = 'select ' + ', '.join(('"' + k + '"') if k in columns else ('NULL AS "' + k + '"') for k in fields) + ' from threads'
rows = [dict(r) for r in db.execute(sql)]
edge_columns = {r[1] for r in db.execute('pragma table_info(thread_spawn_edges)')}
spawned = {r[0] for r in db.execute('select child_thread_id from thread_spawn_edges')} if 'child_thread_id' in edge_columns else set()
db.close()
agent_sources = ${JSON.stringify(codexAgentSources)}
def agent_source(value):
    if not value:
        return False
    if value.strip().lower() in agent_sources:
        return True
    try:
        parsed = json.loads(value)
        return (isinstance(parsed, str) and parsed.strip().lower() in agent_sources) or (isinstance(parsed, dict) and any(k in parsed for k in agent_sources))
    except (ValueError, TypeError):
        return False
records = {}
for folder in ['sessions', 'archived_sessions']:
    for root, dirs, files in os.walk(os.path.join(home, folder), followlinks=False):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for name in files:
            match = re.search(r'-([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$', name)
            if match:
                filename = os.path.join(root, name)
                if not os.path.islink(filename):
                    key = match.group(1).lower()
                    if key not in records or not name.endswith('.zst'):
                        records[key] = filename
sessions = []
for row in rows:
    if row['archived'] or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', row['id'] or ''):
        continue
    agent_path = (row['agent_path'] or '').strip()
    if row['id'] in spawned or agent_source(row['source']) or agent_source(row['thread_source']) or (row['agent_role'] or '').strip() or (row['agent_nickname'] or '').strip() or (agent_path and agent_path != '/root'):
        continue
    cwd = row['cwd'] or ''
    unavailable = None
    if row['id'].lower() not in records:
        unavailable = '原会话历史文件未找到'
    elif not cwd or not os.path.isdir(cwd):
        unavailable = '远程工作目录不存在'
    name = row['name'] or row['title'] or row['first_user_message'] or '未命名会话'
    name = ' '.join(name.strip().splitlines()[0].split())[:120] if name.strip() else '未命名会话'
    sessions.append(dict(id=row['id'], name=name, cwd=cwd, projectId=row['project_id'], updatedAt=row['recency_at_ms'] or row['updated_at_ms'] or (row['updated_at'] or 0)*1000, unavailable=unavailable, nativePath=records.get(row['id'].lower()), model=row['model']))
print('WORKBENCH_CODEX_CATALOG=' + json.dumps(dict(home=home, sessions=sessions), ensure_ascii=True))
`;

export function codexSshArgs(host: CodexSshHost, script = remoteQuery) {
  if (!sshTarget.test(host.target)) throw new Error('Codex SSH 主机配置无效');
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes'];
  if (host.port !== undefined) {
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('Codex SSH 端口无效');
    args.push('-p', String(host.port));
  }
  if (host.identity) {
    if (/[\x00-\x1f]/.test(host.identity)) throw new Error('Codex SSH 密钥路径无效');
    args.push('-i', host.identity);
  }
  // The script is constant and base64 encoded; no project path, thread name or
  // user-provided command is interpolated into the remote shell command.
  const encoded = Buffer.from(script).toString('base64');
  args.push(host.target, `python3 -c 'import base64;exec(base64.b64decode("${encoded}"))'`);
  return args;
}

export const queryCodexRemoteIndex: CodexRemoteReader = async host => {
  const { stdout } = await exec('ssh', codexSshArgs(host), { windowsHide: true, shell: false, timeout: 20000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const line = stdout.split(/\r?\n/).find(line => line.startsWith('WORKBENCH_CODEX_CATALOG='));
  if (!line) throw new Error('远程 Codex 未返回会话列表');
  const value = JSON.parse(line.slice('WORKBENCH_CODEX_CATALOG='.length));
  if (!Array.isArray(value.sessions)) throw new Error('远程 Codex 会话列表格式无效');
  return value;
};

function hostFor(project: Record<string, any>, desktop: Record<string, any>): CodexSshHost | undefined {
  const configs = Array.isArray(desktop['codex-managed-remote-connections']) ? desktop['codex-managed-remote-connections'] : [];
  const config = object(configs.find((value: any) => value?.hostId === project.hostId));
  const discovered = typeof project.hostId === 'string' && project.hostId.startsWith('remote-ssh-discovered:') ? project.hostId.slice('remote-ssh-discovered:'.length) : '';
  const target = typeof config.alias === 'string' && config.alias || typeof config.hostname === 'string' && config.hostname || discovered;
  if (!target || !sshTarget.test(target)) return;
  return { id: project.hostId, name: typeof config.displayName === 'string' && config.displayName || target, target,
    ...(config.sshPort != null ? { port: Number(config.sshPort) } : {}), ...(typeof config.identity === 'string' ? { identity: config.identity } : {}) };
}

export async function addCodexRemoteProjects(local: NativeSessionCatalog, home: string, read: CodexRemoteReader = queryCodexRemoteIndex, linked = new Map<string, string>()): Promise<NativeSessionCatalog> {
  let desktop: Record<string, any>;
  try { desktop = object(JSON.parse(await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8'))); }
  catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return local; throw error; }
  const projects = (Array.isArray(desktop['remote-projects']) ? desktop['remote-projects'] : []).map(object)
    .filter(project => typeof project.id === 'string' && project.id && typeof project.hostId === 'string' && project.hostId && typeof project.remotePath === 'string' && path.posix.isAbsolute(project.remotePath));
  if (!projects.length) return local;
  const hosts = new Map<string, CodexSshHost | undefined>();
  for (const project of projects) hosts.set(project.hostId, hostFor(project, desktop));
  const groups: NativeSessionGroup[] = [];
  const sessions: NativeSessionEntry[] = [];
  const assignments = object(desktop['thread-project-assignments']), memberships = object(desktop['thread-project-membership-host-ids']);
  const projectless = new Set(Array.isArray(desktop['projectless-thread-ids']) ? desktop['projectless-thread-ids'] : []);
  const remoteIds = new Set(Object.entries(assignments).filter(([, value]) => object(value).projectKind === 'remote').map(([id]) => id));
  const base = Math.max(0, ...local.groups.map(group => group.position)) + 1;
  for (const project of projects) groups.push({ id: JSON.stringify([project.hostId, project.id]), name: typeof project.label === 'string' && project.label.trim() || path.posix.basename(project.remotePath), kind: 'project', position: base + groups.length, hostId: project.hostId, hostName: hosts.get(project.hostId)?.name || project.hostId });
  const results = await Promise.allSettled([...hosts].map(async ([id, host]) => {
    if (!host) throw new Error('此 Codex 远程连接没有可用的 SSH 配置');
    return { id, host, index: await read(host) };
  }));
  for (const [index, result] of results.entries()) {
    const hostId = [...hosts.keys()][index], host = hosts.get(hostId);
    if (result.status === 'rejected') {
      const reason = String(result.reason?.message || result.reason);
      const message = /Permission denied|authentication/i.test(reason) ? 'SSH 登录未通过，请先在 Codex 桌面版连接此项目' : /Host key verification|REMOTE HOST IDENTIFICATION/i.test(reason) ? 'SSH 主机验证失败，请先在 Codex 桌面版核对连接' : '远程会话暂时读不了，请确认此项目可在 Codex 桌面版连接后刷新';
      for (const group of groups) if (group.hostId === hostId) group.error = message;
      continue;
    }
    const owned = projects.filter(project => project.hostId === hostId);
    for (const thread of result.value.index.sessions) {
      if (!uuid.test(thread.id) || typeof thread.name !== 'string' || typeof thread.cwd !== 'string') continue;
      const assignment = object(assignments[thread.id]);
      let project: Record<string, any> | undefined;
      if (Object.hasOwn(assignments, thread.id)) {
        if (assignment.projectKind === 'remote' && (assignment.hostId || memberships[thread.id]) === hostId) project = owned.find(project => project.id === assignment.projectId);
      } else {
        project = owned.find(project => project.id === thread.projectId);
        if (!project && !projectless.has(thread.id) && !memberships[thread.id]) {
          const matches = owned.filter(project => { const relative = path.posix.relative(project.remotePath, thread.cwd); return !relative || !path.posix.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'); });
          const longest = Math.max(-1, ...matches.map(project => project.remotePath.length));
          const deepest = matches.filter(project => project.remotePath.length === longest);
          if (deepest.length === 1) project = deepest[0];
        }
      }
      let groupId = project ? JSON.stringify([hostId, project.id]) : JSON.stringify([hostId, '__other__']);
      if (!groups.some(group => group.id === groupId)) groups.push({ id: groupId, name: '其他远程会话', kind: 'section', position: base + groups.length, hostId, hostName: host!.name });
      sessions.push({ nativeId: thread.id, name: thread.name.slice(0, 120), cwd: thread.cwd, updatedAt: Number(thread.updatedAt) || 0, groupId, hostId, hostName: host!.name, linkedSessionId: linked.get(nativeSelectionKey({ hostId, nativeId: thread.id })), ...(thread.unavailable ? { unavailable: thread.unavailable } : {}) });
    }
  }
  const localSessions = local.sessions.filter(session => !remoteIds.has(session.nativeId) && !memberships[session.nativeId]);
  return { ...local, groups: [...local.groups, ...groups], sessions: [...localSessions, ...sessions] };
}

const proxyScript = String.raw`
import os, sys, glob, shutil, socket
home = os.path.abspath(os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex'))
sock = os.path.join(home, 'app-server-control', 'app-server-control.sock')
if not os.path.exists(sock):
    sys.exit('Please connect this remote project in Codex first: native backend is unavailable')
candidates = []
if os.path.isdir('/proc'):
    for pid in os.listdir('/proc'):
        try:
            exe = os.readlink('/proc/' + pid + '/exe')
            if os.path.basename(exe) == 'codex' and exe not in candidates:
                candidates.append(exe)
        except OSError:
            pass
exe = next((p for p in candidates if os.path.isfile(p)), None) or shutil.which('codex')
if not exe:
    sys.exit('Native Codex executable not found; reconnect the project in Codex')
os.execv(exe, [exe, 'app-server', 'proxy', '--sock', sock])
`;

export interface RemoteImportSource {
  nativeId: string; name: string; cwd: string; nativePath: string; model?: string;
  remote: NonNullable<AgentSession['codexRemote']>; messages: Message[];
}
export interface CodexRemoteIntegration {
  resolve(hostId: string, ids: string[]): Promise<RemoteImportSource[]>;
  rpc(hostId: string): Promise<AgentRpc>;
  read(session: AgentSession): Promise<Message[]>;
}

export class CodexRemoteService implements CodexRemoteIntegration {
  constructor(private home: () => string, private readIndex: CodexRemoteReader = queryCodexRemoteIndex) {}
  private async host(id: string) {
    const desktop = object(JSON.parse(await fs.readFile(path.join(this.home(), '.codex-global-state.json'), 'utf8')));
    const projects = Array.isArray(desktop['remote-projects']) ? desktop['remote-projects'] : [];
    const project = projects.find((project: any) => project?.hostId === id);
    const host = project && hostFor(project, desktop);
    if (!host) throw new Error('原 Codex 远程项目或 SSH 配置已改变，请刷新后重试');
    return host;
  }
  async rpc(hostId: string) {
    const host = await this.host(hostId);
    return new CodexSshRpc(codexSshArgs(host, proxyScript), this.home());
  }
  private async initialize(rpc: AgentRpc) {
    await rpc.request('initialize', { clientInfo: { name: 'team_agent_workbench_remote_import', version: '1' }, capabilities: { experimentalApi: true } }, 20000);
    rpc.notify('initialized');
  }
  async resolve(hostId: string, ids: string[]): Promise<RemoteImportSource[]> {
    if (ids.some(id => !uuid.test(id))) throw new Error('原会话标识无效');
    const host = await this.host(hostId), index = await this.readIndex(host);
    const sources = ids.map(id => {
      const source = index.sessions.find(source => source.id.toLowerCase() === id.toLowerCase());
      if (!source || source.unavailable || !source.nativePath || !index.home || !path.posix.isAbsolute(source.cwd)) throw new Error(source?.unavailable || '找不到这条远程 Codex 会话，请刷新后重试');
      const relative = path.posix.relative(index.home, source.nativePath);
      if (!/^(sessions|archived_sessions)\//.test(relative) || relative.split('/').includes('..')) throw new Error('远程会话历史路径无效');
      return { nativeId: source.id, name: source.name, cwd: source.cwd, nativePath: source.nativePath, model: source.model || undefined,
        remote: { hostId, hostName: host.name, cwd: source.cwd, nativePath: source.nativePath, home: index.home }, messages: [] as Message[] };
    });
    const rpc = await this.rpc(hostId);
    try {
      await this.initialize(rpc);
      for (const source of sources) {
        const result = await rpc.request('thread/read', { threadId: source.nativeId, includeTurns: true }, 20000);
        if (result.thread?.id !== source.nativeId) throw new Error('远程后台返回了另一条会话，未导入');
        source.messages = mergeSharedThread([], result.thread);
      }
      return sources;
    } finally { await rpc.close(); }
  }
  async read(session: AgentSession) {
    if (!session.codexRemote || !session.nativeId) throw new Error('远程会话标识缺失');
    const rpc = await this.rpc(session.codexRemote.hostId);
    try {
      await this.initialize(rpc);
      const result = await rpc.request('thread/read', { threadId: session.nativeId, includeTurns: true }, 20000);
      if (result.thread?.id !== session.nativeId) throw new Error('远程后台返回了另一条会话');
      return mergeSharedThread(session.messages, result.thread);
    } finally { await rpc.close(); }
  }
}
