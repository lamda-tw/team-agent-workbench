import { RsiPanel, RsiNotice } from './rsi-panel';
import { personalFamilyIds, PERSONAL_PROJECT_ID, personalProfile, isPersonalBinding } from '../shared/personal-workspace';
import { PersonalSection, SessionOrganization, PersonalMoveDialog, type MoveSelection } from './personal-workspace';
import { newAccountPasswordSchema } from '../shared/accounts';
import { SessionTranscript } from './session-transcript';
import './session-transcript.css';
import { clientVersion, clientWindowTitle } from '../shared/client-version';
import { QuestionFeed, QuestionPanel, questionAutoLock, questionUnread } from './team-questions';
import './team-questions.css';
import { cursorSharedSessionUnavailable } from '../shared/cursor-session-consistency';
import { CursorNativeRecord, CursorNativeQueue } from './cursor-native-record';
import { NativeDesktopControls } from './native-desktop-controls';
import { TeamGroupDialog } from './team-groups';
import { groupRoleLabels } from '../shared/team-groups';
import { activityText } from '../shared/submission';
import { TransferRecords } from './transfer-records';
import { resultPreview } from '../shared/result-reading';
import type { SourceFile } from '../shared/types';
import { SharedContentLibrary } from './shared-content';
import { SessionMaterials } from './session-materials';
import { AccountSyncStatus } from './account-sync';
import { ContentUpdatesPanel, type ContentUpdateFilters } from './content-updates';
import { ActivityRecommendations, type ActivityPanelHandle } from './activity-recommendations';
import { SummaryUpdateStatus } from './summary-update-status';
import './activity-recommendations.css';
import { ConclusionLibrary } from './conclusions';
import { ProjectResults, type ResultScope } from './project-results';
import { projectDirectory, projectDirectoryKey } from '../shared/project-directory';
import { ProjectDirectoryDialog, ProjectSettingsDialog } from './project-directory';
import { PreparationOptionsModal } from './preparation-options';
import { accountIdentity } from '../shared/account-data';
import { AssignmentsPanel } from './assignments';
import { SessionFilesDialog } from './session-files';
import type { ProjectAssignment } from '../shared/assignments';
import { attachedConclusion, conclusionTitle, isConclusionSource } from '../shared/conclusion-context';
import { resultLabelTitle } from '../shared/result-labels';
import { isRemovableSessionReference } from '../shared/session-result-references';
import { sessionMessageText } from '../shared/session-context-text';
import { acceptedSessionContext, isPersonalHandoffSource, sourceIdentity, sourceWasAccepted, uniqueSources } from '../shared/session-context';
import { ProjectBriefEditor } from './project-brief-editor';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from './markdown';
import { Folder, FolderOpen, FileText, Plus, Settings as SettingsIcon, ArrowUp, ArrowUpDown, ArrowLeft, RefreshCw, Upload, Download, Link, X, Check, ChevronRight, MessageSquare, Layers, Server, Unplug, Search, Paperclip, Square, ShieldCheck, FileArchive, HardDrive, PanelRightClose, Sparkles, Copy, Terminal, CircleHelp, BellRing, Pencil, Puzzle, ClipboardList, Ellipsis, Compass } from 'lucide-react';
import { NativeSessionPicker } from './native-sessions';
import './native-sessions.css';
import type { AgentCapabilitySelection, AgentSession, ConclusionMatch, ConnectionProfile, ContentUpdate, Draft, FilePreview, Project, Provider, ProviderAuth, RemoteEntry, Settings, Snapshot, WorkspaceAccess } from '../shared/types';
import './styles.css';
import './result-card.css';
import { DraftEditor, draftStatus } from './draft-editor';
import { DraftTaskList } from './draft-list';
import { DraftDeleteDialog } from './draft-delete';
import type { DraftDeleteResult } from '../shared/draft-delete';
import { preparationCheckpoint } from '../shared/preparation-progress';
import { needsPreparationConfirmation } from '../shared/preparation-review';
import { ModelPicker } from './model-picker';
import { ProviderConnectionSettings } from './provider-connection';
import { newSessionBlockedReason } from './new-session-readiness';
import type { ProviderConnectionCheck } from './provider-connection-check';
import { PermissionPicker } from './permissions';
import { ComposerSettings } from './composer-settings';
import { ComposerMode } from './composer-mode';
import { AgentCustomization } from './agent-customization';
import { PlanMessage } from './plan-message';
import { ComposerCapabilities } from './composer-capabilities';
import { ComposerActions, composerMode } from './composer-actions';
import { submitComposerInput } from './composer-input';
import { PendingSessionMessage, type PendingMessage } from './pending-session-message';
import { SessionStatusIndicator, useSessionCompletionRead } from './session-status';
import './session-status.css';
import { SteeringConfirmation, prepareSteeringReview, confirmSteeringReview, steeringReviewIsCurrent, type SteeringReview } from './steering-confirmation';
import type { PermissionMode, SessionNetworkRoute } from '../shared/types';
import type { UserEgressStatus } from '../shared/egress';
import { useAutosave } from './autosave';
import type { SessionInput } from '../shared/types';
import { ProviderAuthPanel, canUseProvider } from './provider-auth';
import { ProjectOnboarding } from './project-onboarding';
import { RequestCard, isQuestionRequest, isPlanRequest } from './request-card';
import { projectSetupIdentity } from '../shared/project-brief';
import { serverIdentityKey } from '../shared/server-identity';
import { snapshotAccountKey } from '../shared/account-scope';
import { DirectionsBoard } from './directions';
import { CliConnectionNotice } from './cli-connection-notice';
import { ForkSubsessionDialog, SubsessionPanel, SubsessionReportDialog } from './subsessions';
import { BetaFeaturesModal, betaFeatureStates } from './beta-features';
import './cli-connection-notice.css';
import { contentAliasKey, titleSubject } from '../shared/content';
import { clampComposerHeight, COMPOSER_HEIGHT_STEP, composerHeightAfterDrag, DEFAULT_COMPOSER_HEIGHT, maxComposerHeight, MIN_COMPOSER_HEIGHT } from './composer-resize';
document.title = clientWindowTitle('用户版');
let personalSelected = true;
const rawApi = window.workbench;
const api = { ...rawApi, call: <T = unknown,>(action: string, payload?: unknown) => rawApi.call<T>(personalSelected && !['snapshot', 'workspace.select', 'remote.connect', 'remote.disconnect', 'remote.password', 'window.new', 'layout.sidebar', 'local.move'].includes(action) ? 'personal:' + action : action, payload) };
const bytes = (n: number) => n < 1024 ? n + ' B' : n < 1024 ** 2 ? (n / 1024).toFixed(1) + ' KB' : (n / 1024 ** 2).toFixed(1) + ' MB';
const providerLabel = (p: Provider) => p === 'codex' ? 'Codex · GPT' : p === 'claude' ? 'Claude Code' : 'Cursor';
const providerGlyph = (p: Provider) => p === 'codex' ? 'G' : p === 'claude' ? 'A' : 'C';
const statusLabels = { idle: '就绪', starting: '连接 CLI', running: '处理中', approval: '等待操作确认', error: '需要处理' };
const DEFAULT_SIDEBAR_PANES = { workgroups: 180, files: 220, sessions: 240 };
const MIN_SIDEBAR_PANE_HEIGHT = 80, MAX_SIDEBAR_PANE_HEIGHT = 2000;
type SidebarPaneName = keyof typeof DEFAULT_SIDEBAR_PANES;
function ComposerResizeHandle({ height, resize }: { height: number; resize: (height: number) => void }) {
  const limit = maxComposerHeight();
  const begin = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startY = event.clientY, start = height, viewport = window.innerHeight;
    const apply = (clientY: number) => resize(composerHeightAfterDrag(start, startY, clientY, viewport));
    const move = (next: PointerEvent) => apply(next.clientY);
    const finish = (next: PointerEvent) => { apply(next.clientY); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };
  return <button type="button" className="composer-resize" role="separator" aria-label="调整输入框高度" aria-orientation="horizontal" aria-valuemin={MIN_COMPOSER_HEIGHT} aria-valuemax={limit} aria-valuenow={height} title="向上拖动加高，向下拖动降低；双击恢复默认" onPointerDown={begin} onDoubleClick={() => resize(DEFAULT_COMPOSER_HEIGHT)} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(clampComposerHeight(height + (event.key === 'ArrowUp' ? COMPOSER_HEIGHT_STEP : -COMPOSER_HEIGHT_STEP))); } }}><span/></button>;
}
function SidebarSplitter({ label, controls, value, fallback, resize, begin }: { label: string; controls: string; value: number; fallback: number; resize: (height: number, persist?: boolean) => void; begin: (event: React.PointerEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className="sidebar-splitter" role="separator" aria-label={label} aria-orientation="horizontal" aria-controls={controls} aria-valuemin={MIN_SIDEBAR_PANE_HEIGHT} aria-valuemax={MAX_SIDEBAR_PANE_HEIGHT} aria-valuenow={value} title="上下拖动只调整这一块的高度，不会带动旁边的区域；双击恢复默认" onPointerDown={begin} onDoubleClick={() => resize(fallback, true)} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(value + (event.key === 'ArrowUp' ? -24 : 24), true); } }}><span/></button>;
}
function Modal({ title, children, close, wide = false }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) { return <div className="modal-backdrop"><section className={'modal ' + (wide ? 'wide' : '')}><header><h2>{title}</h2><button className="icon" aria-label="关闭窗口" onClick={close}><X size={19}/></button></header>{children}</section></div>; }
function SessionRenameModal({ session, close, saved }: { session: AgentSession; close: () => void; saved: () => Promise<void> }) {
  const [title, setTitle] = useState(session.title), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="重命名会话" close={close}><div className="modal-body"><label className="field">会话名称<input autoFocus aria-label="会话名称" maxLength={120} value={title} onChange={event => setTitle(event.target.value)}/></label><p className="muted small">新名称会用于本机列表；之后上传的成果和轨迹也会把它作为来源会话名展示给团队成员。</p>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" onClick={close}>取消</button><button className="primary" disabled={busy || !title.trim() || title.trim() === session.title} onClick={async () => { setBusy(true); setError(''); try { await api.call('session.rename', { id: session.id, title: title.trim() }); await saved(); close(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{busy ? '正在保存…' : '保存名称'}</button></footer></Modal>;
}
function SessionNetworkModal({ session, auth, egress, activeTaskCount, busy, busyChanged, close }: { session: AgentSession; auth: ProviderAuth; egress?: UserEgressStatus; activeTaskCount: number; busy: boolean; busyChanged: (busy: boolean) => void; close: () => void }) {
  const [route, setRoute] = useState<SessionNetworkRoute>(session.networkRoute || 'direct');
  return <Modal title="网络与登录" wide close={close}><div className="modal-body"><p className="muted small">{session.title} · {providerLabel(session.provider)}</p><ProviderConnectionSettings provider={session.provider} cwd={session.cwd} auth={auth} egress={egress} sessionRoute={route} savedRoute={session.networkRoute || 'direct'} sessionId={session.id} routeChanged={setRoute} activeTaskCount={activeTaskCount} busyChanged={busyChanged}/></div><footer><button className="secondary" disabled={busy} onClick={close}>返回会话</button></footer></Modal>;
}
function ConclusionMatchModal({ matches, close, confirm, skip }: { matches: ConclusionMatch[]; close: () => void; confirm: (ids: string[]) => Promise<void>; skip: () => Promise<void> }) {
  const [selected, setSelected] = useState(matches.slice(0, 5).map(item => item.conclusion.id)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <Modal title="选择这次会话要参考的项目成果" close={close} wide><div className="modal-body"><p className="muted">根据你刚才的问题，以下项目成果可能有帮助。只会把你勾选的内容带入本次会话。</p>{error && <div className="inline-error" role="alert">{error}</div>}<div className="conclusion-match-list">{matches.map(match => <label className="conclusion-match-option" key={match.conclusion.id}><input type="checkbox" aria-label={`带入成果：${conclusionTitle(match.conclusion)}`} checked={selected.includes(match.conclusion.id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, match.conclusion.id])] : current.filter(id => id !== match.conclusion.id))}/><span><b>{conclusionTitle(match.conclusion)}</b>{match.conclusion.titleAlias && <small>原名：{match.conclusion.title}</small>}<small>{match.reasons.join('；')} · v{match.conclusion.version}</small><p>{resultPreview(match.conclusion.content)}</p></span></label>)}</div></div><footer><button className="secondary" disabled={busy} onClick={() => void run(skip)}>不带入成果，直接发送</button><button className="primary" disabled={busy || !selected.length} onClick={() => void run(() => confirm(selected))}>{busy ? '正在带入…' : `带入 ${selected.length} 条并发送`}</button></footer></Modal>;
}
function App() {
  const [state, setState] = useState<Snapshot>(), [error, setError] = useState('');
  const sequence = useRef(0), viewAccount = useRef('');
  const refresh = async () => {
    const request = ++sequence.current;
    try { const next = await api.call<Snapshot>('snapshot'); if (request === sequence.current) { setState(next); setError(''); } }
    catch (error: any) { if (request === sequence.current) setError(error.message); }
  };
  useEffect(() => { void refresh(); return api.subscribe(event => { if (event.type === 'state') void refresh(); }); }, []);
  if (!state) return <div className="boot"><Layers size={34}/><p>{error || '正在启动团队工作台…'}</p></div>;
  // A saved profile can change before login finishes writing its local snapshot.
  // Keep the login dialog mounted until that transition has committed.
  if (!state.accountChanging) viewAccount.current = snapshotAccountKey(state);
  // Remount the entire account view: selections, dialogs, previews and callbacks
  // from the previous account must not become state in the next account's view.
  return <AccountWorkspace key={viewAccount.current} state={state} refresh={refresh}/>;
}
function AccountWorkspace({ state, refresh }: { state: Snapshot; refresh: () => Promise<void> }) {
  const [questionPanel, setQuestionPanel] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'updates' | 'sessions' | 'drafts' | 'transfers' | 'results' | 'assignments' | 'directions' | 'rsi'>('sessions'); const activeView = useRef(view); const [sessionId, setSessionId] = useState('');
  const activityPanel = useRef<ActivityPanelHandle>(null); const selectedSession = useRef('');
  const [resultsScope, setResultsScope] = useState<ResultScope>('team');
  const [projectId, setProjectId] = useState(PERSONAL_PROJECT_ID); const [personalGroup, setPersonalGroup] = useState('');
  const [organizing, setOrganizing] = useState<AgentSession>(); const [moving, setMoving] = useState<MoveSelection>(); const [remoteDir, setRemoteDir] = useState(''); const [entries, setEntries] = useState<RemoteEntry[]>([]); const [fileError, setFileError] = useState(''); const [loadingFiles, setLoadingFiles] = useState(false);
  const [preview, setPreview] = useState<FilePreview>(); const [previewOrigin, setPreviewOrigin] = useState(''); const [search, setSearch] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false); const [betaOpen, setBetaOpen] = useState(false); const [connectOpen, setConnectOpen] = useState(!state.connection?.connected); const [newOpen, setNewOpen] = useState(false); const [nativeProvider, setNativeProvider] = useState<'codex' | 'cursor' | ''>('');
  const [busy, setBusy] = useState(false); const [inputVersion, updateInputs] = useState(0); const localInputs = useRef<Record<string, SessionInput>>({}); const [sendingIds, setSendingIds] = useState<string[]>([]); const submittingInputs = useRef(new Set<string>()); const matchingInputs = useRef(new Set<string>()); const [inputError, setInputError] = useState('');
  const [pendingMessages, setPendingMessages] = useState<Record<string, PendingMessage>>({});
  const [handoff, setHandoff] = useState<{ id: string; text: string }>(); const [handoffPickerId, setHandoffPickerId] = useState(''); const [journalId, setJournalId] = useState(''); const [deletingSession, setDeletingSession] = useState<AgentSession>(); const [history, setHistory] = useState<{ id: string; text: string }>();
  const [forkingSession, setForkingSession] = useState<AgentSession>(); const [reportingSession, setReportingSession] = useState<AgentSession>();
  const [draftId, setDraftId] = useState(''), [draftReturnToList, setDraftReturnToList] = useState(false);
  const [deletingDraft, setDeletingDraft] = useState<Draft>();
  const [activityResult, setActivityResult] = useState<ContentUpdate>();
  const [updateFilters, setUpdateFilters] = useState<ContentUpdateFilters>({ scope: 'pending', filter: 'all' });
  const [networkSessionId, setNetworkSessionId] = useState('');
  const [networkBusy, setNetworkBusy] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<{ id: string; path?: string }>();
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([]), [assignmentError, setAssignmentError] = useState(''), [assignmentLoading, setAssignmentLoading] = useState(false), [startingAssignment, setStartingAssignment] = useState<ProjectAssignment>();
  const assignmentSequence = useRef(0);
  const [libraryFocus, setLibraryFocus] = useState<{ projectId: string; path: string }>(); const [contentUpdates, setContentUpdates] = useState<ContentUpdate[]>([]);
  const [conclusionFocus, setConclusionFocus] = useState<{ projectId: string; id: string }>();
  const [conclusionMatch, setConclusionMatch] = useState<{ sessionId: string; text: string; sourceIds: string[]; capabilities: AgentCapabilitySelection[]; matches: ConclusionMatch[] }>();
  const [detachingSourceId, setDetachingSourceId] = useState('');
  const [steeringReview, setSteeringReview] = useState<SteeringReview>(), [steeringError, setSteeringError] = useState('');
  const [dismissedUpdateIds, setDismissedUpdateIds] = useState<string[]>([]);
  const [showClosed, setShowClosed] = useState(false), [closingSession, setClosingSession] = useState<AgentSession>();
  const [renamingSession, setRenamingSession] = useState<AgentSession>();
  const [preparingSession, setPreparingSession] = useState<AgentSession>();
  const [briefOpen, setBriefOpen] = useState(false);
  const [projectSettings, setProjectSettings] = useState<{ id: string; contextKey: string }>();
  const [toolsSessionId, setToolsSessionId] = useState<string>();
  const [groupDialog, setGroupDialog] = useState<string | null>();
  const [projectCreateOpen, setProjectCreateOpen] = useState(false), [createGroup, setCreateGroup] = useState('');
  const [onboarding, setOnboarding] = useState<{ groupName: string; contextKey: string }>(); const autoPrompted = useRef(false);
  const [groupsError, setGroupsError] = useState(''), [groupsBusy, setGroupsBusy] = useState(false); const groupsLoading = useRef(false);
  const [fileRefreshVersion, setFileRefreshVersion] = useState(0);
  const fileRequest = useRef(0), previewRequest = useRef(0), scroller = useRef<HTMLDivElement>(null);
  const sidebarLayoutLoaded = useRef(false), workgroupList = useRef<HTMLDivElement>(null), fileList = useRef<HTMLDivElement>(null), sessionList = useRef<HTMLDivElement>(null);
  const [sidebarPanes, setSidebarPanes] = useState(DEFAULT_SIDEBAR_PANES);
  const [composerHeight, setComposerHeight] = useState(DEFAULT_COMPOSER_HEIGHT);
  const resizeComposer = (height: number) => setComposerHeight(clampComposerHeight(height));
  const resizeSidebarPane = (pane: SidebarPaneName, height: number, persist = false) => {
    const next = Math.round(Math.max(MIN_SIDEBAR_PANE_HEIGHT, Math.min(height, MAX_SIDEBAR_PANE_HEIGHT)));
    setSidebarPanes(current => ({ ...current, [pane]: next }));
    if (persist) void api.call('layout.sidebar', { [pane]: next }).catch((error: Error) => setNotice('左侧布局保存失败：' + error.message));
  };
  const beginSidebarResize = (pane: SidebarPaneName, event: React.PointerEvent<HTMLButtonElement>) => {
    const list = pane === 'workgroups' ? workgroupList.current : pane === 'files' ? fileList.current : sessionList.current;
    if (!list) return; const top = list.getBoundingClientRect().top; event.preventDefault();
    const move = (next: PointerEvent) => resizeSidebarPane(pane, next.clientY - top);
    const finish = (next: PointerEvent) => { resizeSidebarPane(pane, next.clientY - top, true); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
  };
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => { try { return await fn(); } catch (e: any) { setNotice(e.message); return undefined; } };
  useEffect(() => { activeView.current = view; }, [view]);
  useEffect(() => api.subscribe(event => { if (event.type === 'questions') setView('updates'); if (event.type === 'notice' && !(activeView.current === 'drafts' && /整理(?:完成|失败)/.test(event.message))) setNotice(event.message); }), []);
  useEffect(() => { if (state) setContentUpdates([...(state.settings.contentUpdates || [])].sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))); }, [state?.settings.contentUpdates]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 8000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (view === 'drafts' && /整理(?:完成|失败)/.test(notice)) setNotice(''); }, [view, notice]);
  useEffect(() => { if (!state || sidebarLayoutLoaded.current) return; sidebarLayoutLoaded.current = true; const saved = state.settings.sidebarPanes; setSidebarPanes({ workgroups: saved?.workgroups || DEFAULT_SIDEBAR_PANES.workgroups, files: saved?.files || DEFAULT_SIDEBAR_PANES.files, sessions: saved?.sessions || DEFAULT_SIDEBAR_PANES.sessions }); }, [state]);
  const connection = state?.connection, teamProjects = connection?.connected ? connection.profile.projects : state?.settings.workspaceSnapshot?.profile.projects || [];
  const projects = [personalProfile.projects[0], ...teamProjects], project = projects.find(p => p.id === projectId);
  const personal = projectId === PERSONAL_PROJECT_ID; personalSelected = personal;
  const ownState = personal && state.personal ? state.personal : state;
  const activeSettings = ownState.settings, activeAuth = ownState.auth, activeProviders = ownState.providers, activeEgress = ownState.egress;
  const personalSessions = state.sessions.filter(session => session.purpose === 'work' && isPersonalBinding(session.binding));
  const personalGroups = state.settings.personalGroups || [];
  const movingFamily = moving ? personalFamilyIds(state.sessions, personalSessions.filter(item => moving.sessionId ? item.id === moving.sessionId : item.personalGroupId === moving.groupId).map(item => item.id)) : new Set<string>();
  useEffect(() => { void api.call('workspace.select', { personal }); }, [personal]);
  useEffect(() => { if (personalGroup && personalGroup !== '*' && !personalGroups.some(group => group.id === personalGroup)) setPersonalGroup(''); }, [JSON.stringify(personalGroups)]);
  const teamDirectoryProfile = connection?.connected ? connection.profile : state?.settings.workspaceSnapshot?.profile;
  const directoryProfile = personal ? personalProfile : teamDirectoryProfile;
  const projectContextKey = directoryProfile && project ? projectDirectoryKey(directoryProfile, project.id) : '';
  const currentProjectDirectory = state && directoryProfile && project ? personal ? '' : projectDirectory(state.settings, directoryProfile, project.id) : undefined;
  const settingsProject = teamDirectoryProfile && projectSettings && teamProjects.find(p => p.id === projectSettings.id && projectDirectoryKey(teamDirectoryProfile, p.id) === projectSettings.contextKey);
  const workspaces = connection?.connected ? connection.workspaces || [] : state?.settings.workspaceSnapshot?.workspaces || [];
  const creatableGroups = connection?.connected ? workspaces.filter(w => w.canCreateProject && !w.accessError) : [];
  const projectAdmin = !!workspaces.find(w => w.groupName === project?.groupName)?.canCreateProject;
  const refreshAssignments = async () => {
    const sequence = ++assignmentSequence.current;
    if (personal || !project || !connection?.connected) { setAssignments([]); setAssignmentLoading(false); return; }
    setAssignmentLoading(true);
    try { const items = await api.call<ProjectAssignment[]>('assignment.list', { projectId: project.id }); if (sequence === assignmentSequence.current) { setAssignments(items); setAssignmentError(''); } }
    catch (error: any) { if (sequence === assignmentSequence.current) setAssignmentError(error.message); }
    finally { if (sequence === assignmentSequence.current) setAssignmentLoading(false); }
  };
  useEffect(() => {
    setAssignments([]); setAssignmentError(''); void refreshAssignments();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshAssignments(); }, 60000);
    return () => { assignmentSequence.current++; clearInterval(timer); };
  }, [project?.id, projectAdmin, connection?.connected, connection?.profile.id, connection?.profile.username]);
  const myPendingTasks = assignments.filter(task => task.assignee === connection?.profile.username && !task.deletedAt && !task.purgedAt && ['assigned', 'in_progress', 'pending_review'].includes(task.status));
  const openCreate = (groupName = '') => {
    const workspace = creatableGroups.find(w => w.groupName === groupName);
    if (workspace?.isEmpty && connection?.connected) { autoPrompted.current = true; setOnboarding({ groupName, contextKey: projectSetupIdentity(connection.profile, groupName) }); }
    else { setCreateGroup(groupName); setProjectCreateOpen(true); }
  };
  const onboardingWorkspace = workspaces.find(w => w.groupName === onboarding?.groupName && connection && projectSetupIdentity(connection.profile, w.groupName!) === onboarding?.contextKey);
  useEffect(() => { autoPrompted.current = false; setOnboarding(undefined); }, [connection?.connected, connection?.profile.id, connection?.profile.username, connection?.profile.fingerprint, connection?.profile.host, connection?.profile.port, connection?.profile.localRoot]);
  useEffect(() => {
    if (personal || !state?.workspaceReady || !connection?.connected || connectOpen || settingsOpen || betaOpen || newOpen || projectCreateOpen || onboarding || handoff || history || autoPrompted.current) return;
    const first = creatableGroups.find(w => w.isEmpty);
    if (first?.groupName) { autoPrompted.current = true; setOnboarding({ groupName: first.groupName, contextKey: projectSetupIdentity(connection.profile, first.groupName) }); }
  }, [state?.workspaceReady, connection?.connected, connectOpen, settingsOpen, betaOpen, newOpen, projectCreateOpen, onboarding, handoff, history, JSON.stringify(creatableGroups)]);
  const betaFeatures = activeSettings.betaFeatures?.[personal ? accountIdentity(personalProfile) : snapshotAccountKey(state)] || {};
  const { sessionHandoff: sessionHandoffBetaEnabled, subsessions: subsessionsBetaEnabled, codexDesktopSync: codexDesktopBetaEnabled, cursorDesktopSync: cursorDesktopBetaEnabled } = betaFeatureStates(betaFeatures);
  const session = state?.sessions.find(s => s.id === sessionId), draft = state?.drafts.find(d => d.id === draftId);
  const questionPanelSession = useRef('');
  useEffect(() => {
    if (!session?.id) return;
    if (questionPanelSession.current === session.id) return;
    const previous = questionPanelSession.current;
    questionPanelSession.current = session.id;
    if (!previous || !questionPanel) return;
    const username = connection?.profile.username || state.settings.workspaceSnapshot?.profile.username || '';
    const mine = (state.questions?.items || []).filter(q => q.projectId === session.binding?.project.id && (q.sessionId === session.id || q.recipients.some(r => r.username === username && r.sessionId === session.id)));
    const still = mine.some(q => q.id === questionPanel);
    setQuestionPanel(still ? questionPanel : mine.length === 1 ? mine[0].id : 'session');
  }, [session?.id, questionPanel, state.questions, connection?.profile.username, state.settings.workspaceSnapshot?.profile.username]);
  const autoLock = session ? questionAutoLock(state.questions, session.id) : undefined;
  useSessionCompletionRead(view === 'sessions' && !state.accountChanging ? session : undefined,
    (id, completionId) => api.call('session.completion.read', { id, completionId }),
    error => setNotice('会话已读状态保存失败：' + error.message));
  selectedSession.current = session?.id || '';
  const networkSession = state?.sessions.find(s => s.id === networkSessionId);
  const networkActiveTasks = state?.sessions.filter(s => s.networkRoute === 'management' && ['starting', 'running', 'approval'].includes(s.status)).length || 0;
  const acceptedSources = session ? acceptedSessionContext(session).sourceHashes : {};
  const references = uniqueSources(session?.sources || []);
  const pendingSources = references.filter(source => acceptedSources[source.id] !== source.sha256);
  const includedSources = references.filter(source => acceptedSources[source.id] === source.sha256);
  const workSessions = state.sessions.filter(s => s.purpose === 'work' && (personal ? isPersonalBinding(s.binding) && (personalGroup === '*' || (s.personalGroupId || '') === personalGroup) : !isPersonalBinding(s.binding) && s.binding?.project.groupName === project?.groupName));
  const preparingCount = state?.drafts.filter(d => !d.submitted && d.generation === 'running').length || 0;
  const readyCount = state?.drafts.filter(needsPreparationConfirmation).length || 0;
  const sessionDraft = state?.drafts.find(d => d.sessionId === sessionId && !d.submitted);
  const visibleSessions = (() => {
    const candidates = workSessions.filter(s => showClosed ? !!s.closedAt : !s.closedAt), ordered: AgentSession[] = [], seen = new Set<string>();
    const visit = (value: AgentSession) => { if (seen.has(value.id)) return; seen.add(value.id); ordered.push(value); candidates.filter(child => child.fork?.parentId === value.id).forEach(visit); };
    candidates.filter(value => !value.fork || !candidates.some(parent => parent.id === value.fork?.parentId)).forEach(visit);
    candidates.forEach(visit); return ordered;
  })();
  const sessionChildren = session ? workSessions.filter(value => value.fork?.parentId === session.id) : [];
  const mergeSessions = project ? workSessions.filter(s => s.binding?.project.id === project.id).sort((a, b) => a.id === sessionId ? -1 : b.id === sessionId ? 1 : 0) : [];
  const attachSessions = project ? workSessions.filter(s => s.binding?.project.id === project.id && !s.closedAt) : [];
  const waitingSessions = state?.sessions.filter(s => s.approvals.length > 0 && !s.closedAt) || [];
  const waitingQuestions = waitingSessions.filter(s => s.approvals.some(isQuestionRequest));
  const waitingPlans = waitingSessions.filter(s => s.approvals.some(isPlanRequest));
  const waitingApprovals = waitingSessions.filter(s => s.approvals.some(a => !isQuestionRequest(a) && !isPlanRequest(a)));
  useEffect(() => { if (!visibleSessions.some(s => s.id === sessionId)) setSessionId(visibleSessions[0]?.id || ''); }, [JSON.stringify(visibleSessions.map(s => s.id))]);
  const currentInput = localInputs.current[sessionId] || state?.inputs[sessionId] || { text: '', sourceIds: [], answers: {}, capabilities: [] };
  const composer = currentInput.text, selectedSources = currentInput.sourceIds, selectedCapabilities = currentInput.capabilities || [];
  const selectedSourceKeys = new Set(session?.sources.filter(source => selectedSources.includes(source.id)).map(sourceIdentity));
  const automaticSourceKeys = new Set(session?.sources.filter(source => source.id === session.projectBrief?.sourceId || session.assignment?.sourceIds.includes(source.id) || session.fork?.sourceId === source.id || session.fork?.inheritedSourceIds.includes(source.id) || isConclusionSource(source) || source.sourcePath.startsWith('question:')).map(sourceIdentity));
  const editInput = (id: string, patch: Partial<SessionInput>) => {
    const value = { ...(localInputs.current[id] || state?.inputs[id] || { text: '', sourceIds: [], answers: {} }), ...patch };
    localInputs.current[id] = value; updateInputs(n => n + 1);
    void api.call('session.input', { id, input: value }).then(() => setInputError(''), (e: Error) => setInputError('输入保存失败，请保留当前窗口并重试：' + e.message));
  };
  const setComposer = (text: string) => editInput(sessionId, { text });
  const setSelectedSources = (sourceIds: string[]) => editInput(sessionId, { sourceIds });
  const toggleSource = (source: SourceFile) => {
    const key = sourceIdentity(source), duplicates = new Set(session?.sources.filter(item => sourceIdentity(item) === key).map(item => item.id));
    setSelectedSources(selectedSourceKeys.has(key) ? selectedSources.filter(id => !duplicates.has(id)) : [...selectedSources, source.id]);
  };
  const detachPendingSource = async (source: SourceFile) => {
    if (!session || detachingSourceId) return;
    const id = session.id; setDetachingSourceId(source.id);
    try {
      const result = await api.call<{ sourceIds: string[] }>('session.detachPendingSource', { id, sourceId: source.id });
      const removed = new Set(result.sourceIds), current = localInputs.current[id] || state?.inputs[id];
      if (current) localInputs.current[id] = { ...current, sourceIds: current.sourceIds.filter(value => !removed.has(value)) };
      updateInputs(value => value + 1);
      setNotice(`已从会话撤销“${source.name}”，模型未收到这份参考内容`);
    } catch (error: any) { setNotice('撤销失败：' + error.message); }
    finally { setDetachingSourceId(''); }
  };
  const setSelectedCapabilities = (capabilities: AgentCapabilitySelection[]) => editInput(sessionId, { capabilities });
  useEffect(() => { if (!projects.some(p => p.id === projectId)) setProjectId(projects[0]?.id || ''); }, [connection?.connected, JSON.stringify(projects)]);
  useEffect(() => { setPreview(undefined); previewRequest.current++; setRemoteDir(project?.remoteRoot || ''); }, [projectId, connection?.profile.id, connection?.profile.username]);
  const loadGroups = async (interactive = false) => {
    if (groupsLoading.current || !connection) return;
    groupsLoading.current = true; setGroupsBusy(true);
    try { await api.call('remote.manifest'); setGroupsError(''); if (interactive) { setFileRefreshVersion(version => version + 1); setNotice('账号身份与工作组已刷新'); } }
    catch (e: any) { setGroupsError(e.message); if (interactive && /重新登录/.test(e.message)) setConnectOpen(true); }
    finally { groupsLoading.current = false; setGroupsBusy(false); }
  };
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') void loadGroups(); }, 30000); return () => clearInterval(timer); }, [connection?.connected, connection?.profile.id, connection?.profile.username]);
  useEffect(() => {
    if (!connection?.connected) return;
    void api.call('activity.project', { projectId }).catch(e => setNotice(e.message));
  }, [projectId, connection?.connected, connection?.profile.id, connection?.profile.username]);
  useEffect(() => setGroupsError(''), [connection?.profile.id, connection?.profile.username, connection?.connected]);
  const loadFiles = async () => {
    const n = ++fileRequest.current; if (personal || !state?.workspaceReady || !project || !remoteDir) { setEntries([]); setFileError(''); setLoadingFiles(false); return; }
    setLoadingFiles(true); setFileError('');
    try { const items = await api.call<RemoteEntry[]>('remote.list', { projectId: project.id, path: remoteDir }); if (fileRequest.current === n) setEntries(items); }
    catch (e: any) { if (fileRequest.current === n) { setFileError(e.message); setEntries([]); } }
    finally { if (fileRequest.current === n) setLoadingFiles(false); }
  };
  useEffect(() => { void loadFiles(); return () => { fileRequest.current++; }; }, [remoteDir, projectId, connection?.connected, state?.workspaceReady, fileRefreshVersion]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible' && connection?.connected) void loadFiles(); }, 30000); return () => clearInterval(timer); }, [remoteDir, projectId, connection?.connected, state?.workspaceReady]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [sessionId, session?.approvals.length, session?.messages.length, session?.messages.at(-1)?.text, pendingMessages[sessionId]]);
  const selectSession = (s: AgentSession) => { setSessionId(s.id); setView('sessions'); if (s.binding && projects.some(p => p.id === s.binding!.project.id)) { setProjectId(s.binding.project.id); if (isPersonalBinding(s.binding)) setPersonalGroup(s.personalGroupId || ''); } if (s.nativeLive && !['starting', 'running', 'approval'].includes(s.status)) void api.call('session.native.refresh', { id: s.id }).then(() => refresh(), () => {}); };
  const startAssignedTask = (task: ProjectAssignment) => {
    const existing = state?.sessions.find(session => session.assignment?.id === task.id && session.binding?.project.id === task.projectId && !session.closedAt);
    if (existing) { selectSession(existing); return; }
    setStartingAssignment(task); setNewOpen(true);
  };
  const viewShared = (targetProjectId: string, targetPath: string) => { setActivityResult(undefined); setProjectId(targetProjectId); setLibraryFocus({ projectId: targetProjectId, path: targetPath }); setResultsScope('team'); setView('results'); };
  const viewActivityResult = (item: ContentUpdate) => { setProjectId(item.projectId); setLibraryFocus(undefined); setActivityResult(item); setResultsScope('team'); setView('results'); };
  const openResults = (scope: ResultScope = resultsScope) => { setActivityResult(undefined); setLibraryFocus(undefined); setConclusionFocus(undefined); setResultsScope(scope); setView('results'); };
  const unreadContentUpdates = contentUpdates.filter(item => !item.readAt);
  const unreadDynamics = unreadContentUpdates.length + (state.questions?.items.filter(q => questionUnread(q, state.questions!)).length || 0);
  const visibleUpdateToast = unreadContentUpdates.find(item => !['new', 'updated', 'merged'].includes(item.change) && !dismissedUpdateIds.includes(item.eventId) && !state?.settings.dismissedContentUpdateIds?.includes(item.eventId));
  const sendInput = async (id: string, sent: SessionInput, expectedTurnId?: string) => {
    if (submittingInputs.current.has(id)) return;
    submittingInputs.current.add(id);
    setSendingIds(ids => [...ids, id]);
    setPendingMessages(messages => ({ ...messages, [id]: { text: sent.text, beforeMessageCount: state?.sessions.find(session => session.id === id)?.messages.length || 0, phase: 'submitting' } }));
    try { return await submitComposerInput(api, id, sent, expectedTurnId, () => localInputs.current[id] || state?.inputs[id] || sent, target => editInput(target, { text: '', sourceIds: [], capabilities: [] })); }
    catch (error: any) { setNotice(error.message); if (expectedTurnId) setSteeringError(error.message); return false; }
    finally { submittingInputs.current.delete(id); setSendingIds(ids => ids.filter(x => x !== id)); setPendingMessages(messages => { if (messages[id]?.phase === 'question') return messages; const next = { ...messages }; delete next[id]; return next; }); }
  };
  const send = async () => {
    if (steeringReview || detachingSourceId || !session || session.closedAt || !composer.trim() || submittingInputs.current.has(session.id) || matchingInputs.current.has(session.id)) return;
    const mode = composerMode(session, state?.activeTurns?.[session.id]);
    if (mode === 'wait') return;
    if (mode === 'steer') {
      setSteeringError('');
      setSteeringReview(prepareSteeringReview(session, currentInput, state!.activeTurns![session.id], pendingSources.filter(source => selectedSourceKeys.has(sourceIdentity(source)) || automaticSourceKeys.has(sourceIdentity(source))).map(source => source.name)));
      return;
    }
    if (activityPanel.current?.beforeSend()) return;
    const sent = { ...currentInput };
    if (!session.cursorNative && !session.messages.length && session.binding) {
      matchingInputs.current.add(session.id);
      setPendingMessages(messages => ({ ...messages, [session.id]: { text: sent.text, beforeMessageCount: session.messages.length, phase: 'matching' } }));
      try {
        const candidates = await run(() => api.call<ConclusionMatch[]>('conclusion.match', { projectId: session.binding!.project.id, query: sent.text }));
        const matches = candidates?.filter(match => !attachedConclusion(session, match.conclusion.id));
        if (matches?.length) { setPendingMessages(messages => { const next = { ...messages }; delete next[session.id]; return next; }); setConclusionMatch({ sessionId: session.id, text: sent.text, sourceIds: sent.sourceIds, capabilities: sent.capabilities || [], matches }); return; }
      } finally { matchingInputs.current.delete(session.id); }
    }
    await sendInput(session.id, sent);
  };
  const placeQuestion = (sessionId: string, text: string) => {
    const count = state?.sessions.find(item => item.id === sessionId)?.messages.length || 0;
    setPendingMessages(messages => ({ ...messages, [sessionId]: { text, beforeMessageCount: count, phase: 'question' } }));
  };
  const unplaceQuestion = (sessionId: string) => setPendingMessages(messages => { if (messages[sessionId]?.phase !== 'question') return messages; const next = { ...messages }; delete next[sessionId]; return next; });
  const openFile = async (item: RemoteEntry) => {
    if (item.kind === 'directory') { setRemoteDir(item.path); return; }
    if (item.kind === 'link') { setNotice('第一版不直接打开符号链接，请管理员提供实际目录或文件入口'); return; }
    const n = ++previewRequest.current; const selectedProject = projectId;
    const result = await run(() => api.call<FilePreview>('remote.preview', { projectId: selectedProject, path: item.path }));
    if (result && n === previewRequest.current) { setPreview(result); setPreviewOrigin(selectedProject); }
  };
  if (!state) return <div className="boot"><Layers size={34}/><p>正在启动团队工作台…</p></div>;
  return <div className="app">
    <nav className="rail">
      <div className="brand-mark" data-tooltip="团队工作台"><Layers size={25}/></div>
      <button className={'rail-feature ' + (view === 'assignments' ? 'active' : '')} title={projectAdmin ? '项目任务' : '我的任务'} aria-label={projectAdmin ? '项目任务' : '我的任务'} disabled={personal || !project || !connection?.connected} onClick={() => { setView('assignments'); void refreshAssignments(); }}><ClipboardList size={22}/><span>任务</span>{myPendingTasks.length > 0 && <b>{Math.min(myPendingTasks.length, 99)}</b>}</button>
      <button className={'rail-feature ' + (view === 'updates' ? 'active' : '')} title="团队动态" data-tooltip="团队动态" aria-label="团队动态" onClick={() => connection?.connected ? setView('updates') : setConnectOpen(true)}><BellRing size={22}/><span>动态</span>{unreadDynamics > 0 && <b aria-label={`${unreadDynamics} 条待处理团队动态`}>{Math.min(unreadDynamics, 99)}</b>}</button>
      <button className={'rail-feature ' + (view === 'directions' ? 'active' : '')} title="成员名片" data-tooltip="成员名片" aria-label="成员名片" onClick={() => connection?.connected ? setView('directions') : setConnectOpen(true)}><Compass size={22}/><span>成员名片</span></button>
      <button className={'rail-feature ' + (view === 'sessions' ? 'active' : '')} title="工作会话" data-tooltip="工作会话" aria-label="工作会话" onClick={() => setView('sessions')}><MessageSquare size={22}/><span>工作会话</span></button>
      <button className={'rail-feature ' + (view === 'rsi' ? 'active' : '')} title="项目助手" data-tooltip="项目助手" aria-label="项目助手" disabled={!project} onClick={() => setView('rsi')}><Sparkles size={22}/><span>项目助手</span></button>
      <button className={'rail-feature ' + (view === 'results' ? 'active' : '')} title="项目成果库" data-tooltip="项目成果库" aria-label="项目成果库" disabled={!project} onClick={() => openResults(connection?.connected ? resultsScope : 'personal')}><FileText size={22}/><span>项目成果库</span></button>
      <button className={'rail-feature ' + (view === 'drafts' ? 'active' : '')} title="成果整理" data-tooltip="成果整理" aria-label="打开成果整理" onClick={() => { setDraftId(''); setDraftReturnToList(false); setView('drafts'); }}><FileArchive size={22}/><span>成果整理</span>{(preparingCount > 0 || readyCount > 0) && <span className="preparation-nav-badge" aria-label="成果提醒">{preparingCount ? "整理中" : "待确认"}</span>}</button>
      <button className={'rail-feature ' + (view === 'transfers' ? 'active' : '')} title="传输记录" data-tooltip="传输记录" aria-label="传输记录" onClick={() => setView('transfers')}><ArrowUpDown size={22}/><span>传输记录</span></button>
      <div className="rail-spacer"/>
      <button className="rail-feature" title="修改密码" aria-label="修改密码" disabled={!connection?.connected} onClick={() => setPasswordOpen(true)}><ShieldCheck size={22}/><span>改密码</span></button>
      <button className="rail-feature" title="设置" data-tooltip="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}><SettingsIcon size={22}/><span>设置</span></button>
      <span className="avatar" title="当前账号" data-tooltip="当前账号">我</span>
    </nav>
    <div className="shell"><header className="topbar"><div><strong>团队工作台 <span className="version" aria-label="客户端版本">用户版 · v{clientVersion}</span></strong></div><div className="topbar-actions"><AccountSyncStatus state={state.accountSync} connected={!!connection?.connected}/><button className="beta-entry" aria-label="Beta 功能" onClick={() => setBetaOpen(true)}><Sparkles size={14}/>Beta 功能{(sessionHandoffBetaEnabled || subsessionsBetaEnabled || codexDesktopBetaEnabled || cursorDesktopBetaEnabled) && <span className="beta-entry-dot" aria-label="有功能已开启"/>}</button><button className="secondary compact" title="打开登录窗口；同一账号共用本机资料，不同账号相互隔离" onClick={() => void run(async () => { await api.call('window.new'); })}><Plus size={14}/>新建账号窗口</button><button className={'connection-button ' + (connection?.connected ? 'online' : '')} onClick={() => setConnectOpen(true)}><span className="dot"/>{connection?.connected ? `${connection.profile.mode === 'local' ? '本地模拟 · ' : ''}${connection.profile.name} · ${connection.profile.username}` : '连接团队账号'}<ChevronRight size={14}/></button></div></header>
    <div className="body"><aside className="sidebar"><div className="sidebar-project-pane" id="sidebar-project-pane"><div className="sidebar-head"><h3>项目与会话</h3><div className="row"><button className="icon" title="创建项目组" disabled={!connection?.connected} onClick={()=>setGroupDialog(null)}><Plus size={15}/></button><button className="icon" aria-label="刷新工作组、项目和文件" title={connection?.connected ? '刷新工作组、项目和文件' : '重新连接并刷新账号身份'} disabled={!connection || groupsBusy || loadingFiles} onClick={() => void loadGroups(true)}><RefreshCw size={15} className={groupsBusy || loadingFiles ? 'spin' : ''}/></button></div></div>
      {groupsError && <div className="inline-error" role="alert">{groupsError}</div>}
      <div className="workgroup-list" id="sidebar-workgroup-list" ref={workgroupList} style={{ height: sidebarPanes.workgroups }} aria-label="按工作组展示项目"><PersonalSection groups={personalGroups} sessions={personalSessions} active={personal} selected={personalGroup} select={groupId => { setProjectId(PERSONAL_PROJECT_ID); setPersonalGroup(groupId); setView('sessions'); }} move={setMoving} call={api.call} changed={refresh}/>{workspaces.map(w => <section className="workgroup" key={w.groupName} data-group-name={w.groupName}><div className="workgroup-title"><b>{w.groupLabel || w.groupName}</b>{w.role && w.role!=='member' ? <span className="badge">{groupRoleLabels[w.role]}</span> : w.canCreateProject && <span className="badge">管理者</span>}<button className="icon" title={'项目组管理：' + (w.groupLabel || w.groupName)} disabled={!connection?.connected} onClick={()=>setGroupDialog(w.groupName!)}><SettingsIcon size={13}/></button><span className="spacer"/>{w.canCreateProject && <button className="icon" title={'在 ' + (w.groupLabel || w.groupName) + ' 创建项目'} onClick={() => openCreate(w.groupName)}><Plus size={15}/></button>}</div>{w.accessError ? <p className="inline-error">{w.accessError}</p> : projects.filter(p => p.groupName === w.groupName).length ? projects.filter(p => p.groupName === w.groupName).map(p => <div className="workgroup-project-row" key={p.id}><button className={'workgroup-project ' + (p.id === projectId ? 'selected' : '')} data-project-id={p.id} onClick={() => setProjectId(p.id)}><Folder size={15}/><span>{p.name}</span>{p.id === projectId && <Check size={13}/>}</button><button className="icon" title={'项目设置：' + p.name} aria-label={'项目设置：' + p.name} onClick={() => { setProjectId(p.id); setProjectSettings({ id: p.id, contextKey: projectDirectoryKey(teamDirectoryProfile!, p.id) }); }}><SettingsIcon size={14}/></button></div>) : <div><p className="muted small">暂无项目{w.canCreateProject ? '，点击 + 创建' : '，等待管理者创建'}</p>{w.canCreateProject && w.isEmpty && <button className="text-button" onClick={() => openCreate(w.groupName)}>完善项目资料</button>}</div>}</section>)}</div>
      <SidebarSplitter label="调整工作组高度" controls="sidebar-workgroup-list" value={sidebarPanes.workgroups} fallback={DEFAULT_SIDEBAR_PANES.workgroups} resize={(height, persist) => resizeSidebarPane('workgroups', height, persist)} begin={event => beginSidebarResize('workgroups', event)}/>
      {personal ? <div className="personal-side-note"><b>{personalGroup === '*' ? '全部本机会话' : personalGroups.find(group => group.id === personalGroup)?.name || '未分组'}</b>会话和整理成果保存在本机。<button className="text-button" onClick={() => openResults('personal')}>查看个人成果库</button></div> : project ? <><div className="row pad"><button className="text-button" disabled={!connection?.connected} onClick={() => setBriefOpen(true)}>项目说明</button><button className={projectAdmin ? 'secondary compact' : 'text-button'} onClick={() => openResults(connection?.connected ? resultsScope : 'personal')}>项目成果库</button></div><div className="path-row"><button className="icon" title="上一级" disabled={remoteDir === project.remoteRoot} onClick={() => setRemoteDir(remoteDir.slice(0, remoteDir.lastIndexOf('/')) || project.remoteRoot)}><ArrowLeft size={14}/></button><span title={remoteDir}>{remoteDir.replace(project.remoteRoot, '') || '/'}</span><button className="icon" title="上传文件到当前目录" onClick={() => void run(async () => { const count = await api.call<number>('remote.upload', { projectId, folder: remoteDir }); if (count > 0) { setNotice('文件已加入上传队列'); setView('transfers'); } })}><Upload size={15}/></button></div><label className="search"><Search size={14}/><input placeholder="筛选当前目录" value={search} onChange={e => setSearch(e.target.value)}/></label><div className="file-list" id="sidebar-file-list" ref={fileList} style={{ height: sidebarPanes.files }}>{fileError && <div className="inline-error">{fileError}</div>}{!loadingFiles && !entries.length && !fileError && <div className="muted small pad">此目录还没有文件</div>}{entries.filter(f => f.name.toLowerCase().includes(search.toLowerCase())).map(f => <button key={f.path} className={'file-row ' + (preview?.path === f.path ? 'selected' : '')} onClick={() => void openFile(f)} title={f.path}>{f.kind === 'directory' ? <Folder size={17}/> : <FileText size={17}/>}<span>{f.name}</span>{f.kind === 'directory' ? <ChevronRight size={13}/> : <small>{bytes(f.size)}</small>}</button>)}</div><SidebarSplitter label="调整项目文件高度" controls="sidebar-file-list" value={sidebarPanes.files} fallback={DEFAULT_SIDEBAR_PANES.files} resize={(height, persist) => resizeSidebarPane('files', height, persist)} begin={event => beginSidebarResize('files', event)}/></> : <div className="remote-empty"><Server size={29}/><p>{connection?.connected ? groupsError ? '工作组信息读取失败' : workspaces.length ? '选择工作组下的项目' : '还没有加入工作组' : '连接后自动显示工作组'}</p>{connection?.connected && !groupsError && !workspaces.length && <span>请联系管理员将此账号加入工作组。<br/>加入后点击上方刷新即可。</span>}{connection?.connected && creatableGroups.length > 0 && !projects.length && <button className="primary" onClick={() => openCreate(creatableGroups.length === 1 ? creatableGroups[0].groupName : '')}>创建第一个项目</button>}{!connection?.connected && <button className="secondary" onClick={() => setConnectOpen(true)}>连接团队账号</button>}</div>}
      </div>
      <div className="session-heading"><h3>本地会话</h3><div className="row"><button className="icon" title="接入 Codex 会话" aria-label="接入 Codex 会话" disabled={!project} onClick={() => setNativeProvider('codex')}><span className="provider-icon codex">G</span></button><button className="icon" title="接入 Cursor 会话" aria-label="接入 Cursor 会话" disabled={!project} onClick={() => setNativeProvider('cursor')}><span className="provider-icon cursor">C</span></button><button className="icon" title="新建会话" disabled={!project || currentProjectDirectory === undefined} onClick={() => setNewOpen(true)}><Plus size={18}/></button></div></div><div className="session-list" id="sidebar-session-list" ref={sessionList} style={{ height: sidebarPanes.sessions }}>{visibleSessions.map(s => <div className="personal-session-row" key={s.id}><button className={'session-row ' + (s.fork ? 'subsession-row ' : '') + (sessionId === s.id && view === 'sessions' ? 'selected' : '')} key={s.id} data-session-id={s.id} onClick={() => selectSession(s)}><span className={'provider-icon ' + s.provider}>{providerGlyph(s.provider)}</span><span><b>{s.title}</b><small>{s.fork ? `Subsession · ${workSessions.find(parent => parent.id === s.fork?.parentId)?.title || '父会话'} · ` : ''}{s.closedAt ? '已关闭' : providerLabel(s.provider) + (s.nativeLive ? ' · 同一条' : '')}</small></span><SessionStatusIndicator session={s} sending={sendingIds.includes(s.id)}/></button>{isPersonalBinding(s.binding) && <button className="icon" aria-label={'管理会话归属：' + s.title} title="分组或迁移" onClick={() => setOrganizing(s)}><Folder size={14}/></button>}</div>)}{!visibleSessions.length && <p className="muted small pad">{showClosed ? '没有已关闭的会话。' : '没有打开的会话。'}</p>}</div><SidebarSplitter label="调整会话列表高度" controls="sidebar-session-list" value={sidebarPanes.sessions} fallback={DEFAULT_SIDEBAR_PANES.sessions} resize={(height, persist) => resizeSidebarPane('sessions', height, persist)} begin={event => beginSidebarResize('sessions', event)}/><button className="closed-toggle text-button" onClick={() => setShowClosed(!showClosed)}>{showClosed ? '返回打开的会话' : `已关闭会话（${workSessions.filter(s => s.closedAt).length}）`}</button>
    </aside>
    <main className="main-content">
    {!connection?.connected && <div className="callout connection-status" role="status"><div><b>尚未连接中央节点</b><small>本机会话与成果整理可用；团队动态、任务、共享读写及中央中转需要登录。</small></div><button className="secondary" onClick={() => setConnectOpen(true)}>连接团队账号</button></div>}
    {view === 'sessions' && project && myPendingTasks.length > 0 && <div className="callout assignment-welcome"><ClipboardList size={20}/><div><b>你有 {myPendingTasks.length} 项待办任务</b><small>{myPendingTasks[0].title} · 查看任务要求、工作进展与验收状态。</small></div><button className="primary compact" onClick={() => setView('assignments')}>查看我的任务</button></div>}
    {view === 'assignments' && !personal && project && <AssignmentsPanel key={project.id + ':' + connection?.profile.username} project={project} admin={projectAdmin} username={connection?.profile.username || ''} items={assignments} loading={assignmentLoading} loadError={assignmentError} refresh={refreshAssignments} start={startAssignedTask} sessions={mergeSessions} aliases={state.settings.contentAliases || {}}/>}
    {view === 'updates' && <QuestionFeed inbox={state.questions} projects={projects} open={id => { setQuestionPanel(id); setPreview(undefined); }}/>}
    {view === 'updates' && <ContentUpdatesPanel updates={contentUpdates} aliases={state.settings.contentAliases || {}} view={viewActivityResult}
      filters={updateFilters} filtersChanged={setUpdateFilters}
      changed={async () => { setContentUpdates(await api.call<ContentUpdate[]>('content.updates')); await refresh(); }}/>}
    {view === 'directions' && <DirectionsBoard username={connection?.profile.username || ''} connected={!!connection?.connected} connect={() => setConnectOpen(true)}/>}
    {view === 'results' && project && <ProjectResults projectName={project.name} scope={personal ? 'personal' : resultsScope} changeScope={scope => { if (personal && scope === 'team') { setNotice('先将会话迁移到团队项目，再查看对应团队成果'); return; } openResults(scope); }}>
    {(personal || resultsScope === 'personal') && <ConclusionLibrary projects={projects} embedded refreshToken={[state.accountSync?.syncedAt || '', ...(state.publishingConclusions || []), ...state.transfers.filter(task => task.binding.project.id === project.id).map(task => `${task.id}:${task.status}`)].join('|')} key={project.id} project={project} sessions={mergeSessions} notice={setNotice}
      mergeStarted={next => { setDraftReturnToList(false); setDraftId(next.id); setView('drafts'); void refresh(); }}
      focusId={conclusionFocus?.projectId === project.id ? conclusionFocus.id : undefined} focusHandled={() => setConclusionFocus(undefined)}/>}
    {!personal && resultsScope === 'team' && (connection?.connected ? <SharedContentLibrary embedded key={project.id + ':' + (activityResult?.projectId === project.id ? activityResult.eventId : 'all')} project={project} username={connection?.profile.username || ''} admin={projectAdmin} aliases={state.settings.contentAliases || {}} aliasSaved={refresh} notice={setNotice} mergeSessions={mergeSessions}
      activity={activityResult?.projectId === project.id ? contentUpdates.find(item => item.eventId === activityResult.eventId) || activityResult : undefined}
      activityChanged={async () => { setContentUpdates(await api.call<ContentUpdate[]>('content.updates')); await refresh(); }}
      resultId={activityResult?.projectId === project.id ? activityResult.id : undefined} returnToUpdates={() => { setActivityResult(undefined); setView('updates'); }}
      mergeStarted={next => { setDraftReturnToList(false); setDraftId(next.id); setView('drafts'); void refresh(); }} focusPath={libraryFocus?.projectId === project.id ? libraryFocus.path : undefined} focusHandled={() => setLibraryFocus(undefined)} attachSessions={attachSessions}
      attach={async (item, sessionIds) => {
        const names: string[] = [];
        for (const targetId of sessionIds) {
          const target = state.sessions.find(value => value.id === targetId); if (!target) continue;
          const source = await api.call<SourceFile>('session.attachContent', { id: targetId, contentId: item.id });
          const input = localInputs.current[targetId] || state.inputs[targetId] || { text: '', sourceIds: [], answers: {} };
          editInput(targetId, { sourceIds: [...new Set([...input.sourceIds, source.id])] }); names.push(target.title);
        }
        setContentUpdates(await api.call<ContentUpdate[]>('content.updates'));
        const displayTitle = state.settings.contentAliases?.[contentAliasKey(project.id, item.id)] || titleSubject(item.title) || item.title;
        setNotice(`已将“${displayTitle}”加入会话：${names.join('、')}；同时保存到“个人成果库”`);
      }}
    /> : <div className="page-empty"><Server size={32}/><h2>连接后查看团队成果</h2><p>个人成果仍可在“个人”中查看。</p><button className="primary" onClick={() => setConnectOpen(true)}>连接团队账号</button></div>)}
    </ProjectResults>}

    {waitingQuestions.length > 0 && <div className="pending-approvals pending-questions" role="status" aria-label="待回答提醒"><MessageSquare size={17}/><b>{waitingQuestions.reduce((n, s) => n + s.approvals.filter(isQuestionRequest).reduce((total, request) => total + (request.questions?.length || 1), 0), 0)} 个问题需要你回答</b>{waitingQuestions.map(s => <button className="secondary compact" key={s.id} onClick={() => { if (s.purpose === 'prepare') { const d = state.drafts.find(d => d.prepareSessionId === s.id); if (d) { setDraftReturnToList(false); setDraftId(d.id); setView('drafts'); } } else selectSession(s); }}>{s.purpose === 'prepare' ? '成果整理' : s.title} · 查看问题</button>)}</div>}
    {waitingPlans.length > 0 && <div className="pending-approvals" role="status" aria-label="待确认计划"><FileText size={17}/><b>{waitingPlans.length} 个会话的计划等待确认</b>{waitingPlans.map(s => <button className="secondary compact" key={s.id} onClick={() => selectSession(s)}>{s.title} · 查看计划</button>)}</div>}
    {waitingApprovals.length > 0 && <div className="pending-approvals" role="status" aria-label="待授权提醒"><ShieldCheck size={17}/><b>{waitingApprovals.reduce((n, s) => n + s.approvals.filter(a => !isQuestionRequest(a) && !isPlanRequest(a)).length, 0)} 项操作等待你的授权</b>{waitingApprovals.map(s => <button className="secondary compact" key={s.id} onClick={() => { if (s.purpose === 'prepare') { const d = state.drafts.find(d => d.prepareSessionId === s.id); if (d) { setDraftReturnToList(false); setDraftId(d.id); setView('drafts'); } } else selectSession(s); }}>{s.purpose === 'prepare' ? '成果整理' : s.title} · 查看授权</button>)}</div>}
    {view === 'sessions' && (session ? <><div className="session-toolbar"><div><div className="session-title-row"><h2>{session.title}</h2><button className="icon" title="重命名会话" onClick={() => setRenamingSession(session)}><Pencil size={13}/></button></div><span className="muted small" title={session.cwd}>{providerLabel(session.provider)}{session.nativeLive ? ' · 同一条' : ''} <span className="separator">/</span> {session.binding ? [session.binding.project.groupLabel, session.binding.project.name].filter(Boolean).join(' / ') : '本地会话'} <span className="separator">/</span> {session.closedAt ? '已关闭' : session.stoppedAt && ['starting', 'running', 'approval'].includes(session.status) ? '正在停止' : session.status === 'idle' && session.stoppedAt ? '已停止' : session.status === 'approval' && session.approvals.some(isQuestionRequest) ? '等待回答' : session.status === 'approval' && session.approvals.some(isPlanRequest) ? '等待确认计划' : session.cliConnection?.state === 'reconnecting' ? '重连中' : session.cliConnection?.state === 'failed' ? (session.cliConnection.httpStatus ? `HTTP ${session.cliConnection.httpStatus} · 请求失败` : 'CLI 请求失败') : statusLabels[session.status]}</span></div><div className="row"><details className="session-materials" key={session.id}><summary title="查看已带入的成果、参考文件和阶段摘要">AI 参考内容{includedSources.length > 0 && <span className="materials-count">已带入 {includedSources.length} 项</span>}{session.handoffState?.error && <span className="materials-update">摘要待更新</span>}</summary><div className="session-materials-content"><p className="materials-purpose">已带入的资料会保留在当前对话中，无需再次选择。</p>{includedSources.length > 0 && <ul className="session-reference-list" aria-label="已带入的参考资料">{includedSources.map(source => <li key={source.id}><FileText size={13}/><span>{resultLabelTitle(source.name)}</span><small>已带入</small></li>)}</ul>}<button className="secondary compact" title="AI 自动记录的本地摘要，不会直接上传" onClick={() => void run(async () => setHandoff({ id: session.id, text: await api.call<string>('handoff.read', { id: session.id }) }))}><FileText size={14}/>查看阶段摘要</button><SummaryUpdateStatus session={session}/></div></details><button className="secondary compact" disabled={isPersonalBinding(session.binding)} title={isPersonalBinding(session.binding) ? '迁入团队项目后可向团队提问' : undefined} onClick={() => { setQuestionPanel(questionPanel ? '' : 'session'); setPreview(undefined); }}><MessageSquare size={14}/>提问</button><NativeDesktopControls session={session} run={run}/><button className="secondary compact" onClick={() => void run(async () => setHistory({ id: session.id, text: await api.call<string>('session.history', { id: session.id }) }))}><Upload size={14}/>{isPersonalBinding(session.binding) ? '会话记录' : '轨迹上传'}</button>{session.closedAt ? <><button className="secondary compact" onClick={() => void run(async () => { await api.call('session.reopen', { id: session.id }); setShowClosed(false); })}>重新打开会话</button><button className="secondary compact" onClick={() => setDeletingSession(session)}>删除会话</button></> : <button className="secondary compact" onClick={() => { if (['running', 'starting', 'approval'].includes(session.status)) setClosingSession(session); else void run(() => api.call('session.close', { id: session.id })); }}><X size={14}/>关闭会话</button>}<button aria-label="整理成果" className="primary compact" disabled={!!session.cursorNative || session.purpose === 'prepare' || busy} title={session.cursorNative ? '此 Beta 暂不支持成果整理' : undefined} onClick={() => { if (sessionDraft) { setDraftReturnToList(false); setDraftId(sessionDraft.id); setView('drafts'); } else setPreparingSession(session); }}><Sparkles size={14}/>整理成果{sessionDraft && <span className="session-draft-status">{draftStatus(sessionDraft, state.transfers.find(t => t.id === sessionDraft.submitted))}</span>}</button><details className="session-more" key={"more-" + session.id} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary role="button" aria-label="更多会话操作" title="更多会话操作"><Ellipsis size={18}/></summary><div className="session-more-actions">{session.provider !== 'claude' && !session.cursorNative && !session.closedAt && <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setToolsSessionId(session.id); }}>{session.provider === 'codex' ? 'Codex 设置' : 'Cursor 自定义'}</button>}{session.provider !== 'claude' && session.purpose === 'work' && !session.nativeLive && !session.cursorNative && <button type="button" disabled={session.provider === 'cursor' || ['starting', 'running', 'approval'].includes(session.status)} title={session.provider === 'cursor' ? cursorSharedSessionUnavailable : ['starting', 'running', 'approval'].includes(session.status) ? '请等这条会话结束再登记到桌面端' : '把已经聊过的内容登记到桌面端的会话列表'} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void run(async () => { await api.call('session.native.publish', { id: session.id }); await refresh(); setNotice(session.provider === 'codex' ? `已登记到桌面 Codex，用会话名「${session.title}」查找` : `已登记到 Cursor 的会话列表，在这个工作目录下查找：${session.cwd}`); }); }}>在桌面端显示</button>}<button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setSessionFiles({ id: session.id }); }}><FolderOpen size={14}/>会话文件</button></div></details></div></div>
      <div className="subsession-actions"><button className="secondary compact" disabled={!!session.cursorNative || !subsessionsBetaEnabled || ['starting', 'running', 'approval'].includes(session.status)} title={!subsessionsBetaEnabled ? '在 Beta 功能中开启 Subsession 后可用' : ['starting', 'running', 'approval'].includes(session.status) ? '等当前回复结束后创建' : '从当前已保存的上下文派生独立工作会话'} onClick={() => setForkingSession(session)}><Plus size={13}/>创建 Subsession <span className="beta-inline-tag">Beta</span></button>{session.fork && <><button className="secondary compact" onClick={() => { const parent = state.sessions.find(value => value.id === session.fork?.parentId); if (parent) { setShowClosed(!!parent.closedAt); selectSession(parent); } }}><ArrowLeft size={13}/>返回父会话</button><button className="secondary compact" disabled={!subsessionsBetaEnabled || ['starting', 'running', 'approval'].includes(session.status)} title={!subsessionsBetaEnabled ? '请先开启 Subsession Beta 功能' : ''} onClick={() => setReportingSession(session)}><FileText size={13}/>回报父会话</button></>}</div>
      {sessionChildren.length > 0 && <SubsessionPanel parent={session} children={sessionChildren} enabled={subsessionsBetaEnabled} changed={refresh} openChild={child => { setShowClosed(!!child.closedAt); selectSession(child); }} followup={(child, report, text) => { const input = localInputs.current[child.id] || state.inputs[child.id] || { text: '', sourceIds: [], answers: {} }; editInput(child.id, { text: input.text.trim() ? input.text + "\n\n" + text : text }); setShowClosed(!!child.closedAt); selectSession(child); setNotice(`已将回报 v${report.version} 的补充要求填入子会话，发送前可修改`); }} attached={(sources, compare) => { const input = localInputs.current[session.id] || state.inputs[session.id] || { text: '', sourceIds: [], answers: {} }; editInput(session.id, { sourceIds: [...new Set([...input.sourceIds, ...sources.map(source => source.id)])], ...(compare && !input.text.trim() ? { text: '请比较这些 Subsession 回报的共同发现、冲突、验证依据和下一步建议。不要把尚未验证的效果当作结论。' } : {}) }); setNotice('已选入父会话待发送内容，可在发送前撤销；模型尚未收到'); }}/>}<CliConnectionNotice value={session.cursorNative ? undefined : session.cliConnection} provider={session.provider}/><div className="messages" ref={scroller}>{!session.messages.length && !pendingMessages[session.id] && <div className="session-welcome"><div className="welcome-symbol"><MessageSquare size={26}/></div><h2>开始这次工作</h2><code>{session.cwd}</code></div>}<SessionTranscript session={session} renderMessage={m => <article key={m.id} className={'message ' + m.role + (m.role === 'user' && m.context?.questionRunId && m.context.accepted === false ? ' message-pending is-question' : '')}><div className="message-author"><span className={'provider-icon ' + (m.role === 'user' ? 'user' : session.provider)}>{m.role === 'user' ? '我' : m.role === 'tool' ? '›' : providerGlyph(session.provider)}</span><b>{m.role === 'user' ? '你' : m.role === 'tool' ? '工具执行' : m.role === 'system' ? '运行信息' : providerLabel(session.provider)}</b>{m.steering && <span className="badge">引导</span>}{m.role === 'user' && m.context?.questionRunId && <span className="badge">成员消息</span>}{m.role === 'user' && m.context?.questionRunId && m.context.accepted === false && <span className="pending-message-state question"><span className="status-pulse"/>{session.error || '已放入对话，正在连接本地 CLI…'}</span>}<time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>{m.kind === 'plan' || m.kind === 'planSteps' ? <PlanMessage session={session} message={m} render={text => <Markdown text={text} openFile={path => setSessionFiles({ id: session.id, path })}/>}/> : m.role === 'tool' ? <details><summary>{m.text.split('\n')[0]?.slice(0, 130) || '查看工具事件'}</summary><pre>{m.text}</pre></details> : <><Markdown text={sessionMessageText(session, m)} openFile={path => setSessionFiles({ id: session.id, path })}/>{m.role === 'user' && !!m.context?.capabilities?.length && <div className="message-capabilities">{m.context.capabilities.map(item => <span key={item.id}><Puzzle size={11}/>{item.name}</span>)}</div>}</>}<CursorNativeRecord message={m}/></article>}/><CursorNativeQueue key={session.id} session={session}/>{pendingMessages[session.id] && <PendingSessionMessage pending={pendingMessages[session.id]} messages={session.messages} session={session}/>} {session.error && <div className="inline-error">{session.error}</div>}{!session.cursorNative && !session.codexDesktop && ["unauthenticated", "error", "logging-in"].includes(state.auth[session.provider].status) && state.auth[session.provider].cwd === session.cwd && state.auth[session.provider].networkRoute === session.networkRoute && <ProviderAuthPanel provider={session.provider} auth={activeAuth[session.provider]} cwd={session.cwd} networkRoute={session.networkRoute} autoCheck={false}/>}{['running', 'starting'].includes(session.status) && <div className={'thinking' + (session.status === 'starting' ? ' is-connecting' : '')}><span className="status-pulse"/>{session.cursorNative ? 'Cursor 正在处理；授权和提问请在原生窗口中完成。' : session.status === 'starting' ? (session.messages.some(message => message.role === 'user' && message.context?.questionRunId && message.context.accepted === false) || pendingMessages[session.id]?.phase === 'question' ? '提问已放进对话，正在连接本地 CLI…' : '正在连接本地 CLI…') : session.cliConnection?.state === 'reconnecting' ? 'CLI 正在重连，等待服务恢复…' : session.cliConnection?.state === 'failed' ? 'CLI 连接异常，请查看上方提示。' : 'Agent 正在处理，你可以切换其他会话继续工作。'}</div>}
      {session.approvals.map(a => <RequestCard key={a.id} request={a} onAnswer={(option, answers) => void run(() => api.call('session.answer', { id: session.id, requestId: a.id, option, answers }))}/>)}</div>
      {!session.closedAt && <div className="composer-wrap">{project && <RsiNotice key={projectContextKey} projectId={project.id} open={() => setView('rsi')}/>}{pendingSources.length > 0 && <div className="source-chips" aria-label="待发送的参考资料">{pendingSources.map(f => { const automatic = automaticSourceKeys.has(sourceIdentity(f)), removable = isRemovableSessionReference(session, f) && !sourceWasAccepted(session, f); return <span className="source-chip" key={f.id}><button title={f.sourcePath + '\n' + f.sha256} disabled={automatic} className={selectedSourceKeys.has(sourceIdentity(f)) || automatic ? 'selected' : ''} onClick={() => toggleSource(f)}><Paperclip size={12}/>{resultLabelTitle(f.name)}{(selectedSourceKeys.has(sourceIdentity(f)) || automatic) && <Check size={12}/>}</button>{removable && <button className="source-remove" aria-label={`撤销加入：${resultLabelTitle(f.name)}`} title="从此会话移除，下一条消息不会引用" disabled={!!detachingSourceId || sendingIds.includes(session.id) || ['starting', 'running', 'approval'].includes(session.status)} onClick={() => void detachPendingSource(f)}><X size={12}/></button>}</span>; })}</div>}{selectedCapabilities.length > 0 && <div className="capability-chips" aria-label="下一条消息使用的能力"><span>下一条消息</span>{selectedCapabilities.map(item => <button key={item.id} title="点击移除" onClick={() => setSelectedCapabilities(selectedCapabilities.filter(value => value.id !== item.id))}><Puzzle size={11}/>{item.name}<X size={11}/></button>)}</div>}{!session.cursorNative && <ActivityRecommendations key={'activity-' + session.id} ref={activityPanel} session={session} jobs={state.activity?.jobs || []} changed={refresh} view={viewActivityResult}
          sourcesAdded={ids => { const input = localInputs.current[session.id] || state.inputs[session.id] || currentInput; editInput(session.id, { sourceIds: [...new Set([...input.sourceIds, ...ids])] }); }}
          send={async () => { if (selectedSession.current !== session.id) return; const input = localInputs.current[session.id] || state.inputs[session.id] || currentInput; if (input.text.trim()) await sendInput(session.id, input); }}/>}<div className="composer"><ComposerResizeHandle height={composerHeight} resize={resizeComposer}/><textarea aria-label="任务输入" style={{ height: composerHeight }} disabled={!!autoLock} placeholder={autoLock ? `正在与${autoLock.name}自动对话，不能手动发送` : composerMode(session, state.activeTurns?.[session.id]) === 'steer' ? "补充要求，引导当前任务…" : "描述你的任务…"} value={composer} onChange={e => setComposer(e.target.value)} onKeyDown={e => { if (autoLock) return; if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (!e.repeat) void send(); } }}/><div className="composer-bottom"><ComposerCapabilities key={'capabilities-' + session.id} openSettings={() => setToolsSessionId(session.id)} session={session} selected={selectedCapabilities} change={setSelectedCapabilities} text={composer} changeText={setComposer} changed={refresh}
          attach={() => void run(async () => { const files = await api.call<any[]>('session.attachLocal', { id: session.id }); editInput(session.id, { sourceIds: [...(localInputs.current[session.id]?.sourceIds || selectedSources), ...files.map(f => f.id)] }); })}
          handoff={sessionHandoffBetaEnabled ? () => setHandoffPickerId(session.id) : undefined}/>{session.provider === 'claude' && <><button className="icon" title="添加本地参考文件" onClick={() => void run(async () => { const files = await api.call<any[]>('session.attachLocal', { id: session.id }); editInput(session.id, { sourceIds: [...(localInputs.current[session.id]?.sourceIds || selectedSources), ...files.map(f => f.id)] }); })}><Paperclip size={18}/></button><SessionMaterials key={'materials-' + session.id} session={session} changed={refresh}/>{session.binding && <button className="text-button" title="每轮自动补充项目内各会话最近 5 条日志，详细摘要按需读取" onClick={() => setJournalId(session.id)}>项目会话日志</button>}{sessionHandoffBetaEnabled && <button className="text-button" title="手动选择固定版本的摘要作为额外参考" onClick={() => setHandoffPickerId(session.id)}>引用会话摘要 <span className="beta-inline-tag">Beta</span></button>}</>}{session.provider !== 'claude' && !session.cursorNative && <ComposerMode key={'mode-' + session.id} session={session}/>}<ComposerSettings key={session.id} session={session} networkEnabled={activeEgress?.enabled} authCheckedAt={activeAuth[session.provider].checkedAt} openConnection={() => setNetworkSessionId(session.id)}/><span className="muted small composer-shortcut">{composerMode(session, state.activeTurns?.[session.id]) === 'steer' ? 'Enter 引导' : 'Enter 发送'} · Shift+Enter 换行</span><div className="spacer"/><ComposerActions session={session} activeTurnId={state.activeTurns?.[session.id]} text={composer} busy={sendingIds.includes(session.id)} locked={!!autoLock} send={() => { if (!autoLock) void send(); }} stop={() => void run(() => api.call('session.stop', { id: session.id }))} resume={() => { if (!autoLock) void sendInput(session.id, { text: '请继续', sourceIds: [], answers: {} }); }}/></div></div>{!session.cursorNative && session.provider !== 'codex' && ['running', 'approval'].includes(session.status) && <div className="composer-note">当前 {session.provider === 'claude' ? 'Claude Code' : 'Cursor'} 接入暂不支持生成中引导，可先输入，待本轮结束后发送。</div>}{inputError && <div className="inline-error" role="alert">{inputError}</div>}{sendingIds.includes(session.id) && <div className="composer-submit-status" role="status"><span className="status-pulse"/>{session.stoppedAt ? "正在结束已停止的发送…" : "消息正在提交，确认送达前会保留在输入框中。"}</div>}</div>}</> : personal ? <div className="personal-empty" aria-label="空白工作台"><MessageSquare size={26}/><p>暂无会话</p></div> : <div className="welcome"><span className="eyebrow">YOUR WORK, CONNECTED.</span><h1>个人探索，<br/><em>团队共享。</em></h1><button className="primary large" disabled={!project || currentProjectDirectory === undefined} onClick={() => setNewOpen(true)}><Plus size={18}/>新建工作会话</button><div className="welcome-cards">{state.providers.map(p => <div key={p.provider}><span className={'provider-icon ' + p.provider}>{providerGlyph(p.provider)}</span><b>{providerLabel(p.provider)}</b><span className={p.available ? 'green small' : 'muted small'}>{p.available ? '已检测到 CLI' : '待配置 CLI'}</span></div>)}</div><button className="text-button" onClick={() => setSettingsOpen(true)}>配置 CLI 与本地环境 <ChevronRight size={14}/></button></div>)}
    {view === 'rsi' && project && <RsiPanel key={projectContextKey} projectId={project.id} projectName={project.name} adopt={session && !session.closedAt && session.binding?.project.id === project.id ? text => { setComposer([composer, text].filter(Boolean).join('\n\n')); setView('sessions'); } : undefined}/>}
    {view === 'drafts' && <div className="workspace-page draft-page">{draft ? <DraftEditor key={draft.id} projects={projects} draft={draft} transfers={state.transfers.filter(t => draft.artifacts?.some(item => item.submitted === t.id) || t.id === draft.submitted)} sourceSession={state.sessions.find(s => s.id === draft.sessionId)} sourceTitle={draft.sourceSessionTitle || state.sessions.find(s => s.id === draft.sessionId)?.title} session={state.sessions.find(s => s.id === draft.prepareSessionId)} run={run} notice={setNotice} returnToList={draftReturnToList} reorganized={next => { setDraftId(next.id); void refresh(); }} viewShared={viewShared} viewConclusion={(targetProjectId, conclusionId) => { setProjectId(targetProjectId); setConclusionFocus({ projectId: targetProjectId, id: conclusionId }); setResultsScope('personal'); setView('results'); }} close={() => { if (draftReturnToList) { setDraftId(''); return; } if (draft.conclusionMergeProjectId) { setProjectId(draft.conclusionMergeProjectId); openResults('personal'); return; } if (draft.mergeProjectId) { setProjectId(draft.mergeProjectId); openResults('team'); return; } const source = state.sessions.find(s => s.id === draft.sessionId); if (source) { setShowClosed(!!source.closedAt); selectSession(source); } else setView('sessions'); }}/> : <><div className="page-title draft-page-title"><div><span className="eyebrow">LOCAL PREPARATION</span><h1>成果整理</h1><p className="muted small">查看整理草稿，审阅后再选择保存到个人成果库或提交团队。</p></div><span className="muted small">共 {state.drafts.length} 项</span></div>{state.drafts.length ? <DraftTaskList remove={setDeletingDraft} removeMany={async ids => { const result = await api.call<DraftDeleteResult>('draft.deleteMany', { ids }); await refresh(); if (!result.failures.length) setNotice(`已删除 ${result.deletedIds.length} 条整理记录，已保存成果和增量进度保留`); return result; }} drafts={state.drafts} sessions={state.sessions} transfers={state.transfers} open={selected => { setDraftReturnToList(true); setDraftId(selected.id); }}/> : <div className="page-empty"><FileArchive size={38}/><h2>还没有整理任务</h2><p>从工作会话中点击“整理成果”。</p><button className="secondary" onClick={() => setView('sessions')}>返回工作会话</button></div>}</>}</div>}
    {view === 'transfers' && <div className="workspace-page"><div className="page-title"><div><span className="eyebrow">TRANSFER CENTER</span><h1>传输记录</h1></div></div><div className="row"><span className="muted small">上传缓存：{bytes(state.transfers.filter(t => t.kind !== 'download' && !t.cacheCleared).reduce((n, t) => n + t.total, 0))}</span><button className="secondary compact" onClick={() => void run(async () => { const result = await api.call<{ count: number; bytes: number }>('cache.clean'); setNotice(`已清理 ${result.count} 个成功上传的缓存，释放 ${bytes(result.bytes)}；会话和草稿仍保留`); })}>清理成功上传缓存</button></div>{!state.transfers.length && <div className="page-empty"><Upload size={38}/><h2>没有传输任务</h2></div>}<TransferRecords transfers={state.transfers} retry={id => void run(() => api.call('transfer.retry', { id }))}/></div>}
    </main>
    {questionPanel && <QuestionPanel inbox={state.questions} selectedId={questionPanel} session={session} username={connection?.profile.username || state.settings.workspaceSnapshot?.profile.username || ''} sessions={state.sessions} connected={!!connection?.connected} select={setQuestionPanel} close={() => setQuestionPanel('')} changed={refresh} onPlace={placeQuestion} onUnplace={unplaceQuestion}/>}
    {toolsSessionId && state.sessions.find(s => s.id === toolsSessionId && !s.closedAt) && <AgentCustomization key={toolsSessionId} session={state.sessions.find(s => s.id === toolsSessionId)!} close={() => setToolsSessionId(undefined)}/>}
    {preview && <aside className="inspector"><header><div><span className="eyebrow">FILE PREVIEW</span><h3>{preview.name}</h3></div><button className="icon" title="关闭预览" onClick={() => setPreview(undefined)}><PanelRightClose size={18}/></button></header><div className="file-meta"><code>{preview.path}</code><span>{bytes(preview.size)} · {connection?.profile.mode === 'local' ? '本地共享文件' : '远端文件'}</span></div><div className="preview-content">{preview.type === 'image' ? <img src={preview.content} alt={preview.name}/> : preview.type === 'text' ? /\.md$/i.test(preview.name) ? <Markdown text={preview.content}/> : <pre>{preview.content}</pre> : <div className="page-empty"><FileArchive size={34}/><p>此格式请下载后查看</p></div>}{preview.truncated && <p className="muted small">仅显示前 512 KB，下载可获取完整文件。</p>}</div><footer>{projectAdmin && <button className="secondary" onClick={() => void run(async () => { await api.call('content.adopt', { projectId: previewOrigin, path: preview.path }); setPreview(undefined); setProjectId(previewOrigin); openResults('team'); setNotice('已加入团队成果库，可直接点击“编辑成果”进行编辑、替换或删除'); })}>加入团队成果库</button>}<button className="primary" disabled={!session || !!session.closedAt || session.purpose === 'prepare' || previewOrigin !== session.binding?.project.id} onClick={() => void run(async () => { const file = await api.call<any>('session.attachRemote', { id: session!.id, projectId: previewOrigin, path: preview.path }); setSelectedSources([...selectedSources, file.id]); setNotice('已下载快照并选入当前会话，下次发送时引用'); })}><Link size={15}/>加入当前会话</button><button className="secondary" onClick={() => void run(() => api.call('remote.download', { projectId: previewOrigin, path: preview.path }))}><Download size={15}/>下载</button></footer></aside>}
    </div><footer className="statusbar"><span><span className={'dot ' + (connection?.connected ? 'green-dot' : '')}/>{connection?.connected ? '共享空间已连接' : '本地工作模式'}</span><span>{workSessions.filter(s => ['running', 'starting'].includes(s.status)).length} 个会话运行中 · {state.drafts.filter(d => d.generation === 'running').length} 项成果整理中</span><span className="spacer"/><span>{state.egress?.enabled ? (state.egress.available ? '管理端网络出口可用' : '管理端网络出口已启用') : 'CLI 使用本机网络'}</span></footer></div>
    {notice && <div className="toast"><span>{notice}</span>{/^(收到提问|收到问题答复|问题已关闭)：/.test(notice) && <button className="secondary compact" onClick={() => { setView('updates'); setNotice(''); }}>查看提问</button>}{notice.includes('连接已断开') && <button className="secondary compact" onClick={() => { setNotice(''); setConnectOpen(true); }}>连接团队账号</button>}<button className="icon" title="关闭提示" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {visibleUpdateToast && <div className="toast content-update-toast" role="status"><span>{activityText(visibleUpdateToast, state.settings.contentAliases?.[contentAliasKey(visibleUpdateToast.projectId, visibleUpdateToast.id)] || titleSubject(visibleUpdateToast.title) || visibleUpdateToast.title)}{visibleUpdateToast.projectId !== projectId ? ` · ${visibleUpdateToast.submission?.destination.projectName || visibleUpdateToast.projectName}` : ''}{unreadContentUpdates.length > 1 ? `，另有 ${unreadContentUpdates.length - 1} 条待处理动态` : ''}</span>{visibleUpdateToast.change !== 'deleted' && (visibleUpdateToast.path || visibleUpdateToast.change === 'superseded') && <button className="primary compact" onClick={() => viewActivityResult(visibleUpdateToast)}>查看</button>}<button className="secondary compact" onClick={() => setView('updates')}>处理动态</button><button className="icon" title="关闭本轮动态提示" onClick={() => { const eventIds = unreadContentUpdates.map(item => item.eventId); setDismissedUpdateIds(current => [...new Set([...current, ...eventIds])]); void run(() => api.call('content.updates.dismiss', { eventIds })); }}><X size={16}/></button></div>}
    {journalId && <ProjectJournalDialog id={journalId} close={() => setJournalId('')}/>}
    {deletingSession && <Modal title="删除会话" close={() => setDeletingSession(undefined)}><div className="modal-body"><p>删除“{deletingSession.title}”及其项目会话日志。其他会话的日志总览和摘要副本会同步清理。项目文件、已保存的成果和其他会话已有的对话记录保留。</p></div><footer><button className="secondary" onClick={() => setDeletingSession(undefined)}>取消</button><button className="primary" onClick={() => void run(async () => { await api.call('session.delete', { id: deletingSession.id }); setDeletingSession(undefined); })}>删除会话及日志</button></footer></Modal>}
    {closingSession && <Modal title="停止并关闭会话" close={() => setClosingSession(undefined)}><div className="modal-body"><p>“{closingSession.title}”正在运行。关闭将停止当前任务，已保存的对话和阶段摘要仍可重新打开。正在执行的操作可能已经产生部分改动。</p></div><footer><button className="secondary" onClick={() => setClosingSession(undefined)}>继续工作</button><button className="primary" onClick={() => { const target = closingSession; setClosingSession(undefined); void run(async () => { await api.call('session.close', { id: target.id }); }); }}>停止并关闭</button></footer></Modal>}
    {renamingSession && <SessionRenameModal session={renamingSession} close={() => setRenamingSession(undefined)} saved={refresh}/>}
    {deletingDraft && <DraftDeleteDialog draft={deletingDraft} close={() => setDeletingDraft(undefined)} remove={async () => { await api.call('draft.delete', { id: deletingDraft.id }); setDeletingDraft(undefined); setNotice('整理记录已删除，成果和增量进度已保留'); await refresh(); }}/>}
    {preparingSession && <PreparationOptionsModal session={preparingSession} baseline={preparationCheckpoint(preparingSession, state.drafts)} close={() => setPreparingSession(undefined)} started={async (scope, categories, directions) => { const d = await api.call<Draft>('draft.prepare', { id: preparingSession.id, scope, categories, directions }); setDraftReturnToList(false); setDraftId(d.id); setView('drafts'); await refresh(); }}/>}
    {connectOpen && <ConnectModal settings={state.settings} connection={connection} close={() => setConnectOpen(false)} run={run} onConnected={() => { setConnectOpen(false); setNotice('登录成功，账号身份与工作组已刷新'); void refresh(); }}/> }
    {onboarding && onboardingWorkspace && connection?.connected && <ProjectOnboarding key={onboarding.contextKey} profile={connection.profile} workspace={onboardingWorkspace} close={() => setOnboarding(undefined)} created={async p => { await refresh(); setProjectId(p.id); setOnboarding(undefined); setNotice('项目说明、成果目录与轨迹目录已创建，本组成员可查看项目资料'); }}/>}
    {projectCreateOpen && <ProjectBriefEditor groups={creatableGroups} initialGroup={createGroup} admin close={() => setProjectCreateOpen(false)} saved={async p => { await refresh(); if (p) setProjectId(p.id); setProjectCreateOpen(false); setNotice('项目与公共成果、轨迹目录已创建'); }}/>}
    {groupDialog !== undefined && <TeamGroupDialog groupId={groupDialog || undefined} call={command=>api.call('group.control',command)} close={()=>setGroupDialog(undefined)} changed={refresh}/>}
    {briefOpen && project && <ProjectBriefEditor key={project.id} project={project} groups={workspaces} admin={projectAdmin} close={() => setBriefOpen(false)} saved={async () => { await refresh(); setBriefOpen(false); setNotice('项目资料新版本已保存'); }}/>}
    {settingsProject && projectSettings && <ProjectSettingsDialog key={projectSettings.contextKey} project={settingsProject} admin={!!workspaces.find(w => w.groupName === settingsProject.groupName)?.canCreateProject} contextKey={projectSettings.contextKey} directory={projectDirectory(state.settings, teamDirectoryProfile!, settingsProject.id)} close={() => setProjectSettings(undefined)} directorySaved={refresh} briefSaved={async revision => { await refresh(); setNotice(`项目设置已保存为 v${revision}，“项目说明.md”已同步更新`); }}/> }
    {settingsOpen && (
      <SettingsModal toolSessions={state.sessions.filter(s => s.purpose === "work" && !s.closedAt && s.binding?.project.id === project?.id)} openTools={provider => { const target = state.sessions.find(s => s.id === session?.id && s.provider === provider && !s.closedAt) || state.sessions.find(s => s.provider === provider && s.purpose === "work" && !s.closedAt && s.binding?.project.id === project?.id); if (target) { setSettingsOpen(false); setToolsSessionId(target.id); } }} settings={activeSettings} providers={activeProviders} auth={activeAuth} close={() => setSettingsOpen(false)} run={run}/>
    )}
    {organizing && <SessionOrganization session={organizing} groups={personalGroups} call={api.call} changed={refresh} close={() => setOrganizing(undefined)} move={selection => { setOrganizing(undefined); setMoving(selection); }}/>}
    {moving && <PersonalMoveDialog selection={{ ...moving, count: personalSessions.filter(s => movingFamily.has(s.id)).length }} projects={teamProjects} connected={!!connection?.connected} connect={() => { setMoving(undefined); setConnectOpen(true); }} call={api.call} close={() => setMoving(undefined)} moved={async result => { await refresh(); setMoving(undefined); setProjectId(result.projectId); setSessionId(result.sessionId); setShowClosed(false); setView('sessions'); setNotice(`已将 ${result.count} 条会话迁入团队项目，历史和整理草稿已保留`); }}/>}
    {passwordOpen && <PasswordModal close={() => setPasswordOpen(false)} saved={() => { setPasswordOpen(false); setNotice('密码已修改，下次登录请使用新密码'); }}/>}
    {betaOpen && <BetaFeaturesModal features={betaFeatures} close={() => setBetaOpen(false)} changed={refresh}/>}
    {forkingSession && <ForkSubsessionDialog parent={forkingSession} close={() => setForkingSession(undefined)} created={child => { setForkingSession(undefined); setShowClosed(false); selectSession(child); void refresh(); setNotice('Subsession 已创建，探索方向已填入输入框；发送前可修改'); }}/>}
    {reportingSession && <SubsessionReportDialog child={reportingSession} close={() => setReportingSession(undefined)} reported={refresh}/>}
    {sessionFiles && <SessionFilesDialog key={sessionFiles.id + sessionFiles.path} sessionId={sessionFiles.id} initialPath={sessionFiles.path} close={() => setSessionFiles(undefined)}/>}
    {networkSession && <SessionNetworkModal key={networkSession.id} session={networkSession} auth={isPersonalBinding(networkSession.binding) && state.personal ? state.personal.auth[networkSession.provider] : state.auth[networkSession.provider]} egress={activeEgress} activeTaskCount={networkActiveTasks} busy={networkBusy} busyChanged={setNetworkBusy} close={() => { if (!networkBusy) setNetworkSessionId(''); }}/>}
    {!personal && project && projectContextKey && currentProjectDirectory === undefined && !settingsProject && !connectOpen && !settingsOpen && !betaOpen && !newOpen && !projectCreateOpen && !onboarding && !briefOpen && !handoff && !history && <ProjectDirectoryDialog key={projectContextKey} projectId={project.id} projectName={project.name} contextKey={projectContextKey} saved={refresh}/>}
    {newOpen && <NewSessionModal key={projectContextKey + personalGroup} personalGroupId={personal ? personalGroup === '*' ? undefined : personalGroup || undefined : undefined} codexDesktopBeta={codexDesktopBetaEnabled} cursorDesktopBeta={cursorDesktopBetaEnabled} directory={currentProjectDirectory || ''} auth={activeAuth} egress={activeEgress} activeTaskCount={networkActiveTasks} projectId={projectId} assignment={startingAssignment} close={() => { setNewOpen(false); setStartingAssignment(undefined); }} run={run} created={s => { setShowClosed(false); setSessionId(s.id); setView('sessions'); setNewOpen(false); setStartingAssignment(undefined); void refresh(); void refreshAssignments(); }}/>}
    {nativeProvider && projectId && <NativeSessionPicker cursorDesktopBeta={cursorDesktopBetaEnabled} directory={currentProjectDirectory || ''} key={nativeProvider} provider={nativeProvider} projectId={projectId} close={() => setNativeProvider('')} linked={sessions => { const session = sessions[0]; if (!session) return; setNativeProvider(''); setShowClosed(false); if (session.binding && projects.some(item => item.id === session.binding!.project.id)) setProjectId(session.binding.project.id); setSessionId(session.id); setView('sessions'); setNotice(sessions.length > 1 ? `已导入 ${sessions.length} 条会话` : '已导入这条会话'); void refresh(); }}/>}
    {steeringReview && <SteeringConfirmation review={steeringReview} current={steeringReviewIsCurrent(steeringReview, state.sessions.find(session => session.id === steeringReview.sessionId), state.activeTurns?.[steeringReview.sessionId])} busy={sendingIds.includes(steeringReview.sessionId)} error={steeringError} close={() => { if (!submittingInputs.current.has(steeringReview.sessionId)) setSteeringReview(undefined); }} confirm={() => void (async () => { const review = steeringReview; setSteeringError(''); try { const accepted = await confirmSteeringReview(review, state.sessions.find(session => session.id === review.sessionId), state.activeTurns?.[review.sessionId], () => sendInput(review.sessionId, review.input, review.turnId)); if (accepted) setSteeringReview(current => current === review ? undefined : current); } catch (error: any) { setSteeringError(error.message); } })()}/>}
    {conclusionMatch && <ConclusionMatchModal matches={conclusionMatch.matches} close={() => setConclusionMatch(undefined)}
      skip={async () => { const pending = conclusionMatch; setConclusionMatch(undefined); await sendInput(pending.sessionId, { text: pending.text, sourceIds: pending.sourceIds, answers: {}, capabilities: pending.capabilities }); }}
      confirm={async ids => { const pending = conclusionMatch, sourceIds = [...pending.sourceIds]; for (const conclusionId of ids) { const source = await api.call<SourceFile>('session.attachConclusion', { id: pending.sessionId, conclusionId }); sourceIds.push(source.id); } const sent = { text: pending.text, sourceIds: [...new Set(sourceIds)], answers: {}, capabilities: pending.capabilities }; editInput(pending.sessionId, sent); setConclusionMatch(undefined); await sendInput(pending.sessionId, sent); }}/>}
    {handoff && <AgentNotesPanel key={handoff.id} handoff={handoff} close={() => setHandoff(undefined)}/>}
    {handoffPickerId && <SessionHandoffPicker key={handoffPickerId} targetId={handoffPickerId} close={() => setHandoffPickerId('')} attached={source => { const current = localInputs.current[handoffPickerId] || state.inputs[handoffPickerId]; const old = state.sessions.find(item => item.id === handoffPickerId)?.sources.filter(item => item.sourcePath === source.sourcePath && item.id !== source.id).map(item => item.id) || []; editInput(handoffPickerId, { sourceIds: [...new Set([...(current?.sourceIds || []).filter(id => !old.includes(id)), source.id])] }); setNotice(state.sessions.find(item => item.id === handoffPickerId)?.autoUpload ? '个人会话摘要已选入下一条消息；此会话的轨迹自动上传已关闭' : '个人会话摘要已选入下一条消息，发送后才会进入模型上下文'); setHandoffPickerId(''); }}/>}

    {history && <Modal title={isPersonalBinding(state.sessions.find(s => s.id === history.id)?.binding) ? '会话记录' : '轨迹上传'} wide close={() => setHistory(undefined)}><div className="modal-body">{!isPersonalBinding(state.sessions.find(s => s.id === history.id)?.binding) && <><p className="muted">上传本会话的对话和工具记录，并同时上传仍在本机的会话文件。本组成员可查看。</p>{state.sessions.find(s => s.id === history.id)?.sources.some(isPersonalHandoffSource) && <p className="inline-error">本会话引用过个人会话摘要。轨迹可能含有相关对话内容；请先核对下方预览，再决定是否手动上传。自动上传已关闭。</p>}<label className="check-row"><input type="checkbox" disabled={isPersonalBinding(state.sessions.find(s => s.id === history.id)?.binding) || !state.sessions.find(s => s.id === history.id)?.binding || !!state.sessions.find(s => s.id === history.id)?.sources.some(isPersonalHandoffSource)} checked={!!state.sessions.find(s => s.id === history.id)?.autoUpload} onChange={e => void run(() => api.call('session.autoUpload', { id: history.id, enabled: e.target.checked }))}/>此会话自动上传</label><label className="field">自动上传最短间隔<select aria-label="轨迹自动上传间隔" value={state.settings.autoUploadMinutes || 15} onChange={e => void run(() => api.call('settings.save', { ...state.settings, autoUploadMinutes: Number(e.target.value) }))}>{[1, 5, 15, 30, 60].map(n => <option value={n} key={n}>{n} 分钟</option>)}</select></label><p className="muted small">最近成功上传：{state.sessions.find(s => s.id === history.id)?.lastArchiveAt ? new Date(state.sessions.find(s => s.id === history.id)!.lastArchiveAt!).toLocaleString() : '尚无成功记录'}。</p></>}<div className="history-preview"><Markdown text={history.text}/></div></div><footer>{isPersonalBinding(state.sessions.find(s => s.id === history.id)?.binding) ? <button className="secondary" onClick={() => setHistory(undefined)}>关闭</button> : <button className="primary" disabled={isPersonalBinding(state.sessions.find(s => s.id === history.id)?.binding) || !state.sessions.find(s => s.id === history.id)?.binding} onClick={() => void run(async () => { await api.call('session.uploadTrajectory', { id: history.id }); setHistory(undefined); setView('transfers'); })}><Upload size={15}/>确认上传轨迹</button>}</footer></Modal>}
  </div>;
}
type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
function PasswordModal({ close, saved }: { close: () => void; saved: () => void }) {
  const [oldPassword, setOldPassword] = useState(''), [next, setNext] = useState(''), [repeat, setRepeat] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="修改密码" close={() => { if (!busy) close(); }}><div className="modal-body"><label className="field">原密码<input aria-label="原密码" type="password" autoComplete="current-password" value={oldPassword} onChange={e => setOldPassword(e.target.value)}/></label><NewPasswordFields value={next} repeat={repeat} change={setNext} confirm={setRepeat}/>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy || !oldPassword || !next || next !== repeat} onClick={async () => { setBusy(true); setError(''); try { newAccountPasswordSchema.parse(next); await api.call('remote.password', { oldPassword, newPassword: next }); saved(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>保存密码</button></footer></Modal>;
}
function NewPasswordFields({ value, repeat, change, confirm }: { value: string; repeat: string; change: (v: string) => void; confirm: (v: string) => void }) {
  return <><label className="field">新密码<input aria-label="新密码" type="password" autoComplete="new-password" value={value} onChange={e => change(e.target.value)}/></label><label className="field">确认新密码<input aria-label="确认新密码" type="password" autoComplete="new-password" value={repeat} onChange={e => confirm(e.target.value)}/></label></>;
}
function ConnectModal({ settings, connection, close, run, onConnected }: { settings: Settings; connection: Snapshot['connection']; close: () => void; run: Run; onConnected: () => void }) {
  const savedProfile = settings.connections.at(-1) || connection?.profile || settings.workspaceSnapshot?.profile;
  const empty: ConnectionProfile = { id: crypto.randomUUID(), name: '团队共享空间', host: settings.defaultServer?.host || '', port: settings.defaultServer?.port || 22, username: '', fingerprint: '', manifestPath: '', projects: [], workPath: '' };
  const [profile, setProfile] = useState(savedProfile?.host ? savedProfile : empty);
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [required, setRequired] = useState(false), [next, setNext] = useState(''), [repeat, setRepeat] = useState('');
  const local = profile.mode === 'local';
  const update = (key: keyof ConnectionProfile, value: unknown) => { setRequired(false); setNext(''); setRepeat(''); setProfile({ ...profile, [key]: value, ...(['host', 'port'].includes(key) ? { fingerprint: '' } : {}) }); };
  const rememberedFingerprint = !local && profile.host ? settings.trustedServerIdentities?.[serverIdentityKey(profile.host, profile.port)] || '' : '';
  const effectiveFingerprint = profile.fingerprint || rememberedFingerprint;
  const identityChanged = error.includes('服务器身份发生变化');
  return <Modal title="登录团队工作台" close={close} wide><div className="modal-body">
    {error && <div className="inline-error" role="alert"><span>{error}</span>{identityChanged && <button className="text-button" type="button" onClick={() => void run(async () => { await api.call('server.identity.forget', { host: profile.host, port: profile.port }); setProfile({ ...profile, fingerprint: '' }); setError(''); })}>重新确认</button>}</div>}
    <fieldset className="connection-fields" disabled={busy}>
    {local && !profile.localRoot?.trim() && <div className="inline-error" role="alert">本地测试连接缺少共享目录，请重新生成联调配置。</div>}
    {!local && <div className="connection-server-details"><div className="form-grid">
      <label className="field">服务器地址<input value={profile.host} onChange={e => update('host', e.target.value)}/></label><label className="field">SFTP 端口<input type="number" value={profile.port} onChange={e => update('port', Number(e.target.value))}/></label>
    </div></div>}
    <div className="form-grid">

      <label className="field">{'成员账号'}<input aria-label={'成员账号'} value={profile.username} onChange={e => update('username', e.target.value)}/></label>
      <label className="field">登录密码<input aria-label="登录密码" type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)}/></label>
    </div>
    {required && <><p role="alert">首次登录，请先设置新密码后进入工作台。</p><NewPasswordFields value={next} repeat={repeat} change={setNext} confirm={setRepeat}/></>}
    </fieldset>
  </div><footer>{connection?.connected && <button className="secondary" onClick={() => void run(async () => { await api.call('remote.disconnect'); close(); })}><Unplug size={14}/>断开连接</button>}<span className="spacer"/><button className="secondary" disabled={busy} onClick={close}>{connection?.connected ? '取消' : '跳过，暂不登录'}</button><button className="primary" disabled={busy || (required && (!next || next !== repeat)) || !profile.host || !profile.username || !password || (local && !profile.localRoot?.trim())} onClick={async () => { setBusy(true); setError(''); try { if (required) newAccountPasswordSchema.parse(next); await api.call('remote.connect', { profile: { ...profile, fingerprint: effectiveFingerprint, projects: [], workPath: '', manifestPath: '' }, password, ...(required ? { newPassword: next } : {}) }); setPassword(''); onConnected(); } catch (e: any) { if (e.message.includes('PASSWORD_CHANGE_REQUIRED')) { setRequired(true); setError(''); } else setError(e.message); } finally { setBusy(false); } }}>{busy ? '正在登录…' : '登录'}</button></footer></Modal>;
}

function SettingsModal({ toolSessions, openTools, settings, providers, auth, close, run }: { toolSessions: AgentSession[]; openTools: (provider: Provider) => void; settings: Settings; providers: Snapshot['providers']; auth: Snapshot['auth']; close: () => void; run: Run }) {
  const [paths, setPaths] = useState(settings.providerPaths), [busy, setBusy] = useState(false);
  return <Modal title="本机与 CLI 设置" close={close} wide><div className="modal-body">{(['codex', 'cursor', 'claude'] as Provider[]).map(provider => { const info = providers.find(x => x.provider === provider); return <div className="provider-setting" key={provider}><div className="row"><span className={'provider-icon ' + provider}>{providerGlyph(provider)}</span><strong>{providerLabel(provider)}</strong><span className="spacer"/><span className={'badge ' + (info?.available ? 'done' : 'error')}>{info?.available ? '已检测到 CLI' : '未找到 CLI'}</span></div><label className="field">CLI 程序路径<div className="row"><input placeholder="留空自动检测" value={paths[provider]} onChange={e => setPaths({ ...paths, [provider]: e.target.value })}/><button className="secondary" onClick={() => void run(async () => { const file = await api.call<string>('choose.executable'); if (file) setPaths({ ...paths, [provider]: file }); })}>选择</button></div></label><p className="muted small break">{info?.available ? info.path + '\n' + info.version : info?.detail}</p>{provider !== "claude" && <button className="secondary compact" disabled={!toolSessions.some(s => s.provider === provider)} title={toolSessions.some(s => s.provider === provider) ? "" : "先创建一个此类型的工作会话"} onClick={() => openTools(provider)}>{provider === "codex" ? "Codex 设置" : "Cursor 自定义"}</button>}<ProviderAuthPanel provider={provider} auth={auth[provider]} cwd={settings.localWorkspace} stale={paths[provider] !== settings.providerPaths[provider]} beforeAction={async () => { await api.call('settings.save', { ...settings, providerPaths: paths }); }}/><div className="row"><button className="text-button" onClick={() => void api.call('open.link', provider === 'codex' ? 'https://developers.openai.com/codex/cli' : provider === 'claude' ? 'https://code.claude.com/docs/en/quickstart' : 'https://cursor.com/docs/cli/installation')}>官方安装说明</button></div></div>; })}<div className="callout"><HardDrive size={18}/><div>本机数据</div><button className="secondary compact" onClick={() => void api.call('open.data')}>打开目录</button></div></div><footer><button className="primary" disabled={busy} onClick={() => void run(async () => { setBusy(true); try { await api.call('settings.save', { ...settings, providerPaths: paths }); await api.call('providers.detect'); await Promise.all((['codex', 'cursor', 'claude'] as Provider[]).map(provider => api.call('provider.auth', { provider, cwd: settings.localWorkspace }))); } finally { setBusy(false); } })}>{busy ? '检测中…' : '保存并检测 CLI'}</button></footer></Modal>;
}
function NewSessionModal({ personalGroupId, codexDesktopBeta = false, cursorDesktopBeta = false, directory, auth, egress, activeTaskCount, projectId, assignment, close, run, created }: { personalGroupId?: string; codexDesktopBeta?: boolean; cursorDesktopBeta?: boolean; egress?: Snapshot['egress']; activeTaskCount: number; assignment?: ProjectAssignment; directory: string; auth: Snapshot['auth']; projectId: string; close: () => void; run: Run; created: (s: AgentSession) => void }) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('inherit');
  const [networkRoute, setNetworkRoute] = useState<SessionNetworkRoute>(egress?.enabled ? 'management' : 'direct');
  const [includeBrief, setIncludeBrief] = useState(true);
  const [localDirectory, setLocalDirectory] = useState('');
  const chosenDirectory = projectId === PERSONAL_PROJECT_ID ? localDirectory : directory;
  const [researchCwd, setResearchCwd] = useState('');
  const [networkBusy, setNetworkBusy] = useState(false), [networkPending, setNetworkPending] = useState(false);
  const [networkCheck, setNetworkCheck] = useState<{ provider: Provider; cwd: string; networkRoute: SessionNetworkRoute; result: ProviderConnectionCheck }>();
  const [workspaceError, setWorkspaceError] = useState('');
  useEffect(() => {
    if (chosenDirectory) return;
    let active = true;
    void api.call<string>('workspace.research').then(value => { if (active) setResearchCwd(value); }, error => { if (active) setWorkspaceError(error.message); });
    return () => { active = false; };
  }, [chosenDirectory]);
  const [selected, setSelected] = useState<Provider>('codex'), [busy, setBusy] = useState(false), [model, setModel] = useState('');
  const [desktopSync, setDesktopSync] = useState(codexDesktopBeta || cursorDesktopBeta);
  const desktopSyncSelected = selected === 'codex' && codexDesktopBeta && desktopSync && networkRoute === 'direct';
  const authCwd = chosenDirectory || researchCwd;
  const checked = networkCheck?.provider === selected && networkCheck.cwd === authCwd && networkCheck.networkRoute === networkRoute ? networkCheck.result : undefined;
  const latestAuth = auth[selected].networkRoute === networkRoute && auth[selected].cwd === authCwd ? auth[selected] : undefined;
  const selectedAuth = latestAuth?.checkedAt && latestAuth.checkedAt >= (checked?.auth.checkedAt || '') ? latestAuth : checked?.auth;
  const blockedReason = newSessionBlockedReason({ projectId, networkPending, networkBusy, busy, managementRoute: networkRoute === 'management', provider: selected, cwd: authCwd, checked: checked && { provider: selected, cwd: authCwd, auth: checked.auth }, latestAuth });
  useEffect(() => { if (selected === 'cursor' && permissionMode === 'auto') setPermissionMode('inherit'); }, [selected, permissionMode]);
  useEffect(() => setModel(''), [selected, authCwd]);
  return <Modal title="新建工作会话" close={close} wide><div className="modal-body">{assignment && <div className="callout"><div><b>开始任务：{assignment.title}</b><small>将带入任务说明和 {assignment.references.length} 条关联成果。创建后可检查输入草稿，再发送给 AI。</small></div></div>}
    <div className="provider-picker">{(['codex', 'cursor', 'claude'] as Provider[]).map(p => <button aria-label={providerLabel(p)} disabled={networkBusy && networkPending} className={selected === p ? 'selected' : ''} key={p} onClick={() => setSelected(p)}><span className={'provider-icon ' + p}>{providerGlyph(p)}</span>{providerLabel(p)}{selected === p && <Check size={15}/>}</button>)}</div>
    <div className="new-session-grid"><div>
      {!(selected === 'cursor' && desktopSyncSelected) && <ProviderConnectionSettings key={selected + authCwd} provider={selected} auth={auth[selected]} cwd={authCwd} egress={egress} sessionRoute={networkRoute} routeChanged={route => { setNetworkRoute(route); setNetworkCheck(undefined); setModel(''); }} activeTaskCount={activeTaskCount} busyChanged={setNetworkBusy} pendingChanged={pending => { setNetworkPending(pending); if (pending) setNetworkCheck(undefined); }} showCatalog={false} checked={result => setNetworkCheck({ provider: selected, cwd: authCwd, networkRoute, result })}/>}
      {projectId === PERSONAL_PROJECT_ID && <label className="field">本地工作目录<div className="row"><input aria-label="本地工作目录" value={localDirectory} placeholder="留空则使用独立工作目录" onChange={event => setLocalDirectory(event.target.value)}/><button className="secondary" onClick={() => void run(async () => { const value = await api.call<string>('choose.directory'); if (value) setLocalDirectory(value); })}>选择目录</button></div></label>}<p className="muted small break">工作目录：{chosenDirectory || '本次会话自动使用独立目录'}{projectId === PERSONAL_PROJECT_ID ? '。会话创建后可添加本地文件作为参考。' : '。可点击左侧项目旁的设置按钮修改代码目录。'}</p>
      {workspaceError && <div className="inline-error" role="alert">{workspaceError}</div>}
      {projectId !== PERSONAL_PROJECT_ID && <label className="check-row"><input type="checkbox" checked={includeBrief} onChange={e => setIncludeBrief(e.target.checked)}/>默认引用项目资料（已完善时）</label>}
      {selected === 'codex' && <label className="check-row" title={!codexDesktopBeta ? '请先在 Beta 功能中开启 Codex 桌面联动' : networkRoute === 'management' ? '桌面联动当前仅支持本机网络' : '首次发送启动后台；需要原生窗口时再打开'}><input type="checkbox" aria-label="此会话联动 Codex 桌面版" checked={desktopSyncSelected} disabled={!codexDesktopBeta || networkRoute === 'management'} onChange={event => setDesktopSync(event.target.checked)}/>联动 Codex 桌面版 <span className="badge">Beta</span></label>}
      {selected === 'cursor' && cursorDesktopBeta && <p className="muted small">原生联动请从“导入 Cursor 会话”关联已打开的原生会话。这里创建独立的 CLI 会话。</p>}
    </div>{!(selected === 'cursor' && desktopSyncSelected) && <ModelPicker key={selected + authCwd + networkRoute} provider={selected} cwd={authCwd} networkRoute={networkRoute} ready={!!authCwd && !networkBusy && !networkPending && !!canUseProvider(selectedAuth)} initialCatalog={checked?.catalog} model={model} changed={setModel}/>}</div>
    {!(selected === 'cursor' && desktopSyncSelected) && <PermissionPicker key={selected + authCwd} provider={selected} cwd={authCwd} mode={permissionMode} changed={setPermissionMode}/>}
  </div><footer>{blockedReason && <span id="new-session-blocker" className="new-session-blocker" role="status">{blockedReason}</span>}<button className="secondary" onClick={close}>取消</button><button className="primary" disabled={!!blockedReason} aria-describedby={blockedReason ? 'new-session-blocker' : undefined} onClick={() => void run(async () => { setBusy(true); try { const s = await api.call<AgentSession>(assignment ? 'assignment.start' : 'session.create', { provider: selected, cwd: authCwd, model: model || undefined, permissionMode, includeBrief, projectId, personalGroupId, networkRoute, desktopSync: desktopSyncSelected, ...(assignment ? { taskId: assignment.id, revision: assignment.revision } : {}) }); created(s); } finally { setBusy(false); } })}>创建会话</button></footer></Modal>;
}
function AgentNotesPanel({ handoff, close }: { handoff: { id: string; text: string }; close: () => void }) {
  const key = useRef('handoff:' + handoff.id + ':' + crypto.randomUUID());
  const expected = useRef(handoff.text);
  const editor = useAutosave(key.current, handoff.text, async text => { await api.call('handoff.save', { id: handoff.id, text, expectedText: expected.current }); expected.current = text; });
  const [error, setError] = useState(''), [editing, setEditing] = useState(false);
  const previewText = editor.value.replace(/^#\s+阶段摘要\s*/u, '');
  const finish = async () => { try { await editor.flush(); close(); } catch (e: any) { setError('文件尚未保存，窗口已保留：' + e.message); } };
  return <Modal title="阶段摘要" wide close={() => void finish()}><div className="modal-body"><p className="agent-notes-explanation">这里汇总本次会话的目标、进展、决定、验证和下一步。可手工更正；整理成果时会参考，也可由你选择带入同项目的其他会话。摘要仅保存在本机。</p>{error && <div role="alert" className="inline-error">{error}</div>}{editing ? <><label className="field">更正阶段摘要<textarea className="editor handoff-editor" aria-label="阶段摘要正文" value={editor.value} onChange={e => editor.change(e.target.value)}/></label><p className="muted small">更正后需重新整理，已有结果不会自动变化。</p><p role="status">{editor.status}</p>{editor.status.startsWith('保存失败') && <button className="secondary" onClick={editor.retry}>重试保存</button>}</> : <div className="agent-notes-preview" aria-label="阶段摘要预览"><Markdown text={previewText || '目前还没有阶段摘要。'}/></div>}</div><footer>{!editing && <button className="secondary" onClick={() => setEditing(true)}>更正摘要</button>}<button className="primary" onClick={() => void finish()}>{editing ? '保存并返回' : '返回会话'}</button></footer></Modal>;
}
createRoot(document.getElementById('root')!).render(<App/>);

interface SessionHandoffOption { id: string; title: string; createdAt: string; closedAt?: string; updatedAt: string; sha256: string; text: string; error?: string }
function SessionHandoffPicker({ targetId, close, attached }: { targetId: string; close: () => void; attached: (source: SourceFile) => void }) {
  const [items, setItems] = useState<SessionHandoffOption[]>([]), [selectedId, setSelectedId] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = async () => { setLoading(true); setError(''); try { const next = await api.call<SessionHandoffOption[]>('handoff.list', { id: targetId }); setItems(next); setSelectedId(id => next.some(item => item.id === id) ? id : next[0]?.id || ''); } catch (e: any) { setError(e.message); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [targetId]);
  const selected = items.find(item => item.id === selectedId);
  return <Modal title="引用其他会话的阶段摘要" close={close} wide><div className="modal-body"><p className="agent-notes-explanation">选择自己在当前项目中的其他会话。摘要仅作个人会话参考；先核对，再选入下一条消息。成果整理不会直接读取这份会话间快照。</p>{error && <div className="inline-error" role="alert">{error}</div>}{loading ? <p className="muted">正在读取会话摘要…</p> : !items.length ? <p className="muted">这个项目还没有其他工作会话。</p> : <div className="session-handoff-picker"><div className="session-handoff-list" aria-label="可引用的会话">{items.map(item => <button key={item.id} className={item.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(item.id)}><b>{item.title}</b><small>{item.error ? '无法引用 · ' + item.error : (item.closedAt ? '已关闭' : '进行中') + ' · 摘要更新于 ' + new Date(item.updatedAt).toLocaleString('zh-CN')}</small></button>)}</div><div className="session-handoff-preview" aria-label="来源会话摘要预览">{selected && <><div className="muted small">来源会话：{selected.title}</div>{selected.error ? <p className="inline-error">{selected.error}</p> : <Markdown text={selected.text}/> }</>}</div></div>}</div><footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="secondary" disabled={loading || busy} onClick={() => void load()}>刷新摘要</button><button className="primary" disabled={!selected || !!selected.error || busy || loading} onClick={async () => { if (!selected || selected.error) return; setBusy(true); setError(''); try { const source = await api.call<SourceFile>('handoff.attach', { id: targetId, sourceId: selected.id, sha256: selected.sha256 }); attached(source); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{busy ? '正在加入…' : '加入当前会话'}</button></footer></Modal>;
}

function ProjectJournalDialog({ id, close }: { id: string; close: () => void }) {
  const [value, setValue] = useState<{ text: string; path: string }>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); setError(''); try { setValue(await api.call('journal.project', { id })); } catch (error: any) { setError(error.message); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [id]);
  return <Modal title="项目会话日志" close={close} wide><div className="modal-body"><p className="muted">每个未关闭的会话保留最近 5 轮。每轮结束后后台更新；首次发送带入全量，之后只补充变化。模型可按需读取摘要副本。</p>{error && <p className="inline-error">{error}</p>}{value ? <Markdown text={value.text}/> : <p>正在读取…</p>}</div><footer><button className="secondary" disabled={loading} onClick={() => void load()}>刷新日志</button><button className="primary" onClick={close}>关闭</button></footer></Modal>;
}
