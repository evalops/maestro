import {
	type PlatformServiceConfig,
	getEnvValue,
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

const TOOL_EXECUTION_BASE_URL_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_URL",
	"MAESTRO_TOOL_EXECUTION_SERVICE_URL",
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;

const TOOL_EXECUTION_TOKEN_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_TOKEN",
	"MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const TOOL_EXECUTION_ORGANIZATION_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_ORGANIZATION_ID",
	"MAESTRO_TOOL_EXECUTION_ORGANIZATION_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

const TOOL_EXECUTION_WORKSPACE_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_WORKSPACE_ID",
	"MAESTRO_TOOL_EXECUTION_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_EVALOPS_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
] as const;

const TOOL_EXECUTION_TIMEOUT_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
	"MAESTRO_TOOL_EXECUTION_SERVICE_TIMEOUT_MS",
] as const;

const TOOL_EXECUTION_MAX_ATTEMPTS_ENV_VARS = [
	"TOOL_EXECUTION_SERVICE_MAX_ATTEMPTS",
	"MAESTRO_TOOL_EXECUTION_SERVICE_MAX_ATTEMPTS",
] as const;

const EXECUTE_TOOL_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.toolexecution.executeTool,
);
const RESUME_TOOL_EXECUTION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.toolexecution.resumeToolExecution,
);

export type ToolExecutionRiskLevel =
	| "RISK_LEVEL_UNSPECIFIED"
	| "RISK_LEVEL_LOW"
	| "RISK_LEVEL_MEDIUM"
	| "RISK_LEVEL_HIGH"
	| "RISK_LEVEL_CRITICAL";

export type ToolExecutionState =
	| "TOOL_EXECUTION_STATE_UNSPECIFIED"
	| "TOOL_EXECUTION_STATE_ACCEPTED"
	| "TOOL_EXECUTION_STATE_POLICY_EVALUATING"
	| "TOOL_EXECUTION_STATE_WAITING_APPROVAL"
	| "TOOL_EXECUTION_STATE_RUNNING"
	| "TOOL_EXECUTION_STATE_SUCCEEDED"
	| "TOOL_EXECUTION_STATE_FAILED"
	| "TOOL_EXECUTION_STATE_DENIED"
	| "TOOL_EXECUTION_STATE_CANCELLED";

export interface ToolExecutionLinkage {
	workspaceId: string;
	organizationId?: string;
	agentId: string;
	runId?: string;
	objectiveId?: string;
	stepId: string;
	actorId?: string;
	surface?: string;
	channelId?: string;
	correlationId?: string;
}

export interface PlatformToolRef {
	namespace: string;
	name: string;
	version?: string;
	capability: string;
	operation?: string;
	idempotent?: boolean;
	mutatesResource?: boolean;
}

export interface PlatformConnectorRef {
	connectionId?: string;
	providerId?: string;
	resourceId?: string;
	resourceKind?: string;
	credentialRef?: string;
	credentialEnvironment?: string;
}

export interface PlatformToolRetryPolicy {
	maxAttempts?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	allowNonIdempotentRetry?: boolean;
}

export interface ExecutePlatformToolRequest {
	linkage: ToolExecutionLinkage;
	tool: PlatformToolRef;
	connector?: PlatformConnectorRef;
	arguments: Record<string, unknown>;
	riskLevel?: ToolExecutionRiskLevel;
	retryPolicy?: PlatformToolRetryPolicy;
	idempotencyKey: string;
	metadata?: Record<string, string>;
}

export interface ResumePlatformToolExecutionRequest {
	executionId: string;
	approvalRequestId: string;
	resumeToken: string;
	approved: boolean;
	decidedBy?: string;
	reason?: string;
}

export interface PlatformApprovalWait {
	approvalRequestId?: string;
	resumeToken?: string;
	reason?: string;
}

export interface PlatformToolExecutionRecord {
	id?: string;
	state?: ToolExecutionState;
	errorMessage?: string;
	approvalWait?: PlatformApprovalWait;
}

export interface ExecutePlatformToolResponse {
	execution: PlatformToolExecutionRecord;
	idempotentReplay: boolean;
}

export interface ResumePlatformToolExecutionResponse {
	execution: PlatformToolExecutionRecord;
}

export interface ToolExecutionServiceConfig extends PlatformServiceConfig {}

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/u, "");
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = stripTrailingSlashes(baseUrl.trim());
	for (const suffix of [
		EXECUTE_TOOL_PATH,
		RESUME_TOOL_EXECUTION_PATH,
		platformConnectServicePath(
			PLATFORM_CONNECT_METHODS.toolexecution.executeTool.service,
		),
	]) {
		if (normalized.endsWith(suffix)) {
			normalized = stripTrailingSlashes(normalized.slice(0, -suffix.length));
		}
	}
	return normalized;
}

export async function resolveToolExecutionServiceConfig(
	overrides: Partial<ToolExecutionServiceConfig> = {},
): Promise<ToolExecutionServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: TOOL_EXECUTION_BASE_URL_ENV_VARS,
		tokenEnvVars: TOOL_EXECUTION_TOKEN_ENV_VARS,
		organizationEnvVars: TOOL_EXECUTION_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: TOOL_EXECUTION_WORKSPACE_ENV_VARS,
		timeoutEnvVars: TOOL_EXECUTION_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: TOOL_EXECUTION_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: [
			EXECUTE_TOOL_PATH,
			RESUME_TOOL_EXECUTION_PATH,
			platformConnectServicePath(
				PLATFORM_CONNECT_METHODS.toolexecution.executeTool.service,
			),
		],
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireBaseUrl: false,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config?.baseUrl || !config.workspaceId) {
		return null;
	}
	return {
		...config,
		baseUrl: normalizeBaseUrl(
			trimString(overrides.baseUrl ?? config.baseUrl) ?? config.baseUrl,
		),
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

function firstString(
	record: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function firstBoolean(
	record: Record<string, unknown>,
	...keys: string[]
): boolean | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") {
			return value;
		}
	}
	return undefined;
}

function objectValue(
	record: Record<string, unknown>,
	...keys: string[]
): Record<string, unknown> | undefined {
	for (const key of keys) {
		const value = record[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	}
	return undefined;
}

function normalizeExecutionState(
	value: unknown,
): ToolExecutionState | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	return value.trim() as ToolExecutionState;
}

function normalizeApprovalWait(
	record: Record<string, unknown> | undefined,
): PlatformApprovalWait | undefined {
	if (!record) {
		return undefined;
	}
	const approvalRequestId = firstString(
		record,
		"approvalRequestId",
		"approval_request_id",
	);
	const resumeToken = firstString(record, "resumeToken", "resume_token");
	const reason = firstString(record, "reason");
	if (!approvalRequestId && !resumeToken && !reason) {
		return undefined;
	}
	return {
		...(approvalRequestId ? { approvalRequestId } : {}),
		...(resumeToken ? { resumeToken } : {}),
		...(reason ? { reason } : {}),
	};
}

function normalizeExecutionRecord(
	record: Record<string, unknown> | undefined,
): PlatformToolExecutionRecord {
	if (!record) {
		return {};
	}
	return {
		id: firstString(record, "id"),
		state: normalizeExecutionState(record.state),
		errorMessage: firstString(record, "errorMessage", "error_message"),
		approvalWait: normalizeApprovalWait(
			objectValue(record, "approvalWait", "approval_wait"),
		),
	};
}

function stripUndefinedValues(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

function normalizeExecuteToolRequest(
	request: ExecutePlatformToolRequest,
): Record<string, unknown> {
	return stripUndefinedValues({
		linkage: stripUndefinedValues({
			workspaceId: request.linkage.workspaceId,
			organizationId: request.linkage.organizationId,
			agentId: request.linkage.agentId,
			runId: request.linkage.runId,
			objectiveId: request.linkage.objectiveId,
			stepId: request.linkage.stepId,
			actorId: request.linkage.actorId,
			surface: request.linkage.surface,
			channelId: request.linkage.channelId,
			correlationId: request.linkage.correlationId,
		}),
		tool: stripUndefinedValues({
			namespace: request.tool.namespace,
			name: request.tool.name,
			version: request.tool.version,
			capability: request.tool.capability,
			operation: request.tool.operation,
			idempotent: request.tool.idempotent,
			mutatesResource: request.tool.mutatesResource,
		}),
		connector: request.connector
			? stripUndefinedValues({
					connectionId: request.connector.connectionId,
					providerId: request.connector.providerId,
					resourceId: request.connector.resourceId,
					resourceKind: request.connector.resourceKind,
					credentialRef: request.connector.credentialRef,
					credentialEnvironment: request.connector.credentialEnvironment,
				})
			: undefined,
		arguments: request.arguments,
		riskLevel: request.riskLevel,
		retryPolicy: request.retryPolicy
			? stripUndefinedValues({
					maxAttempts: request.retryPolicy.maxAttempts,
					initialDelayMs: request.retryPolicy.initialDelayMs,
					maxDelayMs: request.retryPolicy.maxDelayMs,
					allowNonIdempotentRetry: request.retryPolicy.allowNonIdempotentRetry,
				})
			: undefined,
		idempotencyKey: request.idempotencyKey,
		metadata: request.metadata,
	});
}

async function parseJsonResponse(
	response: Response,
	serviceName: string,
): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`${serviceName} returned ${response.status}: ${text || response.statusText}`,
		);
	}
	if (!text.trim()) {
		throw new Error(`${serviceName} returned empty response`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

export async function executeToolWithPlatform(
	config: ToolExecutionServiceConfig,
	request: ExecutePlatformToolRequest,
	signal?: AbortSignal,
): Promise<ExecutePlatformToolResponse> {
	const response = await postPlatformConnect(
		config,
		EXECUTE_TOOL_PATH,
		normalizeExecuteToolRequest(request),
		{
			serviceName: "tool execution service",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			signal,
		},
	);
	const payload = await parseJsonResponse(response, "tool execution service");
	return {
		execution: normalizeExecutionRecord(objectValue(payload, "execution")),
		idempotentReplay:
			firstBoolean(payload, "idempotentReplay", "idempotent_replay") === true,
	};
}

export async function resumeToolExecutionWithPlatform(
	config: ToolExecutionServiceConfig,
	request: ResumePlatformToolExecutionRequest,
	signal?: AbortSignal,
): Promise<ResumePlatformToolExecutionResponse> {
	const response = await postPlatformConnect(
		config,
		RESUME_TOOL_EXECUTION_PATH,
		stripUndefinedValues({
			executionId: request.executionId,
			approvalRequestId: request.approvalRequestId,
			resumeToken: request.resumeToken,
			approved: request.approved,
			decidedBy: request.decidedBy,
			reason: request.reason,
		}),
		{
			serviceName: "tool execution service",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			signal,
		},
	);
	const payload = await parseJsonResponse(response, "tool execution service");
	return {
		execution: normalizeExecutionRecord(objectValue(payload, "execution")),
	};
}
