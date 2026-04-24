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
	occurredAt?: string;
}

export interface PlatformAgentRuntimeHandleTriggerResult {
	run: PlatformAgentRun;
	events: PlatformRuntimeEvent[];
	idempotentReplay: boolean;
}

export interface MaestroSessionRuntimeTriggerInput {
	workspaceId?: string;
	sessionId: string;
	agentId?: string;
	actorId?: string;
	correlationId?: string;
	sourceEventId?: string;
	idempotencyKey?: string;
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

function normalizeRun(value: unknown): PlatformAgentRun | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = pickString(record, "id");
	if (!id) {
		return undefined;
	}
	const linkage = pickRecord(record, "linkage");
	return {
		id,
		state: pickString(record, "state"),
		linkage: linkage
			? {
					runId: pickString(linkage, "runId", "run_id"),
					workspaceId: pickString(linkage, "workspaceId", "workspace_id"),
					agentId: pickString(linkage, "agentId", "agent_id"),
					objectiveId: pickString(linkage, "objectiveId", "objective_id"),
				}
			: undefined,
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
		occurredAt: pickString(record, "occurredAt", "occurred_at"),
	};
}

function normalizeHandleTriggerResponse(
	payload: Record<string, unknown>,
): PlatformAgentRuntimeHandleTriggerResult {
	const run = normalizeRun(payload.run);
	if (!run) {
		throw new Error("agent runtime service returned no run");
	}
	return {
		run,
		events:
			pickArray(payload, "events")
				?.map(normalizeEvent)
				.filter((event): event is PlatformRuntimeEvent => Boolean(event)) ?? [],
		idempotentReplay: pickBoolean(
			payload,
			"idempotentReplay",
			"idempotent_replay",
		),
	};
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
	const config = options?.config ?? (await resolveAgentRuntimeServiceConfig());
	if (!config) {
		throw new Error("agent runtime service is not configured");
	}
	const response = await postPlatformConnect(
		config,
		HANDLE_TRIGGER_PATH,
		{ trigger },
		{
			serviceName: "agent runtime service",
			failureMode: "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			signal: options?.signal,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`agent runtime service returned ${response.status}: ${text || response.statusText}`,
		);
	}
	return normalizeHandleTriggerResponse(
		(await response.json()) as Record<string, unknown>,
	);
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
	const trigger = buildMaestroSessionRuntimeTrigger(input, config.workspaceId);
	if (!trigger) {
		return null;
	}
	try {
		return await handleAgentRuntimeTrigger(trigger, {
			config,
			signal: options?.signal,
		});
	} catch {
		return null;
	}
}
