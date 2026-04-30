import {
	type MaestroFactsContext,
	gatherMaestroSessionFactsContext,
} from "./cerebro-facts-client.js";
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

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 2;

const HANDLE_TRIGGER_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.handleTrigger,
);
const CLAIM_NEXT_RUN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.claimNextRun,
);
const RECORD_RUN_STEP_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.agentRuntime.recordRunStep,
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

const AGENT_RUNTIME_BASE_URL_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
	"AGENT_RUNTIME_SERVICE_URL",
] as const;

const AGENT_RUNTIME_TOKEN_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
	"AGENT_RUNTIME_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const AGENT_RUNTIME_ORGANIZATION_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_ORG_ID",
	"AGENT_RUNTIME_ORGANIZATION_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

const AGENT_RUNTIME_WORKSPACE_ENV_VARS = [
	"MAESTRO_AGENT_RUNTIME_WORKSPACE_ID",
	"AGENT_RUNTIME_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
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
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
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
			}),
		},
		triggerKind: PlatformRuntimeTriggerKindValue.Api,
		payload: {
			maestroSessionId: sessionId,
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
			...(typeof input.leaseSeconds === "number"
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
			...(typeof input.retryDelaySeconds === "number"
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
