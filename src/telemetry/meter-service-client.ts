import {
	type PlatformServiceConfig,
	getEnvValue,
	postPlatformConnect,
	resolveConfiguredToken,
	resolveOrganizationId,
	resolvePlatformServiceConfig,
} from "../platform/client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "../platform/core-services.js";
import { createLogger } from "../utils/logger.js";
import type { CanonicalTurnEvent } from "./wide-events.js";

const logger = createLogger("telemetry:meter");

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const INGEST_WIDE_EVENT_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.meter.ingestWideEvent,
);
const QUERY_WIDE_EVENTS_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.meter.queryWideEvents,
);
const GET_EVENT_DASHBOARD_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.meter.getEventDashboard,
);
const MAESTRO_AGENT_ID = "maestro";
const MAESTRO_SURFACE = "maestro";

type RemoteMeterConfig = PlatformServiceConfig & {
	organizationId: string;
	token: string;
};

export interface RemoteMeterWideEventQuery {
	agentId?: string;
	endTime?: string;
	eventType?: string;
	limit?: number;
	metadataKey?: string;
	metadataValue?: string;
	model?: string;
	offset?: number;
	provider?: string;
	startTime?: string;
	surface?: string;
	teamId?: string;
}

export interface RemoteMeterWideEventQueryResult {
	events: Array<Record<string, unknown>>;
	total: number;
	hasMore: boolean;
}

export interface RemoteMeterEventDashboardResult {
	totalEvents?: number;
	totalInputTokens?: number;
	totalOutputTokens?: number;
	totalCacheReadTokens?: number;
	totalCacheWriteTokens?: number;
	totalCostUsd?: number;
	byEventType?: Array<Record<string, unknown>>;
	bySurface?: Array<Record<string, unknown>>;
	byModel?: Array<Record<string, unknown>>;
	byProvider?: Array<Record<string, unknown>>;
}

async function resolveRemoteMeterConfig(): Promise<RemoteMeterConfig | null> {
	const config = await resolvePlatformServiceConfig({
		baseUrlEnvVars: ["MAESTRO_METER_BASE", "MAESTRO_METER_SERVICE_URL"],
		tokenEnvVars: [
			"MAESTRO_METER_ACCESS_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
		],
		organizationEnvVars: [
			"MAESTRO_METER_ORGANIZATION_ID",
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
		],
		teamEnvVars: [
			"MAESTRO_METER_TEAM_ID",
			"MAESTRO_EVALOPS_TEAM_ID",
			"MAESTRO_LLM_GATEWAY_TEAM_ID",
		],
		timeoutEnvVars: ["MAESTRO_METER_TIMEOUT_MS"],
		maxAttemptsEnvVars: ["MAESTRO_METER_MAX_ATTEMPTS"],
		baseUrlSuffixes: [
			INGEST_WIDE_EVENT_PATH,
			QUERY_WIDE_EVENTS_PATH,
			GET_EVENT_DASHBOARD_PATH,
			platformConnectServicePath(PLATFORM_CONNECT_SERVICES.meter),
		],
		defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
		defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
		requireOrganizationId: true,
		requireToken: true,
	});
	if (!config?.organizationId || !config.token) {
		return null;
	}
	return {
		...config,
		organizationId: config.organizationId,
		token: config.token,
	};
}

function trimRecord(
	entries: Record<string, string | undefined>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(entries)
			.map(([key, value]) => [key, value?.trim()] as const)
			.filter((entry): entry is [string, string] => Boolean(entry[1])),
	);
}

function toNonNegativeInt(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.round(value));
}

function buildMetadata(event: CanonicalTurnEvent): Record<string, string> {
	return trimRecord({
		sessionId: event.sessionId,
		turnId: event.turnId,
		traceId: event.traceId,
		status: event.status,
		sampleReason: event.sampleReason,
		sampled: String(event.sampled),
		sandboxMode: event.sandboxMode,
		approvalMode: event.approvalMode,
		thinkingLevel: event.model.thinkingLevel,
	});
}

export function hasRemoteMeterDestination(): boolean {
	const baseUrl = getEnvValue([
		"MAESTRO_METER_BASE",
		"MAESTRO_METER_SERVICE_URL",
		"MAESTRO_PLATFORM_BASE_URL",
		"MAESTRO_EVALOPS_BASE_URL",
		"EVALOPS_BASE_URL",
	]);
	const organizationId = resolveOrganizationId([
		"MAESTRO_METER_ORGANIZATION_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	const token = resolveConfiguredToken([
		"MAESTRO_METER_ACCESS_TOKEN",
		"MAESTRO_EVALOPS_ACCESS_TOKEN",
		"EVALOPS_TOKEN",
	]);
	return Boolean(baseUrl && organizationId && token);
}

function buildWideEventBody(
	config: RemoteMeterConfig,
	event: CanonicalTurnEvent,
): Record<string, unknown> {
	return {
		timestamp: event.timestamp,
		teamId: config.teamId,
		agentId: getEnvValue(["MAESTRO_AGENT_ID"]) ?? MAESTRO_AGENT_ID,
		surface: getEnvValue(["MAESTRO_SURFACE"]) ?? MAESTRO_SURFACE,
		eventType: event.type,
		model: event.model.id,
		provider: event.model.provider,
		requestId: event.turnId,
		metadata: buildMetadata(event),
		data: event,
		metrics: {
			inputTokens: toNonNegativeInt(event.tokens.input),
			outputTokens: toNonNegativeInt(event.tokens.output),
			cacheReadTokens: toNonNegativeInt(event.tokens.cacheRead),
			cacheWriteTokens: toNonNegativeInt(event.tokens.cacheWrite),
			totalCostUsd: event.costUsd,
			durationMs: toNonNegativeInt(event.totalDurationMs),
			toolCallsCount: toNonNegativeInt(event.toolCount),
		},
	};
}

function buildWideEventQueryBody(
	config: RemoteMeterConfig,
	query: RemoteMeterWideEventQuery,
): Record<string, unknown> {
	return {
		teamId: query.teamId ?? config.teamId,
		agentId: query.agentId,
		surface: query.surface,
		eventType: query.eventType,
		model: query.model,
		provider: query.provider,
		metadataKey: query.metadataKey,
		metadataValue: query.metadataValue,
		startTime: query.startTime,
		endTime: query.endTime,
		limit: query.limit,
		offset: query.offset,
	};
}

function stripUndefinedValues(
	value: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, unknown] => {
			return entry[1] !== undefined;
		}),
	);
}

async function postMeter<T>(
	config: RemoteMeterConfig,
	path: string,
	body: Record<string, unknown>,
	emptyResponseValue?: T,
): Promise<T> {
	const response = await postPlatformConnect(
		config,
		path,
		stripUndefinedValues(body),
		{
			serviceName: "meter service",
			timeoutMs: config.timeoutMs,
			maxAttempts: config.maxAttempts,
		},
	);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`meter service returned ${response.status}: ${text || response.statusText}`,
		);
	}
	const text = await response.text();
	if (!text.trim()) {
		if (emptyResponseValue !== undefined) {
			return emptyResponseValue;
		}
		throw new Error("meter service returned empty response");
	}
	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (contentType && !contentType.includes("application/json")) {
		if (emptyResponseValue !== undefined) {
			return emptyResponseValue;
		}
		throw new Error(`meter service returned non-JSON response: ${contentType}`);
	}
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		if (emptyResponseValue !== undefined) {
			return emptyResponseValue;
		}
		throw error;
	}
}

export async function queryRemoteMeterWideEvents(
	query: RemoteMeterWideEventQuery = {},
): Promise<RemoteMeterWideEventQueryResult | null> {
	const config = await resolveRemoteMeterConfig();
	if (!config) {
		return null;
	}

	try {
		return await postMeter<RemoteMeterWideEventQueryResult>(
			config,
			QUERY_WIDE_EVENTS_PATH,
			buildWideEventQueryBody(config, query),
		);
	} catch (error) {
		logger.debug("Failed to query meter wide events", {
			error: error instanceof Error ? error.message : String(error),
			agentId: query.agentId,
			surface: query.surface,
		});
		return null;
	}
}

export async function getRemoteMeterEventDashboard(
	query: RemoteMeterWideEventQuery = {},
): Promise<RemoteMeterEventDashboardResult | null> {
	const config = await resolveRemoteMeterConfig();
	if (!config) {
		return null;
	}

	try {
		return await postMeter<RemoteMeterEventDashboardResult>(
			config,
			GET_EVENT_DASHBOARD_PATH,
			buildWideEventQueryBody(config, query),
		);
	} catch (error) {
		logger.debug("Failed to fetch meter event dashboard", {
			error: error instanceof Error ? error.message : String(error),
			agentId: query.agentId,
			surface: query.surface,
		});
		return null;
	}
}

export async function mirrorCanonicalTurnEventToMeter(
	event: CanonicalTurnEvent,
): Promise<boolean> {
	const config = await resolveRemoteMeterConfig();
	if (!config) {
		return false;
	}

	try {
		await postMeter(
			config,
			INGEST_WIDE_EVENT_PATH,
			buildWideEventBody(config, event),
			null,
		);
		return true;
	} catch (error) {
		logger.debug(
			"Failed to mirror canonical turn to meter; retaining local telemetry sinks",
			{
				error: error instanceof Error ? error.message : String(error),
				sessionId: event.sessionId,
				turnId: event.turnId,
			},
		);
		return false;
	}
}
