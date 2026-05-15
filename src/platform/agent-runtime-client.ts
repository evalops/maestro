import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import { isAbortError } from "../utils/abort-error.js";
import {
	type A2AServiceConfig,
	type A2ATask,
	buildA2AUserMessage,
	getA2ATask,
	resolveA2AServiceConfig,
	resolveA2ATraceContext,
	sendA2AMessage,
} from "./a2a-client.js";
import {
	type MaestroFactsContext,
	gatherMaestroSessionFactsContext,
} from "./cerebro-facts-client.js";
import {
	type PlatformServiceConfig,
	getEnvValue,
	normalizeBaseUrl,
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

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const AGENT_RUNTIME_A2A_ENABLED_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_A2A_ENABLED",
	"MAESTRO_PLATFORM_A2A_ENABLED",
] as const;
const DEDICATED_A2A_BASE_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_URL",
	"MAESTRO_A2A_URL",
] as const;
const DEDICATED_A2A_TOKEN_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_TOKEN",
	"MAESTRO_A2A_TOKEN",
] as const;
const DEDICATED_A2A_ORGANIZATION_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_ORG_ID",
	"MAESTRO_A2A_ORG_ID",
] as const;
const DEDICATED_A2A_WORKSPACE_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_WORKSPACE_ID",
	"MAESTRO_A2A_WORKSPACE_ID",
] as const;
const DEDICATED_A2A_TIMEOUT_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_TIMEOUT_MS",
	"MAESTRO_A2A_TIMEOUT_MS",
] as const;
const DEDICATED_A2A_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_PLATFORM_A2A_MAX_ATTEMPTS",
	"MAESTRO_A2A_MAX_ATTEMPTS",
] as const;

const HANDLE_TRIGGER_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.handleTrigger,
);
const CLAIM_NEXT_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.claimNextRun,
);
const RECORD_RUN_STEP_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.recordRunStep,
);
const RECORD_RUN_WORK_ITEM_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.recordRunWorkItem,
);
const UPDATE_RUN_WORK_ITEM_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.updateRunWorkItem,
);
const WAIT_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.waitRun,
);
const RESUME_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.resumeRun,
);
const COMPLETE_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.completeRun,
);
const FAIL_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.failRun,
);
const GET_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.getRun,
);
const LIST_RUN_EVENTS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.listRunEvents,
);

const AGENT_RUNTIME_BASE_URL_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
	"AGENT_RUNTIME_SERVICE_URL",
] as const;

const AGENT_RUNTIME_TOKEN_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
	"AGENT_RUNTIME_SERVICE_TOKEN",
	...EVALOPS_ACCESS_TOKEN_ENV_VARS,
] as const;

const AGENT_RUNTIME_ORGANIZATION_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_ORG_ID",
	"AGENT_RUNTIME_ORGANIZATION_ID",
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
] as const;

const AGENT_RUNTIME_WORKSPACE_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
	"AGENT_RUNTIME_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	...EVALOPS_WORKSPACE_ID_ENV_VARS.filter(
		(name) => name !== "MAESTRO_WORKSPACE_ID",
	),
] as const;

const AGENT_RUNTIME_TIMEOUT_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_TIMEOUT_MS",
	"AGENT_RUNTIME_SERVICE_TIMEOUT_MS",
] as const;

const AGENT_RUNTIME_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_MAX_ATTEMPTS",
	"AGENT_RUNTIME_SERVICE_MAX_ATTEMPTS",
] as const;

const AGENT_RUNTIME_BASE_URL_SUFFIXES = [
	HANDLE_TRIGGER_PATH,
	platformConnectServicePath(PLATFORM_CONNECT_SERVICES.agentRuntime),
] as const;

export enum PlatformSurfaceValue {
	Maestro = "SURFACE_MAESTRO",
}

export enum PlatformRuntimeChannelKindValue {
	Api = "RUNTIME_CHANNEL_KIND_API",
}

export enum PlatformRuntimeTriggerKindValue {
	Api = "RUNTIME_TRIGGER_KIND_API",
}

export enum PlatformRuntimeEventTypeValue {
	TriggerAccepted = "RUNTIME_EVENT_TYPE_TRIGGER_ACCEPTED",
	RunClaimed = "RUNTIME_EVENT_TYPE_RUN_CLAIMED",
	StepRecorded = "RUNTIME_EVENT_TYPE_STEP_RECORDED",
	RunWaiting = "RUNTIME_EVENT_TYPE_RUN_WAITING",
	RunResumed = "RUNTIME_EVENT_TYPE_RUN_RESUMED",
	RunSucceeded = "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED",
	RunFailed = "RUNTIME_EVENT_TYPE_RUN_FAILED",
}

export enum PlatformAgentRunStateValue {
	Accepted = "AGENT_RUN_STATE_ACCEPTED",
	Queued = "AGENT_RUN_STATE_QUEUED",
	Running = "AGENT_RUN_STATE_RUNNING",
	Waiting = "AGENT_RUN_STATE_WAITING",
	Succeeded = "AGENT_RUN_STATE_SUCCEEDED",
	Failed = "AGENT_RUN_STATE_FAILED",
	Cancelled = "AGENT_RUN_STATE_CANCELLED",
}

export enum PlatformAgentRunStepKindValue {
	ModelCall = "AGENT_RUN_STEP_KIND_MODEL_CALL",
	ToolCallIntent = "AGENT_RUN_STEP_KIND_TOOL_CALL_INTENT",
	ToolResult = "AGENT_RUN_STEP_KIND_TOOL_RESULT",
	ApprovalWait = "AGENT_RUN_STEP_KIND_APPROVAL_WAIT",
	Error = "AGENT_RUN_STEP_KIND_ERROR",
	System = "AGENT_RUN_STEP_KIND_SYSTEM",
}

export enum PlatformAgentRunStepStateValue {
	Pending = "AGENT_RUN_STEP_STATE_PENDING",
	Running = "AGENT_RUN_STEP_STATE_RUNNING",
	Waiting = "AGENT_RUN_STEP_STATE_WAITING",
	Succeeded = "AGENT_RUN_STEP_STATE_SUCCEEDED",
	Failed = "AGENT_RUN_STEP_STATE_FAILED",
	Cancelled = "AGENT_RUN_STEP_STATE_CANCELLED",
	Skipped = "AGENT_RUN_STEP_STATE_SKIPPED",
}

export enum PlatformAgentRunWaitTypeValue {
	Approval = "AGENT_RUN_WAIT_TYPE_APPROVAL",
	Input = "AGENT_RUN_WAIT_TYPE_INPUT",
	Event = "AGENT_RUN_WAIT_TYPE_EVENT",
	Timer = "AGENT_RUN_WAIT_TYPE_TIMER",
}

export enum PlatformAgentWorkItemKindValue {
	Root = "AGENT_WORK_ITEM_KIND_ROOT",
	ModelCall = "AGENT_WORK_ITEM_KIND_MODEL_CALL",
	ToolCall = "AGENT_WORK_ITEM_KIND_TOOL_CALL",
	ChildRun = "AGENT_WORK_ITEM_KIND_CHILD_RUN",
	Wait = "AGENT_WORK_ITEM_KIND_WAIT",
	Memory = "AGENT_WORK_ITEM_KIND_MEMORY",
	UserInput = "AGENT_WORK_ITEM_KIND_USER_INPUT",
	Followup = "AGENT_WORK_ITEM_KIND_FOLLOWUP",
	Recovery = "AGENT_WORK_ITEM_KIND_RECOVERY",
}

export enum PlatformAgentWorkItemStateValue {
	Pending = "AGENT_WORK_ITEM_STATE_PENDING",
	Running = "AGENT_WORK_ITEM_STATE_RUNNING",
	Waiting = "AGENT_WORK_ITEM_STATE_WAITING",
	Blocked = "AGENT_WORK_ITEM_STATE_BLOCKED",
	Succeeded = "AGENT_WORK_ITEM_STATE_SUCCEEDED",
	Failed = "AGENT_WORK_ITEM_STATE_FAILED",
	Cancelled = "AGENT_WORK_ITEM_STATE_CANCELLED",
}

export enum MaestroAgentRuntimeSourceEventType {
	SessionStarted = "maestro.session_started",
}

export interface PlatformRuntimeChannelContext {
	channelKind: PlatformRuntimeChannelKindValue;
	providerWorkspaceId?: string;
	channelId: string;
	threadId?: string;
	actorId?: string;
	attributes?: Record<string, string>;
}

export interface PlatformAgentRuntimeTrigger {
	workspaceId: string;
	agentId: string;
	channelId: string;
	idempotencyKey: string;
	sourceEventId?: string;
	sourceEventType: MaestroAgentRuntimeSourceEventType | string;
	actorId?: string;
	correlationId?: string;
	payload?: Record<string, unknown>;
	surfaceType: PlatformSurfaceValue;
	channelContext: PlatformRuntimeChannelContext;
	triggerKind: PlatformRuntimeTriggerKindValue;
}

export interface PlatformAgentRun {
	id: string;
	state?: PlatformAgentRunStateValue | string;
	lease?: PlatformAgentRunLease;
	steps?: PlatformAgentRunStep[];
	waits?: PlatformAgentRunWait[];
	latestCheckpoint?: PlatformAgentRunCheckpoint;
	linkage?: {
		runId?: string;
		workspaceId?: string;
		agentId?: string;
		objectiveId?: string;
	};
	createdAt?: string;
	updatedAt?: string;
}

export interface PlatformRuntimeEvent {
	id?: string;
	runId?: string;
	sequence?: number;
	type?: string;
	message?: string;
	stepId?: string;
	waitId?: string;
	checkpointId?: string;
	attributes?: Record<string, unknown>;
	occurredAt?: string;
}

export interface PlatformAgentRuntimeHandleTriggerResult {
	run: PlatformAgentRun;
	events: PlatformRuntimeEvent[];
	idempotentReplay: boolean;
}

export interface PlatformAgentRunLease {
	id?: string;
	token?: string;
	workerId?: string;
	workerQueue?: string;
	expiresAt?: string;
	heartbeatAt?: string;
}

export interface PlatformAgentRunStep {
	id?: string;
	name?: string;
	stepKind?: PlatformAgentRunStepKindValue | string;
	state?: PlatformAgentRunStepStateValue | string;
	attempt?: number;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	errorMessage?: string;
	checkpointId?: string;
	startedAt?: string;
	endedAt?: string;
	linkage?: PlatformAgentRun["linkage"];
}

export interface PlatformAgentRunCheckpoint {
	id?: string;
	stepId?: string;
	sequence?: number;
	resumeToken?: string;
	payload?: Record<string, unknown>;
	createdAt?: string;
	linkage?: PlatformAgentRun["linkage"];
}

export interface PlatformAgentRunWait {
	id?: string;
	stepId?: string;
	type?: PlatformAgentRunWaitTypeValue | string;
	externalRef?: string;
	reason?: string;
	payload?: Record<string, unknown>;
	createdAt?: string;
	resumeAfter?: string;
	expiresAt?: string;
	resolvedAt?: string;
	resolvedByEventId?: string;
	linkage?: PlatformAgentRun["linkage"];
}

export interface PlatformAgentWorkItem {
	id?: string;
	linkage?: PlatformAgentRun["linkage"];
	autonomySessionId?: string;
	runId?: string;
	workEnvelopeId?: string;
	parentWorkItemId?: string;
	ownerChildRunId?: string;
	kind?: PlatformAgentWorkItemKindValue | string;
	state?: PlatformAgentWorkItemStateValue | string;
	title?: string;
	goal?: string;
	nextAction?: string;
	blocker?: string;
	waitId?: string;
	toolExecutionId?: string;
	evidenceRefs?: string[];
	completionGate?: string;
	payload?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	cancelledAt?: string;
}

export interface PlatformAgentRuntimeClaimNextRunInput {
	workerId: string;
	workerQueue?: string;
	leaseSeconds?: number;
}

export interface PlatformAgentRuntimeClaimNextRunResult {
	run: PlatformAgentRun;
	lease?: PlatformAgentRunLease;
	events: PlatformRuntimeEvent[];
}

export interface PlatformAgentRuntimeRecordRunStepInput {
	runId: string;
	leaseToken: string;
	step: PlatformAgentRunStep;
}

export interface PlatformAgentRuntimeRecordRunStepResult {
	run: PlatformAgentRun;
	step?: PlatformAgentRunStep;
	event?: PlatformRuntimeEvent;
}

export interface PlatformAgentRuntimeWaitRunInput {
	runId: string;
	leaseToken: string;
	wait: PlatformAgentRunWait;
	checkpoint?: PlatformAgentRunCheckpoint;
}

export interface PlatformAgentRuntimeWaitRunResult {
	run: PlatformAgentRun;
	wait?: PlatformAgentRunWait;
	checkpoint?: PlatformAgentRunCheckpoint;
	event?: PlatformRuntimeEvent;
}

export interface PlatformAgentRuntimeResumeRunInput {
	runId: string;
	waitId: string;
	resumeEventId?: string;
	payload?: Record<string, unknown>;
}

export interface PlatformAgentRuntimeRecordRunWorkItemInput {
	runId: string;
	workItem: PlatformAgentWorkItem;
}

export interface PlatformAgentRuntimeRecordRunWorkItemResult {
	run: PlatformAgentRun;
	workItem?: PlatformAgentWorkItem;
	event?: PlatformRuntimeEvent;
}

export interface PlatformAgentRuntimeUpdateRunWorkItemInput {
	runId: string;
	workItemId: string;
	state: PlatformAgentWorkItemStateValue | string;
	nextAction?: string;
	blocker?: string;
	waitId?: string;
	toolExecutionId?: string;
	evidenceRefs?: string[];
	completionGate?: string;
	payload?: Record<string, unknown>;
}

export interface PlatformAgentRuntimeUpdateRunWorkItemResult {
	run: PlatformAgentRun;
	workItem?: PlatformAgentWorkItem;
	event?: PlatformRuntimeEvent;
}

export interface PlatformAgentRuntimeRunEventResult {
	run: PlatformAgentRun;
	event?: PlatformRuntimeEvent;
}

export interface PlatformAgentRuntimeCompleteRunInput {
	runId: string;
	leaseToken: string;
	result?: Record<string, unknown>;
	checkpoint?: PlatformAgentRunCheckpoint;
}

export interface PlatformAgentRuntimeCompleteRunResult {
	run: PlatformAgentRun;
	checkpoint?: PlatformAgentRunCheckpoint;
	event?: PlatformRuntimeEvent;
}

export interface PlatformAgentRuntimeFailRunInput {
	runId: string;
	leaseToken: string;
	errorMessage: string;
	retryable?: boolean;
	retryDelaySeconds?: number;
}

export interface PlatformAgentRuntimeGetRunInput {
	runId: string;
}

export interface PlatformAgentRuntimeListRunEventsInput {
	runId: string;
}

export interface PlatformAgentRuntimeListRunEventsResult {
	events: PlatformRuntimeEvent[];
}

export interface MaestroSessionRuntimeTriggerInput {
	workspaceId?: string;
	sessionId: string;
	agentId?: string;
	actorId?: string;
	correlationId?: string;
	traceparent?: string;
	tracestate?: string;
	sourceEventId?: string;
	idempotencyKey?: string;
	factsQuery?: string;
	factsContext?: MaestroFactsContext;
	metadata?: Record<string, unknown>;
}

function pickString(
	record: Record<string, unknown> | undefined,
	...names: string[]
): string | undefined {
	for (const name of names) {
		const value = record?.[name];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

// Platform service responses can arrive from Connect JSON, protojson fixtures,
// or A2A metadata. Keep casing tolerance here so HTTP handlers consume one
// Maestro-owned shape instead of duplicating wire compatibility checks.
function pickRecord(
	record: Record<string, unknown> | undefined,
	...names: string[]
): Record<string, unknown> | undefined {
	for (const name of names) {
		const value = record?.[name];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	}
	return undefined;
}

function pickArray(
	record: Record<string, unknown> | undefined,
	...names: string[]
): unknown[] | undefined {
	for (const name of names) {
		const value = record?.[name];
		if (Array.isArray(value)) {
			return value;
		}
	}
	return undefined;
}

function pickBoolean(
	record: Record<string, unknown> | undefined,
	...names: string[]
): boolean {
	for (const name of names) {
		const value = record?.[name];
		if (typeof value === "boolean") {
			return value;
		}
	}
	return false;
}

function pickNumber(
	record: Record<string, unknown> | undefined,
	...names: string[]
): number | undefined {
	for (const name of names) {
		const value = record?.[name];
		if (isFiniteNumber(value)) {
			return value;
		}
	}
	return undefined;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function normalizeLinkage(
	value: unknown,
): PlatformAgentRun["linkage"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const linkage = value as Record<string, unknown>;
	return {
		runId: pickString(linkage, "runId", "run_id"),
		workspaceId: pickString(linkage, "workspaceId", "workspace_id"),
		agentId: pickString(linkage, "agentId", "agent_id"),
		objectiveId: pickString(linkage, "objectiveId", "objective_id"),
	};
}

function compactStringRecord(
	record: Record<string, string | undefined>,
): Record<string, string> | undefined {
	const compacted = Object.fromEntries(
		Object.entries(record).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1].length > 0,
		),
	);
	return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function normalizeLease(value: unknown): PlatformAgentRunLease | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		id: pickString(record, "id"),
		token: pickString(record, "token"),
		workerId: pickString(record, "workerId", "worker_id"),
		workerQueue: pickString(record, "workerQueue", "worker_queue"),
		expiresAt: pickString(record, "expiresAt", "expires_at"),
		heartbeatAt: pickString(record, "heartbeatAt", "heartbeat_at"),
	};
}

function normalizeStep(value: unknown): PlatformAgentRunStep | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		id: pickString(record, "id"),
		name: pickString(record, "name"),
		stepKind: pickString(record, "stepKind", "step_kind", "kind"),
		state: pickString(record, "state"),
		attempt: pickNumber(record, "attempt"),
		input: pickRecord(record, "input"),
		output: pickRecord(record, "output"),
		errorMessage: pickString(record, "errorMessage", "error_message"),
		checkpointId: pickString(record, "checkpointId", "checkpoint_id"),
		startedAt: pickString(record, "startedAt", "started_at"),
		endedAt: pickString(record, "endedAt", "ended_at"),
		linkage: normalizeLinkage(record.linkage),
	};
}

function normalizeCheckpoint(
	value: unknown,
): PlatformAgentRunCheckpoint | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		id: pickString(record, "id"),
		stepId: pickString(record, "stepId", "step_id"),
		sequence: pickNumber(record, "sequence"),
		resumeToken: pickString(record, "resumeToken", "resume_token"),
		payload: pickRecord(record, "payload"),
		createdAt: pickString(record, "createdAt", "created_at"),
		linkage: normalizeLinkage(record.linkage),
	};
}

function normalizeWait(value: unknown): PlatformAgentRunWait | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		id: pickString(record, "id"),
		stepId: pickString(record, "stepId", "step_id"),
		type: pickString(record, "type"),
		externalRef: pickString(record, "externalRef", "external_ref"),
		reason: pickString(record, "reason"),
		payload: pickRecord(record, "payload"),
		createdAt: pickString(record, "createdAt", "created_at"),
		resumeAfter: pickString(record, "resumeAfter", "resume_after"),
		expiresAt: pickString(record, "expiresAt", "expires_at"),
		resolvedAt: pickString(record, "resolvedAt", "resolved_at"),
		resolvedByEventId: pickString(
			record,
			"resolvedByEventId",
			"resolved_by_event_id",
		),
		linkage: normalizeLinkage(record.linkage),
	};
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
	return strings.length > 0 ? strings : undefined;
}

function normalizeWorkItem(value: unknown): PlatformAgentWorkItem | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = pickString(record, "id");
	if (!id) {
		return undefined;
	}
	return {
		id,
		linkage: normalizeLinkage(record.linkage),
		autonomySessionId: pickString(
			record,
			"autonomySessionId",
			"autonomy_session_id",
		),
		runId: pickString(record, "runId", "run_id"),
		workEnvelopeId: pickString(record, "workEnvelopeId", "work_envelope_id"),
		parentWorkItemId: pickString(
			record,
			"parentWorkItemId",
			"parent_work_item_id",
		),
		ownerChildRunId: pickString(
			record,
			"ownerChildRunId",
			"owner_child_run_id",
		),
		kind: pickString(record, "kind"),
		state: pickString(record, "state"),
		title: pickString(record, "title"),
		goal: pickString(record, "goal"),
		nextAction: pickString(record, "nextAction", "next_action"),
		blocker: pickString(record, "blocker"),
		waitId: pickString(record, "waitId", "wait_id"),
		toolExecutionId: pickString(record, "toolExecutionId", "tool_execution_id"),
		evidenceRefs: normalizeStringArray(
			record.evidenceRefs ?? record.evidence_refs,
		),
		completionGate: pickString(record, "completionGate", "completion_gate"),
		payload: pickRecord(record, "payload"),
		createdAt: pickString(record, "createdAt", "created_at"),
		updatedAt: pickString(record, "updatedAt", "updated_at"),
		startedAt: pickString(record, "startedAt", "started_at"),
		completedAt: pickString(record, "completedAt", "completed_at"),
		failedAt: pickString(record, "failedAt", "failed_at"),
		cancelledAt: pickString(record, "cancelledAt", "cancelled_at"),
	};
}

function normalizeRun(value: unknown): PlatformAgentRun | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = pickString(record, "id");
	if (!id) {
		return undefined;
	}
	return {
		id,
		state: pickString(record, "state"),
		lease: normalizeLease(record.lease),
		steps: pickArray(record, "steps")
			?.map(normalizeStep)
			.filter((step): step is PlatformAgentRunStep => Boolean(step)),
		waits: pickArray(record, "waits")
			?.map(normalizeWait)
			.filter((wait): wait is PlatformAgentRunWait => Boolean(wait)),
		latestCheckpoint: normalizeCheckpoint(
			record.latestCheckpoint ?? record.latest_checkpoint,
		),
		linkage: normalizeLinkage(record.linkage),
		createdAt: pickString(record, "createdAt", "created_at"),
		updatedAt: pickString(record, "updatedAt", "updated_at"),
	};
}

function normalizeEvent(value: unknown): PlatformRuntimeEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		id: pickString(record, "id"),
		runId: pickString(record, "runId", "run_id"),
		sequence: pickNumber(record, "sequence"),
		type: pickString(record, "type"),
		message: pickString(record, "message"),
		stepId: pickString(record, "stepId", "step_id"),
		waitId: pickString(record, "waitId", "wait_id"),
		checkpointId: pickString(record, "checkpointId", "checkpoint_id"),
		attributes: pickRecord(record, "attributes"),
		occurredAt: pickString(record, "occurredAt", "occurred_at"),
	};
}

function normalizeHandleTriggerResponse(
	payload: Record<string, unknown>,
): PlatformAgentRuntimeHandleTriggerResult {
	return {
		run: normalizeRequiredRun(payload),
		events: normalizeEvents(payload),
		idempotentReplay: pickBoolean(
			payload,
			"idempotentReplay",
			"idempotent_replay",
		),
	};
}

function normalizeRequiredRun(
	payload: Record<string, unknown>,
): PlatformAgentRun {
	const run = normalizeRun(payload.run);
	if (!run) {
		throw new Error("agent runtime service returned no run");
	}
	return run;
}

function normalizeEvents(
	payload: Record<string, unknown>,
): PlatformRuntimeEvent[] {
	return (
		pickArray(payload, "events")
			?.map(normalizeEvent)
			.filter((event): event is PlatformRuntimeEvent => Boolean(event)) ?? []
	);
}

async function postAgentRuntimeOperation(
	path: string,
	body: Record<string, unknown>,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<Record<string, unknown>> {
	const config = options?.config ?? (await resolveAgentRuntimeServiceConfig());
	if (!config) {
		throw new Error("agent runtime service is not configured");
	}
	const response = await postPlatformConnect(config, path, body, {
		serviceName: "agent runtime service",
		failureMode: "optional",
		timeoutMs: config.timeoutMs,
		maxAttempts: config.maxAttempts,
		signal: options?.signal,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`agent runtime service returned ${response.status}: ${text || response.statusText}`,
		);
	}
	return (await response.json()) as Record<string, unknown>;
}

export async function resolveAgentRuntimeServiceConfig(): Promise<PlatformServiceConfig | null> {
	return await resolvePlatformServiceConfig({
		baseUrlEnvVars: AGENT_RUNTIME_BASE_URL_ENV_VARS,
		tokenEnvVars: AGENT_RUNTIME_TOKEN_ENV_VARS,
		organizationEnvVars: AGENT_RUNTIME_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: AGENT_RUNTIME_WORKSPACE_ENV_VARS,
		timeoutEnvVars: AGENT_RUNTIME_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: AGENT_RUNTIME_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: AGENT_RUNTIME_BASE_URL_SUFFIXES,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireOrganizationId: true,
		requireToken: true,
	});
}

export function buildMaestroSessionRuntimeTrigger(
	input: MaestroSessionRuntimeTriggerInput,
	fallbackWorkspaceId?: string,
): PlatformAgentRuntimeTrigger | null {
	const workspaceId =
		trimString(input.workspaceId) ?? trimString(fallbackWorkspaceId);
	const sessionId = trimString(input.sessionId);
	if (!workspaceId || !sessionId) {
		return null;
	}
	const agentId = trimString(input.agentId) ?? "maestro";
	const channelId = `maestro-session:${sessionId}`;
	const idempotencyKey =
		trimString(input.idempotencyKey) ??
		["maestro-session", workspaceId, sessionId].join(":");
	const correlationId =
		trimString(input.correlationId) ?? ["maestro-session", sessionId].join(":");
	const actorId = trimString(input.actorId);
	const traceContext = maestroRuntimeTraceContext(input);
	// Session starts are idempotent per workspace/session pair. The channel and
	// payload stay Maestro-shaped, while Platform receives enough typed linkage
	// to build timelines, traces, and support views around the same session.
	return {
		workspaceId,
		agentId,
		channelId,
		idempotencyKey,
		sourceEventId: trimString(input.sourceEventId) ?? idempotencyKey,
		sourceEventType: MaestroAgentRuntimeSourceEventType.SessionStarted,
		...(actorId ? { actorId } : {}),
		correlationId,
		surfaceType: PlatformSurfaceValue.Maestro,
		channelContext: {
			channelKind: PlatformRuntimeChannelKindValue.Api,
			providerWorkspaceId: workspaceId,
			channelId,
			threadId: sessionId,
			...(actorId ? { actorId } : {}),
			attributes: compactStringRecord({
				route: "maestro_session",
				maestro_session_id: sessionId,
				source: "maestro",
				traceparent: traceContext?.traceparent,
				tracestate: traceContext?.tracestate,
			}),
		},
		triggerKind: PlatformRuntimeTriggerKindValue.Api,
		payload: {
			maestroSessionId: sessionId,
			...(traceContext ? { trace_context: traceContext } : {}),
			...(input.metadata ? { metadata: input.metadata } : {}),
			...(input.factsContext ? { facts_context: input.factsContext } : {}),
		},
	};
}

export async function handleAgentRuntimeTrigger(
	trigger: PlatformAgentRuntimeTrigger,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeHandleTriggerResult> {
	return normalizeHandleTriggerResponse(
		await postAgentRuntimeOperation(HANDLE_TRIGGER_PATH, { trigger }, options),
	);
}

export async function claimNextAgentRuntimeRun(
	input: PlatformAgentRuntimeClaimNextRunInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeClaimNextRunResult> {
	const payload = await postAgentRuntimeOperation(
		CLAIM_NEXT_RUN_PATH,
		{
			workerId: input.workerId,
			...(input.workerQueue ? { workerQueue: input.workerQueue } : {}),
			...(isFiniteNumber(input.leaseSeconds)
				? { leaseSeconds: input.leaseSeconds }
				: {}),
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		lease: normalizeLease(payload.lease),
		events: normalizeEvents(payload),
	};
}

export async function recordAgentRuntimeRunStep(
	input: PlatformAgentRuntimeRecordRunStepInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeRecordRunStepResult> {
	const payload = await postAgentRuntimeOperation(
		RECORD_RUN_STEP_PATH,
		{
			runId: input.runId,
			leaseToken: input.leaseToken,
			step: input.step,
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		step: normalizeStep(payload.step),
		event: normalizeEvent(payload.event),
	};
}

export async function recordAgentRuntimeRunWorkItem(
	input: PlatformAgentRuntimeRecordRunWorkItemInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeRecordRunWorkItemResult> {
	const payload = await postAgentRuntimeOperation(
		RECORD_RUN_WORK_ITEM_PATH,
		{
			runId: input.runId,
			workItem: input.workItem,
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		workItem: normalizeWorkItem(payload.workItem ?? payload.work_item),
		event: normalizeEvent(payload.event),
	};
}

export async function updateAgentRuntimeRunWorkItem(
	input: PlatformAgentRuntimeUpdateRunWorkItemInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeUpdateRunWorkItemResult> {
	const payload = await postAgentRuntimeOperation(
		UPDATE_RUN_WORK_ITEM_PATH,
		{
			runId: input.runId,
			workItemId: input.workItemId,
			state: input.state,
			...(input.nextAction !== undefined
				? { nextAction: input.nextAction }
				: {}),
			...(input.blocker !== undefined ? { blocker: input.blocker } : {}),
			...(input.waitId !== undefined ? { waitId: input.waitId } : {}),
			...(input.toolExecutionId !== undefined
				? { toolExecutionId: input.toolExecutionId }
				: {}),
			...(input.evidenceRefs !== undefined
				? { evidenceRefs: input.evidenceRefs }
				: {}),
			...(input.completionGate !== undefined
				? { completionGate: input.completionGate }
				: {}),
			...(input.payload ? { payload: input.payload } : {}),
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		workItem: normalizeWorkItem(payload.workItem ?? payload.work_item),
		event: normalizeEvent(payload.event),
	};
}

export async function waitAgentRuntimeRun(
	input: PlatformAgentRuntimeWaitRunInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeWaitRunResult> {
	const payload = await postAgentRuntimeOperation(
		WAIT_RUN_PATH,
		{
			runId: input.runId,
			leaseToken: input.leaseToken,
			wait: input.wait,
			...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		wait: normalizeWait(payload.wait),
		checkpoint: normalizeCheckpoint(payload.checkpoint),
		event: normalizeEvent(payload.event),
	};
}

export async function resumeAgentRuntimeRun(
	input: PlatformAgentRuntimeResumeRunInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeRunEventResult> {
	const payload = await postAgentRuntimeOperation(
		RESUME_RUN_PATH,
		{
			runId: input.runId,
			waitId: input.waitId,
			...(input.resumeEventId ? { resumeEventId: input.resumeEventId } : {}),
			...(input.payload ? { payload: input.payload } : {}),
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		event: normalizeEvent(payload.event),
	};
}

export async function completeAgentRuntimeRun(
	input: PlatformAgentRuntimeCompleteRunInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeCompleteRunResult> {
	const payload = await postAgentRuntimeOperation(
		COMPLETE_RUN_PATH,
		{
			runId: input.runId,
			leaseToken: input.leaseToken,
			...(input.result ? { result: input.result } : {}),
			...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		checkpoint: normalizeCheckpoint(payload.checkpoint),
		event: normalizeEvent(payload.event),
	};
}

export async function failAgentRuntimeRun(
	input: PlatformAgentRuntimeFailRunInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeRunEventResult> {
	const payload = await postAgentRuntimeOperation(
		FAIL_RUN_PATH,
		{
			runId: input.runId,
			leaseToken: input.leaseToken,
			errorMessage: input.errorMessage,
			...(typeof input.retryable === "boolean"
				? { retryable: input.retryable }
				: {}),
			...(isFiniteNumber(input.retryDelaySeconds)
				? { retryDelaySeconds: input.retryDelaySeconds }
				: {}),
		},
		options,
	);
	return {
		run: normalizeRequiredRun(payload),
		event: normalizeEvent(payload.event),
	};
}

export async function getAgentRuntimeRun(
	input: PlatformAgentRuntimeGetRunInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeRunEventResult> {
	const payload = await postAgentRuntimeOperation(
		GET_RUN_PATH,
		{ id: input.runId },
		options,
	);
	return { run: normalizeRequiredRun(payload) };
}

export async function listAgentRuntimeRunEvents(
	input: PlatformAgentRuntimeListRunEventsInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeListRunEventsResult> {
	const payload = await postAgentRuntimeOperation(
		LIST_RUN_EVENTS_PATH,
		{ runId: input.runId },
		options,
	);
	return { events: normalizeEvents(payload) };
}

export async function recordMaestroSessionRuntimeTrigger(
	input: MaestroSessionRuntimeTriggerInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeHandleTriggerResult | null> {
	// Keep transport selection behind this adapter. Headless session handlers
	// should only know whether a Platform correlation handle was recorded, not
	// whether the deployment used Connect or the A2A facade.
	if (isAgentRuntimeA2AEnabled()) {
		return await recordMaestroSessionRuntimeTriggerViaA2A(input, options);
	}
	const config = options?.config ?? (await resolveAgentRuntimeServiceConfig());
	if (!config) {
		return null;
	}
	let factsContext = input.factsContext;
	if (!factsContext) {
		try {
			factsContext = await gatherMaestroSessionFactsContext(
				{
					...input,
					workspaceId: input.workspaceId ?? config.workspaceId,
				},
				{ signal: options?.signal },
			);
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			factsContext = undefined;
		}
	}
	const trigger = buildMaestroSessionRuntimeTrigger(
		{ ...input, factsContext },
		config.workspaceId,
	);
	if (!trigger) {
		return null;
	}
	try {
		return await handleAgentRuntimeTrigger(trigger, {
			config,
			signal: options?.signal,
		});
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return null;
	}
}

async function recordMaestroSessionRuntimeTriggerViaA2A(
	input: MaestroSessionRuntimeTriggerInput,
	options?: {
		config?: PlatformServiceConfig;
		signal?: AbortSignal;
	},
): Promise<PlatformAgentRuntimeHandleTriggerResult | null> {
	const serviceConfig = options?.config
		? {
				...options.config,
				baseUrl: normalizeBaseUrl(
					options.config.baseUrl,
					AGENT_RUNTIME_BASE_URL_SUFFIXES,
				),
			}
		: await resolveAgentRuntimeServiceConfig();
	const dedicatedWorkspaceId = getEnvValue(DEDICATED_A2A_WORKSPACE_ENV_VARS);
	// Dedicated A2A env vars deliberately override shared AgentRuntime config,
	// but managed deployments can omit them and reuse the same service identity
	// while only flipping the transport feature flag.
	const config = await resolveA2AServiceConfig({
		baseUrl: hasDedicatedA2AEnv(DEDICATED_A2A_BASE_URL_ENV_VARS)
			? undefined
			: serviceConfig?.baseUrl,
		token: hasDedicatedA2AEnv(DEDICATED_A2A_TOKEN_ENV_VARS)
			? undefined
			: serviceConfig?.token,
		organizationId: hasDedicatedA2AEnv(DEDICATED_A2A_ORGANIZATION_ENV_VARS)
			? undefined
			: serviceConfig?.organizationId,
		workspaceId:
			trimString(input.workspaceId) ??
			(dedicatedWorkspaceId ? undefined : serviceConfig?.workspaceId),
		agentId: input.agentId ?? "maestro",
		sessionId: input.sessionId,
		actorId: input.actorId ?? "maestro",
		timeoutMs: hasDedicatedA2AEnv(DEDICATED_A2A_TIMEOUT_ENV_VARS)
			? undefined
			: serviceConfig?.timeoutMs,
		maxAttempts: hasDedicatedA2AEnv(DEDICATED_A2A_MAX_ATTEMPTS_ENV_VARS)
			? undefined
			: serviceConfig?.maxAttempts,
	});
	if (!config) {
		return null;
	}
	let factsContext = input.factsContext;
	if (!factsContext) {
		try {
			factsContext = await gatherMaestroSessionFactsContext(
				{
					...input,
					workspaceId: input.workspaceId ?? config.workspaceId,
				},
				{ signal: options?.signal },
			);
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			factsContext = undefined;
		}
	}
	const workspaceId = trimString(input.workspaceId) ?? config.workspaceId;
	const sessionId = trimString(input.sessionId);
	if (!workspaceId || !sessionId) {
		return null;
	}
	const idempotencyKey =
		trimString(input.idempotencyKey) ??
		["maestro-session", workspaceId, sessionId].join(":");
	const correlationId =
		trimString(input.correlationId) ?? ["maestro-session", sessionId].join(":");
	const traceContext = maestroRuntimeTraceContext(input);
	try {
		const sent = await sendA2AMessage(
			config,
			{
				message: buildA2AUserMessage({
					messageId: idempotencyKey,
					contextId: `maestro-session:${sessionId}`,
					text: `Start Maestro hosted session ${sessionId}`,
					metadata: {
						workspaceId,
						agentId: config.agentId ?? "maestro",
						sessionId,
						actorId: config.actorId ?? input.actorId ?? "maestro",
						correlationId,
						...(traceContext?.traceparent
							? { traceparent: traceContext.traceparent }
							: {}),
						...(traceContext?.tracestate
							? { tracestate: traceContext.tracestate }
							: {}),
						sourceEventId: trimString(input.sourceEventId) ?? idempotencyKey,
						sourceEventType: MaestroAgentRuntimeSourceEventType.SessionStarted,
						metadata: input.metadata,
						...(factsContext ? { facts_context: factsContext } : {}),
					},
				}),
				configuration: { returnImmediately: true },
				metadata: {
					route: "maestro_session",
					transport: "a2a",
				},
				traceContext,
			},
			{ signal: options?.signal },
		);
		let task = sent.task;
		try {
			task = mergeA2ATaskLookupResult(
				sent.task,
				await getA2ATask(config, sent.task.id, {
					signal: options?.signal,
					traceContext,
				}),
			);
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
		}
		return a2aTaskToAgentRuntimeTriggerResult(task, config);
	} catch (error) {
		if (isAbortError(error)) {
			throw error;
		}
		return null;
	}
}

function isAgentRuntimeA2AEnabled(): boolean {
	const value = getEnvValue(AGENT_RUNTIME_A2A_ENABLED_ENV_VARS)?.toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function hasDedicatedA2AEnv(names: readonly string[]): boolean {
	return getEnvValue(names) !== undefined;
}

function mergeA2ATaskLookupResult(sent: A2ATask, lookup: A2ATask): A2ATask {
	const preservedMetadata = { ...(sent.metadata ?? {}) };
	delete preservedMetadata.agentRunState;
	delete preservedMetadata.agent_run_state;
	return {
		...sent,
		...lookup,
		metadata: {
			...preservedMetadata,
			...(lookup.metadata ?? {}),
		},
	};
}

function a2aTaskToAgentRuntimeTriggerResult(
	task: A2ATask,
	config: A2AServiceConfig,
): PlatformAgentRuntimeHandleTriggerResult {
	const metadata = task.metadata ?? {};
	// A2A returns a task, while the rest of Maestro expects AgentRuntime-shaped
	// correlation. Prefer Platform-projected metadata and fall back to the task
	// id so health and identity endpoints still have a durable handle.
	const runId = pickString(metadata, "agentRunId", "agent_run_id") ?? task.id;
	const a2aMessageId = pickString(metadata, "a2aMessageId", "a2a_message_id");
	const a2aTaskId = pickString(metadata, "a2aTaskId", "a2a_task_id") ?? task.id;
	const agentId =
		pickString(metadata, "agentId", "agent_id") ?? config.agentId ?? "maestro";
	const workspaceId =
		pickString(metadata, "workspaceId", "workspace_id") ?? config.workspaceId;
	const workerQueue = pickString(metadata, "workerQueue", "worker_queue");
	const correlationId = pickString(metadata, "correlationId", "correlation_id");
	const correlationPath = pickString(
		metadata,
		"correlationPath",
		"correlation_path",
	);
	const traceparent = pickString(metadata, "traceparent", "trace_parent");
	const tracestate = pickString(metadata, "tracestate", "trace_state");
	const idempotencyKey = pickString(
		metadata,
		"idempotencyKey",
		"idempotency_key",
	);
	return {
		run: {
			id: runId,
			state:
				pickString(metadata, "agentRunState", "agent_run_state") ??
				platformRunStateFromA2ATaskState(task.status?.state),
			linkage: {
				runId,
				workspaceId,
				agentId,
			},
			updatedAt: task.status?.timestamp,
		},
		events: [
			{
				type: "maestro.platform_runtime.a2a_correlated",
				runId,
				message: "Maestro A2A task linked to Platform AgentRuntime run",
				attributes: {
					...(a2aMessageId ? { a2a_message_id: a2aMessageId } : {}),
					a2a_task_id: a2aTaskId,
					platform_agent_run_id: runId,
					...(workerQueue ? { worker_queue: workerQueue } : {}),
					...(correlationId ? { correlation_id: correlationId } : {}),
					...(correlationPath ? { correlation_path: correlationPath } : {}),
					...(traceparent ? { traceparent } : {}),
					...(tracestate ? { tracestate } : {}),
					...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
				},
			},
		],
		idempotentReplay: pickBoolean(
			metadata,
			"idempotentReplay",
			"idempotent_replay",
		),
	};
}

function platformRunStateFromA2ATaskState(
	state: string | undefined,
): PlatformAgentRunStateValue {
	switch (state?.trim().toLowerCase()) {
		case "task_state_working":
		case "working":
			return PlatformAgentRunStateValue.Running;
		case "task_state_input_required":
		case "input-required":
			return PlatformAgentRunStateValue.Waiting;
		case "task_state_completed":
		case "completed":
			return PlatformAgentRunStateValue.Succeeded;
		case "task_state_failed":
		case "task_state_rejected":
		case "failed":
		case "rejected":
			return PlatformAgentRunStateValue.Failed;
		case "task_state_auth_required":
		case "auth-required":
			return PlatformAgentRunStateValue.Waiting;
		case "task_state_canceled":
		case "task_state_cancelled":
		case "canceled":
		case "cancelled":
			return PlatformAgentRunStateValue.Cancelled;
		default:
			return PlatformAgentRunStateValue.Queued;
	}
}

function maestroRuntimeTraceContext(
	input: Pick<
		MaestroSessionRuntimeTriggerInput,
		"metadata" | "traceparent" | "tracestate"
	>,
): ReturnType<typeof resolveA2ATraceContext> {
	const traceparent =
		trimString(input.traceparent) ??
		pickString(input.metadata, "traceparent", "trace_parent");
	const tracestate =
		trimString(input.tracestate) ??
		pickString(input.metadata, "tracestate", "trace_state");
	if (traceparent || tracestate) {
		return resolveA2ATraceContext(
			{
				traceparent,
				tracestate,
			},
			{ envFallback: false },
		);
	}
	return resolveA2ATraceContext({
		traceparent,
		tracestate,
	});
}
