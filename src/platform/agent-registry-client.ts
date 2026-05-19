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
const LIST_AGENTS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.list,
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
	LIST_AGENTS_PATH,
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
	a2aTaskId?: string;
	a2aMessageId?: string;
	a2aEndpointUrl?: string;
	a2aDispatchStatus?: string;
	a2aDispatchError?: string;
	a2aSkillId?: string;
}

export interface PlatformAgentRegistryDelegateInput {
	fromAgentId: string;
	toAgentId?: string;
	requiredCapability?: string;
	a2aSkillId?: string;
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

export interface PlatformAgentRegistryListAgentsInput {
	workspaceId?: string;
	agentType?: string;
	capability?: string;
	surface?: string;
	status?: string;
	limit?: number;
	offset?: number;
}

export interface PlatformAgentA2ASkill {
	id: string;
	name?: string;
	description?: string;
	tags?: string[];
	inputModes?: string[];
	outputModes?: string[];
	requiredContextGrants?: string[];
	approvalPolicyRef?: string;
	maxAutonomy?: string;
	requiredArtifactKinds?: string[];
	optionalArtifactKinds?: string[];
	allowedTaskClasses?: string[];
	deniedTaskClasses?: string[];
	attributes?: Record<string, string>;
	metadata?: Record<string, string | number | boolean>;
}

export interface PlatformAgentA2APeerProjection {
	publicEndpointUrl?: string;
	internalEndpointUrl?: string;
	agentCardUrl?: string;
	protocolBinding?: string;
	protocolVersion?: string;
	supportedExtensions?: string[];
	skills?: PlatformAgentA2ASkill[];
	securitySchemes?: string[];
	agentCardETag?: string;
	agentCardHash?: string;
	pushNotifications?: boolean;
	attributes?: Record<string, string>;
}

export interface PlatformAgentRegistryAgent {
	id?: string;
	workspaceId?: string;
	name?: string;
	agentType?: string;
	capabilities?: string[];
	surfaces?: string[];
	status?: string;
	a2a?: PlatformAgentA2APeerProjection;
}

export interface PlatformAgentRegistryDelegateResult {
	delegation?: PlatformDelegationRecord;
}

export interface PlatformAgentRegistryResolveDelegationResult {
	delegation?: PlatformDelegationRecord;
}

export interface PlatformAgentRegistryListAgentsResult {
	agents: PlatformAgentRegistryAgent[];
	total?: number;
}

export interface PlatformAgentRegistryA2APeerCandidate {
	agent: PlatformAgentRegistryAgent;
	endpointUrl: string;
	endpointKind?: "public" | "internal";
	agentCardUrl?: string;
	protocolBinding?: string;
	protocolVersion?: string;
	skills: PlatformAgentA2ASkill[];
	supportedExtensions?: string[];
	pushNotifications?: boolean;
}

export interface PlatformAgentRegistryListA2APeersInput
	extends PlatformAgentRegistryListAgentsInput {
	skillId?: string;
	preferInternalEndpoint?: boolean;
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

function firstNumber(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): number | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function firstBoolean(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): boolean | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") {
			return value;
		}
	}
	return undefined;
}

function stringList(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): string[] | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (!Array.isArray(value)) {
			continue;
		}
		const strings = value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
		if (strings.length > 0) {
			return strings;
		}
	}
	return undefined;
}

function stringRecord(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): Record<string, string> | undefined {
	const object = record ? objectValue(record, ...keys) : undefined;
	if (!object) {
		return undefined;
	}
	const entries = Object.entries(object)
		.map(([key, value]) => [
			key,
			typeof value === "string" ? value.trim() : undefined,
		])
		.filter((entry): entry is [string, string] => Boolean(entry[1]));
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function primitiveRecord(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): Record<string, string | number | boolean> | undefined {
	const object = record ? objectValue(record, ...keys) : undefined;
	if (!object) {
		return undefined;
	}
	const output: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(object)) {
		const normalizedKey = key.trim();
		if (!normalizedKey) {
			continue;
		}
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			output[normalizedKey] = typeof value === "string" ? value.trim() : value;
		}
	}
	return Object.keys(output).length > 0 ? output : undefined;
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

function normalizeA2ASkill(
	record: Record<string, unknown> | undefined,
): PlatformAgentA2ASkill | undefined {
	const id = firstString(record, "id");
	if (!id) {
		return undefined;
	}
	return stripUndefinedValues({
		id,
		name: firstString(record, "name"),
		description: firstString(record, "description"),
		tags: stringList(record, "tags"),
		inputModes: stringList(record, "inputModes", "input_modes"),
		outputModes: stringList(record, "outputModes", "output_modes"),
		requiredContextGrants: stringList(
			record,
			"requiredContextGrants",
			"required_context_grants",
		),
		approvalPolicyRef: firstString(
			record,
			"approvalPolicyRef",
			"approval_policy_ref",
		),
		maxAutonomy: firstString(record, "maxAutonomy", "max_autonomy"),
		requiredArtifactKinds: stringList(
			record,
			"requiredArtifactKinds",
			"required_artifact_kinds",
		),
		optionalArtifactKinds: stringList(
			record,
			"optionalArtifactKinds",
			"optional_artifact_kinds",
		),
		allowedTaskClasses: stringList(
			record,
			"allowedTaskClasses",
			"allowed_task_classes",
		),
		deniedTaskClasses: stringList(
			record,
			"deniedTaskClasses",
			"denied_task_classes",
		),
		attributes: stringRecord(record, "attributes"),
		metadata: primitiveRecord(record, "metadata"),
	}) as unknown as PlatformAgentA2ASkill;
}

function normalizeA2APeerProjection(
	record: Record<string, unknown> | undefined,
): PlatformAgentA2APeerProjection | undefined {
	if (!record) {
		return undefined;
	}
	const skills = Array.isArray(record.skills)
		? record.skills
				.filter(
					(skill): skill is Record<string, unknown> =>
						Boolean(skill) &&
						typeof skill === "object" &&
						!Array.isArray(skill),
				)
				.map((skill) => normalizeA2ASkill(skill))
				.filter((skill): skill is PlatformAgentA2ASkill => skill !== undefined)
		: undefined;
	return stripUndefinedValues({
		publicEndpointUrl: firstString(
			record,
			"publicEndpointUrl",
			"public_endpoint_url",
		),
		internalEndpointUrl: firstString(
			record,
			"internalEndpointUrl",
			"internal_endpoint_url",
		),
		agentCardUrl: firstString(record, "agentCardUrl", "agent_card_url"),
		protocolBinding: firstString(record, "protocolBinding", "protocol_binding"),
		protocolVersion: firstString(record, "protocolVersion", "protocol_version"),
		supportedExtensions: stringList(
			record,
			"supportedExtensions",
			"supported_extensions",
		),
		skills: skills && skills.length > 0 ? skills : undefined,
		securitySchemes: stringList(record, "securitySchemes", "security_schemes"),
		agentCardETag: firstString(record, "agentCardETag", "agent_card_etag"),
		agentCardHash: firstString(record, "agentCardHash", "agent_card_hash"),
		pushNotifications: firstBoolean(
			record,
			"pushNotifications",
			"push_notifications",
		),
		attributes: stringRecord(record, "attributes"),
	}) as PlatformAgentA2APeerProjection;
}

function normalizeAgent(
	record: Record<string, unknown> | undefined,
): PlatformAgentRegistryAgent | undefined {
	if (!record) {
		return undefined;
	}
	const a2a = normalizeA2APeerProjection(objectValue(record, "a2a"));
	return stripUndefinedValues({
		id: firstString(record, "id"),
		workspaceId: firstString(record, "workspaceId", "workspace_id"),
		name: firstString(record, "name"),
		agentType: firstString(record, "agentType", "agent_type"),
		capabilities: stringList(record, "capabilities"),
		surfaces: stringList(record, "surfaces"),
		status: firstString(record, "status"),
		a2a,
	}) as PlatformAgentRegistryAgent;
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
		a2aTaskId: firstString(record, "a2aTaskId", "a2a_task_id"),
		a2aMessageId: firstString(record, "a2aMessageId", "a2a_message_id"),
		a2aEndpointUrl: firstString(record, "a2aEndpointUrl", "a2a_endpoint_url"),
		a2aDispatchStatus: firstString(
			record,
			"a2aDispatchStatus",
			"a2a_dispatch_status",
		),
		a2aDispatchError: firstString(
			record,
			"a2aDispatchError",
			"a2a_dispatch_error",
		),
		a2aSkillId: firstString(record, "a2aSkillId", "a2a_skill_id"),
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

async function resolveAgentRegistryListServiceConfig(
	workspaceId?: string,
): Promise<PlatformServiceConfig | null> {
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
	const resolvedWorkspaceId = trimString(workspaceId) ?? config?.workspaceId;
	if (!config?.baseUrl || !resolvedWorkspaceId) {
		return null;
	}
	return {
		...config,
		baseUrl: trimString(config.baseUrl) ?? config.baseUrl,
		workspaceId: resolvedWorkspaceId,
	};
}

export async function listAgentsWithPlatform(
	input: PlatformAgentRegistryListAgentsInput = {},
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryListAgentsResult | null> {
	const explicitWorkspaceId = trimString(input.workspaceId);
	const resolvedConfig = options?.config
		? explicitWorkspaceId && explicitWorkspaceId !== options.config.workspaceId
			? { ...options.config, workspaceId: explicitWorkspaceId }
			: options.config
		: await resolveAgentRegistryListServiceConfig(explicitWorkspaceId);
	if (!resolvedConfig) {
		return null;
	}
	const payload = await postAgentRegistryOperation(
		LIST_AGENTS_PATH,
		stripUndefinedValues({
			workspaceId: explicitWorkspaceId,
			agentType: input.agentType,
			capability: input.capability,
			surface: input.surface,
			status: input.status,
			limit: input.limit,
			offset: input.offset,
		}),
		{ ...options, config: resolvedConfig },
	);
	if (!payload) {
		return null;
	}
	const agents = Array.isArray(payload.agents)
		? payload.agents
				.filter(
					(agent): agent is Record<string, unknown> =>
						Boolean(agent) &&
						typeof agent === "object" &&
						!Array.isArray(agent),
				)
				.map((agent) => normalizeAgent(agent))
				.filter(
					(agent): agent is PlatformAgentRegistryAgent => agent !== undefined,
				)
		: [];
	return {
		agents,
		total: firstNumber(payload, "total", "totalSize", "total_size"),
	};
}

export async function listA2APeerCandidatesWithPlatform(
	input: PlatformAgentRegistryListA2APeersInput = {},
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryA2APeerCandidate[] | null> {
	const result = await listAgentsWithPlatform(input, options);
	if (!result) {
		return null;
	}
	return result.agents
		.map((agent) => {
			const a2a = agent.a2a;
			const useInternalEndpoint = Boolean(
				input.preferInternalEndpoint && a2a?.internalEndpointUrl,
			);
			const endpointUrl =
				useInternalEndpoint && a2a?.internalEndpointUrl
					? a2a.internalEndpointUrl
					: (a2a?.publicEndpointUrl ?? a2a?.internalEndpointUrl);
			if (!a2a || !endpointUrl) {
				return undefined;
			}
			const endpointKind =
				useInternalEndpoint || endpointUrl === a2a.internalEndpointUrl
					? "internal"
					: "public";
			const skills = a2a.skills ?? [];
			if (
				input.skillId &&
				!skills.some((skill) => skill.id === input.skillId)
			) {
				return undefined;
			}
			return stripUndefinedValues({
				agent,
				endpointUrl,
				endpointKind,
				agentCardUrl: a2a.agentCardUrl,
				protocolBinding: a2a.protocolBinding,
				protocolVersion: a2a.protocolVersion,
				skills,
				supportedExtensions: a2a.supportedExtensions,
				pushNotifications: a2a.pushNotifications,
			}) as unknown as PlatformAgentRegistryA2APeerCandidate;
		})
		.filter(
			(candidate): candidate is PlatformAgentRegistryA2APeerCandidate =>
				candidate !== undefined,
		);
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
			a2aSkillId: input.a2aSkillId,
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
