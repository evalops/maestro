import type {
	ComposerPendingRequestPlatformOperation,
	ComposerRunTimelineEventType,
	ComposerRunTimelineItem,
	ComposerRunTimelineResponse,
	ComposerRunTimelineStatus,
	ComposerRunTimelineVisibility,
} from "@evalops/contracts";
import {
	compactTimelineMetadata,
	compactTimelineSummary,
	redactTimelineMetadata,
} from "../timeline/redaction.js";
import {
	type PlatformServiceConfig,
	postPlatformConnect,
	resolvePlatformServiceConfig,
	trimString,
} from "./client.js";
import {
	PLATFORM_CONNECT_METHODS,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "./core-services.js";

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_ATTEMPTS = 2;

const LIST_RUN_TIMELINE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.maestroTimeline.listRunTimeline,
);

const TIMELINE_BASE_URL_ENV_VARS = [
	"MAESTRO_TIMELINE_SERVICE_URL",
	"MAESTRO_PLATFORM_TIMELINE_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const TIMELINE_TOKEN_ENV_VARS = [
	"MAESTRO_TIMELINE_SERVICE_TOKEN",
	"MAESTRO_PLATFORM_TIMELINE_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const TIMELINE_ORGANIZATION_ENV_VARS = [
	"MAESTRO_TIMELINE_ORG_ID",
	"MAESTRO_PLATFORM_TIMELINE_ORG_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

const TIMELINE_WORKSPACE_ENV_VARS = [
	"MAESTRO_TIMELINE_WORKSPACE_ID",
	"MAESTRO_PLATFORM_TIMELINE_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
] as const;

const TIMELINE_TIMEOUT_ENV_VARS = [
	"MAESTRO_TIMELINE_SERVICE_TIMEOUT_MS",
	"MAESTRO_PLATFORM_TIMELINE_SERVICE_TIMEOUT_MS",
] as const;

const TIMELINE_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_TIMELINE_SERVICE_MAX_ATTEMPTS",
	"MAESTRO_PLATFORM_TIMELINE_SERVICE_MAX_ATTEMPTS",
] as const;

export interface MaestroTimelineServiceConfig extends PlatformServiceConfig {}

export interface PlatformMaestroTimelineQuery {
	sessionId: string;
	workspaceId?: string;
	organizationId?: string;
	agentRunId?: string;
	remoteRunnerSessionId?: string;
	pageToken?: string;
	includeAdminSummaries?: boolean;
	includeAuditOnly?: boolean;
	pendingRequestCount?: number;
}

interface PlatformTimelineEntry {
	id?: string;
	timestamp?: unknown;
	type?: string;
	title?: string;
	summary?: string;
	adminSummary?: string;
	visibility?: string;
	sensitivity?: string;
	relatedIds?: Record<string, unknown>;
	redactions?: string[];
	sourceObject?: {
		source?: string;
		id?: string;
		type?: string;
	};
	metadata?: Record<string, unknown>;
}

interface PlatformTimelineResponse {
	organizationId?: string;
	workspaceId?: string;
	sessionId?: string;
	agentRunId?: string;
	remoteRunnerSessionId?: string;
	entries?: PlatformTimelineEntry[];
	partial?: boolean;
	missingSources?: string[];
	nextPageToken?: string;
}

export async function resolveMaestroTimelineServiceConfig(
	overrides: Partial<MaestroTimelineServiceConfig> = {},
): Promise<MaestroTimelineServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: TIMELINE_BASE_URL_ENV_VARS,
		tokenEnvVars: TIMELINE_TOKEN_ENV_VARS,
		organizationEnvVars: TIMELINE_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: TIMELINE_WORKSPACE_ENV_VARS,
		timeoutEnvVars: TIMELINE_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: TIMELINE_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: [
			LIST_RUN_TIMELINE_PATH,
			platformConnectServicePath(
				PLATFORM_CONNECT_METHODS.maestroTimeline.listRunTimeline.service,
			),
		],
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config?.baseUrl || !config.workspaceId) {
		return null;
	}
	return {
		...config,
		baseUrl: trimString(overrides.baseUrl ?? config.baseUrl) ?? config.baseUrl,
		organizationId:
			trimString(overrides.organizationId ?? config.organizationId) ??
			config.organizationId,
		workspaceId:
			trimString(overrides.workspaceId ?? config.workspaceId) ??
			config.workspaceId,
		token: trimString(overrides.token ?? config.token) ?? config.token,
		timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
		maxAttempts: overrides.maxAttempts ?? config.maxAttempts,
		teamId: trimString(overrides.teamId ?? config.teamId),
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function relatedString(
	relatedIds: Record<string, unknown> | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = stringValue(relatedIds?.[key]);
		if (value) return value;
	}
	return undefined;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
	if (typeof value === "string" || typeof value === "number") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString();
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const seconds =
			typeof record.seconds === "number"
				? record.seconds
				: Number.parseInt(String(record.seconds ?? ""), 10);
		const nanos =
			typeof record.nanos === "number"
				? record.nanos
				: Number.parseInt(String(record.nanos ?? "0"), 10);
		if (Number.isFinite(seconds)) {
			return new Date(
				seconds * 1000 + Math.floor((nanos || 0) / 1_000_000),
			).toISOString();
		}
	}
	return fallback;
}

function normalizeVisibility(
	value: string | undefined,
): ComposerRunTimelineVisibility {
	switch (value) {
		case "MAESTRO_TIMELINE_VISIBILITY_USER_VISIBLE":
		case "user":
			return "user";
		case "MAESTRO_TIMELINE_VISIBILITY_AUDIT_ONLY":
		case "audit":
			return "audit";
		case "MAESTRO_TIMELINE_VISIBILITY_ADMIN_VISIBLE":
		case "admin":
			return "admin";
		default:
			return "audit";
	}
}

function normalizeType(
	value: string | undefined,
): ComposerRunTimelineEventType {
	switch (value) {
		case "MAESTRO_TIMELINE_ENTRY_TYPE_SESSION_STARTED":
			return "session.started";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_CALL_ATTEMPTED":
			return "tool.requested";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_CALL_COMPLETED":
			return "tool.completed";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_EXECUTION_WAITING_APPROVAL":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_APPROVAL_REQUIRED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_WAITING":
			return "wait.pending";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_FAILED":
			return "session.updated";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_ARTIFACT_RECORDED":
			return "artifact.linked";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_APPROVAL_RESOLVED":
			return "policy.decision";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_SESSION_CLOSED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_RESUMED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_SUCCEEDED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUNTIME_EVENT":
			return "session.updated";
		default:
			return "custom.event";
	}
}

function normalizeStatus(value: string | undefined): ComposerRunTimelineStatus {
	switch (value) {
		case "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_EXECUTION_WAITING_APPROVAL":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_APPROVAL_REQUIRED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_WAITING":
			return "pending";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_CALL_COMPLETED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_SUCCEEDED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_SESSION_CLOSED":
			return "completed";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_FAILED":
			return "failed";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_APPROVAL_RESOLVED":
			return "approved";
		default:
			return "info";
	}
}

function platformOperationForType(
	value: string | undefined,
): ComposerPendingRequestPlatformOperation | undefined {
	switch (value) {
		case "MAESTRO_TIMELINE_ENTRY_TYPE_TOOL_EXECUTION_WAITING_APPROVAL":
			return "ResumeToolExecution";
		case "MAESTRO_TIMELINE_ENTRY_TYPE_APPROVAL_REQUIRED":
		case "MAESTRO_TIMELINE_ENTRY_TYPE_RUN_WAITING":
			return "ResumeRun";
		default:
			return undefined;
	}
}

function normalizePlatformEntry(
	entry: PlatformTimelineEntry,
	query: PlatformMaestroTimelineQuery,
	response: PlatformTimelineResponse,
	index: number,
	generatedAt: string,
): ComposerRunTimelineItem {
	const relatedIds = entry.relatedIds;
	const sessionId =
		relatedString(relatedIds, "sessionId", "session_id") ??
		response.sessionId ??
		query.sessionId;
	const agentRunId =
		relatedString(relatedIds, "agentRunId", "agent_run_id") ??
		response.agentRunId ??
		query.agentRunId;
	const remoteRunnerSessionId =
		relatedString(
			relatedIds,
			"remoteRunnerSessionId",
			"remote_runner_session_id",
		) ??
		response.remoteRunnerSessionId ??
		query.remoteRunnerSessionId;
	const platformOperation = platformOperationForType(entry.type);
	const summary = compactTimelineSummary(entry.summary);
	const metadata = compactTimelineMetadata({
		...(redactTimelineMetadata(entry.metadata) ?? {}),
		agentRunId,
		agentRunStepId: relatedString(
			relatedIds,
			"agentRunStepId",
			"agent_run_step_id",
		),
		correlationId: relatedString(relatedIds, "correlationId", "correlation_id"),
		sensitivity: entry.sensitivity,
		sourceObjectSource: entry.sourceObject?.source,
		sourceObjectId: entry.sourceObject?.id,
		sourceObjectType: entry.sourceObject?.type,
		redactions: entry.redactions,
		platformPartial: response.partial === true ? true : undefined,
		platformMissingSources:
			response.partial && response.missingSources?.length
				? response.missingSources
				: undefined,
	});
	return {
		id: entry.id ?? `platform:${sessionId}:${index}`,
		sessionId,
		timestamp: normalizeTimestamp(entry.timestamp, generatedAt),
		type: normalizeType(entry.type),
		title: compactTimelineSummary(entry.title) ?? "Platform timeline event",
		visibility: normalizeVisibility(entry.visibility),
		source: "platform",
		status: normalizeStatus(entry.type),
		...(summary ? { summary } : {}),
		toolCallId: relatedString(relatedIds, "toolCallId", "tool_call_id"),
		toolExecutionId: relatedString(
			relatedIds,
			"toolExecutionId",
			"tool_execution_id",
		),
		approvalRequestId: relatedString(
			relatedIds,
			"approvalRequestId",
			"approval_request_id",
		),
		artifactId: relatedString(relatedIds, "artifactId", "artifact_id"),
		...(remoteRunnerSessionId ? { remoteRunnerSessionId } : {}),
		...(platformOperation ? { platformOperation } : {}),
		...(metadata ? { metadata } : {}),
	};
}

function parseTimelineResponse(
	payload: Record<string, unknown>,
): PlatformTimelineResponse {
	return {
		organizationId: stringValue(
			payload.organizationId ?? payload.organization_id,
		),
		workspaceId: stringValue(payload.workspaceId ?? payload.workspace_id),
		sessionId: stringValue(payload.sessionId ?? payload.session_id),
		agentRunId: stringValue(payload.agentRunId ?? payload.agent_run_id),
		remoteRunnerSessionId: stringValue(
			payload.remoteRunnerSessionId ?? payload.remote_runner_session_id,
		),
		entries: Array.isArray(payload.entries)
			? (payload.entries as PlatformTimelineEntry[])
			: [],
		partial: payload.partial === true,
		missingSources: Array.isArray(payload.missingSources)
			? (payload.missingSources as string[])
			: Array.isArray(payload.missing_sources)
				? (payload.missing_sources as string[])
				: [],
		nextPageToken: stringValue(
			payload.nextPageToken ?? payload.next_page_token,
		),
	};
}

function normalizeTimelineResponse(
	responses: PlatformTimelineResponse[],
	query: PlatformMaestroTimelineQuery,
): ComposerRunTimelineResponse {
	const generatedAt = new Date().toISOString();
	const firstResponse = responses[0] ?? {};
	let index = 0;
	return {
		sessionId: firstResponse.sessionId ?? query.sessionId,
		source: "platform",
		generatedAt,
		platformBacked: true,
		pendingRequestCount: query.pendingRequestCount ?? 0,
		items: responses.flatMap(
			(response) =>
				response.entries?.map((entry) =>
					normalizePlatformEntry(entry, query, response, index++, generatedAt),
				) ?? [],
		),
	};
}

async function parseJsonResponse(
	response: Response,
): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`maestro timeline service returned ${response.status}: ${
				text || response.statusText
			}`,
		);
	}
	if (!text.trim()) {
		throw new Error("maestro timeline service returned empty response");
	}
	return JSON.parse(text) as Record<string, unknown>;
}

export async function listMaestroTimelineWithPlatform(
	config: MaestroTimelineServiceConfig,
	query: PlatformMaestroTimelineQuery,
	signal?: AbortSignal,
): Promise<ComposerRunTimelineResponse> {
	const organizationId =
		trimString(query.organizationId) ?? config.organizationId;
	const workspaceId = trimString(query.workspaceId) ?? config.workspaceId;
	if (!organizationId || !workspaceId) {
		throw new Error(
			"maestro timeline service requires organization and workspace",
		);
	}
	const normalizedQuery = {
		...query,
		organizationId,
		workspaceId,
	};
	const responses: PlatformTimelineResponse[] = [];
	let pageToken = query.pageToken;
	for (let page = 0; page < 20; page += 1) {
		const response = await postPlatformConnect(
			config,
			LIST_RUN_TIMELINE_PATH,
			{
				organizationId,
				workspaceId,
				sessionId: query.sessionId,
				agentRunId: query.agentRunId,
				remoteRunnerSessionId: query.remoteRunnerSessionId,
				pageToken,
				includeAdminSummaries: query.includeAdminSummaries ?? true,
				includeAuditOnly: query.includeAuditOnly ?? false,
			},
			{
				serviceName: "maestro timeline service",
				failureMode: "optional",
				timeoutMs: config.timeoutMs,
				maxAttempts: config.maxAttempts,
				signal,
			},
		);
		const payload = await parseJsonResponse(response);
		const parsed = parseTimelineResponse(payload);
		responses.push(parsed);
		pageToken = parsed.nextPageToken;
		if (!pageToken) {
			return normalizeTimelineResponse(responses, normalizedQuery);
		}
	}
	throw new Error("maestro timeline service returned too many pages");
}

export async function tryListMaestroTimelineWithPlatform(
	query: PlatformMaestroTimelineQuery,
	options?: {
		config?: MaestroTimelineServiceConfig;
		signal?: AbortSignal;
	},
): Promise<ComposerRunTimelineResponse | null> {
	const config =
		options?.config ?? (await resolveMaestroTimelineServiceConfig());
	if (!config) {
		return null;
	}
	try {
		return await listMaestroTimelineWithPlatform(
			config,
			query,
			options?.signal,
		);
	} catch {
		return null;
	}
}
