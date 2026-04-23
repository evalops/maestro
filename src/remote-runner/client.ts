import { randomUUID } from "node:crypto";
import {
	type PlatformServiceConfig,
	getEnvValue,
	normalizeBaseUrl,
	postPlatformConnect,
	resolvePlatformServiceConfig,
	trimString,
} from "../platform/client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "../platform/core-services.js";
import { fetchDownstream } from "../utils/downstream-http.js";

export const DEFAULT_REMOTE_RUNNER_BASE_URL = "https://runner.evalops.dev";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_REMOTE_RUNNER_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_REMOTE_RUNNER_WAIT_POLL_INTERVAL_MS = 5_000;

const CREATE_RUNNER_SESSION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.createRunnerSession,
);
const GET_RUNNER_SESSION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.getRunnerSession,
);
const LIST_RUNNER_SESSIONS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.listRunnerSessions,
);
const STOP_RUNNER_SESSION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.stopRunnerSession,
);
const EXTEND_RUNNER_SESSION_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.extendRunnerSession,
);
const MINT_ATTACH_TOKEN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.mintAttachToken,
);
const REVOKE_ATTACH_TOKEN_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.revokeAttachToken,
);
const LIST_RUNNER_SESSION_EVENTS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.listRunnerSessionEvents,
);
const GET_REMOTE_RUNNER_STATUS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.remoteRunner.getStatus,
);

export const RUNNER_SESSION_STATES = {
	UNSPECIFIED: "RUNNER_SESSION_STATE_UNSPECIFIED",
	REQUESTED: "RUNNER_SESSION_STATE_REQUESTED",
	PROVISIONING: "RUNNER_SESSION_STATE_PROVISIONING",
	RUNNING: "RUNNER_SESSION_STATE_RUNNING",
	IDLE: "RUNNER_SESSION_STATE_IDLE",
	STOPPING: "RUNNER_SESSION_STATE_STOPPING",
	STOPPED: "RUNNER_SESSION_STATE_STOPPED",
	EXPIRED: "RUNNER_SESSION_STATE_EXPIRED",
	FAILED: "RUNNER_SESSION_STATE_FAILED",
	LOST: "RUNNER_SESSION_STATE_LOST",
} as const;

export type RunnerSessionState =
	(typeof RUNNER_SESSION_STATES)[keyof typeof RUNNER_SESSION_STATES];

export const RUNNER_ATTACH_ROLES = {
	UNSPECIFIED: "RUNNER_ATTACH_ROLE_UNSPECIFIED",
	VIEWER: "RUNNER_ATTACH_ROLE_VIEWER",
	CONTROLLER: "RUNNER_ATTACH_ROLE_CONTROLLER",
	ADMIN: "RUNNER_ATTACH_ROLE_ADMIN",
} as const;

export type RunnerAttachRole =
	(typeof RUNNER_ATTACH_ROLES)[keyof typeof RUNNER_ATTACH_ROLES];

const REMOTE_RUNNER_BASE_URL_ENV_VARS = [
	"MAESTRO_REMOTE_RUNNER_URL",
	"REMOTE_RUNNER_SERVICE_URL",
	"EVALOPS_REMOTE_RUNNER_URL",
] as const;

const REMOTE_RUNNER_TOKEN_ENV_VARS = [
	"MAESTRO_REMOTE_RUNNER_TOKEN",
	"REMOTE_RUNNER_SERVICE_TOKEN",
	"MAESTRO_EVALOPS_ACCESS_TOKEN",
	"EVALOPS_TOKEN",
] as const;

const REMOTE_RUNNER_ORGANIZATION_ENV_VARS = [
	"MAESTRO_REMOTE_RUNNER_ORG_ID",
	"REMOTE_RUNNER_ORGANIZATION_ID",
	"MAESTRO_EVALOPS_ORG_ID",
	"EVALOPS_ORGANIZATION_ID",
	"MAESTRO_ENTERPRISE_ORG_ID",
] as const;

const REMOTE_RUNNER_WORKSPACE_ENV_VARS = [
	"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
	"REMOTE_RUNNER_WORKSPACE_ID",
	"MAESTRO_WORKSPACE_ID",
	"EVALOPS_WORKSPACE_ID",
] as const;

const REMOTE_RUNNER_TIMEOUT_ENV_VARS = [
	"MAESTRO_REMOTE_RUNNER_TIMEOUT_MS",
	"REMOTE_RUNNER_SERVICE_TIMEOUT_MS",
] as const;

const REMOTE_RUNNER_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_REMOTE_RUNNER_MAX_ATTEMPTS",
	"REMOTE_RUNNER_SERVICE_MAX_ATTEMPTS",
] as const;

const REMOTE_RUNNER_BASE_URL_SUFFIXES = [
	CREATE_RUNNER_SESSION_PATH,
	GET_RUNNER_SESSION_PATH,
	LIST_RUNNER_SESSIONS_PATH,
	STOP_RUNNER_SESSION_PATH,
	EXTEND_RUNNER_SESSION_PATH,
	MINT_ATTACH_TOKEN_PATH,
	REVOKE_ATTACH_TOKEN_PATH,
	LIST_RUNNER_SESSION_EVENTS_PATH,
	GET_REMOTE_RUNNER_STATUS_PATH,
	platformConnectServicePath(PLATFORM_CONNECT_SERVICES.remoteRunner),
	"/v1/runner-sessions",
	"/v1/runner-sessions/",
] as const;

export interface RemoteRunnerServiceConfig extends PlatformServiceConfig {
	organizationId: string;
	token: string;
}

export interface RemoteRunnerClientOptions {
	baseUrl?: string;
	token?: string;
	organizationId?: string;
	workspaceId?: string;
	timeoutMs?: number;
	maxAttempts?: number;
}

export interface RunnerSession {
	id: string;
	organizationId?: string;
	workspaceId?: string;
	userId?: string;
	agentRunId?: string;
	maestroSessionId?: string;
	state?: RunnerSessionState | string;
	runnerProfile?: string;
	runnerImage?: string;
	workspaceSource?: string;
	repoUrl?: string;
	branch?: string;
	model?: string;
	ownerInstanceId?: string;
	runnerPodNamespace?: string;
	runnerPodName?: string;
	runnerServiceName?: string;
	createdAt?: string;
	startedAt?: string;
	expiresAt?: string;
	idleExpiresAt?: string;
	stoppedAt?: string;
	stopReason?: string;
	lastHeartbeatAt?: string;
	usedRunnerSeconds?: number;
	usedIdleSeconds?: number;
	estimatedCostMicros?: number;
	metadata?: Record<string, unknown>;
}

export interface RunnerSessionEvent {
	id?: string;
	sessionId?: string;
	sequence?: number;
	eventType?: string;
	occurredAt?: string;
	payload?: Record<string, unknown>;
}

export interface RunnerAttachToken {
	id: string;
	sessionId?: string;
	subjectId?: string;
	roles?: Array<RunnerAttachRole | string>;
	createdAt?: string;
	expiresAt?: string;
	revokedAt?: string;
}

export interface CreateRunnerSessionInput {
	workspaceId?: string;
	userId?: string;
	agentRunId?: string;
	maestroSessionId?: string;
	idempotencyKey?: string;
	runnerProfile: string;
	runnerImage?: string;
	workspaceSource?: string;
	repoUrl?: string;
	branch?: string;
	model?: string;
	ttlMinutes: number;
	idleTtlMinutes?: number;
	metadata?: Record<string, unknown>;
}

export interface ListRunnerSessionsInput {
	workspaceId?: string;
	state?: RunnerSessionState | string;
	limit?: number;
	offset?: number;
}

export interface ExtendRunnerSessionInput {
	sessionId: string;
	additionalMinutes: number;
	additionalIdleMinutes?: number;
	reason?: string;
}

export interface MintAttachTokenInput {
	sessionId: string;
	subjectId?: string;
	roles?: Array<RunnerAttachRole | string>;
	ttlMinutes?: number;
}

export interface RevokeAttachTokenInput {
	sessionId: string;
	tokenId: string;
}

export interface ListRunnerSessionEventsInput {
	sessionId: string;
	afterSequence?: number;
	limit?: number;
}

export interface RemoteRunnerStatus {
	service?: string;
	workspaceId?: string;
	downstreamPolicy?: string;
}

export interface WaitForRunnerSessionReadyOptions
	extends RemoteRunnerClientOptions {
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export class WaitForRunnerSessionReadyError extends Error {
	readonly code: "timeout" | "terminal_state";
	readonly elapsedMs: number;
	readonly attempts: number;
	readonly session?: RunnerSession;

	constructor(input: {
		message: string;
		code: "timeout" | "terminal_state";
		elapsedMs: number;
		attempts: number;
		session?: RunnerSession;
	}) {
		super(input.message);
		this.name = "WaitForRunnerSessionReadyError";
		this.code = input.code;
		this.elapsedMs = input.elapsedMs;
		this.attempts = input.attempts;
		this.session = input.session;
	}
}

function firstString(
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

function firstNumber(
	record: Record<string, unknown> | undefined,
	...names: string[]
): number | undefined {
	for (const name of names) {
		const value = record?.[name];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string") {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function firstRecord(
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

function firstArray(
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

function stripUndefinedValues(
	body: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(body).filter((entry): entry is [string, unknown] => {
			return entry[1] !== undefined;
		}),
	);
}

function normalizeRunnerSession(value: unknown): RunnerSession | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = firstString(record, "id");
	if (!id) {
		return undefined;
	}
	return {
		id,
		organizationId: firstString(record, "organizationId", "organization_id"),
		workspaceId: firstString(record, "workspaceId", "workspace_id"),
		userId: firstString(record, "userId", "user_id"),
		agentRunId: firstString(record, "agentRunId", "agent_run_id"),
		maestroSessionId: firstString(
			record,
			"maestroSessionId",
			"maestro_session_id",
		),
		state: firstString(record, "state"),
		runnerProfile: firstString(record, "runnerProfile", "runner_profile"),
		runnerImage: firstString(record, "runnerImage", "runner_image"),
		workspaceSource: firstString(record, "workspaceSource", "workspace_source"),
		repoUrl: firstString(record, "repoUrl", "repo_url"),
		branch: firstString(record, "branch"),
		model: firstString(record, "model"),
		ownerInstanceId: firstString(
			record,
			"ownerInstanceId",
			"owner_instance_id",
		),
		runnerPodNamespace: firstString(
			record,
			"runnerPodNamespace",
			"runner_pod_namespace",
		),
		runnerPodName: firstString(record, "runnerPodName", "runner_pod_name"),
		runnerServiceName: firstString(
			record,
			"runnerServiceName",
			"runner_service_name",
		),
		createdAt: firstString(record, "createdAt", "created_at"),
		startedAt: firstString(record, "startedAt", "started_at"),
		expiresAt: firstString(record, "expiresAt", "expires_at"),
		idleExpiresAt: firstString(record, "idleExpiresAt", "idle_expires_at"),
		stoppedAt: firstString(record, "stoppedAt", "stopped_at"),
		stopReason: firstString(record, "stopReason", "stop_reason"),
		lastHeartbeatAt: firstString(
			record,
			"lastHeartbeatAt",
			"last_heartbeat_at",
		),
		usedRunnerSeconds: firstNumber(
			record,
			"usedRunnerSeconds",
			"used_runner_seconds",
		),
		usedIdleSeconds: firstNumber(
			record,
			"usedIdleSeconds",
			"used_idle_seconds",
		),
		estimatedCostMicros: firstNumber(
			record,
			"estimatedCostMicros",
			"estimated_cost_micros",
		),
		metadata: firstRecord(record, "metadata"),
	};
}

function normalizeRunnerSessionEvent(
	value: unknown,
): RunnerSessionEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		id: firstString(record, "id"),
		sessionId: firstString(record, "sessionId", "session_id"),
		sequence: firstNumber(record, "sequence"),
		eventType: firstString(record, "eventType", "event_type"),
		occurredAt: firstString(record, "occurredAt", "occurred_at"),
		payload: firstRecord(record, "payload"),
	};
}

function normalizeRunnerAttachToken(
	value: unknown,
): RunnerAttachToken | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const id = firstString(record, "id");
	if (!id) {
		return undefined;
	}
	return {
		id,
		sessionId: firstString(record, "sessionId", "session_id"),
		subjectId: firstString(record, "subjectId", "subject_id"),
		roles: firstArray(record, "roles")?.filter(
			(value): value is RunnerAttachRole | string => typeof value === "string",
		),
		createdAt: firstString(record, "createdAt", "created_at"),
		expiresAt: firstString(record, "expiresAt", "expires_at"),
		revokedAt: firstString(record, "revokedAt", "revoked_at"),
	};
}

function requireSession(
	payload: Record<string, unknown>,
	serviceName: string,
): RunnerSession {
	const session = normalizeRunnerSession(payload.session);
	if (!session) {
		throw new Error(`${serviceName} returned no runner session`);
	}
	return session;
}

function requireAttachToken(
	payload: Record<string, unknown>,
	serviceName: string,
): RunnerAttachToken {
	const token = normalizeRunnerAttachToken(payload.token);
	if (!token) {
		throw new Error(`${serviceName} returned no attach token`);
	}
	return token;
}

function ensurePositiveMinutes(
	value: number,
	field: string,
	max = 1440,
): number {
	if (!Number.isInteger(value) || value < 1 || value > max) {
		throw new Error(`${field} must be an integer between 1 and ${max}`);
	}
	return value;
}

function ensureNonNegativeMinutes(
	value: number | undefined,
	field: string,
	max = 1440,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Number.isInteger(value) || value < 0 || value > max) {
		throw new Error(`${field} must be an integer between 0 and ${max}`);
	}
	return value;
}

function normalizeRole(role: RunnerAttachRole | string): RunnerAttachRole {
	const normalized = role
		.trim()
		.toUpperCase()
		.replace(/^RUNNER_ATTACH_ROLE_/u, "");
	const matched =
		RUNNER_ATTACH_ROLES[normalized as keyof typeof RUNNER_ATTACH_ROLES];
	if (!matched || matched === RUNNER_ATTACH_ROLES.UNSPECIFIED) {
		throw new Error(`Unknown runner attach role: ${role}`);
	}
	return matched;
}

function normalizeState(
	state: RunnerSessionState | string,
): RunnerSessionState {
	const normalized = state
		.trim()
		.toUpperCase()
		.replace(/^RUNNER_SESSION_STATE_/u, "");
	const matched =
		RUNNER_SESSION_STATES[normalized as keyof typeof RUNNER_SESSION_STATES];
	if (!matched || matched === RUNNER_SESSION_STATES.UNSPECIFIED) {
		throw new Error(`Unknown runner session state: ${state}`);
	}
	return matched;
}

function stateMatches(
	state: RunnerSessionState | string | undefined,
	expected: readonly RunnerSessionState[],
): boolean {
	if (!state) {
		return false;
	}
	try {
		return expected.includes(normalizeState(state));
	} catch {
		return false;
	}
}

function describeState(state: RunnerSessionState | string | undefined): string {
	return (
		state
			?.replace(/^RUNNER_SESSION_STATE_/u, "")
			.toLowerCase()
			.replaceAll("_", "-") ?? "unknown"
	);
}

function waitDelay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function normalizeConfig(
	config: PlatformServiceConfig,
	overrides: RemoteRunnerClientOptions,
): RemoteRunnerServiceConfig | null {
	const organizationId = trimString(
		overrides.organizationId ?? config.organizationId,
	);
	const token = trimString(overrides.token ?? config.token);
	if (!organizationId || !token) {
		return null;
	}
	const explicitBaseUrl = trimString(overrides.baseUrl ?? config.baseUrl);
	const baseUrl = normalizeBaseUrl(
		explicitBaseUrl ?? DEFAULT_REMOTE_RUNNER_BASE_URL,
		REMOTE_RUNNER_BASE_URL_SUFFIXES,
	);
	return {
		...config,
		baseUrl,
		token,
		organizationId,
		workspaceId: trimString(overrides.workspaceId ?? config.workspaceId),
		timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
		maxAttempts: overrides.maxAttempts ?? config.maxAttempts,
	};
}

export async function resolveRemoteRunnerConfig(
	overrides: RemoteRunnerClientOptions = {},
): Promise<RemoteRunnerServiceConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: REMOTE_RUNNER_BASE_URL_ENV_VARS,
		tokenEnvVars: REMOTE_RUNNER_TOKEN_ENV_VARS,
		organizationEnvVars: REMOTE_RUNNER_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: REMOTE_RUNNER_WORKSPACE_ENV_VARS,
		timeoutEnvVars: REMOTE_RUNNER_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: REMOTE_RUNNER_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: REMOTE_RUNNER_BASE_URL_SUFFIXES,
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireBaseUrl: false,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config) {
		return null;
	}
	return normalizeConfig(config, overrides);
}

export function hasRemoteRunnerDestination(): boolean {
	const organizationId = getEnvValue(REMOTE_RUNNER_ORGANIZATION_ENV_VARS);
	const token = getEnvValue(REMOTE_RUNNER_TOKEN_ENV_VARS);
	return Boolean(organizationId && token);
}

export function remoteRunnerGatewayBaseUrl(
	config: Pick<RemoteRunnerServiceConfig, "baseUrl">,
	sessionId: string,
): string {
	return `${config.baseUrl}/v1/runner-sessions/${encodeURIComponent(
		sessionId,
	)}/headless`;
}

async function postRemoteRunner<T>(
	config: RemoteRunnerServiceConfig,
	path: string,
	body: Record<string, unknown>,
	normalize: (payload: Record<string, unknown>) => T,
): Promise<T> {
	const response = await postPlatformConnect(
		config,
		path,
		stripUndefinedValues(body),
		{
			serviceName: "remote runner service",
			failureMode: "required",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`remote runner service returned ${response.status}: ${
				text || response.statusText
			}`,
		);
	}
	const text = await response.text();
	if (!text.trim()) {
		throw new Error("remote runner service returned empty response");
	}
	return normalize(JSON.parse(text) as Record<string, unknown>);
}

async function requireRemoteRunnerConfig(
	overrides: RemoteRunnerClientOptions,
): Promise<RemoteRunnerServiceConfig> {
	const config = await resolveRemoteRunnerConfig(overrides);
	if (!config) {
		throw new Error(
			"Remote runner requires EvalOps organization and access token. Set MAESTRO_REMOTE_RUNNER_ORG_ID/MAESTRO_EVALOPS_ORG_ID and MAESTRO_REMOTE_RUNNER_TOKEN/MAESTRO_EVALOPS_ACCESS_TOKEN, or run EvalOps login.",
		);
	}
	return config;
}

export async function createRunnerSession(
	input: CreateRunnerSessionInput,
	options: RemoteRunnerClientOptions = {},
): Promise<{
	session: RunnerSession;
	events: RunnerSessionEvent[];
	replayed: boolean;
}> {
	const config = await requireRemoteRunnerConfig(options);
	const workspaceId = trimString(input.workspaceId ?? config.workspaceId);
	if (!workspaceId) {
		throw new Error(
			"Remote runner start requires a workspace id. Pass --workspace or set MAESTRO_REMOTE_RUNNER_WORKSPACE_ID.",
		);
	}
	const ttlMinutes = ensurePositiveMinutes(input.ttlMinutes, "ttlMinutes");
	const idleTtlMinutes = ensureNonNegativeMinutes(
		input.idleTtlMinutes,
		"idleTtlMinutes",
	);
	return postRemoteRunner(
		config,
		CREATE_RUNNER_SESSION_PATH,
		{
			organizationId: config.organizationId,
			workspaceId,
			userId: trimString(input.userId),
			agentRunId: trimString(input.agentRunId),
			maestroSessionId: trimString(input.maestroSessionId),
			idempotencyKey: trimString(input.idempotencyKey) ?? randomUUID(),
			runnerProfile: trimString(input.runnerProfile),
			runnerImage: trimString(input.runnerImage),
			workspaceSource: trimString(input.workspaceSource),
			repoUrl: trimString(input.repoUrl),
			branch: trimString(input.branch),
			model: trimString(input.model),
			ttlMinutes,
			idleTtlMinutes,
			metadata: input.metadata,
		},
		(payload) => ({
			session: requireSession(payload, "remote runner service"),
			events:
				firstArray(payload, "events")
					?.map(normalizeRunnerSessionEvent)
					.filter((event): event is RunnerSessionEvent => Boolean(event)) ?? [],
			replayed: payload.replayed === true,
		}),
	);
}

export async function getRunnerSession(
	sessionId: string,
	options: RemoteRunnerClientOptions = {},
): Promise<RunnerSession> {
	const config = await requireRemoteRunnerConfig(options);
	return postRemoteRunner(
		config,
		GET_RUNNER_SESSION_PATH,
		{ sessionId: trimString(sessionId) },
		(payload) => requireSession(payload, "remote runner service"),
	);
}

export async function listRunnerSessions(
	input: ListRunnerSessionsInput = {},
	options: RemoteRunnerClientOptions = {},
): Promise<{ sessions: RunnerSession[]; nextOffset?: number }> {
	const config = await requireRemoteRunnerConfig(options);
	const workspaceId = trimString(input.workspaceId ?? config.workspaceId);
	if (!workspaceId) {
		throw new Error(
			"Remote runner list requires a workspace id. Pass --workspace or set MAESTRO_REMOTE_RUNNER_WORKSPACE_ID.",
		);
	}
	return postRemoteRunner(
		config,
		LIST_RUNNER_SESSIONS_PATH,
		{
			organizationId: config.organizationId,
			workspaceId,
			state: input.state ? normalizeState(input.state) : undefined,
			limit: input.limit,
			offset: input.offset,
		},
		(payload) => ({
			sessions:
				firstArray(payload, "sessions")
					?.map(normalizeRunnerSession)
					.filter((session): session is RunnerSession => Boolean(session)) ??
				[],
			nextOffset: firstNumber(payload, "nextOffset", "next_offset"),
		}),
	);
}

export async function stopRunnerSession(
	sessionId: string,
	reason?: string,
	options: RemoteRunnerClientOptions = {},
): Promise<{ session: RunnerSession; event?: RunnerSessionEvent }> {
	const config = await requireRemoteRunnerConfig(options);
	return postRemoteRunner(
		config,
		STOP_RUNNER_SESSION_PATH,
		{ sessionId: trimString(sessionId), reason: trimString(reason) },
		(payload) => ({
			session: requireSession(payload, "remote runner service"),
			event: normalizeRunnerSessionEvent(payload.event),
		}),
	);
}

export async function extendRunnerSession(
	input: ExtendRunnerSessionInput,
	options: RemoteRunnerClientOptions = {},
): Promise<{ session: RunnerSession; event?: RunnerSessionEvent }> {
	const config = await requireRemoteRunnerConfig(options);
	return postRemoteRunner(
		config,
		EXTEND_RUNNER_SESSION_PATH,
		{
			sessionId: trimString(input.sessionId),
			additionalMinutes: ensurePositiveMinutes(
				input.additionalMinutes,
				"additionalMinutes",
			),
			additionalIdleMinutes: ensureNonNegativeMinutes(
				input.additionalIdleMinutes,
				"additionalIdleMinutes",
			),
			reason: trimString(input.reason),
		},
		(payload) => ({
			session: requireSession(payload, "remote runner service"),
			event: normalizeRunnerSessionEvent(payload.event),
		}),
	);
}

export async function mintRunnerAttachToken(
	input: MintAttachTokenInput,
	options: RemoteRunnerClientOptions = {},
): Promise<{
	token: RunnerAttachToken;
	tokenSecret: string;
	gatewayBaseUrl: string;
}> {
	const config = await requireRemoteRunnerConfig(options);
	const sessionId = trimString(input.sessionId);
	if (!sessionId) {
		throw new Error("Attach token requires a runner session id");
	}
	const roles = (
		input.roles?.length ? input.roles : [RUNNER_ATTACH_ROLES.CONTROLLER]
	).map(normalizeRole);
	const ttlMinutes = ensureNonNegativeMinutes(
		input.ttlMinutes ?? 30,
		"ttlMinutes",
		60,
	);
	const result = await postRemoteRunner(
		config,
		MINT_ATTACH_TOKEN_PATH,
		{
			sessionId,
			subjectId: trimString(input.subjectId),
			roles,
			ttlMinutes,
		},
		(payload) => {
			const tokenSecret = firstString(payload, "tokenSecret", "token_secret");
			if (!tokenSecret) {
				throw new Error(
					"remote runner service returned no attach token secret",
				);
			}
			return {
				token: requireAttachToken(payload, "remote runner service"),
				tokenSecret,
			};
		},
	);
	return {
		...result,
		gatewayBaseUrl: remoteRunnerGatewayBaseUrl(config, sessionId),
	};
}

export async function revokeRunnerAttachToken(
	input: RevokeAttachTokenInput,
	options: RemoteRunnerClientOptions = {},
): Promise<{ token: RunnerAttachToken; event?: RunnerSessionEvent }> {
	const config = await requireRemoteRunnerConfig(options);
	return postRemoteRunner(
		config,
		REVOKE_ATTACH_TOKEN_PATH,
		{
			sessionId: trimString(input.sessionId),
			tokenId: trimString(input.tokenId),
		},
		(payload) => ({
			token: requireAttachToken(payload, "remote runner service"),
			event: normalizeRunnerSessionEvent(payload.event),
		}),
	);
}

export async function listRunnerSessionEvents(
	input: ListRunnerSessionEventsInput,
	options: RemoteRunnerClientOptions = {},
): Promise<{ events: RunnerSessionEvent[]; nextSequence?: number }> {
	const config = await requireRemoteRunnerConfig(options);
	return postRemoteRunner(
		config,
		LIST_RUNNER_SESSION_EVENTS_PATH,
		{
			sessionId: trimString(input.sessionId),
			afterSequence: input.afterSequence,
			limit: input.limit,
		},
		(payload) => ({
			events:
				firstArray(payload, "events")
					?.map(normalizeRunnerSessionEvent)
					.filter((event): event is RunnerSessionEvent => Boolean(event)) ?? [],
			nextSequence: firstNumber(payload, "nextSequence", "next_sequence"),
		}),
	);
}

export async function getRemoteRunnerStatus(
	workspaceId?: string,
	options: RemoteRunnerClientOptions = {},
): Promise<RemoteRunnerStatus> {
	const config = await requireRemoteRunnerConfig(options);
	const resolvedWorkspaceId = trimString(workspaceId ?? config.workspaceId);
	if (!resolvedWorkspaceId) {
		throw new Error(
			"Remote runner status requires a workspace id. Pass --workspace or set MAESTRO_REMOTE_RUNNER_WORKSPACE_ID.",
		);
	}
	return postRemoteRunner(
		config,
		GET_REMOTE_RUNNER_STATUS_PATH,
		{
			workspaceId: resolvedWorkspaceId,
		},
		(payload) => ({
			service: firstString(payload, "service"),
			workspaceId: firstString(payload, "workspaceId", "workspace_id"),
			downstreamPolicy: firstString(
				payload,
				"downstreamPolicy",
				"downstream_policy",
			),
		}),
	);
}

export async function waitForRunnerSessionReady(
	sessionId: string,
	options: WaitForRunnerSessionReadyOptions = {},
): Promise<{
	session: RunnerSession;
	attempts: number;
	elapsedMs: number;
}> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_RUNNER_WAIT_TIMEOUT_MS;
	const pollIntervalMs =
		options.pollIntervalMs ?? DEFAULT_REMOTE_RUNNER_WAIT_POLL_INTERVAL_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
		throw new Error("Remote runner wait timeout must be at least 1ms");
	}
	if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
		throw new Error("Remote runner poll interval must be 0ms or greater");
	}

	const readyStates = [
		RUNNER_SESSION_STATES.RUNNING,
		RUNNER_SESSION_STATES.IDLE,
	] as const;
	const terminalStates = [
		RUNNER_SESSION_STATES.STOPPED,
		RUNNER_SESSION_STATES.EXPIRED,
		RUNNER_SESSION_STATES.FAILED,
		RUNNER_SESSION_STATES.LOST,
	] as const;

	const startedAt = Date.now();
	let attempts = 0;
	let lastSession: RunnerSession | undefined;

	while (true) {
		attempts += 1;
		lastSession = await getRunnerSession(sessionId, options);
		const elapsedMs = Date.now() - startedAt;

		if (stateMatches(lastSession.state, readyStates)) {
			return {
				session: lastSession,
				attempts,
				elapsedMs,
			};
		}

		if (stateMatches(lastSession.state, terminalStates)) {
			const stopReason = lastSession.stopReason?.trim();
			throw new WaitForRunnerSessionReadyError({
				message: stopReason
					? `Remote runner session ${sessionId} entered terminal state ${describeState(lastSession.state)}: ${stopReason}`
					: `Remote runner session ${sessionId} entered terminal state ${describeState(lastSession.state)}`,
				code: "terminal_state",
				elapsedMs,
				attempts,
				session: lastSession,
			});
		}

		if (elapsedMs >= timeoutMs) {
			throw new WaitForRunnerSessionReadyError({
				message: `Timed out after ${timeoutMs}ms waiting for remote runner session ${sessionId} to become ready (last state: ${describeState(lastSession.state)})`,
				code: "timeout",
				elapsedMs,
				attempts,
				session: lastSession,
			});
		}

		const remainingMs = timeoutMs - elapsedMs;
		const sleepMs = Math.min(pollIntervalMs, remainingMs);
		if (sleepMs > 0) {
			await waitDelay(sleepMs);
		}
	}
}

export async function verifyRunnerHeadlessAttach(input: {
	gatewayBaseUrl: string;
	tokenId: string;
	tokenSecret: string;
	sessionId: string;
	protocolVersion: string;
	clientVersion?: string;
	takeControl?: boolean;
	timeoutMs?: number;
}): Promise<{
	sessionId?: string;
	connectionId?: string;
	heartbeatIntervalMs?: number;
	role?: string;
}> {
	const headers = {
		Authorization: `Bearer ${input.tokenSecret}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		"X-EvalOps-Runner-Attach-Token-Id": input.tokenId,
	};
	const body = {
		sessionId: input.sessionId,
		protocolVersion: input.protocolVersion,
		clientInfo: {
			name: "maestro-remote-cli",
			version: input.clientVersion,
		},
		role: "controller",
		takeControl: input.takeControl ?? false,
		optOutNotifications: ["heartbeat"],
		capabilities: {
			serverRequests: ["approval", "user_input", "tool_retry"],
			utilityOperations: [
				"command_exec",
				"file_search",
				"file_read",
				"file_watch",
			],
		},
	};
	const response = await fetchDownstream(
		`${input.gatewayBaseUrl}/api/headless/connections`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(body),
		},
		{
			serviceName: "remote runner headless gateway",
			failureMode: "required",
			timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxAttempts: 1,
		},
	);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`remote runner headless gateway returned ${response.status}: ${
				text || response.statusText
			}`,
		);
	}
	const payload = text.trim()
		? (JSON.parse(text) as Record<string, unknown>)
		: {};
	const connectionId = firstString(payload, "connection_id", "connectionId");
	const runtimeSessionId = firstString(payload, "session_id", "sessionId");
	if (connectionId || runtimeSessionId) {
		void fetchDownstream(
			`${input.gatewayBaseUrl}/api/headless/sessions/${encodeURIComponent(
				runtimeSessionId ?? input.sessionId,
			)}/disconnect`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ connectionId }),
			},
			{
				serviceName: "remote runner headless gateway",
				failureMode: "required",
				timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxAttempts: 1,
			},
		).catch(() => undefined);
	}
	return {
		sessionId: runtimeSessionId,
		connectionId,
		heartbeatIntervalMs: firstNumber(
			payload,
			"heartbeat_interval_ms",
			"heartbeatIntervalMs",
		),
		role: firstString(payload, "role"),
	};
}
