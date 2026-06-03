import type { AgentEvent } from "../agent/types.js";
import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import {
	type PlatformServiceConfig,
	buildPlatformJsonHeaders,
	getEnvValue,
	normalizeBaseUrl,
	resolvePlatformServiceConfig,
	trimString,
} from "../platform/client.js";
import { PLATFORM_HTTP_ROUTES } from "../platform/core-services.js";
import { fetchDownstream } from "../utils/downstream-http.js";
import { createLogger } from "../utils/logger.js";
import {
	type AgentWorkforceNativeEvent,
	type AgentWorkforceNativeProjectionOptions,
	projectAgentWorkforceNativeEvents,
	verifyAgentWorkforceNativeEventChain,
} from "./agent-workforce-native-event.js";

const logger = createLogger("telemetry:agent-workforce-native-event-client");

export const AGENT_WORKFORCE_NATIVE_EVENT_BATCH_SCHEMA_VERSION =
	"agent_workforce_native_event_batch.v1" as const;
export const DEFAULT_AGENT_WORKFORCE_NATIVE_EVENT_TIMEOUT_MS = 2_000;
export const DEFAULT_AGENT_WORKFORCE_NATIVE_EVENT_MAX_ATTEMPTS = 2;

const AGENT_WORKFORCE_INGEST_URL_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_INGEST_URL",
] as const;

const AGENT_WORKFORCE_BASE_URL_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_BASE_URL",
	"MAESTRO_AGENT_WORKFORCE_SERVICE_URL",
] as const;

const AGENT_WORKFORCE_TOKEN_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_ACCESS_TOKEN",
	...EVALOPS_ACCESS_TOKEN_ENV_VARS,
] as const;

const AGENT_WORKFORCE_ORGANIZATION_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_ORG_ID",
	...EVALOPS_ORGANIZATION_ID_ENV_VARS,
] as const;

const AGENT_WORKFORCE_WORKSPACE_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_WORKSPACE_ID",
	...EVALOPS_WORKSPACE_ID_ENV_VARS,
] as const;

const AGENT_WORKFORCE_TIMEOUT_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_TIMEOUT_MS",
] as const;

const AGENT_WORKFORCE_MAX_ATTEMPTS_ENV_VARS = [
	"MAESTRO_AGENT_WORKFORCE_MAX_ATTEMPTS",
] as const;

const SENSITIVE_EGRESS_KEY_PATTERN =
	/(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization|password|provider[_-]?(?:headers|request|response|token|secret|internal)|raw[_-]?provider|api|credentials?|credential[_-]?(?:key|material|raw|secret|token|value))(?:$|[_-])/iu;

const SIGNED_CREDENTIAL_EGRESS_KEYS = new Set([
	"credential_assumption",
	"credential_subject",
	"credential_assumption_ref",
	"credential_assumption_id",
	"credential_name",
]);

export interface AgentWorkforceNativeEventPlatformConfig
	extends PlatformServiceConfig {
	endpointUrl: string;
	organizationId: string;
	workspaceId: string;
	token: string;
}

export interface AgentWorkforceNativeEventBatchBody {
	schema_version: typeof AGENT_WORKFORCE_NATIVE_EVENT_BATCH_SCHEMA_VERSION;
	organization_id: string;
	workspace_id: string;
	batch_id?: string;
	event_count: number;
	events: AgentWorkforceNativeEvent[];
}

export interface AgentWorkforceNativeEventPostOptions {
	batchId?: string;
	fetchImpl?: typeof fetch;
	sleepMs?: (delayMs: number) => Promise<void>;
	signal?: AbortSignal;
}

export interface AgentWorkforceNativeEventPostResult {
	accepted: boolean;
	status: number;
	eventCount: number;
	responseText?: string;
}

function isSensitiveEgressKey(key: string): boolean {
	if (SIGNED_CREDENTIAL_EGRESS_KEYS.has(key)) {
		return false;
	}
	return SENSITIVE_EGRESS_KEY_PATTERN.test(key);
}

function sanitizeForPlatformPost(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeForPlatformPost(item));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).flatMap(
				([key, item]) => {
					if (item === undefined || isSensitiveEgressKey(key)) {
						return [];
					}
					return [[key, sanitizeForPlatformPost(item)]];
				},
			),
		);
	}
	return value;
}

export function sanitizeAgentWorkforceNativeEventForPlatformPost(
	event: AgentWorkforceNativeEvent,
): AgentWorkforceNativeEvent {
	return sanitizeForPlatformPost(event) as AgentWorkforceNativeEvent;
}

export async function resolveAgentWorkforceNativeEventPlatformConfig(
	overrides: Partial<AgentWorkforceNativeEventPlatformConfig> = {},
): Promise<AgentWorkforceNativeEventPlatformConfig | null> {
	const configuredEndpoint =
		trimString(overrides.endpointUrl) ??
		getEnvValue(AGENT_WORKFORCE_INGEST_URL_ENV_VARS);
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: AGENT_WORKFORCE_BASE_URL_ENV_VARS,
		tokenEnvVars: AGENT_WORKFORCE_TOKEN_ENV_VARS,
		organizationEnvVars: AGENT_WORKFORCE_ORGANIZATION_ENV_VARS,
		workspaceEnvVars: AGENT_WORKFORCE_WORKSPACE_ENV_VARS,
		timeoutEnvVars: AGENT_WORKFORCE_TIMEOUT_ENV_VARS,
		maxAttemptsEnvVars: AGENT_WORKFORCE_MAX_ATTEMPTS_ENV_VARS,
		baseUrlSuffixes: [PLATFORM_HTTP_ROUTES.agentWorkforce.nativeEventBatch],
		defaultTimeoutMs: DEFAULT_AGENT_WORKFORCE_NATIVE_EVENT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_AGENT_WORKFORCE_NATIVE_EVENT_MAX_ATTEMPTS,
		requireBaseUrl: !configuredEndpoint,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config?.organizationId || !config.workspaceId || !config.token) {
		return null;
	}

	const baseUrl =
		trimString(overrides.baseUrl ?? config.baseUrl) ?? config.baseUrl;
	const endpointUrl = configuredEndpoint
		? normalizeBaseUrl(configuredEndpoint)
		: `${normalizeBaseUrl(baseUrl)}${PLATFORM_HTTP_ROUTES.agentWorkforce.nativeEventBatch}`;

	return {
		...config,
		baseUrl,
		endpointUrl,
		organizationId:
			trimString(overrides.organizationId ?? config.organizationId) ??
			config.organizationId,
		workspaceId:
			trimString(overrides.workspaceId ?? config.workspaceId) ??
			config.workspaceId,
		token: trimString(overrides.token ?? config.token) ?? config.token,
		timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
		maxAttempts: overrides.maxAttempts ?? config.maxAttempts,
		teamId: trimString(overrides.teamId ?? config.teamId),
	};
}

export function buildAgentWorkforceNativeEventBatchBody(
	config: Pick<
		AgentWorkforceNativeEventPlatformConfig,
		"organizationId" | "workspaceId"
	>,
	events: readonly AgentWorkforceNativeEvent[],
	batchId?: string,
): AgentWorkforceNativeEventBatchBody {
	return {
		schema_version: AGENT_WORKFORCE_NATIVE_EVENT_BATCH_SCHEMA_VERSION,
		organization_id: config.organizationId,
		workspace_id: config.workspaceId,
		...(batchId ? { batch_id: batchId } : {}),
		event_count: events.length,
		events: events.map(sanitizeAgentWorkforceNativeEventForPlatformPost),
	};
}

export async function postAgentWorkforceNativeEventBatchToPlatform(
	config: AgentWorkforceNativeEventPlatformConfig,
	events: readonly AgentWorkforceNativeEvent[],
	options: AgentWorkforceNativeEventPostOptions = {},
): Promise<AgentWorkforceNativeEventPostResult> {
	const response = await fetchDownstream(
		config.endpointUrl,
		{
			method: "POST",
			headers: buildPlatformJsonHeaders(config, {
				"X-Workspace-ID": config.workspaceId,
			}),
			body: JSON.stringify(
				buildAgentWorkforceNativeEventBatchBody(
					config,
					events,
					options.batchId,
				),
			),
			signal: options.signal,
		},
		{
			serviceName: "agent workforce native event ingest",
			failureMode: "optional",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
			fetchImpl: options.fetchImpl,
			sleepMs: options.sleepMs,
		},
	);
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`agent workforce native event ingest returned ${response.status}: ${
				responseText || response.statusText
			}`,
		);
	}
	return {
		accepted: true,
		status: response.status,
		eventCount: events.length,
		...(responseText ? { responseText } : {}),
	};
}

export async function mirrorAgentWorkforceNativeEventsToPlatform(
	nativeEvents: readonly AgentEvent[],
	projectionOptions: AgentWorkforceNativeProjectionOptions,
	options: AgentWorkforceNativeEventPostOptions & {
		config?: AgentWorkforceNativeEventPlatformConfig;
	} = {},
): Promise<boolean> {
	const projected = projectAgentWorkforceNativeEvents(
		nativeEvents,
		projectionOptions,
	);
	if (projected.length === 0) {
		return false;
	}
	const verification = verifyAgentWorkforceNativeEventChain(projected);
	if (!verification.valid) {
		throw new Error(
			`agent workforce native event chain verification failed: ${verification.reason}`,
		);
	}

	const config =
		options.config ?? (await resolveAgentWorkforceNativeEventPlatformConfig());
	if (!config) {
		return false;
	}

	try {
		await postAgentWorkforceNativeEventBatchToPlatform(
			config,
			projected,
			options,
		);
		return true;
	} catch (error) {
		logger.debug(
			"Failed to mirror Agent Workforce native events to Platform; retaining local projection",
			{
				error: error instanceof Error ? error.message : String(error),
				eventCount: projected.length,
			},
		);
		return false;
	}
}
