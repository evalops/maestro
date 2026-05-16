import { Buffer } from "node:buffer";
import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import {
	type PlatformServiceConfig,
	postPlatformConnect,
	resolvePlatformServiceConfig,
	trimString,
} from "./client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "./core-services.js";

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_ATTEMPTS = 2;

const DELEGATE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.delegate,
);
const RESOLVE_DELEGATION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.resolveDelegation,
);

const AGENT_REGISTRY_BASE_URL_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_SERVICE_URL",
	"AGENT_REGISTRY_SERVICE_URL",
	"MAESTRO_AGENT_REGISTRY_URL",
	"AGENT_REGISTRY_BASE_URL",
	"PLATFORM_AGENT_REGISTRY_URL",
] as const;

const AGENT_REGISTRY_TOKEN_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_SERVICE_TOKEN",
	"AGENT_REGISTRY_SERVICE_TOKEN",
	"MAESTRO_AGENT_REGISTRY_TOKEN",
	"AGENT_REGISTRY_TOKEN",
	...EVALOPS_ACCESS_TOKEN_ENV_VARS,
] as const;

const AGENT_REGISTRY_ORGANIZATION_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_ORG_ID",
	"AGENT_REGISTRY_ORGANIZATION_ID",
	"AGENT_REGISTRY_ORG_ID",
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
] as const;

const AGENT_REGISTRY_WORKSPACE_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_WORKSPACE_ID",
	"AGENT_REGISTRY_WORKSPACE_ID",
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	...EVALOPS_WORKSPACE_ID_ENV_VARS,
] as const;

const AGENT_REGISTRY_TIMEOUT_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_TIMEOUT_MS",
	"AGENT_REGISTRY_SERVICE_TIMEOUT_MS",
] as const;

const AGENT_REGISTRY_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_AGENT_REGISTRY_MAX_ATTEMPTS",
	"AGENT_REGISTRY_SERVICE_MAX_ATTEMPTS",
] as const;

const AGENT_REGISTRY_BASE_URL_SUFFIXES = [
	DELEGATE_PATH,
	RESOLVE_DELEGATION_PATH,
	platformConnectServicePath(PLATFORM_CONNECT_SERVICES.agents),
] as const;

export enum PlatformDelegationStatusValue {
	Pending = "DELEGATION_STATUS_PENDING",
	Accepted = "DELEGATION_STATUS_ACCEPTED",
	Rejected = "DELEGATION_STATUS_REJECTED",
	Completed = "DELEGATION_STATUS_COMPLETED",
	Failed = "DELEGATION_STATUS_FAILED",
	TimedOut = "DELEGATION_STATUS_TIMED_OUT",
}

export interface PlatformDelegationRecord {
	id?: string;
	workspaceId?: string;
	fromAgentId?: string;
	toAgentId?: string;
	requiredCapability?: string;
	objectiveId?: string;
	workflowRunId?: string;
	workflowStepId?: string;
	status?: PlatformDelegationStatusValue | string;
	reason?: string;
	errorMessage?: string;
	createdAt?: string;
	resolvedAt?: string;
}

export interface PlatformAgentRegistryDelegateInput {
	fromAgentId: string;
	toAgentId?: string;
	requiredCapability?: string;
	objectiveId?: string;
	workflowRunId?: string;
	workflowStepId?: string;
	contextPayload?: Record<string, unknown>;
	reason?: string;
}

export interface PlatformAgentRegistryResolveDelegationInput {
	delegationId: string;
	status: PlatformDelegationStatusValue | string;
	resultPayload?: Record<string, unknown>;
	errorMessage?: string;
}

export interface PlatformAgentRegistryDelegateResult {
	delegation?: PlatformDelegationRecord;
}

export interface PlatformAgentRegistryResolveDelegationResult {
	delegation?: PlatformDelegationRecord;
}

function firstString(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): string | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
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

function stripUndefinedValues(
	record: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined),
	);
}

function encodeJsonBytes(
	value: Record<string, unknown> | undefined,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function normalizeDelegation(
	record: Record<string, unknown> | undefined,
): PlatformDelegationRecord | undefined {
	if (!record) {
		return undefined;
	}
	const id = firstString(record, "id");
	const status = firstString(record, "status") as
		| PlatformDelegationStatusValue
		| string
		| undefined;
	return stripUndefinedValues({
		id,
		workspaceId: firstString(record, "workspaceId", "workspace_id"),
		fromAgentId: firstString(record, "fromAgentId", "from_agent_id"),
		toAgentId: firstString(record, "toAgentId", "to_agent_id"),
		requiredCapability: firstString(
			record,
			"requiredCapability",
			"required_capability",
		),
		objectiveId: firstString(record, "objectiveId", "objective_id"),
		workflowRunId: firstString(record, "workflowRunId", "workflow_run_id"),
		workflowStepId: firstString(record, "workflowStepId", "workflow_step_id"),
		status,
		reason: firstString(record, "reason"),
		errorMessage: firstString(record, "errorMessage", "error_message"),
		createdAt: firstString(record, "createdAt", "created_at"),
		resolvedAt: firstString(record, "resolvedAt", "resolved_at"),
	}) as PlatformDelegationRecord;
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
		return {};
	}
	return JSON.parse(text) as Record<string, unknown>;
}

async function postAgentRegistryOperation(
	path: string,
	body: Record<string, unknown>,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<Record<string, unknown> | null> {
	const config = options?.config ?? (await resolveAgentRegistryServiceConfig());
	if (!config) {
		return null;
	}
	const response = await postPlatformConnect(
		config,
		path,
		body,
		{
			serviceName: "agent registry service",
			failureMode: "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			signal: options?.signal,
		},
		{
			"X-Workspace-ID": config.workspaceId,
		},
	);
	return parseJsonResponse(response, "agent registry service");
}

export async function resolveAgentRegistryServiceConfig(): Promise<PlatformServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: AGENT_REGISTRY_BASE_URL_ENV_VARS,
		tokenEnvVars: AGENT_REGISTRY_TOKEN_ENV_VARS,
		organizationEnvVars: AGENT_REGISTRY_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: AGENT_REGISTRY_WORKSPACE_ENV_VARS,
		timeoutEnvVars: AGENT_REGISTRY_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: AGENT_REGISTRY_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: AGENT_REGISTRY_BASE_URL_SUFFIXES,
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
		baseUrl: trimString(config.baseUrl) ?? config.baseUrl,
	};
}

export async function delegateAgentWithPlatform(
	input: PlatformAgentRegistryDelegateInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryDelegateResult | null> {
	const payload = await postAgentRegistryOperation(
		DELEGATE_PATH,
		stripUndefinedValues({
			fromAgentId: input.fromAgentId,
			toAgentId: input.toAgentId,
			requiredCapability: input.requiredCapability,
			objectiveId: input.objectiveId,
			workflowRunId: input.workflowRunId,
			workflowStepId: input.workflowStepId,
			contextPayload: encodeJsonBytes(input.contextPayload),
			reason: input.reason,
		}),
		options,
	);
	if (!payload) {
		return null;
	}
	return {
		delegation: normalizeDelegation(objectValue(payload, "delegation")),
	};
}

export async function resolveAgentDelegationWithPlatform(
	input: PlatformAgentRegistryResolveDelegationInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryResolveDelegationResult | null> {
	const payload = await postAgentRegistryOperation(
		RESOLVE_DELEGATION_PATH,
		stripUndefinedValues({
			delegationId: input.delegationId,
			status: input.status,
			resultPayload: encodeJsonBytes(input.resultPayload),
			errorMessage: input.errorMessage,
		}),
		options,
	);
	if (!payload) {
		return null;
	}
	return {
		delegation: normalizeDelegation(objectValue(payload, "delegation")),
	};
}
