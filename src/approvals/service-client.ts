import { Buffer } from "node:buffer";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
} from "../agent/action-approval.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { CONNECT_PROTOCOL_VERSION } from "../platform/client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "../platform/core-services.js";
import {
	type DownstreamFailureMode as DownstreamHttpFailureMode,
	fetchDownstream,
} from "../utils/downstream-http.js";
import * as downstream from "../utils/downstream.js";

const DEFAULT_AGENT_ID = "maestro";
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_SURFACE = "maestro";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RISK_LEVEL = "RISK_LEVEL_MEDIUM";
const REQUEST_APPROVAL_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.approvals.requestApproval,
);
const RESOLVE_APPROVAL_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.approvals.resolveApproval,
);

export const APPROVALS_CALL_FAILURE_MODES = {
	requestApproval: {
		optional: downstream.FailOpen,
		required: downstream.FailClosed,
	},
	resolveApproval: {
		optional: downstream.FailOpen,
		required: downstream.FailClosed,
	},
} as const;

type ApprovalsCall = keyof typeof APPROVALS_CALL_FAILURE_MODES;

export interface ApprovalsServiceConfig {
	baseUrl?: string;
	token?: string;
	workspaceId?: string;
	approverUserId?: string;
	agentId?: string;
	surface?: string;
	riskLevel?: string;
	timeoutMs?: number;
	maxAttempts?: number;
	circuitFailureThreshold?: number;
	circuitResetTimeoutMs?: number;
	circuitSuccessThreshold?: number;
	required?: boolean;
}

export interface ResolvedApprovalsServiceConfig {
	baseUrl: string;
	token?: string;
	workspaceId: string;
	approverUserId?: string;
	agentId: string;
	surface: string;
	riskLevel: string;
	timeoutMs: number;
	maxAttempts: number;
	circuitFailureThreshold: number;
	circuitResetTimeoutMs: number;
	circuitSuccessThreshold: number;
	failureMode: DownstreamHttpFailureMode;
}

export interface RemoteApprovalRequest {
	requestId: string;
	autoApprovedReason?: string;
}

interface RequestApprovalResponse {
	approvalRequest?: {
		id?: string;
	};
	autoApproveEvidence?: {
		pattern?: string;
		confidence?: number;
		observationCount?: number;
		thresholdApplied?: number;
	};
}

const downstreamClients = new Map<string, downstream.DownstreamClient>();

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function getEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = trimString(process.env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim();
	for (const suffix of [
		REQUEST_APPROVAL_PATH,
		RESOLVE_APPROVAL_PATH,
		platformConnectServicePath(PLATFORM_CONNECT_SERVICES.approvals),
	]) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length);
		}
	}
	return normalized.replace(/\/+$/, "");
}

function normalizeRiskLevel(value: string | undefined): string {
	const normalized = value?.trim().toLowerCase();
	switch (normalized) {
		case "low":
		case "risk_level_low":
			return "RISK_LEVEL_LOW";
		case "medium":
		case "risk_level_medium":
			return "RISK_LEVEL_MEDIUM";
		case "high":
		case "risk_level_high":
			return "RISK_LEVEL_HIGH";
		case "critical":
		case "risk_level_critical":
			return "RISK_LEVEL_CRITICAL";
		default:
			return DEFAULT_RISK_LEVEL;
	}
}

function resolveWorkspaceId(
	config: ApprovalsServiceConfig | undefined,
): string | undefined {
	const configuredWorkspaceId = trimString(config?.workspaceId);
	const envWorkspaceId = getEnvValue([
		"APPROVALS_SERVICE_WORKSPACE_ID",
		"MAESTRO_APPROVALS_WORKSPACE_ID",
		"MAESTRO_EVALOPS_WORKSPACE_ID",
		"MAESTRO_WORKSPACE_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (configuredWorkspaceId ?? envWorkspaceId) {
		return configuredWorkspaceId ?? envWorkspaceId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

export function resolveApprovalsServiceConfig(
	config: ApprovalsServiceConfig | false | undefined,
): ResolvedApprovalsServiceConfig | null {
	if (config === false) {
		return null;
	}

	const baseUrl =
		trimString(config?.baseUrl) ??
		getEnvValue([
			"APPROVALS_SERVICE_URL",
			"MAESTRO_APPROVALS_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
		]);
	if (!baseUrl) {
		return null;
	}

	const workspaceId = resolveWorkspaceId(config);
	if (!workspaceId) {
		return null;
	}

	const storedToken = trimString(loadOAuthCredentials("evalops")?.access);
	const token =
		trimString(config?.token) ??
		getEnvValue([
			"APPROVALS_SERVICE_TOKEN",
			"MAESTRO_APPROVALS_SERVICE_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
		]) ??
		storedToken;

	const required =
		config?.required ??
		getEnvValue([
			"APPROVALS_SERVICE_REQUIRED",
			"MAESTRO_APPROVALS_SERVICE_REQUIRED",
		]) === "1";

	return {
		agentId:
			trimString(config?.agentId) ??
			getEnvValue([
				"APPROVALS_SERVICE_AGENT_ID",
				"MAESTRO_APPROVALS_AGENT_ID",
				"MAESTRO_EVALOPS_AGENT_ID",
				"MAESTRO_AGENT_ID",
			]) ??
			DEFAULT_AGENT_ID,
		approverUserId:
			trimString(config?.approverUserId) ??
			getEnvValue([
				"APPROVALS_SERVICE_APPROVER_USER_ID",
				"MAESTRO_APPROVALS_APPROVER_USER_ID",
			]),
		baseUrl: normalizeBaseUrl(baseUrl),
		circuitFailureThreshold:
			config?.circuitFailureThreshold ??
			parsePositiveInt(
				getEnvValue([
					"APPROVALS_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
					"MAESTRO_APPROVALS_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
				]),
				5,
			),
		circuitResetTimeoutMs:
			config?.circuitResetTimeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"APPROVALS_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
					"MAESTRO_APPROVALS_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
				]),
				30_000,
			),
		circuitSuccessThreshold:
			config?.circuitSuccessThreshold ??
			parsePositiveInt(
				getEnvValue([
					"APPROVALS_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
					"MAESTRO_APPROVALS_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
				]),
				2,
			),
		failureMode: required ? "required" : "optional",
		maxAttempts:
			config?.maxAttempts ??
			parsePositiveInt(
				getEnvValue([
					"APPROVALS_SERVICE_MAX_ATTEMPTS",
					"MAESTRO_APPROVALS_SERVICE_MAX_ATTEMPTS",
				]),
				DEFAULT_MAX_ATTEMPTS,
			),
		riskLevel: normalizeRiskLevel(
			config?.riskLevel ??
				getEnvValue([
					"APPROVALS_SERVICE_RISK_LEVEL",
					"MAESTRO_APPROVALS_SERVICE_RISK_LEVEL",
				]),
		),
		surface:
			trimString(config?.surface) ??
			getEnvValue([
				"APPROVALS_SERVICE_SURFACE",
				"MAESTRO_APPROVALS_SURFACE",
				"MAESTRO_EVALOPS_SURFACE",
				"MAESTRO_SURFACE",
			]) ??
			DEFAULT_SURFACE,
		timeoutMs:
			config?.timeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"APPROVALS_SERVICE_TIMEOUT_MS",
					"MAESTRO_APPROVALS_SERVICE_TIMEOUT_MS",
				]),
				DEFAULT_TIMEOUT_MS,
			),
		token,
		workspaceId,
	};
}

function getDownstreamClient(
	config: ResolvedApprovalsServiceConfig,
	op: ApprovalsCall,
): downstream.DownstreamClient {
	const failureMode = APPROVALS_CALL_FAILURE_MODES[op][config.failureMode];
	const key = JSON.stringify({
		baseUrl: config.baseUrl,
		failureMode,
		op,
		reset: config.circuitResetTimeoutMs,
		success: config.circuitSuccessThreshold,
		threshold: config.circuitFailureThreshold,
	});
	const cached = downstreamClients.get(key);
	if (cached) {
		return cached;
	}
	const client = downstream.New(`approvals.${op}`, {
		failureMode,
		breaker: {
			failureThreshold: config.circuitFailureThreshold,
			resetTimeoutMs: config.circuitResetTimeoutMs,
			successThreshold: config.circuitSuccessThreshold,
			toolName: `approvals.${op}`,
		},
	});
	downstreamClients.set(key, client);
	return client;
}

function toHttpFailureMode(
	client: downstream.DownstreamClient,
): DownstreamHttpFailureMode {
	return client.failureMode === downstream.FailClosed ? "required" : "optional";
}

function buildHeaders(
	config: ResolvedApprovalsServiceConfig,
): Record<string, string> {
	return {
		...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		"Content-Type": "application/json",
	};
}

function encodeActionPayload(
	request: ActionApprovalRequest,
	sessionId: string | undefined,
): string {
	return Buffer.from(
		JSON.stringify({
			localRequestId: request.id,
			toolName: request.toolName,
			displayName: request.displayName,
			summaryLabel: request.summaryLabel,
			actionDescription: request.actionDescription,
			args: request.args,
			reason: request.reason,
			sessionId,
		}),
		"utf8",
	).toString("base64");
}

function buildContextJson(
	request: ActionApprovalRequest,
	sessionId: string | undefined,
): string {
	return JSON.stringify({
		localRequestId: request.id,
		sessionId,
		source: "maestro",
	});
}

function normalizeAutoApprovedReason(
	evidence: RequestApprovalResponse["autoApproveEvidence"],
): string | undefined {
	if (!evidence) {
		return undefined;
	}
	const details = [
		trimString(evidence.pattern)
			? `pattern=${trimString(evidence.pattern)}`
			: undefined,
		typeof evidence.confidence === "number"
			? `confidence=${evidence.confidence.toFixed(2)}`
			: undefined,
		typeof evidence.observationCount === "number"
			? `observations=${Math.trunc(evidence.observationCount)}`
			: undefined,
	].filter((item): item is string => Boolean(item));
	return details.length > 0
		? `Auto-approved by approvals service habit (${details.join(", ")})`
		: "Auto-approved by approvals service habit";
}

function toServiceDecision(
	decision: ActionApprovalDecision,
): "DECISION_TYPE_APPROVED" | "DECISION_TYPE_DENIED" {
	return decision.approved ? "DECISION_TYPE_APPROVED" : "DECISION_TYPE_DENIED";
}

async function callApprovals<T>(
	config: ResolvedApprovalsServiceConfig,
	op: ApprovalsCall,
	path: string,
	body: Record<string, unknown>,
	parse: (response: Response) => Promise<T>,
	failOpenValue: () => T,
	options?: {
		signal?: AbortSignal;
	},
): Promise<T> {
	const client = getDownstreamClient(config, op);
	return downstream.CallOp(
		client,
		op,
		async () => {
			const response = await fetchDownstream(
				`${config.baseUrl}${path}`,
				{
					method: "POST",
					headers: buildHeaders(config),
					signal: options?.signal,
					body: JSON.stringify(body),
				},
				{
					serviceName: "approvals service",
					failureMode: toHttpFailureMode(client),
					timeoutMs: config.timeoutMs,
					maxAttempts: config.maxAttempts,
				},
			);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`approvals service returned ${response.status}: ${
						text || response.statusText
					}`,
				);
			}
			return await parse(response);
		},
		failOpenValue,
	);
}

export async function requestApprovalWithApprovalsService(
	config: ResolvedApprovalsServiceConfig,
	request: ActionApprovalRequest,
	options?: {
		sessionId?: string;
		signal?: AbortSignal;
	},
): Promise<RemoteApprovalRequest | null> {
	const payload = await callApprovals<RequestApprovalResponse | null>(
		config,
		"requestApproval",
		REQUEST_APPROVAL_PATH,
		{
			workspaceId: config.workspaceId,
			approverUserId: config.approverUserId,
			agentId: config.agentId,
			surface: config.surface,
			actionType: request.toolName,
			actionPayload: encodeActionPayload(request, options?.sessionId),
			riskLevel: config.riskLevel,
			contextJson: buildContextJson(request, options?.sessionId),
		},
		async (response) => (await response.json()) as RequestApprovalResponse,
		() => null,
		options,
	);
	if (!payload) {
		return null;
	}

	const requestId = trimString(payload.approvalRequest?.id);
	if (!requestId) {
		throw new Error("approvals service response did not include request id");
	}
	return {
		requestId,
		autoApprovedReason: normalizeAutoApprovedReason(
			payload.autoApproveEvidence,
		),
	};
}

export async function resolveApprovalWithApprovalsService(
	config: ResolvedApprovalsServiceConfig,
	requestId: string,
	decision: ActionApprovalDecision,
	options?: {
		signal?: AbortSignal;
	},
): Promise<void> {
	await callApprovals<void>(
		config,
		"resolveApproval",
		RESOLVE_APPROVAL_PATH,
		{
			approvalRequestId: requestId,
			decision: toServiceDecision(decision),
			decidedBy:
				decision.resolvedBy === "user" ? "maestro_user" : "maestro_policy",
			reason: decision.reason,
		},
		async () => undefined,
		() => undefined,
		options,
	);
}

export function resetApprovalsDownstreamForTests(): void {
	downstreamClients.clear();
}
