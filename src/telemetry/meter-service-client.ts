import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { createLogger } from "../utils/logger.js";
import type { CanonicalTurnEvent } from "./wide-events.js";

const logger = createLogger("telemetry:meter");

const CONNECT_PROTOCOL_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 2_000;
const INGEST_WIDE_EVENT_PATH = "/meter.v1.MeterService/IngestWideEvent";
const MAESTRO_AGENT_ID = "maestro";
const MAESTRO_SURFACE = "maestro";

type RemoteMeterConfig = {
	baseUrl: string;
	organizationId: string;
	teamId?: string;
	timeoutMs: number;
	token: string;
};

function getEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function normalizeBaseUrl(value: string): string {
	let normalized = value.trim();
	for (const suffix of [
		"/meter.v1.MeterService/IngestWideEvent",
		"/meter.v1.MeterService/QueryWideEvents",
		"/meter.v1.MeterService/GetEventDashboard",
		"/meter.v1.MeterService",
	]) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length);
		}
	}
	return normalized.replace(/\/+$/, "");
}

function parseTimeoutMs(): number {
	const raw = getEnvValue(["MAESTRO_METER_TIMEOUT_MS"]);
	if (!raw) {
		return DEFAULT_TIMEOUT_MS;
	}
	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_TIMEOUT_MS;
	}
	return value;
}

function resolveOrganizationId(): string | undefined {
	const envOrgId = getEnvValue([
		"MAESTRO_METER_ORGANIZATION_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (envOrgId) {
		return envOrgId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

function resolveTeamId(): string | undefined {
	return getEnvValue([
		"MAESTRO_METER_TEAM_ID",
		"MAESTRO_EVALOPS_TEAM_ID",
		"MAESTRO_LLM_GATEWAY_TEAM_ID",
	]);
}

function hasStoredEvalopsToken(): boolean {
	const stored = loadOAuthCredentials("evalops")?.access;
	return typeof stored === "string" && stored.trim().length > 0;
}

function resolveConfiguredToken(): string | undefined {
	return (
		getEnvValue([
			"MAESTRO_METER_ACCESS_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]) ??
		(hasStoredEvalopsToken()
			? loadOAuthCredentials("evalops")?.access?.trim()
			: undefined)
	);
}

async function resolveRemoteMeterConfig(): Promise<RemoteMeterConfig | null> {
	const baseUrl = getEnvValue([
		"MAESTRO_METER_BASE",
		"MAESTRO_METER_SERVICE_URL",
	]);
	const organizationId = resolveOrganizationId();
	if (!baseUrl || !organizationId) {
		return null;
	}

	const token =
		getEnvValue([
			"MAESTRO_METER_ACCESS_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]) ?? (await getOAuthToken("evalops"));
	if (!token) {
		return null;
	}

	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		organizationId,
		teamId: resolveTeamId(),
		timeoutMs: parseTimeoutMs(),
		token,
	};
}

function buildHeaders(config: RemoteMeterConfig): Record<string, string> {
	return {
		Authorization: `Bearer ${config.token}`,
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		"Content-Type": "application/json",
		"X-Organization-ID": config.organizationId,
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
	]);
	return Boolean(
		baseUrl && resolveOrganizationId() && resolveConfiguredToken(),
	);
}

export async function mirrorCanonicalTurnEventToMeter(
	event: CanonicalTurnEvent,
): Promise<boolean> {
	const config = await resolveRemoteMeterConfig();
	if (!config) {
		return false;
	}

	try {
		const response = await fetch(`${config.baseUrl}${INGEST_WIDE_EVENT_PATH}`, {
			method: "POST",
			headers: buildHeaders(config),
			body: JSON.stringify({
				timestamp: event.timestamp,
				teamId: config.teamId,
				agentId: MAESTRO_AGENT_ID,
				surface: MAESTRO_SURFACE,
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
			}),
			signal: AbortSignal.timeout(config.timeoutMs),
		});
		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`meter service returned ${response.status}: ${text || response.statusText}`,
			);
		}
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
