import type { SubmissionRecord } from './submission';
import type { ContentMetadata, ContributionCategory, GitRevision } from './content';
import type { ProjectBrief } from './project-brief';
import type { UserEgressSettings, UserEgressStatus } from './egress';
export type Provider = 'codex' | 'cursor' | 'claude';
export type PermissionMode = 'inherit' | 'review' | 'auto' | 'full';
export interface PermissionReport { provider: Provider; checkedAt: string; source: 'config' | 'runtime'; sandbox: string; approval: string; reviewer?: string; warnings: string[]; allowedModes?: PermissionMode[]; execution?: 'passed' | 'blocked' | 'unknown'; executionDetail?: string; cursorConfig?: { files: string[]; allow: string[]; deny: string[] }; }
export interface PermissionIssue { kind: 'sandbox' | 'policy' | 'filesystem'; message: string; at: string; }
export interface Project { briefRevision?: number; id: string; name: string; remoteRoot: string; uploadPath: string; historyPath: string; managed?: boolean; groupName?: string; groupLabel?: string }
export interface ConnectionProfile { mode?: 'sftp' | 'local'; localRoot?: string; id: string; name: string; host: string; port: number; username: string; fingerprint: string; manifestPath: string; projects: Project[]; workPath?: string }
export interface WorkspaceSnapshot { profile: ConnectionProfile; workspaces: WorkspaceAccess[] }
export interface ProjectBriefState { brief?: ProjectBrief; revision: number; updatedAt?: string }
export interface ContentSeenState { files?: import('./content-files-state').ContentFilesState; missingFiles?: string[]; submission?: SubmissionRecord; revision: number; title?: string; path?: string; author?: string; updatedBy?: string; updatedAt?: string; kind?: 'contribution' | 'file' | 'trajectory'; category?: ContributionCategory; sourceSessionTitle?: string; sources?: string[] }
export type BetaFeature = 'sessionHandoff' | 'subsessions' | 'cursorDesktopSync';
export interface BetaFeatureSettings { sessionHandoff?: boolean; subsessions?: boolean; cursorDesktopSync?: boolean }
export interface Settings { personalGroups?: import('./personal-workspace').PersonalGroup[]; betaFeatures?: Record<string, BetaFeatureSettings>; egress?: UserEgressSettings; workspaceSnapshot?: WorkspaceSnapshot; projectDirectories?: Record<string, string>; autoUploadMinutes?: number; sidebarProjectHeight?: number; sidebarPanes?: { workgroups?: number; files?: number; sessions?: number }; defaultServer?: { host: string; port: number }; trustedServerIdentities?: Record<string, string>; contentSeen?: Record<string, Record<string, number | ContentSeenState>>; contentUpdates?: ContentUpdate[]; dismissedContentUpdateIds?: string[]; contentAliases?: Record<string, string>; connections: ConnectionProfile[]; providerPaths: Record<Provider, string>; lastWorkspace: string; localWorkspace?: string; verifiedLocalWorkspace?: string }
export type AgentCapabilityKind = 'skill' | 'plugin';
export interface AgentCapabilitySelection { id: string; kind: AgentCapabilityKind; name: string }
export interface AgentCapabilityOption extends AgentCapabilitySelection { description: string; invocation: string; path?: string; source?: string; enabled: boolean; unavailableReason?: string }
export interface AgentCapabilityCatalog { provider: Provider; skills: AgentCapabilityOption[]; plugins: AgentCapabilityOption[]; checkedAt: string; skillError?: string; pluginError?: string }
export interface SessionInput { nextTurnOnly?: boolean; text: string; sourceIds: string[]; answers: Record<string, string>; capabilities?: AgentCapabilitySelection[] }
export interface WorkspaceAccess { path: string; canonicalPath: string; canCreateProject: boolean; role?: import('./team-groups').GroupRole; creator?: string; groupName?: string; groupLabel?: string; accessError?: string; isEmpty?: boolean }
export interface RemoteEntry { name: string; path: string; kind: 'directory' | 'file' | 'link'; size: number; modified: number }
export interface FilePreview { name: string; path: string; type: 'text' | 'image' | 'binary'; content: string; truncated: boolean; size: number }
export interface SourceFile { userAttachment?: boolean; resultUnavailable?: boolean; id: string; name: string; localPath: string; sourcePath: string; sha256: string; size: number; fetchedAt: string; contentRef?: { projectId: string; id: string; revision: number } }
export interface SessionFile { path: string; name: string; size: number; modifiedAt: string }
export interface MessageContext { questionRunId?: string; questionFill?: boolean; nativeId: string; accepted: boolean; workRecord: boolean; sourceHashes: Record<string, string>; capabilities?: AgentCapabilitySelection[]; projectJournal?: import('./project-journal').JournalReceipt }
export interface Message { id: string; nativeItemId?: string; role: 'user' | 'assistant' | 'tool' | 'system'; phase?: 'commentary' | 'final_answer'; text: string; userText?: string; context?: MessageContext; steering?: boolean; createdAt: string; kind?: 'plan' | 'planSteps'; steps?: import('./session-mode').PlanStep[]; nativeDetails?: { thinking?: unknown; allThinkingBlocks?: unknown; toolCall?: unknown; toolResults?: unknown; artifacts?: Array<{ content: string; blobId: string }>; error?: unknown } }
export interface CursorQueuedRequest { id: string; text: string; createdAt: string; state: 'queued' | 'sending' | 'accepted' | 'completed' | 'aborted' | 'error' | 'uncertain' | 'cancelled'; error?: string; nativeMessageId?: string; candidates?: string[] }
export interface ApprovalOption { id: string; label: string; kind: 'allow' | 'deny' | 'answer' }
export interface Approval { id: string; method: string; title: string; summary?: string; details: string; options: ApprovalOption[]; questions?: { id: string; text: string; options: { id: string; label: string }[]; allowMultiple?: boolean }[] }
export interface RemoteBinding { connectionId: string; host: string; port: number; username: string; fingerprint: string; project: Project }
export interface SubsessionFork { parentId: string; capturedAt: string; parentMessageId?: string; parentMessageCount: number; snapshotHash: string; sourceId: string; inheritedSourceIds: string[]; workspaceKind: 'git-worktree' | 'directory-copy' | 'shared-directory'; workspaceRoot: string; baseRevision?: string; nativeFork?: boolean; remoteContext?: string; parentWasRunning?: boolean; promotedAt?: string; visibleSnapshotPath?: string }
export interface SubsessionReport { id: string; version: number; createdAt: string; reviewedAt?: string; title: string; body: string; sourceHash: string; messageCount: number; latestReply: string; changedFiles: string[] }
export interface SubsessionReportPreview { childId: string; parentId: string; title: string; body: string; latestReply: string; changedFiles: string[]; messageCount: number; sourceHash: string; nextVersion: number }
export interface SideChat { id: string; parentId: string; projectId: string; parentTitle: string; capturedAt: string; expired?: boolean; session: AgentSession; draft: string }
export type SessionNetworkRoute = 'direct' | 'management';
export interface AgentSession {
  codexRemote?: { hostId: string; hostName: string; cwd: string; nativePath: string; home: string };
  codexDesktop?: boolean;
  codexSyncRequest?: { requestedAt: string; error?: string };
  nativeSourceId?: string;
  codexPrivateFork?: boolean;
  desktopSyncPending?: boolean;
  desktopWaitingApproval?: boolean;
  desktopSyncState?: 'connecting' | 'connected' | 'disconnected';
  desktopSyncError?: string;
  cursorNative?: { descriptorFile: string; managed?: boolean; creationUnconfirmed?: boolean; transport?: 'ide-files-v1' };
  cursorSettings?: import('./cursor-native-settings').CursorNativeSettings;
  cursorQueue?: { paused: boolean; requests: CursorQueuedRequest[] };
  cursorPendingSubmission?: { id: string; text: string };
  mode?: import('./session-mode').SessionMode; proposedPlan?: import('./session-mode').ProposedPlan;
  id: string; title: string; provider: Provider; model?: string; resolvedModel?: string; reasoningEffort?: string; closedAt?: string; nativeId?: string; nativePath?: string; nativeLive?: boolean; codexStorage?: 'workbench'; codexNeedsRegistration?: boolean;
  personalGroupId?: string; relayAccount?: string;
  cwd: string; purpose: 'work' | 'prepare' | 'background'; networkRoute?: SessionNetworkRoute; parentId?: string; fork?: SubsessionFork; reports?: SubsessionReport[]; createdAt: string;
  handoffState?: import('./activity-assistant').HandoffState;
  status: 'idle' | 'starting' | 'running' | 'approval' | 'error'; error?: string; stoppedAt?: string;
  completion?: { id: string; readAt?: string };
  messages: Message[]; approvals: Approval[]; sources: SourceFile[]; binding?: RemoteBinding;
  permissionMode?: PermissionMode; permissions?: PermissionReport; permissionIssue?: PermissionIssue; settingsPending?: boolean;
  cliConnection?: import('./cli-connection').CliConnection;
  projectBrief?: { revision: number; sourceId: string; capturedAt: string }; followProjectBrief?: boolean; lastTrajectoryHash?: string; lastTrajectoryQueuedAt?: string;
  assignment?: { id: string; revision: number; title: string; sourceIds: string[] };
  outputFiles?: string[];
  preparationCheckpoint?: PreparationCheckpoint;
  autoUpload: boolean; lastArchiveAt?: string; handoffPath: string;
}
export type TransferPhase = 'queued' | 'streaming' | 'awaiting_receipt' | 'verifying' | 'rejected' | 'completed';
export interface Transfer { submission?: SubmissionRecord; conclusionSourceId?: string; dependsOn?: string[]; attachment?: boolean; metadata?: ContentMetadata; trajectoryHash?: string; cacheCleared?: boolean; sha256?: string; completedAt?: string; requestId?: string; phase?: TransferPhase; id: string; kind: 'upload' | 'history' | 'download'; name: string; status: 'queued' | 'running' | 'done' | 'error'; bytes: number; total: number; target: string; projectName: string; createdAt: string; error?: string; sessionId?: string; localPath: string; binding: RemoteBinding }
export interface DraftDestination { id: string; path: string; description: string }
export interface DraftArtifact { classificationVersion?: number; resultStatus?: import('./result-model').ResultStatus; updateTarget?: import('./content').ResultReference; topic?: string; evidenceIds?: string[]; sourceDetails?: string; attachments?: { fileId: string; selected: boolean }[]; id: string; category: ContributionCategory; title: string; titleAlias?: string; fields: Record<string, string>; body: string; repoUrl?: string; target: string; selected: boolean; submitted?: string }
export type PreparationScope = 'full' | 'incremental';
export interface PreparationSnapshot { capturedAt: string; messageCount: number; totalMessageCount?: number; lastMessageId?: string; lastMessageLength?: number; conversationHash: string; scope?: PreparationScope; baseDraftId?: string; baseLastMessageId?: string; baseCapturedAt?: string }
export interface PreparationCheckpoint { draftId: string; snapshot: PreparationSnapshot }
export interface ContentMergeSource { category?: ContributionCategory; resultStatus?: import('./result-model').ResultStatus; id: string; revision: number; title: string; author: string; updatedAt: string }
export interface ContentMergeAnalysis { overview: string; consensus: string[]; conflicts: { topic: string; positions: { sourceIds: string[]; statement: string }[]; resolution?: string; requiresDecision: boolean }[]; evidence: { claim: string; sourceIds: string[] }[]; scope?: string; unresolved: string[] }
export interface ContentUpdateAction { kind: 'saved_conclusion' | 'attached_session' | 'detached_session' | 'kept_conclusion' | 'deleted_conclusion' | 'acknowledged' | 'archived'; at: string; targetId?: string; targetTitle?: string; sourceRevision?: number; sourceTitle?: string; correctedFromTitle?: string }
export interface ContentUpdate { files?: import('./content-files-state').ContentFilesState; missingFiles?: string[]; submission?: SubmissionRecord; eventId: string; projectId: string; projectName: string; id: string; path?: string; removedPath?: string; title: string; author?: string; updatedBy?: string; revision: number; category?: ContributionCategory; sourceSessionTitle?: string; change: 'new' | 'updated' | 'deleted' | 'merged' | 'superseded' | 'files_missing' | 'files_restored'; replacedBy?: { id: string; title: string }; sourceTitles?: string[]; occurredAt: string; detectedAt: string; readAt?: string; statusChangedAt?: string; actions?: ContentUpdateAction[]; archiveReason?: 'own_change' | 'content_deleted' | 'files_restored'; unavailableAt?: string }
export interface ConclusionSource { publication?: { path: string; sha256: string; revision: number; contentId?: string }; details?: string; sha256?: string; id: string; kind: 'remote' | 'session' | 'manual' | 'conclusion'; title: string; content?: string; revision?: number; path?: string; updatedAt: string }
export interface ProjectConclusion { publication?: import('./conclusion-upload').ConclusionPublication; uploadState?: import('./conclusion-upload').ConclusionUploadState; localFiles?: ConclusionFile[]; resultStatus?: import('./result-model').ResultStatus; resultOwner?: string; category?: ContributionCategory; accountOwner?: string; id: string; projectId: string; title: string; titleAlias?: string; content: string; sources: ConclusionSource[]; derivedFrom?: import('./content').ResultReference[]; replaces?: import('./content').ResultReference[]; supersededBy?: import('./content').ResultReference; versions?: { category?: ContributionCategory; resultStatus?: import('./result-model').ResultStatus; resultOwner?: string; version: number; title: string; content: string; updatedAt: string; sources: ConclusionSource[]; derivedFrom?: import('./content').ResultReference[] }[]; updatedAt: string; version: number; archived?: boolean; deletedAt?: string; automatic?: boolean }
export interface ConclusionMatch { conclusion: ProjectConclusion; score: number; reasons: string[] }
export interface ConclusionOrganization { conclusion: ProjectConclusion; action: 'created' | 'updated' | 'duplicate' }
export interface ConclusionFile { id: string; name: string; sha256: string; size: number; localPath: string }
export interface Draft { organizationFormat?: 'project-profile-v1'; organizationEdited?: boolean; attachments?: { fileId: string; selected: boolean }[]; preparationDirections?: import('./preparation-directions').PreparationDirections; emptyResult?: import('./preparation-review').EmptyPreparationResult; preparationExistingResults?: { id: string; title: string; category?: ContributionCategory; version?: number; scope?: 'personal' | 'team'; state?: 'current' | 'history' }[]; resultRules?: import('./result-rules').ResultRuleSnapshot; preparationEvidenceIds?: string[]; resultCategory?: ContributionCategory; resultSourceDetails?: string; sourceSessionTitle?: string; restored?: boolean; concise?: boolean; git?: GitRevision; includeGit?: boolean; snapshot?: PreparationSnapshot; preparationScope?: PreparationScope; baseDraftId?: string; id: string; sessionId: string; prepareSessionId?: string; generation?: 'running' | 'ready' | 'error' | 'canceled'; generationError?: string; generationStartedAt?: string; generationFinishedAt?: string; generationStage?: 'directories' | 'agent'; preparationVersion?: number; requestedCategories?: ContributionCategory[]; supplement?: string; repoUrlOverride?: string; destinations?: DraftDestination[]; destinationNote?: string; artifacts?: DraftArtifact[]; personalSavedIds?: string[]; mergeProjectId?: string; conclusionMergeProjectId?: string; conclusionMergeInstruction?: string; mergeSources?: ContentMergeSource[]; mergeReplacementIds?: string[]; mergeAnalysis?: ContentMergeAnalysis; mergeCompletedAt?: string; mergeResultId?: string; mergeResultPath?: string; title: string; titleAlias?: string; body: string; repoUrl?: string; target?: string; generatedBody?: string; files: SourceFile[]; binding?: RemoteBinding; inputDir: string; outputPath: string; createdAt: string; submitted?: string }
export interface ProviderInfo { provider: Provider; path: string; available: boolean; version: string; detail: string }
export interface ProviderAuth { status: 'unknown' | 'checking' | 'authenticated' | 'configured' | 'unauthenticated' | 'error' | 'not-required' | 'logging-in'; detail: string; identity?: string; plan?: string; cwd?: string; checkedAt?: string; loginUrl?: string; networkRoute?: SessionNetworkRoute; verifiedLocally?: boolean; connectionIssue?: string }
export interface ReasoningEffortOption { id: string; description?: string }
export interface ModelOption { id: string; name: string; isDefault?: boolean; defaultReasoningEffort?: string; reasoningEfforts?: ReasoningEffortOption[] }
export interface QuotaWindow { name: string; usedPercent: number; windowMinutes?: number; resetsAt?: number }
export interface ProviderCatalog { models: ModelOption[]; defaultModel?: string; defaultModelWarning?: string; modelError?: string; quota: { windows: QuotaWindow[]; detail: string; url: string }; checkedAt: string }
export interface Snapshot { sideChats?: SideChat[]; projectSync?: Record<string, { pending: boolean; localOnly: boolean; historyOnly?: boolean; history?: { id: string; at: string; method: string }[]; error?: string; conflict?: import('./sync-conflict').SyncConflict }>; projectCreation?: import('./project-connection').ProjectCreationIntent; selectedProjectId?: string; reusableConnections?: import('./project-connection').ReusableProjectConnection[]; personal?: { settings: Settings; providers: ProviderInfo[]; auth: Record<Provider, ProviderAuth>; egress?: UserEgressStatus }; questions?: import('./questions').QuestionInbox; activity?: import('./activity-assistant').ActivityAssistantView; publishingConclusions?: string[]; accountChanging?: boolean; activeTurns?: Record<string, string>; accountSync?: import('./account-data').AccountSyncState; settings: Settings; sessions: AgentSession[]; inputs: Record<string, SessionInput>; transfers: Transfer[]; drafts: Draft[]; connection?: { profile: ConnectionProfile; connected: boolean; workspace?: WorkspaceAccess; workspaces: WorkspaceAccess[] }; providers: ProviderInfo[]; auth: Record<Provider, ProviderAuth>; workspaceReady: boolean; egress?: UserEgressStatus }
export type WorkbenchEvent = { type: 'state' } | { type: 'questions' } | { type: 'notice'; message: string };
export interface WorkbenchAPI {
  call<T = unknown>(action: string, payload?: unknown): Promise<T>;
  subscribe(listener: (event: WorkbenchEvent) => void): () => void;
}
declare global { interface Window { workbench: WorkbenchAPI } }
