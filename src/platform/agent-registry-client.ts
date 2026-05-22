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

const HEARTBEAT_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.heartbeat,
);
const REGISTER_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.register,
);
const DELEGATE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.delegate,
);
const LIST_AGENTS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.list,
);
const RESOLVE_DELEGATION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.resolveDelegation,
);
const UPDATE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.update,
);
const CONTROL_A2A_DELEGATION_TASK_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.controlA2ADelegationTask,
);
const GET_A2A_DELEGATION_GRAPH_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agents.getA2ADelegationGraph,
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
	HEARTBEAT_PATH,
	REGISTER_PATH,
	DELEGATE_PATH,
	LIST_AGENTS_PATH,
	RESOLVE_DELEGATION_PATH,
	UPDATE_PATH,
	CONTROL_A2A_DELEGATION_TASK_PATH,
	GET_A2A_DELEGATION_GRAPH_PATH,
	platformConnectServicePath(PLATFORM_CONNECT_SERVICES.agents),
] as const;

export enum PlatformAgentStatusValue {
	Active = "AGENT_STATUS_ACTIVE",
	Idle = "AGENT_STATUS_IDLE",
	Busy = "AGENT_STATUS_BUSY",
	Offline = "AGENT_STATUS_OFFLINE",
	Degraded = "AGENT_STATUS_DEGRADED",
	Suspended = "AGENT_STATUS_SUSPENDED",
}

export enum PlatformDelegationStatusValue {
	Pending = "DELEGATION_STATUS_PENDING",
	Accepted = "DELEGATION_STATUS_ACCEPTED",
	Rejected = "DELEGATION_STATUS_REJECTED",
	Completed = "DELEGATION_STATUS_COMPLETED",
	Failed = "DELEGATION_STATUS_FAILED",
	TimedOut = "DELEGATION_STATUS_TIMED_OUT",
}

export enum PlatformA2ADelegationTaskControlModeValue {
	Steer = "A2A_DELEGATION_TASK_CONTROL_MODE_STEER",
	Followup = "A2A_DELEGATION_TASK_CONTROL_MODE_FOLLOWUP",
	Collect = "A2A_DELEGATION_TASK_CONTROL_MODE_COLLECT",
	Interrupt = "A2A_DELEGATION_TASK_CONTROL_MODE_INTERRUPT",
	Cancel = "A2A_DELEGATION_TASK_CONTROL_MODE_CANCEL",
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
	a2aDispatchedAt?: string;
	a2aLeaseRenewedAt?: string;
	a2aResumeWaitContracts?: Record<string, unknown>[];
	a2aRootDelegationId?: string;
	a2aParentDelegationId?: string;
	a2aDelegationChain?: string[];
}

export interface PlatformAgentRegistryDelegateInput {
	workspaceId?: string;
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

export interface PlatformAgentRegistryControlA2ADelegationTaskInput {
	workspaceId?: string;
	delegationId: string;
	mode: PlatformA2ADelegationTaskControlModeValue | string;
	message?: string;
	idempotencyKey?: string;
	targetRunId?: string;
	childRunId?: string;
	subagentLaneId?: string;
	workItemId?: string;
	payload?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface PlatformAgentRegistryGetA2ADelegationGraphInput {
	workspaceId?: string;
	rootDelegationId?: string;
	delegationId?: string;
	maxDepth?: number;
	limit?: number;
}

export interface PlatformAgentRegistryListAgentsInput {
	workspaceId?: string;
	agentType?: string;
	capability?: string;
	surface?: string;
	status?: string;
	limit?: number;
	offset?: number;
	a2aSkillId?: string;
	taskClass?: string;
	requireA2ADispatch?: boolean;
	eligibleForDelegation?: boolean;
}

export interface PlatformAgentRegistryRegisterInput {
	workspaceId?: string;
	id?: string;
	name: string;
	description?: string;
	agentType: string;
	capabilities: string[];
	surfaces?: string[];
	surfaceTypes?: string[];
	ownerId?: string;
	a2a?: PlatformAgentA2APeerProjection;
}

export interface PlatformAgentRegistryUpdateInput {
	workspaceId?: string;
	id: string;
	name?: string;
	description?: string;
	capabilities?: string[];
	surfaces?: string[];
	surfaceTypes?: string[];
	a2a?: PlatformAgentA2APeerProjection;
}

export interface PlatformAgentRegistryHeartbeatInput {
	workspaceId?: string;
	agentId: string;
	status?: PlatformAgentStatusValue | string;
	currentObjectiveIds?: string[];
	surface?: string;
	surfaceType?: string;
	a2a?: PlatformAgentA2APeerProjection;
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
	agentCardObservedAt?: string;
	agentCardETag?: string;
	agentCardHash?: string;
	pushNotifications?: boolean;
	attributes?: Record<string, string>;
}

export interface PlatformAgentCapacity {
	current?: number;
	max?: number;
	remaining?: number;
	reservedDelegationCount?: number;
}

export interface PlatformAgentRegistryAgent {
	id?: string;
	workspaceId?: string;
	name?: string;
	description?: string;
	agentType?: string;
	capabilities?: string[];
	surfaces?: string[];
	surfaceTypes?: string[];
	status?: string;
	activeConfigVersion?: number;
	ownerId?: string;
	lastHeartbeatAt?: string;
	createdAt?: string;
	updatedAt?: string;
	a2a?: PlatformAgentA2APeerProjection;
	capacity?: PlatformAgentCapacity;
}

export interface PlatformAgentRegistryRegisterResult {
	agent?: PlatformAgentRegistryAgent;
}

export interface PlatformAgentRegistryUpdateResult {
	agent?: PlatformAgentRegistryAgent;
}

export interface PlatformAgentRegistryHeartbeatResult {
	nextHeartbeatBy?: string;
}

export interface PlatformAgentRegistryDelegateResult {
	delegation?: PlatformDelegationRecord;
}

export interface PlatformAgentRegistryResolveDelegationResult {
	delegation?: PlatformDelegationRecord;
}

export interface PlatformAgentDiscoveryEvidence {
	schema?: string;
	decision?: string;
	reason?: string;
	workspaceId?: string;
	capability?: string;
	capabilities?: string[];
	agentType?: string;
	a2aSkillId?: string;
	taskClass?: string;
	requireA2ADispatch?: boolean;
	surface?: string;
	status?: string;
	candidateCount?: number;
	matchedCount?: number;
	exclusions?: PlatformAgentDiscoveryExclusion[];
}

export interface PlatformAgentDiscoveryExclusion {
	reason?: string;
	count?: number;
	sampleAgentIds?: string[];
	policyReasons?: string[];
	policyScopes?: string[];
	allowedTaskClasses?: string[];
	deniedTaskClasses?: string[];
}

export interface PlatformAgentRegistryListAgentsResult {
	agents: PlatformAgentRegistryAgent[];
	total?: number;
	discoveryEvidence?: PlatformAgentDiscoveryEvidence;
}

export interface PlatformA2ADelegationTaskControlResult {
	taskId?: string;
	state?: string;
	controlId?: string;
	controlMode?: string;
	cancelled?: boolean;
	queuedForWorker?: boolean;
	parentTaskId?: string;
	targetRunId?: string;
	appliedRunId?: string;
	targetExternal?: boolean;
	subagentLaneId?: string;
	workItemId?: string;
	observedAt?: string;
	rawPayloadWithheld?: boolean;
}

export interface PlatformAgentRegistryControlA2ADelegationTaskResult {
	delegation?: PlatformDelegationRecord;
	remoteTask?: PlatformA2ADelegationTaskControlResult;
}

export interface PlatformA2ADelegationGraphNode {
	delegation?: PlatformDelegationRecord;
	depth?: number;
	childCount?: number;
	terminal?: boolean;
}

export interface PlatformA2ADelegationGraphEdge {
	parentDelegationId?: string;
	childDelegationId?: string;
}

export interface PlatformAgentRegistryGetA2ADelegationGraphResult {
	rootDelegationId?: string;
	nodes: PlatformA2ADelegationGraphNode[];
	edges: PlatformA2ADelegationGraphEdge[];
	total?: number;
	truncated?: boolean;
	missingParentDelegationIds?: string[];
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

function objectList(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): Record<string, unknown>[] | undefined {
	if (!record) {
		return undefined;
	}
	for (const key of keys) {
		const value = record[key];
		if (!Array.isArray(value)) {
			continue;
		}
		const objects = value.filter(
			(item): item is Record<string, unknown> =>
				Boolean(item) && typeof item === "object" && !Array.isArray(item),
		);
		if (objects.length > 0) {
			return objects;
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
		agentCardObservedAt: firstString(
			record,
			"agentCardObservedAt",
			"agent_card_observed_at",
		),
		agentCardETag: firstString(
			record,
			"agentCardETag",
			"agentCardEtag",
			"agent_card_etag",
		),
		agentCardHash: firstString(record, "agentCardHash", "agent_card_hash"),
		pushNotifications: firstBoolean(
			record,
			"pushNotifications",
			"push_notifications",
		),
		attributes: stringRecord(record, "attributes"),
	}) as PlatformAgentA2APeerProjection;
}

function normalizeAgentCapacity(
	record: Record<string, unknown> | undefined,
): PlatformAgentCapacity | undefined {
	if (!record) {
		return undefined;
	}
	const capacity = stripUndefinedValues({
		current: firstNumber(record, "current"),
		max: firstNumber(record, "max"),
		remaining: firstNumber(record, "remaining"),
		reservedDelegationCount: firstNumber(
			record,
			"reservedDelegationCount",
			"reserved_delegation_count",
		),
	});
	return Object.keys(capacity).length > 0
		? (capacity as PlatformAgentCapacity)
		: undefined;
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
		description: firstString(record, "description"),
		agentType: firstString(record, "agentType", "agent_type"),
		capabilities: stringList(record, "capabilities"),
		surfaces: stringList(record, "surfaces"),
		surfaceTypes: stringList(record, "surfaceTypes", "surface_types"),
		status: firstString(record, "status"),
		activeConfigVersion: firstNumber(
			record,
			"activeConfigVersion",
			"active_config_version",
		),
		ownerId: firstString(record, "ownerId", "owner_id"),
		lastHeartbeatAt: firstString(
			record,
			"lastHeartbeatAt",
			"last_heartbeat_at",
		),
		createdAt: firstString(record, "createdAt", "created_at"),
		updatedAt: firstString(record, "updatedAt", "updated_at"),
		a2a,
		capacity: normalizeAgentCapacity(objectValue(record, "capacity")),
	}) as PlatformAgentRegistryAgent;
}

function encodeA2ASkill(skill: PlatformAgentA2ASkill): Record<string, unknown> {
	return stripUndefinedValues({
		id: skill.id,
		name: skill.name,
		description: skill.description,
		tags: skill.tags,
		inputModes: skill.inputModes,
		outputModes: skill.outputModes,
		requiredContextGrants: skill.requiredContextGrants,
		approvalPolicyRef: skill.approvalPolicyRef,
		maxAutonomy: skill.maxAutonomy,
		requiredArtifactKinds: skill.requiredArtifactKinds,
		optionalArtifactKinds: skill.optionalArtifactKinds,
		allowedTaskClasses: skill.allowedTaskClasses,
		deniedTaskClasses: skill.deniedTaskClasses,
		attributes: skill.attributes,
	});
}

function encodeA2APeerProjection(
	a2a: PlatformAgentA2APeerProjection | undefined,
): Record<string, unknown> | undefined {
	if (!a2a) {
		return undefined;
	}
	return stripUndefinedValues({
		publicEndpointUrl: a2a.publicEndpointUrl,
		internalEndpointUrl: a2a.internalEndpointUrl,
		agentCardUrl: a2a.agentCardUrl,
		protocolBinding: a2a.protocolBinding,
		protocolVersion: a2a.protocolVersion,
		supportedExtensions: a2a.supportedExtensions,
		skills: a2a.skills?.map(encodeA2ASkill),
		securitySchemes: a2a.securitySchemes,
		agentCardObservedAt: a2a.agentCardObservedAt,
		agentCardEtag: a2a.agentCardETag,
		agentCardHash: a2a.agentCardHash,
		pushNotifications: a2a.pushNotifications,
		attributes: a2a.attributes,
	});
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
		a2aDispatchedAt: firstString(
			record,
			"a2aDispatchedAt",
			"a2a_dispatched_at",
		),
		a2aLeaseRenewedAt: firstString(
			record,
			"a2aLeaseRenewedAt",
			"a2a_lease_renewed_at",
		),
		a2aResumeWaitContracts: objectList(
			record,
			"a2aResumeWaitContracts",
			"a2a_resume_wait_contracts",
		),
		a2aRootDelegationId: firstString(
			record,
			"a2aRootDelegationId",
			"a2a_root_delegation_id",
		),
		a2aParentDelegationId: firstString(
			record,
			"a2aParentDelegationId",
			"a2a_parent_delegation_id",
		),
		a2aDelegationChain: stringList(
			record,
			"a2aDelegationChain",
			"a2a_delegation_chain",
		),
	}) as PlatformDelegationRecord;
}

function normalizeDiscoveryExclusion(
	record: Record<string, unknown> | undefined,
): PlatformAgentDiscoveryExclusion | undefined {
	if (!record) {
		return undefined;
	}
	const exclusion = stripUndefinedValues({
		reason: firstString(record, "reason"),
		count: firstNumber(record, "count"),
		sampleAgentIds: stringList(record, "sampleAgentIds", "sample_agent_ids"),
		policyReasons: stringList(record, "policyReasons", "policy_reasons"),
		policyScopes: stringList(record, "policyScopes", "policy_scopes"),
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
	});
	return Object.keys(exclusion).length > 0
		? (exclusion as PlatformAgentDiscoveryExclusion)
		: undefined;
}

function normalizeDiscoveryEvidence(
	record: Record<string, unknown> | undefined,
): PlatformAgentDiscoveryEvidence | undefined {
	if (!record) {
		return undefined;
	}
	return stripUndefinedValues({
		schema: firstString(record, "schema"),
		decision: firstString(record, "decision"),
		reason: firstString(record, "reason"),
		workspaceId: firstString(record, "workspaceId", "workspace_id"),
		capability: firstString(record, "capability"),
		capabilities: stringList(record, "capabilities"),
		agentType: firstString(record, "agentType", "agent_type"),
		a2aSkillId: firstString(record, "a2aSkillId", "a2a_skill_id"),
		taskClass: firstString(record, "taskClass", "task_class"),
		requireA2ADispatch: firstBoolean(
			record,
			"requireA2aDispatch",
			"requireA2ADispatch",
			"require_a2a_dispatch",
		),
		surface: firstString(record, "surface"),
		status: firstString(record, "status"),
		candidateCount: firstNumber(record, "candidateCount", "candidate_count"),
		matchedCount: firstNumber(record, "matchedCount", "matched_count"),
		exclusions: objectList(record, "exclusions")
			?.map((exclusion) => normalizeDiscoveryExclusion(exclusion))
			.filter(
				(exclusion): exclusion is PlatformAgentDiscoveryExclusion =>
					exclusion !== undefined,
			),
	}) as PlatformAgentDiscoveryEvidence;
}

function normalizeA2ADelegationGraphNode(
	record: Record<string, unknown> | undefined,
): PlatformA2ADelegationGraphNode | undefined {
	if (!record) {
		return undefined;
	}
	const node = stripUndefinedValues({
		delegation: normalizeDelegation(objectValue(record, "delegation")),
		depth: firstNumber(record, "depth"),
		childCount: firstNumber(record, "childCount", "child_count"),
		terminal: firstBoolean(record, "terminal"),
	});
	return Object.keys(node).length > 0
		? (node as PlatformA2ADelegationGraphNode)
		: undefined;
}

function normalizeA2ADelegationGraphEdge(
	record: Record<string, unknown> | undefined,
): PlatformA2ADelegationGraphEdge | undefined {
	if (!record) {
		return undefined;
	}
	const edge = stripUndefinedValues({
		parentDelegationId: firstString(
			record,
			"parentDelegationId",
			"parent_delegation_id",
		),
		childDelegationId: firstString(
			record,
			"childDelegationId",
			"child_delegation_id",
		),
	});
	return Object.keys(edge).length > 0
		? (edge as PlatformA2ADelegationGraphEdge)
		: undefined;
}

function normalizeA2ADelegationTaskControlResult(
	record: Record<string, unknown> | undefined,
): PlatformA2ADelegationTaskControlResult | undefined {
	if (!record) {
		return undefined;
	}
	return stripUndefinedValues({
		taskId: firstString(record, "taskId", "task_id"),
		state: firstString(record, "state"),
		controlId: firstString(record, "controlId", "control_id"),
		controlMode: firstString(record, "controlMode", "control_mode"),
		cancelled: firstBoolean(record, "cancelled"),
		queuedForWorker: firstBoolean(
			record,
			"queuedForWorker",
			"queued_for_worker",
		),
		parentTaskId: firstString(record, "parentTaskId", "parent_task_id"),
		targetRunId: firstString(record, "targetRunId", "target_run_id"),
		appliedRunId: firstString(record, "appliedRunId", "applied_run_id"),
		targetExternal: firstBoolean(record, "targetExternal", "target_external"),
		subagentLaneId: firstString(record, "subagentLaneId", "subagent_lane_id"),
		workItemId: firstString(record, "workItemId", "work_item_id"),
		observedAt: firstString(record, "observedAt", "observed_at"),
		rawPayloadWithheld: firstBoolean(
			record,
			"rawPayloadWithheld",
			"raw_payload_withheld",
		),
	}) as PlatformA2ADelegationTaskControlResult;
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

export function isAgentAlreadyExistsError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b409\b|already exists|already_exists/i.test(message);
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

export async function registerAgentWithPlatform(
	input: PlatformAgentRegistryRegisterInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryRegisterResult | null> {
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
		REGISTER_PATH,
		stripUndefinedValues({
			workspaceId: explicitWorkspaceId ?? resolvedConfig.workspaceId,
			id: input.id,
			name: input.name,
			description: input.description,
			agentType: input.agentType,
			capabilities: input.capabilities,
			surfaces: input.surfaces,
			surfaceTypes: input.surfaceTypes,
			ownerId: input.ownerId,
			a2a: encodeA2APeerProjection(input.a2a),
		}),
		{ ...options, config: resolvedConfig },
	);
	if (!payload) {
		return null;
	}
	return {
		agent: normalizeAgent(objectValue(payload, "agent")),
	};
}

export async function updateAgentWithPlatform(
	input: PlatformAgentRegistryUpdateInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryUpdateResult | null> {
	const explicitWorkspaceId = trimString(input.workspaceId);
	const resolvedConfig = options?.config
		? explicitWorkspaceId && explicitWorkspaceId !== options.config.workspaceId
			? { ...options.config, workspaceId: explicitWorkspaceId }
			: options.config
		: explicitWorkspaceId
			? await resolveAgentRegistryListServiceConfig(explicitWorkspaceId)
			: undefined;
	const payload = await postAgentRegistryOperation(
		UPDATE_PATH,
		stripUndefinedValues({
			id: input.id,
			name: input.name,
			description: input.description,
			capabilities: input.capabilities,
			surfaces: input.surfaces,
			surfaceTypes: input.surfaceTypes,
			a2a: encodeA2APeerProjection(input.a2a),
		}),
		resolvedConfig ? { ...options, config: resolvedConfig } : options,
	);
	if (!payload) {
		return null;
	}
	return {
		agent: normalizeAgent(objectValue(payload, "agent")),
	};
}

export async function heartbeatAgentWithPlatform(
	input: PlatformAgentRegistryHeartbeatInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryHeartbeatResult | null> {
	const explicitWorkspaceId = trimString(input.workspaceId);
	const resolvedConfig = options?.config
		? explicitWorkspaceId && explicitWorkspaceId !== options.config.workspaceId
			? { ...options.config, workspaceId: explicitWorkspaceId }
			: options.config
		: explicitWorkspaceId
			? await resolveAgentRegistryListServiceConfig(explicitWorkspaceId)
			: undefined;
	const payload = await postAgentRegistryOperation(
		HEARTBEAT_PATH,
		stripUndefinedValues({
			agentId: input.agentId,
			status: input.status,
			currentObjectiveIds: input.currentObjectiveIds,
			surface: input.surface,
			surfaceType: input.surfaceType,
			a2a: encodeA2APeerProjection(input.a2a),
		}),
		resolvedConfig ? { ...options, config: resolvedConfig } : options,
	);
	if (!payload) {
		return null;
	}
	return {
		nextHeartbeatBy: firstString(
			payload,
			"nextHeartbeatBy",
			"next_heartbeat_by",
		),
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
			a2aSkillId: input.a2aSkillId,
			taskClass: input.taskClass,
			requireA2aDispatch: input.requireA2ADispatch,
			eligibleForDelegation: input.eligibleForDelegation,
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
		discoveryEvidence: normalizeDiscoveryEvidence(
			objectValue(payload, "discoveryEvidence", "discovery_evidence"),
		),
	};
}

export async function listA2APeerCandidatesWithPlatform(
	input: PlatformAgentRegistryListA2APeersInput = {},
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryA2APeerCandidate[] | null> {
	const result = await listAgentsWithPlatform(
		{
			...input,
			a2aSkillId: input.a2aSkillId ?? input.skillId,
			requireA2ADispatch: input.requireA2ADispatch ?? true,
			eligibleForDelegation: input.eligibleForDelegation ?? true,
		},
		options,
	);
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
	const explicitWorkspaceId = trimString(input.workspaceId);
	const resolvedConfig = options?.config
		? explicitWorkspaceId && explicitWorkspaceId !== options.config.workspaceId
			? { ...options.config, workspaceId: explicitWorkspaceId }
			: options.config
		: explicitWorkspaceId
			? await resolveAgentRegistryListServiceConfig(explicitWorkspaceId)
			: undefined;
	const payload = await postAgentRegistryOperation(
		DELEGATE_PATH,
		stripUndefinedValues({
			workspaceId: explicitWorkspaceId,
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
		resolvedConfig ? { ...options, config: resolvedConfig } : options,
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

export async function getA2ADelegationGraphWithPlatform(
	input: PlatformAgentRegistryGetA2ADelegationGraphInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryGetA2ADelegationGraphResult | null> {
	const explicitWorkspaceId = trimString(input.workspaceId);
	const resolvedConfig = options?.config
		? explicitWorkspaceId && explicitWorkspaceId !== options.config.workspaceId
			? { ...options.config, workspaceId: explicitWorkspaceId }
			: options.config
		: explicitWorkspaceId
			? await resolveAgentRegistryListServiceConfig(explicitWorkspaceId)
			: undefined;
	const payload = await postAgentRegistryOperation(
		GET_A2A_DELEGATION_GRAPH_PATH,
		stripUndefinedValues({
			workspaceId: explicitWorkspaceId ?? resolvedConfig?.workspaceId,
			rootDelegationId: input.rootDelegationId,
			delegationId: input.delegationId,
			maxDepth: input.maxDepth,
			limit: input.limit,
		}),
		resolvedConfig ? { ...options, config: resolvedConfig } : options,
	);
	if (!payload) {
		return null;
	}
	const nodes =
		objectList(payload, "nodes")
			?.map((node) => normalizeA2ADelegationGraphNode(node))
			.filter(
				(node): node is PlatformA2ADelegationGraphNode => node !== undefined,
			) ?? [];
	const edges =
		objectList(payload, "edges")
			?.map((edge) => normalizeA2ADelegationGraphEdge(edge))
			.filter(
				(edge): edge is PlatformA2ADelegationGraphEdge => edge !== undefined,
			) ?? [];
	return {
		rootDelegationId: firstString(
			payload,
			"rootDelegationId",
			"root_delegation_id",
		),
		nodes,
		edges,
		total: firstNumber(payload, "total"),
		truncated: firstBoolean(payload, "truncated"),
		missingParentDelegationIds: stringList(
			payload,
			"missingParentDelegationIds",
			"missing_parent_delegation_ids",
		),
	};
}

export async function controlA2ADelegationTaskWithPlatform(
	input: PlatformAgentRegistryControlA2ADelegationTaskInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRegistryControlA2ADelegationTaskResult | null> {
	const explicitWorkspaceId = trimString(input.workspaceId);
	const resolvedConfig = options?.config
		? explicitWorkspaceId && explicitWorkspaceId !== options.config.workspaceId
			? { ...options.config, workspaceId: explicitWorkspaceId }
			: options.config
		: explicitWorkspaceId
			? await resolveAgentRegistryListServiceConfig(explicitWorkspaceId)
			: undefined;
	const payload = await postAgentRegistryOperation(
		CONTROL_A2A_DELEGATION_TASK_PATH,
		stripUndefinedValues({
			delegationId: input.delegationId,
			mode: input.mode,
			message: input.message,
			idempotencyKey: input.idempotencyKey,
			targetRunId: input.targetRunId,
			childRunId: input.childRunId,
			subagentLaneId: input.subagentLaneId,
			workItemId: input.workItemId,
			payload: input.payload,
			metadata: input.metadata,
		}),
		resolvedConfig ? { ...options, config: resolvedConfig } : options,
	);
	if (!payload) {
		return null;
	}
	return {
		delegation: normalizeDelegation(objectValue(payload, "delegation")),
		remoteTask: normalizeA2ADelegationTaskControlResult(
			objectValue(payload, "remoteTask", "remote_task"),
		),
	};
}
