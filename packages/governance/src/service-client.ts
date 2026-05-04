import { Buffer } from "node:buffer";
import type {
	GovernanceEvaluationResult,
	GovernanceScanResult,
	GovernanceToolCall,
} from "./types.js";

const DEFAULT_AGENT_ID = "maestro";
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 2_000;
const CONNECT_PROTOCOL_VERSION = "1";
const GOVERNANCE_SERVICE_PATH = "/governance.v1.GovernanceService";
const EVALUATE_ACTION_PATH = `${GOVERNANCE_SERVICE_PATH}/EvaluateAction`;
const DETECT_PII_PATH = `${GOVERNANCE_SERVICE_PATH}/DetectPII`;
const GET_SAFETY_POLICY_PATH = `${GOVERNANCE_SERVICE_PATH}/GetSafetyPolicy`;

export interface GovernanceServiceConfig {
	baseUrl?: string;
	token?: string;
	workspaceId?: string;
	agentId?: string;
	timeoutMs?: number;
	maxAttempts?: number;
}

export interface ResolvedGovernanceServiceConfig {
	baseUrl: string;
	token?: string;
	workspaceId: string;
	agentId: string;
	timeoutMs: number;
	maxAttempts: number;
}

export interface PlatformSafetyPolicySummary {
	workspaceId?: string;
	ruleCount: number;
	decisions: string[];
}

interface EvaluateActionResponse {
	evaluation?: {
		decision?: string | number;
		reasons?: string[];
		matchedRules?: string[];
	};
	pii?: DetectPIIResponse["result"];
}

interface DetectPIIResponse {
	result?: {
		spans?: Array<{
			category?: string | number;
			detector?: string;
		}>;
		classification?: string | number;
		enforcementAction?: string | number;
		enforcement_action?: string | number;
		redactedText?: string;
		redacted_text?: string;
		reasons?: string[];
	};
}

interface GetSafetyPolicyResponse {
	policy?: {
		workspaceId?: string;
		workspace_id?: string;
		rules?: Array<{
			action?: string | number;
		}>;
	};
}

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function getEnvValue(names: readonly string[]): string | undefined {
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
	return value.replace(/\/+$/u, "");
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = stripTrailingSlashes(baseUrl.trim());
	for (const suffix of [
		EVALUATE_ACTION_PATH,
		DETECT_PII_PATH,
		GET_SAFETY_POLICY_PATH,
		GOVERNANCE_SERVICE_PATH,
	]) {
		if (normalized.endsWith(suffix)) {
			normalized = stripTrailingSlashes(normalized.slice(0, -suffix.length));
		}
	}
	return normalized;
}

function resolveWorkspaceId(
	config: GovernanceServiceConfig | undefined,
	toolCall?: GovernanceToolCall,
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
	return (
		configuredWorkspaceId ?? trimString(toolCall?.user?.orgId) ?? envWorkspaceId
	);
}

export function resolveGovernanceServiceConfig(
	config: GovernanceServiceConfig | false | undefined,
	toolCall?: GovernanceToolCall,
): ResolvedGovernanceServiceConfig | null {
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
	const workspaceId = resolveWorkspaceId(config, toolCall);
	if (!baseUrl || !workspaceId) {
		return null;
	}

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
			]),
		workspaceId,
	};
}

function buildHeaders(
	config: ResolvedGovernanceServiceConfig,
): Record<string, string> {
	return {
		...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		"Content-Type": "application/json",
	};
}

async function fetchJson(
	config: ResolvedGovernanceServiceConfig,
	path: string,
	body: unknown,
): Promise<unknown> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
		try {
			const response = await fetch(`${config.baseUrl}${path}`, {
				body: JSON.stringify(body),
				headers: buildHeaders(config),
				method: "POST",
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!response.ok) {
				throw new Error(
					`governance service returned ${response.status}: ${
						(await response.text()) || response.statusText
					}`,
				);
			}
			return await response.json();
		} catch (error) {
			clearTimeout(timeout);
			lastError = error;
			if (attempt >= config.maxAttempts) {
				break;
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function encodeActionPayload(toolCall: GovernanceToolCall): string {
	return Buffer.from(
		JSON.stringify({
			args: toolCall.args,
			metadata: toolCall.metadata,
			session: toolCall.session
				? {
						id: toolCall.session.id,
						startedAt: toolCall.session.startedAt.toISOString(),
					}
				: undefined,
			toolName: toolCall.toolName,
			user: toolCall.user,
			userIntent: toolCall.userIntent,
		}),
		"utf8",
	).toString("base64");
}

function normalizeDecision(
	decision: string | number | undefined,
): GovernanceEvaluationResult["verdict"] {
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

export async function evaluateActionWithGovernanceService(
	config: ResolvedGovernanceServiceConfig,
	toolCall: GovernanceToolCall,
): Promise<GovernanceEvaluationResult> {
	const payload = (await fetchJson(config, EVALUATE_ACTION_PATH, {
		actionPayload: encodeActionPayload(toolCall),
		actionType: toolCall.toolName,
		agentId: config.agentId,
		context: buildActionContext(),
		workspaceId: config.workspaceId,
	})) as EvaluateActionResponse;
	const evaluation = payload.evaluation;
	if (!evaluation) {
		throw new Error("governance service response did not include evaluation");
	}

	const verdict = normalizeDecision(evaluation.decision);
	if (verdict === "allow") {
		return { triggeredBy: "policy", verdict };
	}

	const reasons = normalizeStringArray(evaluation.reasons);
	const matchedRules = normalizeStringArray(evaluation.matchedRules);
	return {
		reason: reasons.join("; ") || "Action denied by governance service",
		ruleId: matchedRules[0] ?? "governance-service",
		triggeredBy: "policy",
		verdict,
	};
}

function buildActionContext(): Record<string, string> | undefined {
	const environment = getEnvValue([
		"GOVERNANCE_SERVICE_ENVIRONMENT",
		"NODE_ENV",
	]);
	return environment ? { environment } : undefined;
}

function stringifyPayload(payload: unknown): string {
	return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function normalizeCategory(value: string | number | undefined): string {
	if (typeof value === "number") {
		return `PII_CATEGORY_${value}`;
	}
	return value?.trim() || "PII_CATEGORY_UNSPECIFIED";
}

export async function detectPIIWithGovernanceService(
	config: ResolvedGovernanceServiceConfig,
	payload: unknown,
): Promise<GovernanceScanResult> {
	const response = (await fetchJson(config, DETECT_PII_PATH, {
		text: stringifyPayload(payload),
	})) as DetectPIIResponse;
	const result = response.result;
	if (!result) {
		throw new Error("governance service response did not include result");
	}

	const spans = result.spans ?? [];
	const findingTypes = [
		...new Set(spans.map((span) => normalizeCategory(span.category))),
	];
	const enforcementAction =
		result.enforcementAction ?? result.enforcement_action ?? "";
	const blocked =
		enforcementAction === "PII_ENFORCEMENT_ACTION_BLOCK" ||
		enforcementAction === 3;
	return {
		blockReason: blocked
			? normalizeStringArray(result.reasons).join("; ") ||
				"PII blocked by governance service"
			: undefined,
		blocked,
		findingCount: spans.length,
		findingTypes,
		hasSensitiveContent: spans.length > 0,
		sanitizedPayload:
			result.redactedText ?? result.redacted_text ?? stringifyPayload(payload),
	};
}

export async function getSafetyPolicyWithGovernanceService(
	config: ResolvedGovernanceServiceConfig,
): Promise<PlatformSafetyPolicySummary> {
	const response = (await fetchJson(config, GET_SAFETY_POLICY_PATH, {
		workspaceId: config.workspaceId,
	})) as GetSafetyPolicyResponse;
	const policy = response.policy;
	return {
		decisions: [
			...new Set(
				(policy?.rules ?? []).map((rule) => String(rule.action ?? "unknown")),
			),
		],
		ruleCount: policy?.rules?.length ?? 0,
		workspaceId: policy?.workspaceId ?? policy?.workspace_id,
	};
}
