import { assertPersonalRelay } from '../core/personal-relay';
import { PERSONAL_PROJECT_ID, isPersonalBinding } from '../shared/personal-workspace';
import { newAccountPasswordSchema } from '../shared/accounts';
import { clientWindowTitle } from '../shared/client-version';
import { preparationCategoriesSchema } from '../shared/result-rules';
import { resultStatusSchema } from '../shared/result-model';
import { ownDataDirectory } from '../shared/single-instance';
import { runtimeAssets } from '../shared/runtime-assets';
import { draftDeleteIdsSchema } from '../shared/draft-delete';
import { preparationDirectionsSchema } from '../shared/preparation-directions';
import { contentDeleteSelectionsSchema, contentEditSchema, contributionCategorySchema, resultReferenceSchema } from '../shared/content';
import { errorMessage } from '../shared/errors';
import { app, BrowserWindow, Notification, ipcMain, dialog, shell, clipboard, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { serverIdentityKey } from '../shared/server-identity';
import { Workbench } from '../core/workbench';
import { CodexDesktopService } from '../core/codex-desktop-service';
import { mcpServerInputSchema } from '../core/codex-mcp';
import { SharedFiles } from '../core/shared-files';
import { atomicJson } from '../core/store';
import { AccountWorkspacePool, migrateAccountWorkspace } from '../core/account-workspaces';
import { accountIdentity } from '../shared/account-data';
import { scopeAccountSnapshot } from '../shared/account-scope';
import { settingsSchema, profileSchema } from '../core/config';
import { historyMarkdown, packageDraft, freezeFile } from '../core/artifacts';
import { safeFilename } from '../core/paths';
import type { WorkbenchEvent } from '../shared/types';
import { projectBriefSchema } from '../shared/project-brief';
import { projectOrganizationSchema } from '../shared/project-organization';
import { assignmentAllFiles, assignmentCreateSchema, assignmentStatusSchema } from '../shared/assignments';
import { checkedSessionFile, listSessionFiles, previewSessionFile } from '../core/session-files';
import { ServerIdentityStore } from '../core/server-identities';
import { EgressClientProxy } from '../core/egress';
import { decodeEgressInvite, userEgressInputSchema } from '../core/egress-config';
import { taskbarAttention, taskbarShouldAlert, type TaskbarAttention } from '../shared/taskbar-attention';
import { planExecuteSchema, planReviseSchema } from '../shared/session-mode';
type DataContext = { workbench: Workbench; egress: EgressClientProxy; egressSecretFile: string; broadcast: () => void; notice: (message: string) => void };
type SidebarPanes = { workgroups?: number; files?: number; sessions?: number };
type WindowContext = DataContext & { slot: number; sidebarProjectHeight?: number; sidebarPanes?: SidebarPanes; release: () => Promise<void> };
const windows = new Set<BrowserWindow>(), contexts = new Map<BrowserWindow, WindowContext>(), activeSlots = new Set<number>(), closingWindows = new Set<BrowserWindow>();
const taskbarSeen = new WeakMap<BrowserWindow, TaskbarAttention>();
const switchingWindows = new Set<BrowserWindow>();
let accountRouting: Promise<unknown> = Promise.resolve();
function routeAccount<T>(operation: () => Promise<T>): Promise<T> { const next = accountRouting.catch(() => {}).then(operation); accountRouting = next; return next; }
let quitting = false; let closing = false; let windowsReady = false; let openingWindow = false;
let sharedServerEndpoint: { host: string; port: number } | undefined;
const pendingWindowRequests: boolean[] = [];
const entry = path.join(__dirname, runtimeAssets, 'index.html');
app.setName('Team Agent User');
if (process.platform === 'win32') app.setAppUserModelId('local.teamagent.user');
app.setPath('userData', process.env.WORKBENCH_DATA_DIR || path.join(app.getPath('appData'), 'TeamAgentUser'));
const serverIdentities = new ServerIdentityStore(path.join(app.getPath('userData'), 'server-identities.json'));
const accountWorkspaces = new AccountWorkspacePool<DataContext>(async (profile, seedRoot) => createDataContext(await migrateAccountWorkspace(app.getPath('userData'), profile, seedRoot)), async context => { await context.workbench.close(); await context.egress.stop(); });
async function syncServerIdentities(clearKey?: string) {
  const identities = serverIdentities.snapshot();
  await Promise.all([...new Map([...contexts.values()].map(context => [context.workbench, context])).values()].map(async context => {
    const settings = context.workbench.store.settings;
    settings.trustedServerIdentities = { ...identities };
    if (clearKey) {
      if (context.workbench.remote.profile && serverIdentityKey(context.workbench.remote.profile.host, context.workbench.remote.profile.port) === clearKey) context.workbench.remote.disconnect();
      settings.connections = settings.connections.map(profile => serverIdentityKey(profile.host, profile.port) === clearKey ? { ...profile, fingerprint: '' } : profile);
      if (settings.workspaceSnapshot && serverIdentityKey(settings.workspaceSnapshot.profile.host, settings.workspaceSnapshot.profile.port) === clearKey) settings.workspaceSnapshot.profile.fingerprint = '';
    }
    await context.workbench.store.save(); context.broadcast();
  }));
}
const personalWindows = new Set<BrowserWindow>();
let personalContext: DataContext | undefined;
let personalRelay: DataContext | undefined;
function actionContext(action: string, raw: any, owner: BrowserWindow, preferPersonal = false): DataContext {
  const team = contexts.get(owner)!;
  preferPersonal ||= personalWindows.has(owner);
  if (!personalContext || action === 'snapshot' || action === 'workspace.select' || action === 'layout.sidebar' || action.startsWith('account.') || action === 'local.move' || /^(remote\.|group\.|project\.|assignment\.|question\.|rsi\.|content\.|window\.)/.test(action)) return team;
  if (action.startsWith('local.')) return personalContext;
  if (Array.isArray(raw?.ids)) { const localIds = new Set([...personalContext.workbench.store.sessions, ...personalContext.workbench.store.drafts].map(item => item.id)); if (raw.ids.some((id: string) => localIds.has(id)) && !raw.ids.every((id: string) => localIds.has(id))) throw new Error('请分别处理未分项目和团队项目中的记录'); if (raw.ids.every((id: string) => localIds.has(id))) return personalContext; }
  const sessionId = raw?.id || raw?.parentId || raw?.sessionId;
  if (sessionId && !preferPersonal && team.workbench.store.conclusions.some(item => item.id === sessionId)) return team;
  if (sessionId && (personalContext.workbench.store.sessions.some(item => item.id === sessionId) || personalContext.workbench.store.drafts.some(item => item.id === sessionId) || personalContext.workbench.store.conclusions.some(item => item.id === sessionId))) return personalContext;
  if (raw?.projectId && raw.projectId !== PERSONAL_PROJECT_ID) return team;
  if (raw?.id && (team.workbench.store.sessions.some(item => item.id === raw.id) || team.workbench.store.drafts.some(item => item.id === raw.id))) return team;
  if (raw?.projectId === PERSONAL_PROJECT_ID || preferPersonal) return personalContext;
  return team;
}
async function alignPersonalRelay(team: DataContext, action: string, raw: any) {
  if (!personalContext) return;
  const local = personalContext.workbench;
  if (!local.store.settings.egress && team.workbench.store.settings.egress) {
    const settings = structuredClone(team.workbench.store.settings.egress), accessCode = await readProtected(team.egressSecretFile);
    await applyClientEgress(personalContext, { settings, accessCode });
  }
  const central = local.store.settings.egress?.viaSharedServer;
  const draft = local.store.drafts.find(item => item.id === raw?.id);
  const session = action === 'rsi.run' ? local.store.sessions.filter(item => item.purpose === 'work' && !item.closedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : local.store.sessions.find(item => item.id === (draft?.sessionId || raw?.id || raw?.parentId || raw?.sessionId));
  const route = raw?.networkRoute || session?.networkRoute || (local.store.settings.egress?.enabled ? 'management' : 'direct');
  const executing = /^(session\.(create|send|retry|mode|model|network|permission|native|codexDesktop|desktopSync)|draft\.(prepare|retry|reorganize)|conclusion\.merge\.prepare|subsession\.create|provider\.(auth|catalog|login$)|rsi\.run|egress\.test)/.test(action);
  if (central && executing && route === 'management') {
    const identity = team.workbench.remote.connected && team.workbench.remote.profile ? accountIdentity(team.workbench.remote.profile) : undefined;
    assertPersonalRelay(route, central, identity, session);
    if (personalRelay && personalRelay !== team && local.store.sessions.some(item => item.networkRoute === 'management' && (['starting', 'running', 'approval'].includes(item.status) || (local.activity.busy || local.rsi.busy)))) throw new Error('本机会话正在使用另一个中央账号中转，请先结束任务');
    personalRelay = team;
    if (session && !session.relayAccount && session.networkRoute === 'management') { session.relayAccount = identity; await local.store.save(); }
  }
  personalContext.egress.sharedServerConnectionChanged(!!personalRelay?.workbench.remote.connected);
}
const id = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:-[1-5])?$/i), text = z.string().max(2 * 1024 * 1024), provider = z.enum(['codex', 'cursor', 'claude']);
const sessionInput = z.object({ id });
const capability = z.object({ id: z.string().min(1).max(500), kind: z.enum(['skill', 'plugin']), name: z.string().min(1).max(200) });
async function chooseFiles(owner: BrowserWindow) { return (await dialog.showOpenDialog(owner, { title: '选择要共享的文件', properties: ['openFile', 'multiSelections'] })).filePaths; }
async function dispatch(action: string, raw: unknown, owner: BrowserWindow, preferPersonal = false): Promise<unknown> {
  const active = contexts.get(owner);
  const context = actionContext(action, raw, owner, preferPersonal); if (!context) throw new Error('当前窗口的独立工作台尚未就绪');
  const { workbench, egress, broadcast, notice } = context;
  if (context === personalContext && active) await alignPersonalRelay(active, action, raw);
  if (!['snapshot', 'remote.connect', 'window.new'].includes(action)) workbench.assertAccountReady();
  const setupActions = new Set(['snapshot', 'workspace.select', 'local.move', 'window.new', 'group.control', 'content.updates', 'content.updates.read', 'content.updates.clear', 'content.updates.dismiss', 'settings.save', 'layout.sidebar', 'providers.detect', 'provider.auth', 'provider.login.cancel', 'choose.directory', 'choose.executable', 'server.identity.forget', 'remote.connect', 'remote.disconnect', 'provider.login', 'open.data', 'open.link', 'copy', 'session.stop', 'session.completion.read', 'remote.manifest', 'session.history', 'handoff.read', 'egress.configure', 'egress.test']);
  if (!setupActions.has(action)) workbench.assertWorkspace();
  switch (action) {
    case 'workspace.select': { const p = z.object({ personal: z.boolean() }).parse(raw); if (p.personal) personalWindows.add(owner); else personalWindows.delete(owner); return true; }
    case 'local.group.save': { const p = z.object({ id: id.optional(), name: z.string().max(120) }).parse(raw); return workbench.savePersonalGroup(p.name, p.id); }
    case 'local.group.delete': return workbench.dissolvePersonalGroup(z.object({ id }).parse(raw).id);
    case 'local.session.group': { const p = z.object({ id, groupId: id.optional() }).parse(raw); return workbench.assignPersonalGroup(p.id, p.groupId); }
    case 'local.move': { const p = z.object({ projectId: z.string().min(1), sessionId: id.optional(), groupId: id.optional() }).parse(raw); return personalContext!.workbench.movePersonalTo(workbench, p.projectId, p); }
    case 'snapshot': {
      const snapshot = switchingWindows.has(owner) ? scopeAccountSnapshot({ ...workbench.snapshot(), accountChanging: true }) : workbench.snapshot();
      const local = personalContext?.workbench.snapshot();
      return { ...snapshot, workspaceReady: true,
        sessions: [...(local?.sessions || []), ...snapshot.sessions], drafts: [...(local?.drafts || []), ...snapshot.drafts],
        inputs: { ...snapshot.inputs, ...local?.inputs }, activeTurns: { ...snapshot.activeTurns, ...local?.activeTurns },
        activity: { ...snapshot.activity, jobs: [...(snapshot.activity?.jobs || []), ...(local?.activity?.jobs || [])] },
        personal: local && { settings: local.settings, providers: local.providers, auth: local.auth, egress: personalContext!.egress.status() },
        settings: { ...snapshot.settings, personalGroups: local?.settings.personalGroups || [], sidebarProjectHeight: active!.sidebarProjectHeight, sidebarPanes: active!.sidebarPanes, defaultServer: sharedServerEndpoint }, egress: egress.status() };
    }
    case 'window.new': openAdditionalWindow(false); return true;
    case 'egress.configure': {
      await applyClientEgress(context, await prepareClientEgress(context, userEgressInputSchema.parse(raw)));
      if (workbench.store.settings.egress?.enabled) void egress.probe().catch(() => {}); broadcast(); return egress.status();
    }
    case 'egress.test': {
      const route = z.object({ networkRoute: z.enum(['direct', 'management']).optional() }).optional().parse(raw)?.networkRoute;
      if (route === 'direct') return { enabled: false, configured: true, running: true, available: true, detail: '使用本机网络直连', hasAccessCode: false };
      if (route === 'management' && !egress.status().enabled) throw new Error('该会话的管理端出口尚未启用');
      await egress.probe(); broadcast(); return egress.status();
    }
    case 'settings.save': {
      const next: import('../shared/types').Settings = settingsSchema.parse(raw);
      // Settings forms must not overwrite newer local inbox/alias changes with a stale snapshot.
      for (const key of ['contentSeen', 'contentUpdates', 'contentAliases', 'dismissedContentUpdateIds', 'egress', 'projectDirectories', 'betaFeatures', 'personalGroups'] as const) Object.assign(next, { [key]: workbench.store.settings[key] });
      for (const p of ['codex', 'cursor', 'claude'] as const) if (next.providerPaths[p] !== workbench.store.settings.providerPaths[p]) workbench.accounts.invalidate(p);
      next.verifiedLocalWorkspace = workbench.store.settings.verifiedLocalWorkspace; next.workspaceSnapshot = workbench.store.settings.workspaceSnapshot; workbench.store.settings = next; await workbench.store.save(); broadcast(); return true;
    }
    case 'layout.sidebar': {
      const pane = z.number().int().min(80).max(2000);
      const p = z.object({ height: z.number().int().min(180).max(4000).optional(), workgroups: pane.optional(), files: pane.optional(), sessions: pane.optional() }).refine(value => value.height !== undefined || value.workgroups !== undefined || value.files !== undefined || value.sessions !== undefined).parse(raw);
      if (p.height !== undefined) active!.sidebarProjectHeight = p.height;
      active!.sidebarPanes = { ...active!.sidebarPanes, ...(p.workgroups !== undefined ? { workgroups: p.workgroups } : {}), ...(p.files !== undefined ? { files: p.files } : {}), ...(p.sessions !== undefined ? { sessions: p.sessions } : {}) };
      await atomicJson(windowStateFile(active!.slot), { profile: active!.workbench.store.settings.workspaceSnapshot?.profile, sidebarProjectHeight: active!.sidebarProjectHeight, sidebarPanes: active!.sidebarPanes });
      return true;
    }
    case 'beta.set': { const p = z.object({ feature: z.enum(['sessionHandoff', 'subsessions', 'codexDesktopSync', 'cursorDesktopSync']), enabled: z.boolean() }).parse(raw); return workbench.setBetaFeature(p.feature, p.enabled); }
    case 'providers.detect': return workbench.detect();
    case 'account.sync': await workbench.accountSync.sync(); return workbench.accountSync.state;
    case 'account.sync.resolve': { const p = z.object({ key: z.string(), choice: z.enum(['local', 'remote']) }).parse(raw); await workbench.accountSync.resolve(p.key, p.choice); return workbench.accountSync.state; }
    case 'directions.list': return workbench.listDirections();
    case 'directions.save': return workbench.saveDirections(z.object({ directions: z.unknown() }).parse(raw).directions);
    case 'workspace.research': return workbench.researchWorkspace();
    case 'project.directory.save': { const p = z.object({ projectId: z.string().min(1), directory: z.string().max(32768), contextKey: z.string().max(4096) }).parse(raw); return workbench.saveProjectDirectory(p.projectId, p.directory, p.contextKey); }
    case 'provider.auth': {
      const p = z.object({ provider, cwd: z.string().optional(), networkRoute: z.enum(['direct', 'management']).optional() }).parse(raw);
      return workbench.accounts.check(p.provider, p.cwd || workbench.store.settings.localWorkspace || app.getPath('home'), p.networkRoute);
    }
    case 'provider.login.cancel': workbench.accounts.cancel(z.object({ provider }).parse(raw).provider); return true;
    case 'provider.catalog': { const p = z.object({ provider, cwd: text.min(1), networkRoute: z.enum(['direct', 'management']).optional(), forceRefresh: z.boolean().optional() }).parse(raw); return workbench.catalog(p.provider, p.cwd, p.networkRoute, p.forceRefresh); }
    case 'session.capabilities': { const p = z.object({ id, forceRefresh: z.boolean().optional(), kind: z.enum(['skill', 'plugin']).optional() }).parse(raw); return workbench.capabilities(p.id, p.forceRefresh, p.kind); }
    case 'session.modes': return workbench.modes(z.object({ id }).parse(raw).id);
    case 'session.mode': { const p = z.object({ id, mode: z.enum(['default', 'plan', 'ask']) }).parse(raw); return workbench.changeMode(p.id, p.mode); }
    case 'session.plan.execute': { const p = planExecuteSchema.parse(raw); return workbench.executePlan(p.id, p.messageId); }
    case 'session.plan.revise': { const p = planReviseSchema.parse(raw); return workbench.revisePlan(p.id, p.messageId, p.text); }
    case 'session.tools.configuration': { const p = z.object({ id, kind: z.enum(['mcp', 'skill', 'plugin']) }).parse(raw); const file = await workbench.toolConfiguration(p.id, p.kind); const error = await shell.openPath(file); if (error) throw new Error('无法打开配置，请检查本机文件关联。'); return true; }
    case 'session.skills.configure': { const p = z.object({ id, skillId: z.string().min(1).max(1000), enabled: z.boolean() }).parse(raw); return workbench.configureSkill(p.id, p.skillId, p.enabled); }
    case 'session.mcp': { const p = z.object({ id, refresh: z.boolean().optional() }).parse(raw); return workbench.mcpCatalog(p.id, p.refresh); }
    case 'session.mcp.add': { const p = z.object({ id, server: mcpServerInputSchema }).parse(raw); return workbench.mcpWrite(p.id, p.server); }
    case 'session.mcp.toggle': { const p = z.object({ id, name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), enabled: z.boolean() }).parse(raw); return workbench.mcpWrite(p.id, { name: p.name, enabled: p.enabled }); }
    case 'session.mcp.editable': { const p = z.object({ id, name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).parse(raw); return workbench.mcpEditable(p.id, p.name); }
    case 'session.mcp.update': { const p = z.object({ id, server: mcpServerInputSchema }).parse(raw); return workbench.mcpWrite(p.id, { operation: 'update', server: p.server }); }
    case 'session.mcp.remove': { const p = z.object({ id, name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).parse(raw); return workbench.mcpWrite(p.id, { operation: 'remove', name: p.name }); }
    case 'session.mcp.login': {
      const p = z.object({ id, name: z.string().min(1).max(200) }).parse(raw);
      const url = await workbench.mcpLogin(p.id, p.name); if (typeof url === 'string') await shell.openExternal(url); return true;
    }
    case 'provider.permissions': { const p = z.object({ provider, cwd: text.min(1) }).parse(raw); return workbench.inspectPermissions(p.provider, p.cwd); }
    case 'provider.cursorReview': return workbench.configureCursorReview(z.object({ cwd: text.min(1) }).parse(raw).cwd);
    case 'session.permissions': { const p = z.object({ id, mode: z.enum(['inherit', 'review', 'auto', 'full']), stop: z.boolean().optional() }).parse(raw); return workbench.changePermissions(p.id, p.mode, p.stop); }
    case 'session.model': { const p = z.object({ id, model: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/), stop: z.boolean().optional() }).parse(raw); return workbench.changeModel(p.id, p.model, p.stop); }
    case 'session.reasoningEffort': { const p = z.object({ id, effort: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).nullable() }).parse(raw); return workbench.changeReasoningEffort(p.id, p.effort); }
    case 'session.network': { const p = z.object({ id, networkRoute: z.enum(['direct', 'management']) }).parse(raw); return workbench.changeNetworkRoute(p.id, p.networkRoute, workbench.personal && workbench.store.settings.egress?.viaSharedServer && active?.workbench.remote.profile ? accountIdentity(active.workbench.remote.profile) : undefined); }
    case 'choose.directory': return (await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })).filePaths[0] || '';
    case 'choose.executable': return (await dialog.showOpenDialog(owner, { title: '选择 CLI 程序（不是编辑器）', properties: ['openFile'], filters: [{ name: 'CLI', extensions: ['exe', 'cmd', 'ps1'] }] })).filePaths[0] || '';
    case 'remote.connect': {
      const p = z.object({ profile: profileSchema, password: z.string().min(1).max(4096), newPassword: newAccountPasswordSchema.optional(), localPath: z.string().default(''), egress: userEgressInputSchema.optional() }).parse(raw);
      const key = serverIdentityKey(p.profile.host, p.profile.port);
      const profile = { ...p.profile, fingerprint: p.profile.mode === 'local' ? p.profile.fingerprint : serverIdentities.get(key) };
      return loginWindow(owner, profile, p.password, p.localPath, async fingerprint => {
        const accepted = (await dialog.showMessageBox(owner, {
        type: 'question', title: '首次连接团队服务器', message: p.profile.name || '团队共享服务器',
        detail: `这是本机第一次连接 ${p.profile.host}:${p.profile.port}，请确认服务器地址填写正确。`,
        buttons: ['取消', '继续登录'], defaultId: 0, cancelId: 0,
        })).response === 1;
        if (accepted) {
          await serverIdentities.remember(key, fingerprint); await syncServerIdentities();
        }
        return accepted;
      }, p.egress, p.newPassword);
    }
    case 'server.identity.forget': {
      const p = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) }).parse(raw), key = serverIdentityKey(p.host, p.port);
      await serverIdentities.forget(key); await syncServerIdentities(key); return true;
    }
    case 'project.create': { const p = z.object({ name: z.string().min(1).max(180), groupName: z.string().optional(), brief: projectBriefSchema.optional() }).parse(raw); return workbench.createProject(p.name, p.groupName, p.brief); }
    case 'project.initialize': { const p = z.object({ name: z.string().min(1).max(180), groupName: z.string().min(1).max(80), contextKey: z.string().max(4096), brief: projectBriefSchema }).parse(raw); return workbench.initializeProject(p.name, p.groupName, p.brief, p.contextKey); }
    case 'remote.password': { const p = z.object({ oldPassword: z.string().min(1).max(4096), newPassword: newAccountPasswordSchema }).parse(raw); return workbench.remote.changePassword(p.oldPassword, p.newPassword); }
    case 'remote.disconnect': if (personalRelay === active && personalContext?.workbench.store.sessions.some(session => session.networkRoute === 'management' && (['starting', 'running', 'approval'].includes(session.status) || (personalContext?.workbench.activity.busy || personalContext?.workbench.rsi.busy)))) throw new Error('请先结束使用中央中转的本机会话，再断开连接'); workbench.remote.disconnect(); return true;
    case 'group.control': return workbench.groupCommand(raw as any);
    case 'remote.manifest': return workbench.refreshGroups();
    case 'remote.list': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.list(workbench.remote.binding(p.projectId), p.path); }
    case 'remote.preview': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.preview(workbench.remote.binding(p.projectId), p.path); }
    case 'remote.download': {
      const p = z.object({ projectId: z.string(), path: text }).parse(raw); const binding = workbench.remote.binding(p.projectId);
      const result = await dialog.showSaveDialog(owner, { defaultPath: path.posix.basename(p.path) }); if (!result.filePath) return false;
      await workbench.queue.enqueueDownload(binding, p.path, result.filePath); notice('文件已加入下载队列，可在传输记录查看结果'); return true;
    }
    case 'remote.upload': { const p = z.object({ projectId: z.string(), folder: text }).parse(raw); const binding = workbench.remote.binding(p.projectId); const files = await chooseFiles(owner); if (!files.length) return 0; await workbench.uploadFiles(binding, p.folder, files); return files.length; }
    case 'session.create': { const p = z.object({ provider, cwd: text, projectId: z.string().optional(), model: z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/).optional(), permissionMode: z.enum(['inherit', 'review', 'auto', 'full']).optional(), includeBrief: z.boolean().default(true), networkRoute: z.enum(['direct', 'management']).optional(), desktopSync: z.boolean().default(false) }).parse(raw); if ((p.networkRoute || (workbench.store.settings.egress?.enabled ? 'management' : 'direct')) === 'management') await workbench.requireAuth(p.provider, p.cwd.trim() || await workbench.researchWorkspace(), 'management'); const groupId = z.object({ personalGroupId: id.optional() }).parse(raw).personalGroupId;
      const session = await workbench.createSession(p.provider, p.cwd, p.projectId, 'work', undefined, p.model, p.permissionMode, p.includeBrief, p.networkRoute, p.desktopSync, groupId);
      if (workbench.personal) { if (session.networkRoute === 'management' && workbench.store.settings.egress?.viaSharedServer && active?.workbench.remote.profile) session.relayAccount = accountIdentity(active.workbench.remote.profile); await workbench.store.save(); }
      return session; }
    case 'session.native.list': return workbench.listNativeSessions(z.object({ provider: z.enum(['codex', 'cursor']) }).parse(raw).provider);
    case 'session.native.link': { const p = z.object({ provider: z.enum(['codex', 'cursor']), nativeId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i), projectId: z.string().min(1) }).parse(raw); return workbench.linkNativeSession(p.provider, p.nativeId, p.projectId); }
    case 'session.native.linkMany': { const p = z.object({ provider: z.enum(['codex', 'cursor']), nativeIds: z.array(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)).min(1).max(50), projectId: z.string().min(1) }).parse(raw); return workbench.linkNativeSessions(p.provider, p.nativeIds, p.projectId); }
    case 'session.native.refresh': return workbench.refreshNativeTranscript(sessionInput.parse(raw).id);
    case 'session.codexDesktop.open': return workbench.openCodexDesktop(sessionInput.parse(raw).id);
    case 'session.codexDesktop.reconnect': return workbench.reconnectCodexDesktop(sessionInput.parse(raw).id);
    case 'session.desktopSync.restore': return workbench.restoreDesktopSync(sessionInput.parse(raw).id);
    case 'session.cursorDesktop.list': { const p=z.object({cwd:z.string().default(''),launch:z.boolean().default(false)}).parse(raw); return workbench.listCursorDesktopSessions(p.cwd,p.launch); }
    case 'session.cursorDesktop.linkMany': { const p=z.object({nativeIds:z.array(z.string().uuid()).min(1).max(50),projectId:z.string().min(1)}).parse(raw); return workbench.linkCursorDesktopSessions(p.nativeIds,p.projectId); }
    case 'session.cursorNative.focus': return workbench.focusCursorNative(sessionInput.parse(raw).id);
    case 'session.cursorNative.settings': {
      const input=z.object({id:z.string(),kind:z.enum(['model','mode','permission']).optional(),value:z.string().min(1).max(256).optional(),revision:z.string().max(24000).optional(),cancel:z.boolean().optional()}).parse(raw);
      return workbench.cursorNativeSettings(input.id,input.kind,input.value,input.revision,input.cancel);
    }
    case 'session.cursorNative.queue': { const p=z.object({id,action:z.enum(['cancel','resume','reconcile','confirm','withdraw']),requestId:z.string().uuid().optional(),nativeMessageId:z.string().uuid().optional()}).parse(raw);return workbench.cursorQueueAction(p.id,p.action,p.requestId,p.nativeMessageId); }
    case 'session.native.publish': return workbench.publishToDesktop(sessionInput.parse(raw).id);
    case 'subsession.create': { const p = z.object({ parentId: id, focus: z.string().trim().min(1).max(120) }).parse(raw); return workbench.forkSubsession(p.parentId, p.focus); }
    case 'subsession.report.preview': return workbench.previewSubsessionReport(sessionInput.parse(raw).id);
    case 'subsession.report.publish': { const p = z.object({ id, sourceHash: z.string().regex(/^[a-f0-9]{64}$/), body: z.string().min(1).max(128 * 1024) }).parse(raw); return workbench.publishSubsessionReport(p.id, p.sourceHash, p.body); }
    case 'subsession.report.review': { const p = z.object({ parentId: id, childId: id, reportId: id }).parse(raw); return workbench.reviewSubsessionReport(p.parentId, p.childId, p.reportId); }
    case 'subsession.report.attach': { const p = z.object({ parentId: id, childId: id, reportId: id }).parse(raw); return workbench.attachSubsessionReport(p.parentId, p.childId, p.reportId); }
    case 'session.completion.read': { const p = z.object({ id, completionId: z.string().uuid() }).parse(raw); return workbench.readSessionCompletion(p.id, p.completionId); }
    case 'session.rename': { const p = z.object({ id, title: z.string().trim().min(1).max(120) }).parse(raw); return workbench.renameSession(p.id, p.title); }
    case 'project.brief': return workbench.remote.projectBrief(workbench.remote.binding(z.object({ projectId: z.string() }).parse(raw).projectId));
    case 'project.brief.save': { const p = z.object({ projectId: z.string(), brief: projectBriefSchema, revision: z.number().int().nonnegative() }).parse(raw); const value = await workbench.remote.saveProjectBrief(workbench.remote.binding(p.projectId), p.brief, p.revision); await workbench.refreshGroups(); return value; }
    case 'content.list': return workbench.remote.contentList(workbench.remote.binding(z.object({ projectId: z.string() }).parse(raw).projectId));
    case 'content.history': { const p = z.object({ projectId: z.string(), id: z.string().uuid().optional(), revision: z.number().int().positive().optional() }).parse(raw); return workbench.remote.contentHistory(workbench.remote.binding(p.projectId), p.id, p.revision); }
    case 'conclusion.publish': { const p = z.object({ id: z.string().uuid(), version: z.number().int().positive().optional(), disclose: z.array(resultReferenceSchema).max(30).default([]) }).parse(raw); return workbench.publishConclusion(p.id, p.disclose, p.version); }
    case 'content.alias.save': { const p = z.object({ projectId: z.string(), contentId: id, alias: z.string().trim().max(200) }).parse(raw); return workbench.saveContentAlias(p.projectId, p.contentId, p.alias); }
    case 'rsi.settings': { const p = z.object({ projectId: text }).parse(raw); const view = await workbench.rsi.view(p.projectId); return { config: view.config, sourceSession: view.sourceSession }; }
    case 'rsi.shadow.configure': { const p = z.object({ projectId: text, config: z.unknown() }).parse(raw); return workbench.rsi.configureShadow(p.projectId, p.config); }
    case 'rsi.preference': { const p = z.object({ projectId: text, text: z.string().max(2000) }).parse(raw); return workbench.rsi.personalPreference(p.projectId, p.text); }
    case 'rsi.reuse': { const p = z.object({ projectId: text, sourceProjectId: text, policyId: text }).parse(raw); return workbench.rsi.reuse(p.projectId, p.sourceProjectId, p.policyId); }
    case 'rsi.view': return workbench.rsi.view(z.object({ projectId: text }).parse(raw).projectId);
    case 'rsi.inbox': return workbench.rsi.inbox(z.object({ projectId: text }).parse(raw).projectId);
    case 'rsi.configure': { const p = z.object({ projectId: text, config: z.unknown() }).parse(raw); return workbench.rsi.configure(p.projectId, p.config); }
    case 'rsi.collect': return workbench.rsi.collect(z.object({ projectId: text }).parse(raw).projectId);
    case 'rsi.run': { const p = z.object({ projectId: text, operation: z.enum(['recommend', 'learn', 'evaluate']), candidateId: text.optional() }).parse(raw); await workbench.rsi.start(p.projectId, p.operation, 'manual', p.candidateId); return true; }
    case 'rsi.feedback': { const p = z.object({ projectId: text, reaction: z.unknown() }).parse(raw); return workbench.rsi.feedback(p.projectId, p.reaction); }
    case 'rsi.case': { const p = z.object({ projectId: text, value: z.unknown() }).parse(raw); return workbench.rsi.addCase(p.projectId, p.value); }
    case 'rsi.publish': { const p = z.object({ projectId: text, candidateId: text }).parse(raw); return workbench.rsi.publish(p.projectId, p.candidateId); }
    case 'rsi.rollback': return workbench.rsi.rollback(z.object({ projectId: text }).parse(raw).projectId);
    case 'activity.project': { const p = z.object({ projectId: z.string() }).parse(raw); for (const current of contexts.values()) if (current.workbench !== workbench) current.workbench.activity.removeWindow(String(owner.id)); await workbench.setActivityProject(String(owner.id), p.projectId); return true; }
    case 'activity.presented':
    case 'activity.ignore': { const p = z.object({ id, jobIds: z.array(z.string()).max(1000) }).parse(raw); return workbench.markActivity(p.id, p.jobIds, action === 'activity.ignore'); }
    case 'activity.apply': { const p = z.object({ id, choices: z.array(z.object({ jobId: z.string(), attach: z.boolean(), save: z.boolean() })).max(100) }).parse(raw); return workbench.applyActivity(p.id, p.choices); }
    case 'content.sync': return workbench.syncContentUpdates();
    case 'content.updates': return workbench.contentUpdates();
    case 'content.updates.read': { const p = z.object({ eventIds: z.array(z.string()).max(10000).optional(), processed: z.boolean().optional() }).parse(raw || {}); return workbench.markContentUpdates(p.eventIds, p.processed); }
    case 'content.updates.clear': return workbench.clearReadContentUpdates();
    case 'content.updates.dismiss': return workbench.dismissContentUpdates(z.object({ eventIds: z.array(z.string()) }).parse(raw).eventIds);
    case 'conclusion.list': { const p = z.object({ projectId: z.string(), includeArchived: z.boolean().optional() }).parse(raw); return workbench.conclusions(p.projectId, p.includeArchived).map(item => ({ ...item, uploadState: workbench.conclusionUploadState(item.id) })); }
    case 'question.members': return workbench.questions.members(z.object({ projectId: z.string() }).parse(raw).projectId);
    case 'question.sync': return workbench.questions.sync();
    case 'question.create': { const p = z.object({ sessionId: id, question: z.unknown() }).parse(raw); return workbench.questions.create(p.sessionId, p.question); }
    case 'question.close': { const p = z.object({ projectId: z.string(), id }).parse(raw); return workbench.questions.closeQuestion(p.projectId, p.id); }
    case 'question.read': { const p = z.object({ id, revision: z.number().int().positive() }).parse(raw); return workbench.questions.read(p.id, p.revision); }
    case 'question.link': { const p = z.object({ projectId: z.string(), id, sessionId: id }).parse(raw); return workbench.questions.link(p.projectId, p.id, p.sessionId); }
    case 'question.answer': { const p = z.object({ projectId: z.string(), id, answerId: id, body: z.string().trim().min(1).max(12000) }).parse(raw); return workbench.questions.answer(p.projectId, p.id, p.answerId, p.body); }
    case 'question.files.stage': return workbench.questions.stage(await chooseFiles(owner));
    case 'question.files.remove': return workbench.questions.unstage(z.object({ id }).parse(raw).id);
    case 'question.file.preview':
    case 'question.file.download': {
      const p = z.object({ projectId: z.string(), id, sha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(240) }).parse(raw);
      const located = workbench.questions.locateFile(p.projectId, p.id, p.sha256, p.name);
      if (action === 'question.file.preview') return workbench.remote.preview(located.binding, located.path, located.file.name);
      const selected = await dialog.showSaveDialog(owner, { defaultPath: safeFilename(located.file.name) }); if (!selected.filePath) return false;
      const temporary = path.join(workbench.store.root, 'downloads', randomUUID(), safeFilename(located.file.name));
      try { await workbench.remote.download(located.binding, located.path, temporary, () => {}, { sha256: located.file.sha256, size: located.file.size }); await fs.copyFile(temporary, selected.filePath); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      notice('附件已下载'); return true;
    }
    case 'question.follow': { const p = z.object({ projectId: z.string(), id, followId: id, body: z.string(), target: z.string().trim().min(1).max(160).optional(), fileIds: z.array(id).max(30).optional() }).parse(raw); return workbench.questions.follow(p.projectId, p.id, p.followId, p.body, p.target, p.fileIds || []); }
    case 'question.import': { const p = z.object({ projectId: z.string(), id, sessionId: id, answerId: id }).parse(raw); return workbench.questions.importReply(p.projectId, p.id, p.sessionId, p.answerId); }
    case 'question.auto': { const p = z.object({ projectId: z.string(), id, sessionId: id, peer: z.string().trim().min(1).max(160) }).parse(raw); return workbench.questions.startAuto(p.projectId, p.id, p.peer, p.sessionId); }
    case 'question.auto.stop': { const p = z.object({ projectId: z.string(), id, peer: z.string().trim().min(1).max(160) }).parse(raw); return workbench.questions.stopAuto(p.projectId, p.id, p.peer); }
    case 'question.fill': { const p = z.object({ projectId: z.string(), id, peer: z.string().trim().min(1).max(160) }).parse(raw); return workbench.questions.fillDraft(p.projectId, p.id, p.peer); }
    case 'assignment.list': return workbench.remote.assignmentList(workbench.remote.binding(z.object({ projectId: z.string() }).parse(raw).projectId));
    case 'assignment.members': return workbench.remote.assignmentMembers(workbench.remote.binding(z.object({ projectId: z.string() }).parse(raw).projectId));
    case 'assignment.create': { const p = z.object({ projectId: z.string(), task: assignmentCreateSchema }).parse(raw); return workbench.createAssignment(p.projectId, p.task); }
    case 'assignment.files.pick': { const p = z.object({ projectId: z.string(), taskId: id, selectionId: id.optional() }).parse(raw); return workbench.selectAssignmentFiles(p.projectId, p.taskId, await chooseFiles(owner), p.selectionId); }
    case 'assignment.file.download': {
      const p = z.object({ projectId: z.string(), taskId: id, fileId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw), binding = workbench.remote.binding(p.projectId);
      const task = (await workbench.remote.assignmentList(binding)).find(item => item.id === p.taskId), file = task && assignmentAllFiles(task).find(item => item.id === p.fileId);
      if (!file) throw new Error('任务附件不存在或无权访问');
      const selected = await dialog.showSaveDialog(owner, { defaultPath: safeFilename(file.name) }); if (!selected.filePath) return false;
      const temporary = path.join(workbench.store.root, 'downloads', randomUUID(), safeFilename(file.name));
      try { await workbench.remote.assignmentDownload(binding, p.taskId, p.fileId, temporary); await fs.copyFile(temporary, selected.filePath); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      return true;
    }
    case 'assignment.status': { const p = z.object({ projectId: z.string(), change: assignmentStatusSchema }).parse(raw); return workbench.updateAssignment(p.projectId, p.change); }
    case 'assignment.start': { const p = z.object({ projectId: z.string(), taskId: id, revision: z.number().int().positive(), provider, cwd: text, model: z.string().min(1).max(256).optional(), permissionMode: z.enum(['inherit', 'review', 'auto', 'full']).optional(), includeBrief: z.boolean().default(true), networkRoute: z.enum(['direct', 'management']).optional(), desktopSync: z.boolean().default(false) }).parse(raw); if ((p.networkRoute || (workbench.store.settings.egress?.enabled ? 'management' : 'direct')) === 'management') await workbench.requireAuth(p.provider, p.cwd.trim() || await workbench.researchWorkspace(), 'management'); return workbench.startAssignment(p.projectId, p.taskId, p.revision, p.provider, p.cwd, p.model, p.permissionMode, p.includeBrief, p.networkRoute, p.desktopSync); }
    case 'conclusion.match': { const p = z.object({ projectId: z.string(), query: text.min(1) }).parse(raw); return workbench.matchConclusions(p.projectId, p.query); }
    case 'conclusion.create': { const p = z.object({ projectId: z.string(), title: z.string().trim().min(1).max(200), content: text.min(1), category: contributionCategorySchema.optional(), resultStatus: resultStatusSchema.optional(), resultOwner: z.string().max(160).optional(), fileIds: z.array(id).max(30).optional() }).parse(raw); return workbench.createConclusion(p.projectId, p.title, p.content, p.category, p.resultStatus, p.resultOwner, p.fileIds); }
    case 'conclusion.files.stage': return workbench.stageConclusionFiles(await chooseFiles(owner));
    case 'conclusion.files.add': { const p = z.object({ id }).parse(raw); return workbench.addConclusionFiles(p.id, await chooseFiles(owner)); }
    case 'conclusion.files.remove': { const p = z.object({ id: id.optional(), fileId: id }).parse(raw); return workbench.removeConclusionFile(p.id, p.fileId); }
    case 'conclusion.file.preview': {
      const p = z.object({ id: id.optional(), fileId: id }).parse(raw), file = workbench.conclusionFile(p.id, p.fileId);
      const { previewSessionFile } = await import('../core/session-files');
      return { ...await previewSessionFile({ cwd: path.dirname(file.localPath), outputFiles: [], messages: [] } as any, file.localPath), name: file.name };
    }
    case 'conclusion.save': { const p = z.object({ id, title: z.string().trim().min(1).max(200), content: text.min(1), category: contributionCategorySchema.optional(), resultStatus: resultStatusSchema.optional(), version: z.number().int().positive().optional(), resultOwner: z.string().max(160).optional() }).parse(raw); return workbench.saveConclusion(p.id, p.title, p.content, p.category, p.resultStatus, p.version, p.resultOwner); }
    case 'conclusion.alias.save': { const p = z.object({ id, alias: z.string().trim().max(200) }).parse(raw); return workbench.saveConclusionAlias(p.id, p.alias); }
    case 'content.deletion.conclusions': return workbench.deletedContentConclusions(z.object({ eventId: z.string() }).parse(raw).eventId);
    case 'content.deletion.resolve': { const p = z.object({ eventId: z.string(), selections: z.array(z.object({ id, version: z.number().int().positive() })).max(1000) }).parse(raw); return workbench.resolveContentDeletion(p.eventId, p.selections); }
    case 'conclusion.archive': { const p = z.object({ id, archived: z.boolean() }).parse(raw); return workbench.archiveConclusion(p.id, p.archived); }
    case 'conclusion.delete': { const p = z.object({ id, version: z.number().int().positive() }).parse(raw); return workbench.deleteConclusion(p.id, p.version); }
    case 'conclusion.deleteMany': return workbench.deleteConclusions(z.object({ selections: z.array(z.object({ id, version: z.number().int().positive() })).min(1).max(1000) }).parse(raw).selections);
    case 'content.updates.delete': return workbench.deleteContentUpdates(z.object({ eventIds: z.array(z.string()).min(1).max(10000) }).parse(raw).eventIds);
    case 'conclusion.import': { const p = z.object({ projectId: z.string(), contentId: id, expectedRevision: z.number().int().positive().optional() }).parse(raw); return workbench.importContentConclusion(p.projectId, p.contentId, p.expectedRevision); }
    case 'conclusion.merge.prepare': { const p = z.object({ projectId: z.string(), sessionId: id, sourceIds: z.array(id).min(1).max(20), instruction: z.string().max(8000).default('') }).parse(raw); return workbench.prepareConclusionMerge(p.projectId, p.sessionId, p.sourceIds, p.instruction); }
    case 'conclusion.merge.commit': { const p = z.object({ id, replaceIds: z.array(id).max(20).default([]), confirmDuplicateTodos: z.boolean().optional() }).parse(raw); return workbench.commitConclusionMerge(p.id, p.replaceIds, p.confirmDuplicateTodos); }
    case 'conclusion.merge.submit': { const p = z.object({ id, confirmDuplicateTodos: z.boolean().optional() }).parse(raw); return workbench.submitConclusionMerge(p.id, p.confirmDuplicateTodos); }
    case 'content.merge.prepare': { const p = z.object({ projectId: z.string(), sessionId: id, sourceIds: z.array(z.string().uuid()).min(2).max(20) }).parse(raw); return workbench.prepareContentMerge(p.projectId, p.sessionId, p.sourceIds); }
    case 'content.merge.save': { const p = z.object({ id, title: z.string().max(200), body: text }).parse(raw); return workbench.saveContentMerge(p.id, p.title, p.body); }
    case 'content.merge.commit': { const p = z.object({ id, replaceIds: z.array(id).max(20).default([]), confirmDuplicateTodos: z.boolean().optional() }).parse(raw); return workbench.commitContentMerge(p.id, p.replaceIds, p.confirmDuplicateTodos); }
    case 'content.merge.personal': { const p = z.object({ id, confirmDuplicateTodos: z.boolean().optional() }).parse(raw); return workbench.saveContentMergePersonal(p.id, p.confirmDuplicateTodos); }
    case 'content.adopt': { const p = z.object({ projectId: z.string(), path: text }).parse(raw); return workbench.remote.contentAdopt(workbench.remote.binding(p.projectId), p.path); }
    case 'content.edit': { const p = z.object({ projectId: z.string(), change: contentEditSchema }).parse(raw); return workbench.editSharedContent(p.projectId, p.change); }
    case 'content.deleteMany': { const p = z.object({ projectId: z.string(), selections: contentDeleteSelectionsSchema }).parse(raw); return workbench.deleteSharedContents(p.projectId, p.selections); }
    case 'content.reap': { const p = z.object({ projectId: z.string() }).parse(raw); return workbench.reapProjectFiles(p.projectId); }
    case 'content.replace': {
      const p = z.object({ projectId: z.string(), change: contentEditSchema }).parse(raw), binding = workbench.remote.binding(p.projectId);
      const file = (await dialog.showOpenDialog(owner, { title: '选择替换文件（保存为新修订）', properties: ['openFile'] })).filePaths[0];
      if (!file) return false;
      const snapshot = await freezeFile(file, path.join(workbench.store.root, 'uploads', 'replacements'));
      try { await workbench.remote.contentReplace(binding, p.change, snapshot.localPath); return true; } finally { await fs.rm(snapshot.localPath, { force: true }); }
    }
    case 'session.attachContent': { const p = z.object({ id, contentId: z.string().uuid() }).parse(raw); return workbench.attachContent(p.id, p.contentId); }
    case 'session.attachConclusion': { const p = z.object({ id, conclusionId: z.string().uuid() }).parse(raw); return workbench.attachConclusion(p.id, p.conclusionId); }
    case 'session.detachPendingSource': { const p = z.object({ id, sourceId: z.string().uuid() }).parse(raw); return workbench.detachPendingSource(p.id, p.sourceId); }
    case 'session.projectContext': return workbench.refreshProjectContext(sessionInput.parse(raw).id);
    case 'draft.revise': return workbench.reviseDraft(sessionInput.parse(raw).id);
    case 'draft.git': { const p = z.object({ id, include: z.boolean() }).parse(raw); const draft = workbench.draft(p.id); if (draft.submitted) throw new Error('已提交的快照不能修改'); draft.includeGit = p.include; await workbench.store.save(); broadcast(); return true; }
    case 'cache.clean': return workbench.cleanUploadCache();
    case 'session.send': {
      const p = z.object({ id, text: text.min(1), sourceIds: z.array(z.string()).default([]), capabilities: z.array(capability).max(20).default([]) }).parse(raw); const s = workbench.session(p.id); workbench.assertCanWork(s.binding);
      if (!s.cursorNative && !s.codexDesktop) await workbench.requireAuth(s.provider, s.cwd, s.networkRoute);
      if (s.title === '新会话') s.title = p.text.trim().slice(0, 40);
      return new Promise<boolean>((resolve, reject) => {
        let submitted = false;
        void workbench.send(p.id, p.text, p.sourceIds, p.capabilities, () => { submitted = true; resolve(true); }).then(started => { if (!started && !submitted) reject(new Error(s.error || '任务未能提交给 CLI，请重试')); }).catch(error => { notice(error.message); if (!submitted) reject(error); });
      });
    }
    case 'session.steer': {
      const p = z.object({ id, expectedTurnId: z.string().min(1).max(200), text: text.min(1), sourceIds: z.array(z.string()).default([]), capabilities: z.array(capability).max(20).default([]) }).parse(raw);
      return workbench.steer(p.id, p.expectedTurnId, p.text, p.sourceIds, p.capabilities);
    }
    case 'session.input': { const p = z.object({ id, input: z.object({ text, sourceIds: z.array(z.string()), answers: z.record(z.string(), z.string()), capabilities: z.array(capability).max(20).optional() }) }).parse(raw); await workbench.saveInput(p.id, p.input); return true; }
    case 'session.stop': return workbench.stop(sessionInput.parse(raw).id);
    case 'session.close': return workbench.closeSession(sessionInput.parse(raw).id);
    case 'session.delete': return workbench.deleteSession(sessionInput.parse(raw).id);
    case 'journal.project': return workbench.projectJournal(sessionInput.parse(raw).id);
    case 'session.reopen': return workbench.reopenSession(sessionInput.parse(raw).id);
    case 'session.answer': { const p = z.object({ id, requestId: z.string(), option: z.string(), answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional() }).parse(raw); return workbench.answer(p.id, p.requestId, p.option, p.answers); }
    case 'session.attachLocal': { const p = sessionInput.parse(raw); return workbench.attachLocal(p.id, await chooseFiles(owner)); }
    case 'session.attachRemote': { const p = z.object({ id, projectId: z.string(), path: text }).parse(raw); return workbench.attachRemote(p.id, p.projectId, p.path); }
    case 'session.autoUpload': { const p = z.object({ id, enabled: z.boolean() }).parse(raw); const s = workbench.session(p.id); if (p.enabled && (workbench.personal || !s.binding || s.purpose !== 'work')) throw new Error('只有绑定远端项目的工作会话可开启自动上传'); if (p.enabled && s.sources.some(source => source.sourcePath.startsWith('session-handoff:') || source.sourcePath.startsWith('subsession-report:'))) throw new Error('当前会话引用了个人会话内容，不能开启轨迹自动上传；如需分享轨迹，请先预览并手动确认'); s.autoUpload = p.enabled; await workbench.store.save(); broadcast(); return true; }
    case 'session.history': return historyMarkdown(workbench.session(sessionInput.parse(raw).id));
    case 'session.uploadTrajectory': return workbench.archive(sessionInput.parse(raw).id);
    case 'handoff.read': return workbench.readHandoff(sessionInput.parse(raw).id);
    case 'handoff.list': return workbench.listSessionHandoffs(sessionInput.parse(raw).id);
    case 'handoff.attach': { const p = z.object({ id, sourceId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw); return workbench.attachSessionHandoff(p.id, p.sourceId, p.sha256); }
    case 'handoff.save': { const p = z.object({ id, text, expectedText: text.optional() }).parse(raw); return workbench.saveHandoff(p.id, p.text, p.expectedText); }
    case 'draft.prepare': { const p = z.object({ id, categories: preparationCategoriesSchema.optional(), scope: z.enum(['incremental', 'full']).optional(), directions: preparationDirectionsSchema.optional() }).parse(raw); return workbench.prepare(p.id, [], p.categories, p.scope, p.directions); }
    case 'draft.reorganize': { const p = z.object({ id, categories: preparationCategoriesSchema.optional(), scope: z.enum(['incremental', 'full']), directions: preparationDirectionsSchema.optional() }).parse(raw); return workbench.reorganizePreparation(p.id, p.scope, p.categories, p.directions); }
    case 'draft.confirmEmpty': return workbench.confirmEmptyPreparation(sessionInput.parse(raw).id);
    case 'draft.retry': return workbench.retryPreparation(sessionInput.parse(raw).id);
    case 'draft.cancel': return workbench.cancelPreparation(sessionInput.parse(raw).id);
    case 'draft.delete': return workbench.deleteDraft(sessionInput.parse(raw).id);
    case 'draft.deleteMany': return workbench.deleteDrafts(z.object({ ids: draftDeleteIdsSchema }).parse(raw).ids);
    case 'draft.supplement': { const p = z.object({ id, supplement: text, repoUrlOverride: z.string().max(2048) }).parse(raw); return workbench.saveDraftSupplement(p.id, p.supplement, p.repoUrlOverride); }
    case 'draft.artifact.edit': { const p = z.object({ id, artifactId: z.string(), title: z.string().trim().min(1).max(120).optional(), body: text.min(1).optional(), updateTarget: resultReferenceSchema.nullable().optional(), organization: projectOrganizationSchema.optional() }).refine(value => !!value.organization || !!value.title && !!value.body, '请填写有效标题和正文').parse(raw); return workbench.editDraftArtifact(p.id, p.artifactId, p.title, p.body, p.updateTarget, p.organization); }
    case 'draft.category': { const p = z.object({ id, category: contributionCategorySchema, artifactId: z.string().optional() }).parse(raw); return workbench.changeDraftCategory(p.id, p.category, p.artifactId); }
    case 'draft.artifactSelection': { const p = z.object({ id, artifactId: z.string(), selected: z.boolean() }).parse(raw); return workbench.selectDraftArtifact(p.id, p.artifactId, p.selected); }
    case 'draft.renameResult': { const p = z.object({ id, artifactId: z.string().optional(), title: z.string().trim().min(1).max(120) }).parse(raw); return workbench.renameDraftResult(p.id, p.title, p.artifactId); }
    case 'draft.save': { const p = z.object({ id, title: z.string().max(120), body: text, repoUrl: z.string().max(2048), target: z.string().optional() }).parse(raw); return workbench.saveDraft(p.id, p.title, p.body, p.repoUrl, p.target); }
    case 'draft.attach': { const p = z.object({ id, artifactId: z.string().optional() }).parse(raw); return workbench.addDraftFiles(p.id, await chooseFiles(owner), p.artifactId); }
    case 'draft.attachment.select': { const p = z.object({ id, artifactId: z.string(), fileId: id, selected: z.boolean() }).parse(raw); return workbench.selectDraftAttachment(p.id, p.artifactId, p.fileId, p.selected); }
    case 'draft.attachment.preview': {
      const p = z.object({ id, fileId: id }).parse(raw), draft = workbench.draft(p.id), file = draft.files.find(file => file.id === p.fileId);
      if (!file) throw new Error('附件不存在');
      const { previewSessionFile } = await import('../core/session-files');
      return { ...await previewSessionFile({ cwd: path.dirname(file.localPath), outputFiles: [], messages: [] } as any, file.localPath), name: file.name };
    }
    case 'content.attachment.preview':
    case 'content.attachment.download': {
      const p = z.object({ projectId: z.string(), contentId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw), binding = workbench.remote.binding(p.projectId);
      const item = (await workbench.remote.contentList(binding)).find(item => item.id === p.contentId), file = item?.attachments?.find(file => file.sha256 === p.sha256);
      if (!file) throw new Error('附件所属成果已更新或删除，请刷新');
      if (item?.files?.attachments[file.sha256] && item.files.attachments[file.sha256] !== 'ok') throw new Error('此附件缺失或暂不可访问，请刷新后检查');
      if (action === 'content.attachment.preview') return workbench.remote.preview(binding, file.path, file.name);
      const name = safeFilename(file.name);
      const result = await dialog.showSaveDialog(owner, { defaultPath: name }); if (!result.filePath) return false;
      const temporary = path.join(workbench.store.root, 'downloads', randomUUID(), name);
      await workbench.remote.download(binding, file.path, temporary);
      const { hashFile } = await import('../core/artifacts');
      if (await hashFile(temporary) !== file.sha256) throw new Error('附件校验失败，未写入所选位置');
      await fs.copyFile(temporary, result.filePath); await fs.unlink(temporary); notice('附件已下载'); return true;
    }
    case 'draft.submit': { const p = z.object({ id, target: z.string().optional() }).parse(raw); return workbench.submitDraft(p.id, p.target); }
    case 'draft.personal.save': { const p = z.object({ id, artifactIds: z.array(id).min(1).max(5) }).parse(raw); return workbench.saveDraftPersonal(p.id, p.artifactIds); }
    case 'draft.export': {
      const d = workbench.draft(sessionInput.parse(raw).id); const target = await dialog.showSaveDialog(owner, { defaultPath: 'contribution.zip', filters: [{ name: '成果包', extensions: ['zip'] }] }); if (!target.filePath) return false;
      const zip = await packageDraft(d, workbench.store.root); await fs.copyFile(zip, target.filePath); return true;
    }
    case 'transfer.retry': return workbench.queue.retry(sessionInput.parse(raw).id);
    case 'provider.login': {
      const p = z.object({ provider, cwd: z.string().optional(), networkRoute: z.enum(['direct', 'management']).optional() }).parse(raw);
      await workbench.accounts.login(p.provider, p.cwd || workbench.store.settings.localWorkspace || app.getPath('home'), p.networkRoute);
      return true;
    }
    case 'copy': clipboard.writeText(text.parse(raw)); return true;
    case 'session.files': return listSessionFiles(workbench.session(sessionInput.parse(raw).id));
    case 'session.file.preview': { const p = z.object({ id, path: text }).parse(raw); return previewSessionFile(workbench.session(p.id), p.path); }
    case 'session.file.open': {
      const p = z.object({ id, path: text, reveal: z.boolean().default(false) }).parse(raw);
      const { target } = await checkedSessionFile(workbench.session(p.id), p.path);
      if (process.env.WORKBENCH_TEST === '1') return target;
      if (p.reveal) { shell.showItemInFolder(target); return target; }
      if (/\.(exe|com|bat|cmd|ps1|sh|msi|vbs|vbe|js|jse|wsf|wsh|scr|lnk|url|reg|hta)$/i.test(target)) throw new Error('脚本和程序请在页面预览或使用“打开所在文件夹”');
      const error = await shell.openPath(target); if (error) throw new Error('无法打开文件：' + error); return target;
    }
    case 'open.link': { const url = new URL(text.parse(raw)); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('只允许打开网页链接'); await shell.openExternal(url.href); return true; }
    case 'open.data': await shell.openPath(workbench.store.root); return true;
    default: throw new Error('未知操作：' + action);
  }
}
function latestWindow() {
  const list = [...windows];
  for (let index = list.length - 1; index >= 0; index -= 1) if (!list[index].isDestroyed() && list[index].isFocused()) return list[index];
  for (let index = list.length - 1; index >= 0; index -= 1) if (!list[index].isDestroyed()) return list[index];
}
function claimSlot(preferred?: number) { let slot = preferred && !activeSlots.has(preferred) ? preferred : 1; while (activeSlots.has(slot)) slot += 1; activeSlots.add(slot); return slot; }
function instanceRoot(slot: number) { return slot === 1 ? app.getPath('userData') : path.join(app.getPath('userData'), 'instances', String(slot)); }
function windowStateFile(slot: number) { return path.join(app.getPath('userData'), 'window-state', slot + '.json'); }
const serverEndpointSchema = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) });
function serverEndpointFile() { return path.join(app.getPath('userData'), 'server-endpoint.json'); }
function usableServer(profile: { mode?: string; host?: string; port?: number } | undefined) { return profile && profile.mode !== 'local' && profile.host && profile.port ? { host: profile.host, port: profile.port } : undefined; }
async function loadSharedServerEndpoint() {
  try { return serverEndpointSchema.parse(JSON.parse(await fs.readFile(serverEndpointFile(), 'utf8'))); }
  catch (error: any) { if (error.code !== 'ENOENT') { /* Keep looking through saved connections. */ } }
  const found: { host: string; port: number }[] = [];
  const consider = (profile: { mode?: string; host?: string; port?: number } | undefined) => { const endpoint = usableServer(profile); if (endpoint) found.push(endpoint); };
  try {
    const settings = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    for (const connection of settings.connections || []) consider(connection);
    consider(settings.workspaceSnapshot?.profile);
  } catch { /* A new installation has no saved server yet. */ }
  try {
    const directory = path.join(app.getPath('userData'), 'window-state');
    for (const name of await fs.readdir(directory)) {
      if (!/^[1-9]\d*\.json$/.test(name)) continue;
      try { consider(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')).profile); } catch { /* Skip an unreadable window record. */ }
    }
  } catch { /* No window records yet. */ }
  const endpoint = found.at(-1);
  if (endpoint) await atomicJson(serverEndpointFile(), endpoint);
  return endpoint;
}
async function rememberServerEndpoint(host: string, port: number) {
  const endpoint = serverEndpointSchema.parse({ host, port });
  if (sharedServerEndpoint?.host === endpoint.host && sharedServerEndpoint.port === endpoint.port) return;
  sharedServerEndpoint = endpoint;
  await atomicJson(serverEndpointFile(), endpoint);
}
async function storedWindowState(slot: number): Promise<{ profile?: import('../shared/types').ConnectionProfile; sidebarProjectHeight?: number; sidebarPanes?: SidebarPanes }> {
  try { const state = JSON.parse(await fs.readFile(windowStateFile(slot), 'utf8')); return { profile: state.profile ? profileSchema.parse(state.profile) : undefined, sidebarProjectHeight: state.sidebarProjectHeight, sidebarPanes: state.sidebarPanes }; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  try { const settings = JSON.parse(await fs.readFile(path.join(instanceRoot(slot), 'settings.json'), 'utf8')); const snapshot = settings.workspaceSnapshot || settings.offlineAuthorization; return { profile: snapshot?.profile ? profileSchema.parse(snapshot.profile) : undefined, sidebarProjectHeight: settings.sidebarProjectHeight }; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; return {}; }
}
async function loginWindow(window: BrowserWindow, profile: import('../shared/types').ConnectionProfile, password: string, localPath: string, trust: (fingerprint: string) => Promise<boolean>, egressInput?: z.infer<typeof userEgressInputSchema>, newPassword?: string) {
  if (personalRelay === contexts.get(window) && personalContext?.workbench.store.sessions.some(session => session.networkRoute === 'management' && (['starting', 'running', 'approval'].includes(session.status) || (personalContext?.workbench.activity.busy || personalContext?.workbench.rsi.busy)))) throw new Error('请先结束使用中央中转的本机会话，再更换登录账号');
  if (switchingWindows.has(window)) throw new Error('正在登录，请等待结果');
  const previous = contexts.get(window)!;
  const currentProfile = previous.workbench.store.settings.workspaceSnapshot?.profile;
  if (!currentProfile || accountIdentity(currentProfile) !== accountIdentity(profile)) previous.workbench.assertCanLeaveAccount();
  switchingWindows.add(window); previous.broadcast();
  const verified = new SharedFiles(() => {});
  let acquired: Awaited<ReturnType<typeof accountWorkspaces.acquire>> | undefined;
  try {
    const requestedEgress = egressInput ? await prepareClientEgress(previous, egressInput) : undefined;
    if (requestedEgress?.settings?.enabled && requestedEgress.settings.viaSharedServer && profile.mode === 'local') throw new Error('本地共享目录不支持中转，请登录共享服务器');
    // Authenticate before selecting any other account's local records. Failure leaves
    // the old context, its live tasks and the window's persisted selection untouched.
    const result = await verified.connect({ ...profile, projects: [], manifestPath: '', workPath: '' }, password, trust);
    if ((await verified.passwordStatus()).required) {
      if (!newPassword) throw new Error('PASSWORD_CHANGE_REQUIRED：首次登录，请设置新密码');
      await verified.changePassword(password, newPassword);
    }
    await verified.loadManifest();
    return await routeAccount(async () => {
      if (window.isDestroyed() || closingWindows.has(window) || closing) throw new Error('窗口正在关闭，请重新登录');
      acquired = await accountWorkspaces.acquire(result, previous.workbench.store.root);
      const target = acquired.value;
      // Apply login choices to the authenticated account, never to the account
      // whose window happened to open the login dialog.
      if (requestedEgress) await applyClientEgress(target, requestedEgress);
      if (!target.workbench.remote.connected) await target.workbench.configureWorkspace(result, '', localPath, trust, verified);
      // An already open account keeps its live SSH transfers and CLI runtimes. The
      // temporary connection above still verifies this login's password and server.
      target.egress.setUsername(result.username);
      if (target.workbench.store.settings.egress?.enabled) void target.egress.probe().catch(() => {});
      if (window.isDestroyed() || closingWindows.has(window) || closing) throw new Error('窗口正在关闭，请重新登录');
      await atomicJson(windowStateFile(previous.slot), { profile: target.workbench.remote.profile || result, sidebarProjectHeight: previous.sidebarProjectHeight, sidebarPanes: previous.sidebarPanes });
      try { await previous.release(); }
      catch (error) { await atomicJson(windowStateFile(previous.slot), { profile: currentProfile, sidebarProjectHeight: previous.sidebarProjectHeight, sidebarPanes: previous.sidebarPanes }); throw error; }
      contexts.set(window, { ...target, slot: previous.slot, sidebarProjectHeight: previous.sidebarProjectHeight, sidebarPanes: previous.sidebarPanes, release: acquired.release }); acquired = undefined;
      const signedIn = target.workbench.remote.profile || result;
      if (signedIn.mode !== 'local' && signedIn.host) await rememberServerEndpoint(signedIn.host, signedIn.port);
      target.broadcast();
      return signedIn;
    });
  } finally {
    verified.disconnect();
    try { if (acquired) await acquired.release(); }
    finally { switchingWindows.delete(window); contexts.get(window)?.broadcast(); }
  }
}
async function readProtected(file: string) {
  try { const data = await fs.readFile(file); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : data.toString('utf8'); }
  catch { return ''; }
}
async function writeProtected(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true }); const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value, 'utf8'); await fs.writeFile(file, data, { mode: 0o600 });
}
async function prepareClientEgress(context: DataContext, input: z.infer<typeof userEgressInputSchema>) {
  let settings = context.workbench.store.settings.egress, accessCode = await readProtected(context.egressSecretFile);
  const viaSharedServer = input.viaSharedServer ?? settings?.viaSharedServer ?? false;
  if (input.inviteCode?.trim()) {
    const invite = decodeEgressInvite(input.inviteCode);
    settings = { enabled: input.enabled, viaSharedServer: invite.version === 2 || viaSharedServer, host: invite.host, port: invite.port, certificateFingerprint: invite.fingerprint, ...(invite.version === 2 ? { sharedServer: invite.sharedServer } : {}) }; accessCode = invite.accessCode;
  } else if (settings) settings = { ...settings, enabled: input.enabled, viaSharedServer };
  else if (input.enabled) throw new Error('请粘贴管理端生成的接入码');
  if (input.enabled && !accessCode) throw new Error('已保存的接入信息不完整，请重新粘贴接入码');
  return { settings, accessCode };
}
async function applyClientEgress(context: DataContext, next: Awaited<ReturnType<typeof prepareClientEgress>>) {
  const { workbench, egress } = context, { settings, accessCode } = next, previous = workbench.store.settings.egress;
  const normalize = (value: typeof settings) => value ? { enabled: value.enabled, host: value.host, port: value.port, certificateFingerprint: value.certificateFingerprint, viaSharedServer: !!value.viaSharedServer, sharedServer: value.sharedServer } : undefined;
  if (JSON.stringify(normalize(previous)) === JSON.stringify(normalize(settings)) && accessCode === await readProtected(context.egressSecretFile)) return;
  await workbench.networkChanged();
  if (accessCode) await writeProtected(context.egressSecretFile, accessCode);
  workbench.store.settings.egress = settings; await workbench.store.save();
  const username = workbench.remote.profile?.username || workbench.store.settings.workspaceSnapshot?.profile.username || '';
  await egress.configure(settings ? { ...settings, accessCode, username } : undefined);
  context.broadcast();
}
async function datasetMetadata(slot: number) {
  const root = instanceRoot(slot);
  try {
    const { profile } = await storedWindowState(slot);
    const username = profile ? accountIdentity(profile) : '';
    const counts = await Promise.all(['sessions.json', 'drafts.json', 'transfers.json', 'conclusions.json'].map(async name => {
      try { const value = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); return Array.isArray(value) ? value.length : 0; } catch { return 0; }
    }));
    return { slot, username, records: counts.reduce((sum, count) => sum + count, 0) };
  } catch { return { slot, username: '', records: 0 }; }
}
async function storedDatasetSlots() {
  let slots = [1];
  try {
    const entries = await fs.readdir(path.join(app.getPath('userData'), 'instances'), { withFileTypes: true });
    slots.push(...entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => Number(entry.name)).filter(slot => slot > 1));
  } catch { /* No additional account data yet. */ }
  try { slots.push(...(await fs.readdir(path.join(app.getPath('userData'), 'window-state'))).filter(name => /^[1-9]\d*\.json$/.test(name)).map(name => Number(name.slice(0, -5)))); } catch { /* No migrated window preferences yet. */ }
  const datasets = await Promise.all([...new Set(slots)].sort((a, b) => a - b).map(datasetMetadata));
  const preferredByAccount = new Map<string, { slot: number; records: number }>();
  for (const dataset of datasets) {
    if (!dataset.username) continue;
    const current = preferredByAccount.get(dataset.username);
    if (!current || dataset.records > current.records || dataset.records === current.records && dataset.slot < current.slot) preferredByAccount.set(dataset.username, dataset);
  }
  return datasets.filter(dataset => (dataset.username || dataset.records) && (!dataset.username || preferredByAccount.get(dataset.username)?.slot === dataset.slot)).map(dataset => dataset.slot);
}
function syncTaskbar(window: BrowserWindow, workbench: Workbench) {
  try {
    if (window.isDestroyed()) return;
    const next = taskbarAttention(workbench.questions.view(), workbench.contentUpdates(), [...workbench.store.sessions, ...(personalContext?.workbench.store.sessions || [])]);
    const previous = taskbarSeen.get(window);
    taskbarSeen.set(window, next);
    if (taskbarShouldAlert(previous, next) && !window.isFocused()) window.flashFrame(true);
  } catch (error) { console.error('任务栏提醒未更新', errorMessage(error)); }
}
async function createDataContext(root: string, personal = false): Promise<DataContext> {
  let workbench: Workbench;
  const emit = (event: WorkbenchEvent) => { for (const [window, context] of contexts) if ((personal || context.workbench === workbench) && !window.isDestroyed()) window.webContents.send('workbench:event', event); };
  let emitTimer: NodeJS.Timeout | undefined;
  const broadcast = () => { egress?.sharedServerConnectionChanged(personal ? !!personalRelay?.workbench.remote.connected : !!workbench?.remote.connected); if (!personal) personalContext?.egress.sharedServerConnectionChanged(!!personalRelay?.workbench.remote.connected); if (!emitTimer) emitTimer = setTimeout(() => { emitTimer = undefined; emit({ type: 'state' }); for (const [window, context] of contexts) if ((personal || context.workbench === workbench) && !window.isDestroyed()) syncTaskbar(window, context.workbench); }, 80); };
  const notice = (message: string) => { emit({ type: 'notice', message });
    if (/^(收到提问|收到问题答复|问题已关闭)：/.test(message) && Notification.isSupported()) {
      const notification = new Notification({ title: '团队工作台 · 提问', body: message });
      notification.on('click', () => { for (const [window, context] of contexts) if (context.workbench === workbench && !window.isDestroyed()) { window.show(); window.focus(); window.webContents.send('workbench:event', { type: 'questions' }); break; } });
      notification.show();
    } if (message.startsWith('待授权：')) for (const [window, context] of contexts) if ((personal || context.workbench === workbench) && !window.isDestroyed() && !window.isFocused()) window.flashFrame(true); };
  let egress: EgressClientProxy | undefined;
  workbench = new Workbench(root, broadcast, notice, 10 * 60 * 1000, (route, session) => {
    if (route === 'direct') return {};
    if (personal) assertPersonalRelay(route || (workbench.store.settings.egress?.enabled ? 'management' : 'direct'), workbench.store.settings.egress?.viaSharedServer, personalRelay?.workbench.remote.connected && personalRelay.workbench.remote.profile ? accountIdentity(personalRelay.workbench.remote.profile) : undefined, session);
    const environment = egress?.environment() || {};
    if (route === 'management' && !environment.HTTPS_PROXY) throw new Error('该会话的管理端出口未启动，请先恢复管理端连接');
    return environment;
  },
    (session, value) => { if (session.networkRoute === 'management') egress?.reportCliStatus(session.provider, session.id, value, session.binding?.username || ''); },new CodexDesktopService({workerFile:path.join(__dirname,runtimeAssets,'codex-desktop-worker.cjs')}), undefined, personal);
  try {
    await workbench.init();
    workbench.store.settings.trustedServerIdentities = serverIdentities.snapshot();
    const egressSecretFile = path.join(root, 'egress-access.bin'), settings = workbench.store.settings.egress, accessCode = await readProtected(egressSecretFile);
    const username = workbench.store.settings.connections.at(-1)?.username || workbench.store.settings.workspaceSnapshot?.profile.username || '';
    egress = new EgressClientProxy(settings ? { ...settings, accessCode, username } : undefined, (host, port, signal, expectedServer) => (personal ? personalRelay?.workbench.remote : workbench.remote)?.openEgressTunnel(host, port, signal, expectedServer) || Promise.reject(new Error('请先登录中央节点'))); egress.on('changed', broadcast);
    if (settings?.enabled && accessCode) { await egress.start().catch(() => {}); if (!settings.viaSharedServer || workbench.remote.connected) void egress.probe().catch(() => {}); }
    return { workbench, egress, egressSecretFile, broadcast, notice };
  } catch (error) { await workbench.close().catch(() => {}); await egress?.stop().catch(() => {}); throw error; }
}
async function createWindow(preferredSlot?: number, fresh = false) {
  const slot = claimSlot(preferredSlot);
  const window = new BrowserWindow({ width: 1520, height: 980, minWidth: 1100, minHeight: 720, backgroundColor: '#f5f6f8', show: process.env.WORKBENCH_TEST !== '1', title: clientWindowTitle('用户版'), webPreferences: { preload: path.join(__dirname, runtimeAssets, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  windows.add(window);
  try {
    const { profile, sidebarProjectHeight, sidebarPanes } = fresh ? {} : await storedWindowState(slot);
    if (profile) {
      const acquired = await accountWorkspaces.acquire(profile, instanceRoot(slot));
      contexts.set(window, { ...acquired.value, slot, sidebarProjectHeight, sidebarPanes, release: acquired.release });
    } else {
      const context = await createDataContext(path.join(app.getPath('userData'), 'window-state', String(slot)));
      contexts.set(window, { ...context, slot, sidebarProjectHeight, sidebarPanes, release: async () => { await context.workbench.close(); await context.egress.stop(); } });
      await atomicJson(windowStateFile(slot), {});
    }
  } catch (error) { await contexts.get(window)?.release().catch(() => {}); contexts.delete(window); windows.delete(window); activeSlots.delete(slot); window.destroy(); throw error; }
  window.setMenuBarVisibility(false);
  window.on('focus', () => window.flashFrame(false));
  window.on('close', event => {
    if (quitting || closingWindows.has(window)) return;
    event.preventDefault();
    dismissWindow(window);
    if (windows.size === 1) void finishQuit();
    else void closeWindow(window);
  });
  window.on('closed', () => {
    for (const current of contexts.values()) current.workbench.activity.removeWindow(String(window.id));
    personalWindows.delete(window);
    windows.delete(window); const context = contexts.get(window); contexts.delete(window);
    if (context) { activeSlots.delete(context.slot); if (!quitting && !closingWindows.has(window)) void context.release().catch(error => console.error('账号窗口关闭失败', errorMessage(error))); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await window.loadFile(entry);
  const ready = contexts.get(window);
  if (ready) syncTaskbar(window, ready.workbench);
  return window;
}
function openAdditionalWindow(reuseStored: boolean) {
  if (quitting || closing) return;
  pendingWindowRequests.push(reuseStored);
  void drainAdditionalWindows();
}
function drainAdditionalWindows() {
  if (!windowsReady || openingWindow || quitting || closing) return;
  openingWindow = true;
  void (async () => {
    try {
      while (pendingWindowRequests.length && !quitting && !closing) {
        const reuseStored = pendingWindowRequests.shift()!;
        try {
          await routeAccount(async () => {
            if (quitting || closing) return;
            const storedSlot = reuseStored ? (await storedDatasetSlots()).find(slot => !activeSlots.has(slot)) : undefined;
            // Each launch opens a window. When all accounts are already open,
            // start at login instead of reusing an unrelated old slot's identity.
            await createWindow(storedSlot, storedSlot === undefined);
          });
        } catch (error: any) { dialog.showErrorBox('工作台窗口启动失败', error.message); }
      }
    }
    finally { openingWindow = false; }
  })();
}
if (ownDataDirectory(latestWindow, () => openAdditionalWindow(true))) app.whenReady().then(async () => {
  ipcMain.handle('workbench', async (event, action, payload) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || !windows.has(owner) || event.senderFrame?.url !== pathToFileURL(entry).href) return { ok: false, error: '不允许的调用来源' };
    try {
      const requested = z.string().parse(action), preferPersonal = requested.startsWith('personal:'), operation = preferPersonal ? requested.slice(9) : requested, context = contexts.get(owner)!;
      const executing = actionContext(operation, payload, owner, preferPersonal);
      if ((switchingWindows.has(owner) || closingWindows.has(owner) || closing) && operation !== 'snapshot') throw new Error('正在登录或关闭窗口，请等待完成');
      const value = await executing.workbench.runAccountOperation(operation, () => dispatch(operation, payload, owner, preferPersonal));
      if (!['snapshot', 'remote.connect', 'window.new'].includes(operation) && contexts.get(owner) !== context) throw new Error('账号已改变，未返回上一个账号的操作结果，请刷新后重试');
      return { ok: true, value };
    } catch (e: any) { return { ok: false, error: errorMessage(e) }; }
  });
  const legacySettings = await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8').then(value => JSON.parse(value)).catch((error: any) => { if (error.code === 'ENOENT') return {}; throw error; });
  await serverIdentities.init(legacySettings.trustedServerIdentities || {});
  sharedServerEndpoint = await loadSharedServerEndpoint();
  personalContext = await createDataContext(path.join(app.getPath('userData'), 'personal'), true);
  await routeAccount(() => createWindow());
  windowsReady = true;
  void drainAdditionalWindows();
}).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => { if (!closing) void finishQuit(); });
function dismissWindow(window: BrowserWindow) {
  if (window.isDestroyed()) return;
  window.hide();
}
function reportCloseFailure(error: unknown) {
  dialog.showErrorBox('未保存的编辑', '保存失败，窗口已经关闭。\n' + errorMessage(error) + '\n请恢复目录或磁盘空间后重新打开工作台。');
}
async function closeWindow(window: BrowserWindow) {
  if (closingWindows.has(window)) return;
  const context = contexts.get(window); if (!context) { if (!window.isDestroyed()) window.destroy(); return; }
  closingWindows.add(window);
  for (const current of contexts.values()) current.workbench.activity.removeWindow(String(window.id));
  contexts.delete(window); activeSlots.delete(context.slot); windows.delete(window);
  dismissWindow(window);
  if (!window.isDestroyed()) window.destroy();
  try { await routeAccount(() => context.release()); }
  catch (error) { reportCloseFailure(error); }
  finally { closingWindows.delete(window); }
}
async function finishQuit() {
  if (closing) return; closing = true;
  const pending = [...contexts.entries()];
  for (const [window, context] of pending) {
    closingWindows.add(window); activeSlots.delete(context.slot); windows.delete(window); contexts.delete(window);
    for (const [, current] of pending) current.workbench.activity.removeWindow(String(window.id));
  }
  for (const [window] of pending) { dismissWindow(window); if (!window.isDestroyed()) window.destroy(); }
  try { await routeAccount(async () => { for (const [, context] of pending) await context.release(); if (personalContext) { await personalContext.workbench.close(); await personalContext.egress.stop(); } }); }
  catch (error) { reportCloseFailure(error); }
  finally { quitting = true; for (const [window] of pending) closingWindows.delete(window); closing = false; app.quit(); }
}
app.on('before-quit', event => { if (!quitting && contexts.size) { event.preventDefault(); void finishQuit(); } });
