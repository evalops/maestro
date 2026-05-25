import type {
	ComposerAgentEvent,
	ComposerApprovalsStatusResponse,
	ComposerApprovalsUpdateResponse,
	ComposerAssistantMessageEvent,
	ComposerBackgroundHistoryResponse,
	ComposerBackgroundStatusResponse,
	ComposerBackgroundUpdateResponse,
	ComposerChatRequest,
	ComposerCommand,
	ComposerCommandPrefs,
	ComposerConfigResponse,
	ComposerConfigWriteRequest,
	ComposerConfigWriteResponse,
	ComposerErrorResponse,
	ComposerFrameworkListResponse,
	ComposerFrameworkStatusResponse,
	ComposerFrameworkUpdateResponse,
	ComposerGuardianConfigResponse,
	ComposerGuardianRunResponse,
	ComposerGuardianStatusResponse,
	ComposerMessage,
	ComposerModel,
	ComposerPendingRequestResumeRequest,
	ComposerPendingRequestResumeResponse,
	ComposerPlanActionResponse,
	ComposerPlanStatusResponse,
	ComposerProjectOnboardingState,
	ComposerPromptSuggestionRequest,
	ComposerPromptSuggestionResponse,
	ComposerRunTimelineResponse,
	ComposerSession,
	ComposerSessionMessagesView,
	ComposerSessionSummary,
	ComposerToolCall,
	ComposerUndoOperationResponse,
	ComposerUndoStatusResponse,
	MemoryEntry,
	MemoryMutationResponse,
	MemoryRecentResponse,
	MemorySearchResponse,
	MemorySearchResult,
	MemoryStats,
	MemoryStatsResponse,
	MemoryTopicResponse,
	MemoryTopicSummary,
	MemoryTopicsResponse,
	TeamMemoryMutationResponse,
	TeamMemoryStatus,
	TeamMemoryStatusResponse,
} from "@evalops/contracts";

export type {
	MemoryEntry,
	MemoryMutationResponse,
	MemoryRecentResponse,
	MemorySearchResponse,
	MemorySearchResult,
	MemoryStats,
	MemoryStatsResponse,
	MemoryTopicResponse,
	MemoryTopicSummary,
	MemoryTopicsResponse,
	TeamMemoryMutationResponse,
	TeamMemoryStatus,
	TeamMemoryStatusResponse,
};

export type Message = ComposerMessage;

export type { ComposerToolCall };

export type AssistantMessageEvent = ComposerAssistantMessageEvent;

/** AgentEvent is a discriminated union of all possible server-sent events */
export type AgentEvent = ComposerAgentEvent;

export type Model = ComposerModel;

export type Session = ComposerSession;

export type SessionSummary = ComposerSessionSummary;

export type RunTimelineResponse = ComposerRunTimelineResponse;

export type ChatRequest = ComposerChatRequest;

export type CommandDefinition = ComposerCommand;

export type CommandPrefs = ComposerCommandPrefs;

export type ConfigResponse = ComposerConfigResponse;

export type ConfigWriteRequest = ComposerConfigWriteRequest;

export type ConfigWriteResponse = ComposerConfigWriteResponse;

export type GuardianStatusResponse = ComposerGuardianStatusResponse;

export type GuardianRunResponse = ComposerGuardianRunResponse;

export type GuardianConfigResponse = ComposerGuardianConfigResponse;

export type PlanStatusResponse = ComposerPlanStatusResponse;

export type PlanActionResponse = ComposerPlanActionResponse;

export type BackgroundStatusResponse = ComposerBackgroundStatusResponse;

export type BackgroundHistoryResponse = ComposerBackgroundHistoryResponse;

export type BackgroundUpdateResponse = ComposerBackgroundUpdateResponse;

export type ApprovalsStatusResponse = ComposerApprovalsStatusResponse;

export type ApprovalsUpdateResponse = ComposerApprovalsUpdateResponse;

export type FrameworkStatusResponse = ComposerFrameworkStatusResponse;

export type FrameworkListResponse = ComposerFrameworkListResponse;

export type FrameworkUpdateResponse = ComposerFrameworkUpdateResponse;

export type UndoStatusResponse = ComposerUndoStatusResponse;

export type UndoOperationResponse = ComposerUndoOperationResponse;

export interface ApiClientAuthConfig {
	accessToken?: string | null;
	apiKey?: string | null;
	csrfToken?: string | null;
}

export interface ApiClientOptions {
	auth?: ApiClientAuthConfig;
}

export interface PolicyValidationError {
	path?: string;
	message: string;
	keyword?: string;
}

export interface PolicyValidationResponse {
	valid: boolean;
	errors?: PolicyValidationError[];
}

export interface AttachmentTextExtractionResponse {
	fileName: string;
	format: string;
	extractor?: "native" | "markitdown";
	size: number;
	truncated: boolean;
	extractedText: string;
	cached?: boolean;
}

export type PackageScope = "local" | "project" | "user";

export interface PackageResourceFilters {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface PackageInspectionResult {
	sourceSpec: string;
	resolvedSource: string;
	sourceType: "local" | "git" | "npm";
	resolvedPath: string;
	discovered: {
		name: string;
		version?: string;
		isMaestroPackage: boolean;
		hasManifest: boolean;
		manifestPaths?: PackageResourceFilters | null;
		errors: string[];
	} | null;
	resources: {
		extensions: string[];
		skills: string[];
		prompts: string[];
		themes: string[];
	} | null;
}

export interface PackageStatusEntry {
	scope: PackageScope;
	configPath: string;
	sourceSpec: string;
	filters: PackageResourceFilters | null;
	inspection: PackageInspectionResult | null;
	issues: string[] | null;
	error: string | null;
}

export interface PackageStatusResponse {
	packages: PackageStatusEntry[];
}

export interface PackageInspectResponse {
	inspection: PackageInspectionResult;
	issues: string[];
}

export interface PackageBulkRefreshEntry {
	source: string;
	sourceType: "git" | "npm";
	scopes: PackageScope[];
	inspection: PackageInspectionResult | null;
	issues: string[];
	error: string | null;
}

export interface PackageBulkRefreshResponse {
	refreshed: PackageBulkRefreshEntry[];
	localCount: number;
	remoteCount: number;
}

export interface PackageCachePruneResponse {
	cacheDir: string;
	removed: string[];
	removedCount: number;
	referencedCount: number;
}

export interface PackageMutationRequest {
	source: string;
	scope?: PackageScope;
}

export interface PackageAddResponse {
	path: string;
	scope: PackageScope;
	spec: string;
}

export interface PackageSearchEntry {
	name: string;
	version?: string;
	description?: string;
	keywords: string[];
	date?: string;
	links: {
		npm?: string;
		repository?: string;
		homepage?: string;
	};
	installSource: string;
}

export interface PackageSearchResponse {
	query: string;
	entries: PackageSearchEntry[];
}

export interface PackageRemoveResponse {
	path: string;
	scope: PackageScope;
	removedCount: number;
	fallback?: {
		scope: PackageScope;
		sourceSpec: string;
	} | null;
}

export type A2ACockpitTaskStatus =
	| "waiting"
	| "running"
	| "completed"
	| "failed"
	| "unknown";

export type A2ACockpitNextActionSeverity = "info" | "warning" | "critical";

export interface A2ACockpitResponse {
	generatedAt: string;
	registryPath: string;
	tasksPath: string;
	peer?: string;
	counts: {
		peers: number;
		onlinePeers: number;
		unreachablePeers: number;
		tasks: number;
		runningTasks: number;
		actionRequiredTasks: number;
		failedTasks: number;
		completedTasks: number;
	};
	peers: A2ACockpitPeerSummary[];
	tasks: A2ACockpitTaskSummary[];
	nextActions: A2ACockpitNextAction[];
}

export interface A2ACockpitPeerSummary {
	name: string;
	displayName?: string;
	url: string;
	status: "online" | "unreachable";
	error?: string;
	auth?: string;
	model?: string;
	cwd?: string;
	taskCounts: {
		tasks: number;
		runningTasks: number;
		actionRequiredTasks: number;
		failedTasks: number;
		completedTasks: number;
	};
	lastTask?: {
		id: string;
		state: string;
		status: A2ACockpitTaskStatus;
		updatedAt: string;
		text: string;
	};
}

export interface A2ACockpitTaskSummary {
	ledgerId: string;
	peer: string;
	peerDisplayName?: string;
	orphanedPeer?: boolean;
	taskId: string;
	state: string;
	status: A2ACockpitTaskStatus;
	requiresInput: boolean;
	terminal: boolean;
	final: boolean;
	text: string;
	responseText?: string;
	updatedAt: string;
	completedAt?: string;
	workGraph?: unknown;
	nextCommand?: string;
}

export interface A2ACockpitNextAction {
	id: string;
	label: string;
	command: string;
	severity: A2ACockpitNextActionSeverity;
	peer: string;
	taskId?: string;
	reason: string;
}

export interface TrajectoryReplayLabResponse {
	schemaVersion: string;
	generatedAt: string;
	run: {
		id: string;
		sessionId: string;
		source: "local" | "platform";
		generatedAt: string;
		platformBacked: boolean;
	};
	summary: {
		timelineItems: number;
		trajectoryEvents: number;
		replayDeltas: number;
		replayErrors: number;
		replayWarnings: number;
		scoreRules: number;
		scoreFailures: number;
		scoreWarnings: number;
		jumpTargets: number;
		phases: number;
		toolCalls: number;
	};
	timeline: {
		items: TrajectoryReplayLabTimelineItem[];
		pendingRequestCount?: number;
		platformBacked?: boolean;
	};
	trajectory: {
		events: TrajectoryReplayLabEvent[];
		counts: {
			events: number;
			byPhase: Record<string, number>;
			byKind: Record<string, number>;
			byStatus: Record<string, number>;
		};
	};
	replay: {
		counts: {
			deltas: number;
			errors: number;
			warnings: number;
			toolCalls: number;
			phases: number;
		};
		phases: TrajectoryReplayLabPhase[];
		toolCalls: TrajectoryReplayLabToolCall[];
		deltas: TrajectoryReplayLabDelta[];
	};
	score: {
		counts: {
			rules: number;
			passed: number;
			failed: number;
			warnings: number;
		};
		findings: TrajectoryReplayLabFinding[];
	};
	inspection: {
		counts: {
			jumpTargets: number;
			replayDeltas: number;
			scoreFindings: number;
			scoreFailures: number;
			scoreWarnings: number;
		};
		finalAnswer?: {
			eventId: string;
			timelineItemIds: string[];
			title: string;
			summary?: string;
		};
	};
}

export interface TrajectoryReplayLabTimelineItem {
	id: string;
	timestamp: string;
	type: string;
	title: string;
	status?: string;
	source: "local" | "platform";
	visibility: string;
	summary?: string;
	toolName?: string;
	toolCallId?: string;
	toolExecutionId?: string;
	approvalRequestId?: string;
	pendingRequestId?: string;
	artifactId?: string;
	agentRunId?: string;
	childAgentRunId?: string;
}

export interface TrajectoryReplayLabEvent {
	id: string;
	sequence: number;
	timestamp: string;
	kind: string;
	phase: string;
	actor: string;
	type: string;
	status: string;
	title: string;
	summary?: string;
	toolName?: string;
	relatedIds?: string[];
}

export interface TrajectoryReplayLabPhase {
	phase: string;
	events: number;
	firstSequence: number;
	lastSequence: number;
}

export interface TrajectoryReplayLabToolCall {
	toolCallId: string;
	toolName?: string;
	requestedSequence?: number;
	resultSequences: number[];
	terminalStatus?: "completed" | "failed";
}

export interface TrajectoryReplayLabDelta {
	id: string;
	severity: "error" | "warning";
	ruleId: string;
	message: string;
	eventId?: string;
	sequence?: number;
	phase?: string;
	kind?: string;
	expected?: string;
	observed?: string;
}

export interface TrajectoryReplayLabFinding {
	ruleId: string;
	status: "pass" | "fail" | "warn";
	severity: "error" | "warning";
	message: string;
	eventIds: string[];
	remediation: string;
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: Record<string, unknown>;
	capability?: {
		domain?: string;
		toolLane?: string;
		riskClass?: string;
		requiresReceipt?: boolean;
		proofRequired?: boolean;
		mutatesDesktop?: boolean;
		mutatesFiles?: boolean;
		rawSecretPossible?: boolean;
	};
}

export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface McpPromptDefinition {
	name: string;
	title?: string;
	description?: string;
	arguments?: McpPromptArgument[];
}

export type McpRemoteTrust = "official" | "custom" | "unknown";

export type McpProjectApprovalStatus = "pending" | "approved" | "denied";

export interface McpOfficialRegistryInfo {
	displayName?: string;
	directoryUrl?: string;
	documentationUrl?: string;
	permissions?: string;
	authorName?: string;
	url?: string;
}

export interface McpOfficialRegistryUrlOption {
	url: string;
	label?: string;
	description?: string;
}

export interface McpOfficialRegistryEntry extends McpOfficialRegistryInfo {
	slug?: string;
	serverName?: string;
	oneLiner?: string;
	transport?: "stdio" | "http" | "sse";
	urlOptions?: McpOfficialRegistryUrlOption[];
	urlRegex?: string;
	toolCount?: number;
	promptCount?: number;
}

export interface McpServerStatus {
	name: string;
	connected: boolean;
	scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	transport?: "stdio" | "http" | "sse";
	tools?: McpToolDefinition[] | number;
	toolCapabilitySummary?: {
		total: number;
		byDomain?: Record<string, number>;
		byRiskClass?: Record<string, number>;
		byToolLane?: Record<string, number>;
		mutating?: {
			desktop?: number;
			files?: number;
		};
		requiresReceipt?: number;
		rawSecretPossible?: number;
	};
	resources?: string[];
	prompts?: string[];
	promptDetails?: McpPromptDefinition[];
	error?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	envKeys?: string[];
	remoteUrl?: string;
	remoteHost?: string;
	headerKeys?: string[];
	headersHelper?: string;
	authPreset?: string;
	timeout?: number;
	remoteTrust?: McpRemoteTrust;
	officialRegistry?: McpOfficialRegistryInfo;
	projectApproval?: McpProjectApprovalStatus;
}

export interface McpAuthPresetStatus {
	name: string;
	scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	headerKeys: string[];
	headersHelper?: string;
}

export interface McpStatus {
	servers: McpServerStatus[];
	authPresets: McpAuthPresetStatus[];
}

export interface McpRegistrySearchResponse {
	query: string;
	entries: McpOfficialRegistryEntry[];
}

export interface McpRegistryImportRequest {
	query: string;
	name?: string;
	scope?: "local" | "project" | "user";
	url?: string;
	headers?: Record<string, string>;
	headersHelper?: string;
	authPreset?: string;
	transport?: "http" | "sse";
}

export interface McpRegistryImportResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	entry: McpOfficialRegistryEntry;
	server: {
		transport: "http" | "sse";
		url: string;
		headers?: Record<string, string>;
		headersHelper?: string;
		authPreset?: string;
	};
}

export interface McpServerConfigInput {
	name: string;
	transport?: "stdio" | "http" | "sse";
	command?: string;
	args?: string[] | null;
	env?: Record<string, string> | null;
	cwd?: string | null;
	url?: string;
	headers?: Record<string, string> | null;
	headersHelper?: string | null;
	authPreset?: string | null;
	timeout?: number | null;
	enabled?: boolean;
	disabled?: boolean;
}

export interface McpAuthPresetConfigInput {
	name: string;
	headers?: Record<string, string> | null;
	headersHelper?: string | null;
}

export interface McpServerAddRequest {
	scope?: "local" | "project" | "user";
	server: McpServerConfigInput;
}

export interface McpServerUpdateRequest {
	name: string;
	scope?: "local" | "project" | "user";
	server: McpServerConfigInput;
}

export interface McpServerMutationResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	server: McpServerConfigInput & {
		transport: "stdio" | "http" | "sse";
	};
}

export interface McpServerRemoveRequest {
	name: string;
	scope?: "local" | "project" | "user";
}

export interface McpServerRemoveResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	fallback: {
		name: string;
		scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	} | null;
}

export interface McpAuthPresetAddRequest {
	scope?: "local" | "project" | "user";
	preset: McpAuthPresetConfigInput;
}

export interface McpAuthPresetUpdateRequest {
	name: string;
	scope?: "local" | "project" | "user";
	preset: McpAuthPresetConfigInput;
}

export interface McpAuthPresetMutationResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	preset: McpAuthPresetConfigInput;
}

export interface McpAuthPresetRemoveRequest {
	name: string;
	scope?: "local" | "project" | "user";
}

export interface McpAuthPresetRemoveResponse {
	name: string;
	scope: "local" | "project" | "user";
	path: string;
	fallback: {
		name: string;
		scope?: "enterprise" | "plugin" | "project" | "local" | "user";
	} | null;
}

export interface McpProjectApprovalRequest {
	name: string;
	decision: Exclude<McpProjectApprovalStatus, "pending">;
}

export interface McpProjectApprovalResponse {
	name: string;
	scope: "project";
	decision: Exclude<McpProjectApprovalStatus, "pending">;
	projectApproval: McpProjectApprovalStatus;
}

export interface McpResourceContent {
	uri: string;
	text?: string;
	blob?: string;
	mimeType?: string;
}

export interface McpResourceReadResponse {
	contents: McpResourceContent[];
}

export interface McpPromptMessage {
	role: string;
	content: string;
}

export interface McpPromptResponse {
	description?: string;
	messages: McpPromptMessage[];
}

export type SessionArtifactAccessAction = "view" | "file" | "events" | "zip";

export interface SessionArtifactAccessResponse {
	token: string;
	expiresAt: string;
	actions: SessionArtifactAccessAction[];
	sessionId: string;
	filename?: string;
}

export interface ChatResponse {
	message: Message;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface BackgroundTaskSnapshotEntry {
	id?: string;
	status?: string;
	command?: string;
	summary?: string;
	lastLogLine?: string;
	issues?: string[];
	logTruncated?: boolean;
	durationSeconds?: number;
	restarts?: string;
}

export interface BackgroundTaskLimitBreach {
	kind: "memory" | "cpu";
	limit: number;
	actual: number;
}

export interface BackgroundTaskHistoryEntry {
	event: "started" | "restarted" | "exited" | "failed" | "stopped";
	taskId: string;
	status: string;
	command: string;
	timestamp: string;
	restartAttempts: number;
	failureReason?: string;
	limitBreach?: BackgroundTaskLimitBreach;
}

export interface BackgroundTaskSnapshot {
	total: number;
	running: number;
	restarting: number;
	failed: number;
	truncated?: boolean;
	notificationsEnabled?: boolean;
	detailsRedacted?: boolean;
	entries?: BackgroundTaskSnapshotEntry[];
	history?: BackgroundTaskHistoryEntry[];
	historyTruncated?: boolean;
}

export type RunHealthLevel = "healthy" | "degraded" | "unhealthy";

export interface RunHealthSlo {
	id: string;
	label: string;
	status: RunHealthLevel;
	target: string;
	observed: string;
	detail?: string;
}

export interface RunHealthSnapshot {
	status: RunHealthLevel;
	slos: RunHealthSlo[];
	diagnostics: string[];
	generatedAt: string;
}

export interface WorkspaceStatus {
	cwd: string;
	git: {
		branch: string;
		status: {
			modified: number;
			added: number;
			deleted: number;
			untracked: number;
			total: number;
		};
	} | null;
	context: {
		agentMd: boolean;
		claudeMd: boolean;
	};
	onboarding?: ComposerProjectOnboardingState;
	server: {
		uptime: number;
		version: string;
		staticCacheMaxAgeSeconds?: number;
	};
	database: {
		configured: boolean;
		connected: boolean;
		initialized?: boolean;
		reachable?: boolean;
	};
	backgroundTasks: BackgroundTaskSnapshot | null;
	hooks: {
		asyncInFlight: number;
		concurrency: {
			max: number;
			active: number;
			queued: number;
		};
	};
	runHealth?: RunHealthSnapshot;
	lastUpdated: number;
	lastLatencyMs: number;
}

export interface UsageSummary {
	totalCost: number;
	totalRequests: number;
	totalTokens: number;
	totalTokensDetailed: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	totalTokensBreakdown: UsageSummary["totalTokensDetailed"];
	totalCachedTokens: number;
	byProvider: Record<
		string,
		{
			cost: number;
			calls: number;
			requests: number;
			tokens: number;
			tokensDetailed: UsageSummary["totalTokensDetailed"];
			cachedTokens: number;
		}
	>;
	byModel: Record<
		string,
		{
			cost: number;
			calls: number;
			requests: number;
			tokens: number;
			tokensDetailed: UsageSummary["totalTokensDetailed"];
			cachedTokens: number;
		}
	>;
}

export interface UIStatusResponse {
	zenMode: boolean;
	cleanMode: "off" | "soft" | "aggressive";
	footerMode: "ensemble" | "solo";
	compactTools: boolean;
	queueMode: "one" | "all";
}

export interface QueueListResponse {
	mode: "one" | "all";
	pending: Array<{ id: number; text?: string; createdAt?: number }>;
	count: number;
}

export interface QueueStatusResponse {
	mode: "one" | "all";
	pendingCount: number;
	enabled: boolean;
}

export interface BranchListResponse {
	userMessages: Array<{ number: number; index: number; snippet: string }>;
}
