import { Buffer } from "node:buffer";
import type {
	ActionApprovalContext,
	ActionFirewallVerdict,
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
const DEFAULT_TIMEOUT_MS = 2_000;
const EVALUATE_ACTION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.governance.evaluateAction,
);

export const GOVERNANCE_CALL_FAILURE_MODES = {
	evaluateAction: {
		optional: downstream.FailOpen,
		required: downstream.FailClosed,
	},
} as const;

type GovernanceCall = keyof typeof GOVERNANCE_CALL_FAILURE_MODES;

export interface ActionFirewallGovernanceServiceConfig {
	baseUrl?: string;
	token?: string;
	workspaceId?: string;
	agentId?: string;
	timeoutMs?: number;
	maxAttempts?: number;
	circuitFailureThreshold?: number;
	circuitResetTimeoutMs?: number;
	circuitSuccessThreshold?: number;
	required?: boolean;
}

export interface ResolvedActionFirewallGovernanceServiceConfig {
	baseUrl: string;
	token?: string;
	workspaceId: string;
	agentId: string;
	timeoutMs: number;
	maxAttempts: number;
	circuitFailureThreshold: number;
	circuitResetTimeoutMs: number;
	circuitSuccessThreshold: number;
	failureMode: DownstreamHttpFailureMode;
}

interface EvaluateActionResponse {
	evaluation?: {
		decision?: string | number;
		reasons?: string[];
		matchedRules?: string[];
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

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = stripTrailingSlashes(baseUrl.trim());
	for (const suffix of [
		EVALUATE_ACTION_PATH,
		platformConnectServicePath(PLATFORM_CONNECT_SERVICES.governance),
	]) {
		if (normalized.endsWith(suffix)) {
			normalized = stripTrailingSlashes(normalized.slice(0, -suffix.length));
		}
	}
	return normalized;
}

function resolveWorkspaceId(
	config: ActionFirewallGovernanceServiceConfig | undefined,
	context: ActionApprovalContext,
): string | undefined {
	const configuredWorkspaceId = trimString(config?.workspaceId);
	const envWorkspaceId = getEnvValue([
		"GOVERNANCE_SERVICE_WORKSPACE_ID",
		"MAESTRO_GOVERNANCE_WORKSPACE_ID",
		"MAESTRO_EVALOPS_WORKSPACE_ID",
		"MAESTRO_WORKSPACE_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (
		configuredWorkspaceId ??
		trimString(context.user?.orgId) ??
		envWorkspaceId
	) {
		return (
			configuredWorkspaceId ?? trimString(context.user?.orgId) ?? envWorkspaceId
		);
	}

	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

export function resolveActionFirewallGovernanceServiceConfig(
	config: ActionFirewallGovernanceServiceConfig | false | undefined,
	context: ActionApprovalContext,
): ResolvedActionFirewallGovernanceServiceConfig | null {
	if (config === false) {
		return null;
	}

	const baseUrl =
		trimString(config?.baseUrl) ??
		getEnvValue([
			"GOVERNANCE_SERVICE_URL",
			"MAESTRO_GOVERNANCE_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
		]);
	if (!baseUrl) {
		return null;
	}

	const workspaceId = resolveWorkspaceId(config, context);
	if (!workspaceId) {
		return null;
	}

	const storedToken = trimString(loadOAuthCredentials("evalops")?.access);
	const required =
		config?.required ??
		getEnvValue([
			"GOVERNANCE_SERVICE_REQUIRED",
			"MAESTRO_GOVERNANCE_SERVICE_REQUIRED",
		]) === "1";

	return {
		agentId:
			trimString(config?.agentId) ??
			getEnvValue([
				"GOVERNANCE_SERVICE_AGENT_ID",
				"MAESTRO_GOVERNANCE_AGENT_ID",
				"MAESTRO_EVALOPS_AGENT_ID",
				"MAESTRO_AGENT_ID",
			]) ??
			DEFAULT_AGENT_ID,
		baseUrl: normalizeBaseUrl(baseUrl),
		circuitFailureThreshold:
			config?.circuitFailureThreshold ??
			parsePositiveInt(
				getEnvValue([
					"GOVERNANCE_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
					"MAESTRO_GOVERNANCE_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
				]),
				5,
			),
		circuitResetTimeoutMs:
			config?.circuitResetTimeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"GOVERNANCE_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
					"MAESTRO_GOVERNANCE_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
				]),
				30_000,
			),
		circuitSuccessThreshold:
			config?.circuitSuccessThreshold ??
			parsePositiveInt(
				getEnvValue([
					"GOVERNANCE_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
					"MAESTRO_GOVERNANCE_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
				]),
				2,
			),
		failureMode: required ? "required" : "optional",
		maxAttempts:
			config?.maxAttempts ??
			parsePositiveInt(
				getEnvValue([
					"GOVERNANCE_SERVICE_MAX_ATTEMPTS",
					"MAESTRO_GOVERNANCE_SERVICE_MAX_ATTEMPTS",
				]),
				DEFAULT_MAX_ATTEMPTS,
			),
		timeoutMs:
			config?.timeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"GOVERNANCE_SERVICE_TIMEOUT_MS",
					"MAESTRO_GOVERNANCE_SERVICE_TIMEOUT_MS",
				]),
				DEFAULT_TIMEOUT_MS,
			),
		token:
			trimString(config?.token) ??
			getEnvValue([
				"GOVERNANCE_SERVICE_TOKEN",
				"MAESTRO_GOVERNANCE_SERVICE_TOKEN",
				"MAESTRO_EVALOPS_ACCESS_TOKEN",
				"EVALOPS_TOKEN",
			]) ??
			storedToken,
		workspaceId,
	};
}

function getDownstreamClient(
	config: ResolvedActionFirewallGovernanceServiceConfig,
	op: GovernanceCall,
): downstream.DownstreamClient {
	const failureMode = GOVERNANCE_CALL_FAILURE_MODES[op][config.failureMode];
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
	const client = downstream.New(`governance.${op}`, {
		failureMode,
		breaker: {
			failureThreshold: config.circuitFailureThreshold,
			resetTimeoutMs: config.circuitResetTimeoutMs,
			successThreshold: config.circuitSuccessThreshold,
			toolName: `governance.${op}`,
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
	config: ResolvedActionFirewallGovernanceServiceConfig,
): Record<string, string> {
	return {
		...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		"Content-Type": "application/json",
	};
}

function buildActionContext(): Record<string, string> | undefined {
	const environment = getEnvValue([
		"GOVERNANCE_SERVICE_ENVIRONMENT",
		"NODE_ENV",
	]);
	return environment ? { environment } : undefined;
}

function encodeActionPayload(context: ActionApprovalContext): string {
	return Buffer.from(
		JSON.stringify({
			args: context.args,
			metadata: context.metadata,
			session: context.session
				? {
						id: context.session.id,
						startedAt: context.session.startedAt.toISOString(),
					}
				: undefined,
			toolName: context.toolName,
			user: context.user,
			userIntent: context.userIntent,
		}),
		"utf8",
	).toString("base64");
}

function normalizeDecision(
	decision: string | number | undefined,
): ActionFirewallVerdict["action"] {
	switch (decision) {
		case "ACTION_DECISION_ALLOW":
		case "allow":
		case 1:
			return "allow";
		case "ACTION_DECISION_DENY":
		case "deny":
		case 2:
			return "block";
		case "ACTION_DECISION_REQUIRE_APPROVAL":
		case "require_approval":
		case 3:
			return "require_approval";
		default:
			throw new Error("governance service response did not include a decision");
	}
}

function normalizeStringArray(value: string[] | undefined): string[] {
	return Array.isArray(value)
		? value.map((item) => item.trim()).filter((item) => item.length > 0)
		: [];
}

function normalizeEvaluationResponse(
	payload: EvaluateActionResponse,
): ActionFirewallVerdict {
	const evaluation = payload.evaluation;
	if (!evaluation) {
		throw new Error("governance service response did not include evaluation");
	}

	const action = normalizeDecision(evaluation.decision);
	if (action === "allow") {
		return { action };
	}

	const reasons = normalizeStringArray(evaluation.reasons);
	const matchedRules = normalizeStringArray(evaluation.matchedRules);
	const ruleId = matchedRules[0] ?? "governance-service";
	const reason = reasons.join("; ") || "Action denied by governance service";
	if (action === "block") {
		return {
			action,
			ruleId,
			reason,
		};
	}
	return {
		action: "require_approval",
		ruleId,
		reason,
	};
}

export async function evaluateActionWithActionFirewallGovernanceService(
	config: ResolvedActionFirewallGovernanceServiceConfig,
	context: ActionApprovalContext,
): Promise<ActionFirewallVerdict | null> {
	const client = getDownstreamClient(config, "evaluateAction");
	return downstream.CallOp(
		client,
		"evaluateAction",
		async () => {
			const response = await fetchDownstream(
				`${config.baseUrl}${EVALUATE_ACTION_PATH}`,
				{
					method: "POST",
					headers: buildHeaders(config),
					body: JSON.stringify({
						workspaceId: config.workspaceId,
						agentId: config.agentId,
						actionType: context.toolName,
						actionPayload: encodeActionPayload(context),
						context: buildActionContext(),
					}),
				},
				{
					serviceName: "governance service",
					failureMode: toHttpFailureMode(client),
					timeoutMs: config.timeoutMs,
					maxAttempts: config.maxAttempts,
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`governance service returned ${response.status}: ${
						text || response.statusText
					}`,
				);
			}

			return normalizeEvaluationResponse(
				(await response.json()) as EvaluateActionResponse,
			);
		},
		() => null,
	);
}

export function resetActionFirewallGovernanceDownstreamForTests(): void {
	downstreamClients.clear();
}
