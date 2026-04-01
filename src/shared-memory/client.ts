import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PATHS } from "../config/constants.js";
import {
	scanOutboundSensitiveContent,
	summarizeOutboundSensitiveFindings,
} from "../safety/outbound-secret-preflight.js";
import { createLogger } from "../utils/logger.js";
import { DEFAULT_CAPABILITIES, SHARED_MEMORY_CONFIG } from "./contract.js";

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

type SharedMemoryConfig = {
	baseUrl: string;
	apiKey?: string;
	sessionIdOverride?: string;
};

type SharedMemoryEvent = {
	type: string;
	payload?: JsonValue;
	tags?: string[];
	id?: string;
	actor?: string;
};

type SharedMemoryUpdate = {
	sessionId: string;
	state?: Record<string, JsonValue>;
	event?: SharedMemoryEvent;
};

type PendingSession = {
	sessionKey: string;
	state: Record<string, JsonValue> | null;
	events: SharedMemoryEvent[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	flushInFlight: boolean;
	blockedUntil: number | null;
	retryDelayMs: number;
	updatedAt: number;
};

type Capabilities = {
	supportsSync: boolean;
	supportsGzip: boolean;
	maxBodyBytes: number;
	maxEventsBatch: number;
	maxEventPayloadBytes: number;
	maxEventTypeLength: number;
	maxEventIdLength: number;
};

type QueueStatsSnapshot = {
	trimmed_states: number;
	trimmed_events: number;
	dropped_states: number;
	dropped_events: number;
	batch_splits: number;
	gzip_requests: number;
	last_sent_at: string;
	source: "maestro";
	instance_id: string;
};

const logger = createLogger("shared-memory");

// Configuration constants from shared contract (cast to number to avoid literal type issues)
const FLUSH_DELAY_MS: number = SHARED_MEMORY_CONFIG.FLUSH_DELAY_MS;
const REQUEST_TIMEOUT_MS: number = SHARED_MEMORY_CONFIG.REQUEST_TIMEOUT_MS;
const MAX_PENDING_EVENTS: number = SHARED_MEMORY_CONFIG.MAX_PENDING_EVENTS;
const MAX_BACKOFF_MS: number = SHARED_MEMORY_CONFIG.MAX_BACKOFF_MS;
const MIN_GZIP_BYTES = 1024;
const AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_EVENTS_PER_BATCH: number =
	SHARED_MEMORY_CONFIG.DEFAULT_EVENTS_PER_BATCH;
const TARGET_MAX_BODY_BYTES: number =
	SHARED_MEMORY_CONFIG.TARGET_MAX_BODY_BYTES;
const MAX_STRING_LENGTH: number = SHARED_MEMORY_CONFIG.MAX_STRING_LENGTH;
const MAX_ARRAY_LENGTH: number = SHARED_MEMORY_CONFIG.MAX_ARRAY_LENGTH;
const PERSIST_DEBOUNCE_MS: number = SHARED_MEMORY_CONFIG.PERSIST_DEBOUNCE_MS;
const PERSIST_TTL_MS: number = SHARED_MEMORY_CONFIG.PERSIST_TTL_MS;
const CAPABILITIES_TTL_MS: number = SHARED_MEMORY_CONFIG.CAPABILITIES_TTL_MS;

// Default capability values from shared contract
const DEFAULT_MAX_BODY_BYTES = DEFAULT_CAPABILITIES.maxBodyBytes;
const DEFAULT_EVENT_PAYLOAD_BYTES = DEFAULT_CAPABILITIES.maxEventPayloadBytes;
const DEFAULT_EVENT_TYPE_LENGTH = DEFAULT_CAPABILITIES.maxEventTypeLength;
const DEFAULT_EVENT_ID_LENGTH = DEFAULT_CAPABILITIES.maxEventIdLength;
const STATE_TRIM_KEYS = [
	"summary",
	"content",
	"preview",
	"text",
	"message",
	"body",
];
const REQUEST_ID_PREFIX = "maestro";
const instanceId = randomUUID();

const pendingBySession = new Map<string, PendingSession>();
let eventCounter = 0;
let requestCounter = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let missingConfigLogged = false;
let authFailureSignature: string | null = null;
let capabilitiesCache: { value: Capabilities; fetchedAt: number } | null = null;
let capabilitiesPromise: Promise<Capabilities> | null = null;
const queueStats = {
	trimmedStates: 0,
	trimmedEvents: 0,
	droppedStates: 0,
	droppedEvents: 0,
	batchSplits: 0,
	gzipRequests: 0,
	lastSentAt: null as string | null,
};

class SharedMemoryError extends Error {
	status?: number;
	retryAfterMs?: number;
	requestId?: string;

	constructor(
		message: string,
		status?: number,
		retryAfterMs?: number,
		requestId?: string,
	) {
		super(message);
		this.name = "SharedMemoryError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
		this.requestId = requestId;
	}
}

// Keep in sync with Conductor's shared-memory retry parsing.
function parseRateLimitResetMs(response: Response): number | null {
	const resetHeader =
		response.headers.get("RateLimit-Reset") ??
		response.headers.get("X-RateLimit-Reset");
	if (!resetHeader) return null;
	const resetValue = Number(resetHeader.trim());
	if (!Number.isFinite(resetValue)) return null;
	let delayMs: number;
	if (resetValue >= 10_000_000_000) {
		delayMs = resetValue - Date.now();
	} else if (resetValue >= 1_000_000_000) {
		delayMs = resetValue * 1000 - Date.now();
	} else {
		delayMs = resetValue * 1000;
	}
	return Math.max(0, delayMs);
}

function parseRetryAfterMs(response: Response): number | null {
	const retryAfter = response.headers.get("Retry-After")?.trim();
	if (retryAfter) {
		const asNumber = Number(retryAfter);
		if (Number.isFinite(asNumber)) {
			return Math.max(0, asNumber * 1000);
		}
		const asDate = Date.parse(retryAfter);
		if (!Number.isNaN(asDate)) {
			return Math.max(0, asDate - Date.now());
		}
	}
	return parseRateLimitResetMs(response);
}

function invalidateCapabilitiesCache(
	override?: Partial<Capabilities>,
): Capabilities {
	if (!override) {
		capabilitiesCache = null;
		capabilitiesPromise = null;
		return {
			supportsSync: true,
			supportsGzip: true,
			maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
			maxEventsBatch: DEFAULT_EVENTS_PER_BATCH,
			maxEventPayloadBytes: DEFAULT_EVENT_PAYLOAD_BYTES,
			maxEventTypeLength: DEFAULT_EVENT_TYPE_LENGTH,
			maxEventIdLength: DEFAULT_EVENT_ID_LENGTH,
		};
	}
	const base = capabilitiesCache?.value ?? {
		supportsSync: true,
		supportsGzip: true,
		maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
		maxEventsBatch: DEFAULT_EVENTS_PER_BATCH,
		maxEventPayloadBytes: DEFAULT_EVENT_PAYLOAD_BYTES,
		maxEventTypeLength: DEFAULT_EVENT_TYPE_LENGTH,
		maxEventIdLength: DEFAULT_EVENT_ID_LENGTH,
	};
	const value = { ...base, ...override };
	capabilitiesCache = { value, fetchedAt: Date.now() };
	capabilitiesPromise = null;
	return value;
}

function isUnsupportedEncoding(error: SharedMemoryError): boolean {
	if (error.status === 415) return true;
	return error.message.toLowerCase().includes("unsupported content-encoding");
}

function authSignature(config: SharedMemoryConfig): string {
	const keyLength = config.apiKey ? config.apiKey.length : 0;
	return `${config.baseUrl}|${config.sessionIdOverride ?? ""}|${keyLength}`;
}

function logAuthFailureOnce(
	config: SharedMemoryConfig,
	error: SharedMemoryError,
): void {
	const signature = authSignature(config);
	if (authFailureSignature === signature) return;
	authFailureSignature = signature;
	logger.warn("Shared memory auth failed; backing off", {
		status: error.status,
		requestId: error.requestId,
	});
}

function classifyError(error: unknown): "retriable" | "auth" | "drop" {
	if (!(error instanceof SharedMemoryError)) return "retriable";
	if (error.status === 401 || error.status === 403) return "auth";
	if (error.status === undefined) return "retriable";
	if (error.status >= 500 || error.status === 408 || error.status === 429) {
		return "retriable";
	}
	return "drop";
}

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

function readConfig(): SharedMemoryConfig | null {
	const base = process.env.MAESTRO_SHARED_MEMORY_BASE?.trim();
	if (!base) return null;
	const apiKey = process.env.MAESTRO_SHARED_MEMORY_API_KEY?.trim();
	const override = process.env.MAESTRO_SHARED_MEMORY_SESSION_ID?.trim();
	return {
		baseUrl: normalizeBaseUrl(base),
		apiKey: apiKey || undefined,
		sessionIdOverride: override || undefined,
	};
}

function nextRequestId(prefix: string): string {
	try {
		return `${prefix}-${randomUUID()}`;
	} catch {
		requestCounter = (requestCounter + 1) % 1_000_000;
		return `${prefix}-${Date.now()}-${requestCounter}`;
	}
}

function buildHeaders(apiKey?: string, requestId?: string): Headers {
	const headers = new Headers({
		"Content-Type": "application/json; charset=utf-8",
	});
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	if (requestId) headers.set("X-Request-Id", requestId);
	return headers;
}

async function safeFetch(url: string, init: RequestInit): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			const message = await response.text().catch(() => "");
			const retryAfterMs = parseRetryAfterMs(response);
			const requestId = response.headers.get("x-request-id") ?? undefined;
			throw new SharedMemoryError(
				message
					? `Shared memory error: ${response.status} ${message}`
					: `Shared memory error: ${response.status}`,
				response.status,
				retryAfterMs ?? undefined,
				requestId ?? undefined,
			);
		}
	} finally {
		clearTimeout(timeout);
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value);
}

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function shrinkValue(value: unknown): unknown {
	if (typeof value === "string") {
		return truncateString(value, MAX_STRING_LENGTH);
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_ARRAY_LENGTH) {
			return value.slice(0, MAX_ARRAY_LENGTH).map(shrinkValue);
		}
		return value.map(shrinkValue);
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(record)) {
			out[key] = shrinkValue(entry);
		}
		return out;
	}
	return value;
}

function dropKeys(value: unknown, keys: string[], maxBytes: number): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const record = { ...(value as Record<string, unknown>) };
	for (const key of keys) {
		if (key in record) {
			delete record[key];
			const size = byteLength(JSON.stringify(record));
			if (size <= maxBytes) {
				return record;
			}
		}
	}
	return record;
}

function fitJsonToBytes(
	value: unknown,
	maxBytes: number,
	dropList: string[],
): { value: unknown; trimmed: boolean } {
	const shrunk = shrinkValue(value);
	let serialized = JSON.stringify(shrunk);
	if (byteLength(serialized) <= maxBytes)
		return { value: shrunk, trimmed: false };
	const dropped = dropKeys(shrunk, dropList, maxBytes);
	serialized = JSON.stringify(dropped);
	if (byteLength(serialized) <= maxBytes)
		return { value: dropped, trimmed: true };
	if (Array.isArray(dropped)) {
		let trimmed = dropped.slice(0, Math.max(1, Math.floor(dropped.length / 2)));
		while (
			trimmed.length > 1 &&
			byteLength(JSON.stringify(trimmed)) > maxBytes
		) {
			trimmed = trimmed.slice(0, Math.max(1, Math.floor(trimmed.length / 2)));
		}
		return { value: trimmed, trimmed: true };
	}
	return { value: {}, trimmed: true };
}

function currentEventPayloadLimit(): number {
	const max =
		capabilitiesCache?.value?.maxEventPayloadBytes ??
		DEFAULT_EVENT_PAYLOAD_BYTES;
	return Math.min(max, TARGET_MAX_BODY_BYTES);
}

function normalizeEventType(eventType: string): string | null {
	const trimmed = eventType.trim();
	if (!trimmed) return null;
	const max =
		capabilitiesCache?.value?.maxEventTypeLength ?? DEFAULT_EVENT_TYPE_LENGTH;
	if (trimmed.length > max) return null;
	return trimmed;
}

function clampEventId(prefix: string, suffix: string): string {
	const max =
		capabilitiesCache?.value?.maxEventIdLength ?? DEFAULT_EVENT_ID_LENGTH;
	if (max <= 0) {
		return "";
	}
	if (suffix.length >= max) {
		return suffix.slice(0, max);
	}
	if (prefix.length + suffix.length + 1 <= max) {
		return `${prefix}-${suffix}`;
	}
	const prefixMax = Math.max(0, max - suffix.length - 1);
	const clippedPrefix = prefix.slice(0, prefixMax);
	if (!clippedPrefix) {
		return suffix;
	}
	return `${clippedPrefix}-${suffix}`;
}

async function getCapabilities(
	config: SharedMemoryConfig,
): Promise<Capabilities> {
	const cachedAt = capabilitiesCache?.fetchedAt ?? 0;
	if (capabilitiesCache && Date.now() - cachedAt < CAPABILITIES_TTL_MS) {
		return capabilitiesCache.value;
	}
	if (capabilitiesPromise) return capabilitiesPromise;
	const fallback: Capabilities = {
		supportsSync: true,
		supportsGzip: true,
		maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
		maxEventsBatch: DEFAULT_EVENTS_PER_BATCH,
		maxEventPayloadBytes: DEFAULT_EVENT_PAYLOAD_BYTES,
		maxEventTypeLength: DEFAULT_EVENT_TYPE_LENGTH,
		maxEventIdLength: DEFAULT_EVENT_ID_LENGTH,
	};

	capabilitiesPromise = (async () => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${config.baseUrl}/capabilities`, {
				method: "GET",
				headers: buildHeaders(config.apiKey, nextRequestId(REQUEST_ID_PREFIX)),
				signal: controller.signal,
			});
			if (!response.ok) {
				if (response.status === 404 || response.status === 405) {
					return { ...fallback, supportsSync: false };
				}
				return fallback;
			}
			const data = (await response.json()) as Partial<{
				supports_sync: boolean;
				supports_gzip: boolean;
				max_body_bytes: number;
				max_events_batch: number;
				max_event_payload_bytes: number;
				max_event_type_length: number;
				max_event_id_length: number;
			}>;
			const supportsSync = data.supports_sync !== false;
			const supportsGzip = data.supports_gzip !== false;
			const maxBodyBytes =
				typeof data.max_body_bytes === "number"
					? data.max_body_bytes
					: DEFAULT_MAX_BODY_BYTES;
			const maxEventsBatch =
				typeof data.max_events_batch === "number"
					? data.max_events_batch
					: DEFAULT_EVENTS_PER_BATCH;
			const maxEventPayloadBytes =
				typeof data.max_event_payload_bytes === "number"
					? data.max_event_payload_bytes
					: DEFAULT_EVENT_PAYLOAD_BYTES;
			const maxEventTypeLength =
				typeof data.max_event_type_length === "number"
					? data.max_event_type_length
					: DEFAULT_EVENT_TYPE_LENGTH;
			const maxEventIdLength =
				typeof data.max_event_id_length === "number"
					? data.max_event_id_length
					: DEFAULT_EVENT_ID_LENGTH;
			return {
				supportsSync,
				supportsGzip,
				maxBodyBytes,
				maxEventsBatch,
				maxEventPayloadBytes,
				maxEventTypeLength,
				maxEventIdLength,
			};
		} catch {
			return fallback;
		} finally {
			clearTimeout(timeout);
		}
	})();

	const value = await capabilitiesPromise;
	capabilitiesCache = { value, fetchedAt: Date.now() };
	capabilitiesPromise = null;
	return value;
}

function schedulePersist(): void {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistQueue();
	}, PERSIST_DEBOUNCE_MS);
}

function getQueueFilePath(): string {
	return join(PATHS.MAESTRO_HOME, "shared-memory-queue.json");
}

async function persistQueue(): Promise<void> {
	try {
		const path = getQueueFilePath();
		if (!pendingBySession.size) {
			if (existsSync(path)) {
				await writeFile(path, "");
			}
			return;
		}
		const sessions: Record<
			string,
			{
				state: Record<string, JsonValue> | null;
				events: SharedMemoryEvent[];
				blockedUntil: number | null;
				updatedAt: number;
			}
		> = {};
		for (const [key, pending] of pendingBySession) {
			sessions[key] = {
				state: pending.state,
				events: pending.events,
				blockedUntil: pending.blockedUntil,
				updatedAt: pending.updatedAt,
			};
		}
		const payload = {
			version: 1,
			updatedAt: Date.now(),
			sessions,
			stats: queueStats,
		};
		await mkdir(PATHS.MAESTRO_HOME, { recursive: true });
		const tmp = `${path}.tmp`;
		await writeFile(tmp, JSON.stringify(payload), "utf8");
		await rename(tmp, path);
	} catch {
		// ignore persistence failures
	}
}

function loadPersistedQueue(): void {
	try {
		const path = getQueueFilePath();
		if (!existsSync(path)) return;
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return;
		const parsed = JSON.parse(raw) as {
			version?: number;
			updatedAt?: number;
			sessions?: Record<
				string,
				{
					state: Record<string, JsonValue> | null;
					events: SharedMemoryEvent[];
					blockedUntil?: number | null;
					updatedAt?: number;
				}
			>;
			stats?: Partial<typeof queueStats>;
		};
		if (parsed.stats) {
			queueStats.trimmedStates =
				parsed.stats.trimmedStates ?? queueStats.trimmedStates;
			queueStats.trimmedEvents =
				parsed.stats.trimmedEvents ?? queueStats.trimmedEvents;
			queueStats.droppedStates =
				parsed.stats.droppedStates ?? queueStats.droppedStates;
			queueStats.droppedEvents =
				parsed.stats.droppedEvents ?? queueStats.droppedEvents;
			queueStats.batchSplits =
				parsed.stats.batchSplits ?? queueStats.batchSplits;
			queueStats.gzipRequests =
				parsed.stats.gzipRequests ?? queueStats.gzipRequests;
			queueStats.lastSentAt = parsed.stats.lastSentAt ?? queueStats.lastSentAt;
		}
		const sessions = parsed.sessions ?? {};
		const cutoff = Date.now() - PERSIST_TTL_MS;
		for (const [sessionKey, entry] of Object.entries(sessions)) {
			const updatedAt = entry.updatedAt ?? parsed.updatedAt ?? Date.now();
			if (updatedAt < cutoff) continue;
			const pending = getPendingSession(sessionKey);
			pending.state = entry.state ?? null;
			pending.events = entry.events ?? [];
			const blockedUntil =
				typeof entry.blockedUntil === "number" ? entry.blockedUntil : null;
			pending.blockedUntil =
				blockedUntil && blockedUntil > Date.now() ? blockedUntil : null;
			pending.updatedAt = updatedAt;
			scheduleFlush(pending);
		}
	} catch {
		// ignore malformed cache
	}
}

function normalizeEvent(event: SharedMemoryEvent): SharedMemoryEvent {
	return {
		...event,
		actor: event.actor ?? "maestro",
	};
}

function buildStatsSnapshot(): QueueStatsSnapshot {
	const sentAt = new Date().toISOString();
	queueStats.lastSentAt = sentAt;
	return {
		trimmed_states: queueStats.trimmedStates,
		trimmed_events: queueStats.trimmedEvents,
		dropped_states: queueStats.droppedStates,
		dropped_events: queueStats.droppedEvents,
		batch_splits: queueStats.batchSplits,
		gzip_requests: queueStats.gzipRequests,
		last_sent_at: sentAt,
		source: "maestro",
		instance_id: instanceId,
	};
}

async function trySync(
	config: SharedMemoryConfig,
	sessionId: string,
	state: Record<string, JsonValue> | null,
	events: SharedMemoryEvent[],
	capabilities: Capabilities,
	stats?: QueueStatsSnapshot,
): Promise<void> {
	const payload: Record<string, JsonValue> = {};
	if (state) {
		payload.state = { maestro: state } as JsonValue;
	}
	if (events.length) {
		payload.events = events as JsonValue;
	}
	if (stats) {
		payload.stats = stats as JsonValue;
	}
	const requestId = nextRequestId(REQUEST_ID_PREFIX);
	const { body, headers } = prepareRequestBody(
		payload,
		Math.min(capabilities.maxBodyBytes, TARGET_MAX_BODY_BYTES),
		capabilities.supportsGzip,
		config.apiKey,
		requestId,
	);
	await safeFetch(
		`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/sync`,
		{
			method: "PATCH",
			headers,
			body,
		},
	);
}

async function fallbackSync(
	config: SharedMemoryConfig,
	sessionId: string,
	state: Record<string, JsonValue> | null,
	events: SharedMemoryEvent[],
	supportsGzip: boolean,
): Promise<void> {
	if (state) {
		try {
			const requestId = nextRequestId(REQUEST_ID_PREFIX);
			const { body, headers } = prepareRequestBody(
				{ state: { maestro: state } },
				TARGET_MAX_BODY_BYTES,
				supportsGzip,
				config.apiKey,
				requestId,
			);
			await safeFetch(
				`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/state`,
				{
					method: "PATCH",
					headers,
					body,
				},
			);
		} catch (error) {
			if (error instanceof SharedMemoryError && error.status === 413) {
				logger.debug("Dropped oversized shared memory state payload");
			} else {
				throw error;
			}
		}
	}
	for (const event of events) {
		try {
			const requestId = nextRequestId(REQUEST_ID_PREFIX);
			const { body, headers } = prepareRequestBody(
				event as Record<string, JsonValue>,
				TARGET_MAX_BODY_BYTES,
				supportsGzip,
				config.apiKey,
				requestId,
			);
			await safeFetch(
				`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`,
				{
					method: "POST",
					headers,
					body,
				},
			);
		} catch (error) {
			if (error instanceof SharedMemoryError && error.status === 413) {
				logger.debug("Dropped oversized shared memory event", {
					type: event.type,
				});
			} else {
				throw error;
			}
		}
	}
}

async function sendSyncBatch(
	config: SharedMemoryConfig,
	sessionId: string,
	state: Record<string, JsonValue> | null,
	events: SharedMemoryEvent[],
	capabilities: Capabilities,
	stats?: QueueStatsSnapshot,
): Promise<void> {
	if (!state && events.length === 0) return;
	try {
		if (capabilities.supportsSync) {
			await trySync(config, sessionId, state, events, capabilities, stats);
			return;
		}
		await fallbackSync(
			config,
			sessionId,
			state,
			events,
			capabilities.supportsGzip,
		);
		return;
	} catch (error) {
		if (error instanceof SharedMemoryError) {
			if (isUnsupportedEncoding(error) && capabilities.supportsGzip) {
				const updated = invalidateCapabilitiesCache({ supportsGzip: false });
				await sendSyncBatch(config, sessionId, state, events, updated, stats);
				return;
			}
			if (error.status === 404 || error.status === 405) {
				invalidateCapabilitiesCache({ supportsSync: false });
				await fallbackSync(
					config,
					sessionId,
					state,
					events,
					capabilities.supportsGzip,
				);
				return;
			}
			if (error.status === 413) {
				if (state && events.length > 0) {
					queueStats.batchSplits += 1;
					await sendSyncBatch(
						config,
						sessionId,
						state,
						[],
						capabilities,
						stats,
					);
					await sendSyncBatch(config, sessionId, null, events, capabilities);
					return;
				}
				if (events.length > 1) {
					const mid = Math.ceil(events.length / 2);
					queueStats.batchSplits += 1;
					await sendSyncBatch(
						config,
						sessionId,
						state,
						events.slice(0, mid),
						capabilities,
						stats,
					);
					await sendSyncBatch(
						config,
						sessionId,
						null,
						events.slice(mid),
						capabilities,
					);
					return;
				}
				if (events.length === 1) {
					const [firstEvent] = events;
					if (firstEvent) {
						queueStats.droppedEvents += 1;
						logger.debug("Dropped oversized shared memory event", {
							type: firstEvent.type,
						});
					}
					return;
				}
				if (state) {
					queueStats.droppedStates += 1;
					logger.debug("Dropped oversized shared memory state payload");
					return;
				}
			}
		}
		throw error;
	}
}

async function sendSyncBatches(
	config: SharedMemoryConfig,
	sessionId: string,
	state: Record<string, JsonValue> | null,
	events: SharedMemoryEvent[],
	capabilities: Capabilities,
): Promise<void> {
	if (!state && events.length === 0) return;
	const normalizedEvents = events.map(normalizeEvent);
	if (!normalizedEvents.length) {
		await sendSyncBatch(
			config,
			sessionId,
			state,
			[],
			capabilities,
			buildStatsSnapshot(),
		);
		return;
	}

	let stats: QueueStatsSnapshot | undefined = buildStatsSnapshot();
	let includeState = state;
	const maxEventsPerBatch = Math.max(
		1,
		Math.min(DEFAULT_EVENTS_PER_BATCH, capabilities.maxEventsBatch),
	);
	for (let i = 0; i < normalizedEvents.length; i += maxEventsPerBatch) {
		const batch = normalizedEvents.slice(i, i + maxEventsPerBatch);
		await sendSyncBatch(
			config,
			sessionId,
			includeState,
			batch,
			capabilities,
			stats,
		);
		stats = undefined;
		includeState = null;
	}
}

function nextEventId(prefix: string): string {
	eventCounter = (eventCounter + 1) % 1_000_000;
	const suffix = `${Date.now()}-${eventCounter}`;
	return clampEventId(prefix, suffix);
}

function resolveRetryDelayMs(pending: PendingSession, error?: unknown): number {
	if (error instanceof SharedMemoryError) {
		const retryAfterMs = error.retryAfterMs;
		if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
			return Math.min(MAX_BACKOFF_MS, Math.max(FLUSH_DELAY_MS, retryAfterMs));
		}
	}
	return Math.min(
		MAX_BACKOFF_MS,
		Math.max(FLUSH_DELAY_MS, pending.retryDelayMs * 2),
	);
}

function getPendingSession(sessionKey: string): PendingSession {
	const existing = pendingBySession.get(sessionKey);
	if (existing) return existing;
	const pending: PendingSession = {
		sessionKey,
		state: null,
		events: [],
		flushTimer: null,
		flushInFlight: false,
		blockedUntil: null,
		retryDelayMs: FLUSH_DELAY_MS,
		updatedAt: Date.now(),
	};
	pendingBySession.set(sessionKey, pending);
	return pending;
}

function scheduleFlush(
	pending: PendingSession,
	delayMs = FLUSH_DELAY_MS,
): void {
	if (pending.flushTimer) return;
	const now = Date.now();
	const blockedDelay =
		pending.blockedUntil && pending.blockedUntil > now
			? pending.blockedUntil - now
			: 0;
	const actualDelay = Math.max(delayMs, blockedDelay);
	pending.flushTimer = setTimeout(() => {
		pending.flushTimer = null;
		void flushSession(pending);
	}, actualDelay);
}

function requeueState(
	pending: PendingSession,
	state: Record<string, JsonValue>,
): void {
	const mergedState = { ...state, ...(pending.state ?? {}) };
	const fittedState = fitJsonToBytes(
		mergedState,
		TARGET_MAX_BODY_BYTES,
		STATE_TRIM_KEYS,
	);
	if (fittedState.trimmed) {
		queueStats.trimmedStates += 1;
	}
	if (
		fittedState.value &&
		typeof fittedState.value === "object" &&
		!Array.isArray(fittedState.value)
	) {
		pending.state = fittedState.value as Record<string, JsonValue>;
	} else {
		pending.state = state;
	}
}

function requeueEvents(
	pending: PendingSession,
	events: SharedMemoryEvent[],
): void {
	pending.events = events.concat(pending.events).slice(-MAX_PENDING_EVENTS);
}

async function flushSession(pending: PendingSession): Promise<void> {
	if (pending.flushInFlight) {
		scheduleFlush(pending);
		return;
	}
	const now = Date.now();
	if (pending.blockedUntil && pending.blockedUntil > now) {
		scheduleFlush(pending, pending.blockedUntil - now);
		return;
	}
	pending.blockedUntil = null;
	if (!pending.state && pending.events.length === 0) {
		pendingBySession.delete(pending.sessionKey);
		return;
	}

	const config = readConfig();
	if (!config) {
		pending.retryDelayMs = Math.min(
			MAX_BACKOFF_MS,
			Math.max(FLUSH_DELAY_MS, pending.retryDelayMs * 2),
		);
		const jitter = Math.floor(Math.random() * 100);
		scheduleFlush(pending, pending.retryDelayMs + jitter);
		return;
	}

	pending.flushInFlight = true;
	const state = pending.state;
	const events = pending.events.slice();
	pending.state = null;
	pending.events = [];

	try {
		const capabilities = await getCapabilities(config);
		await sendSyncBatches(
			config,
			pending.sessionKey,
			state,
			events,
			capabilities,
		);
		pending.retryDelayMs = FLUSH_DELAY_MS;
		pending.updatedAt = Date.now();
		schedulePersist();
	} catch (error) {
		const classification = classifyError(error);
		if (classification === "auth") {
			if (state) requeueState(pending, state);
			if (events.length) requeueEvents(pending, events);
			pending.retryDelayMs = AUTH_FAILURE_COOLDOWN_MS;
			pending.blockedUntil = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
			pending.updatedAt = Date.now();
			if (error instanceof SharedMemoryError) {
				logAuthFailureOnce(config, error);
			}
			schedulePersist();
		} else if (classification === "drop") {
			if (state) queueStats.droppedStates += 1;
			if (events.length) queueStats.droppedEvents += events.length;
			pending.retryDelayMs = FLUSH_DELAY_MS;
			pending.blockedUntil = null;
			pending.updatedAt = Date.now();
			schedulePersist();
			logger.warn("Dropped shared memory update after non-retriable error", {
				error,
			});
		} else {
			if (state) requeueState(pending, state);
			if (events.length) requeueEvents(pending, events);
			pending.retryDelayMs = resolveRetryDelayMs(pending, error);
			pending.updatedAt = Date.now();
			schedulePersist();
			logger.debug("Shared memory update failed", { error });
		}
	} finally {
		pending.flushInFlight = false;
		if (pending.state || pending.events.length) {
			const jitter = Math.floor(Math.random() * 100);
			scheduleFlush(pending, pending.retryDelayMs + jitter);
		} else {
			pendingBySession.delete(pending.sessionKey);
			schedulePersist();
		}
	}
}

export function queueSharedMemoryUpdate(update: SharedMemoryUpdate): void {
	const config = readConfig();
	if (!config) {
		if (!missingConfigLogged) {
			missingConfigLogged = true;
			logger.debug("Shared memory update skipped: missing config");
		}
		authFailureSignature = null;
		return;
	}
	missingConfigLogged = false;
	const sessionKey = config.sessionIdOverride ?? update.sessionId;
	const pending = getPendingSession(sessionKey);

	if (update.state) {
		const scan = scanOutboundSensitiveContent(update.state);
		if (scan.blockingFindings.length > 0) {
			queueStats.droppedStates += 1;
			logger.warn("Blocked shared memory state containing sensitive content", {
				sessionId: sessionKey,
				findings: summarizeOutboundSensitiveFindings(scan.blockingFindings),
			});
		} else {
			const mergedState = {
				...(pending.state ?? {}),
				...update.state,
				instanceId,
				source: "maestro",
			};
			const fitted = fitJsonToBytes(
				mergedState,
				TARGET_MAX_BODY_BYTES,
				STATE_TRIM_KEYS,
			);
			if (fitted.trimmed) {
				queueStats.trimmedStates += 1;
			}
			if (
				fitted.value &&
				typeof fitted.value === "object" &&
				!Array.isArray(fitted.value)
			) {
				pending.state = fitted.value as Record<string, JsonValue>;
			} else {
				pending.state = {
					...(pending.state ?? {}),
					instanceId,
					source: "maestro",
				};
			}
			pending.updatedAt = Date.now();
		}
	}
	if (update.event) {
		const scan = scanOutboundSensitiveContent(update.event.payload ?? null);
		if (scan.blockingFindings.length > 0) {
			queueStats.droppedEvents += 1;
			pending.updatedAt = Date.now();
			scheduleFlush(pending);
			schedulePersist();
			logger.warn("Blocked shared memory event containing sensitive content", {
				sessionId: sessionKey,
				type: update.event.type,
				findings: summarizeOutboundSensitiveFindings(scan.blockingFindings),
			});
			return;
		}
		const normalizedType = normalizeEventType(update.event.type);
		if (!normalizedType) {
			queueStats.droppedEvents += 1;
			pending.updatedAt = Date.now();
			scheduleFlush(pending);
			schedulePersist();
			logger.debug("Dropped shared memory event with invalid type", {
				type: update.event.type,
			});
			return;
		}
		const payload: Record<string, JsonValue> =
			update.event.payload &&
			typeof update.event.payload === "object" &&
			!Array.isArray(update.event.payload)
				? {
						...(update.event.payload as Record<string, JsonValue>),
						instanceId,
						source: "maestro",
					}
				: {
						instanceId,
						source: "maestro",
						value: update.event.payload ?? null,
					};
		const fittedPayload = fitJsonToBytes(payload, currentEventPayloadLimit(), [
			"summary",
			"content",
			"preview",
			"text",
			"message",
			"body",
			"markdown",
			"html",
		]);
		if (fittedPayload.trimmed) {
			queueStats.trimmedEvents += 1;
		}
		pending.events.push({
			...update.event,
			type: normalizedType,
			payload: fittedPayload.value as JsonValue,
			id: update.event.id ?? nextEventId(`maestro-${sessionKey}`),
		});
		if (pending.events.length > MAX_PENDING_EVENTS) {
			pending.events = pending.events.slice(-MAX_PENDING_EVENTS);
		}
		pending.updatedAt = Date.now();
	}

	scheduleFlush(pending);
	schedulePersist();
}

function prepareRequestBody(
	payload: Record<string, JsonValue>,
	maxBytes: number,
	supportsGzip: boolean,
	apiKey?: string,
	requestId?: string,
): { body: Buffer | string; headers: Headers } {
	const shrunk = shrinkValue(payload) as Record<string, JsonValue>;
	let candidate = shrunk;
	let json = JSON.stringify(candidate);
	if (byteLength(json) > maxBytes && "stats" in candidate) {
		const { stats: _stats, ...rest } = candidate;
		const withoutStats = rest as Record<string, JsonValue>;
		const withoutStatsJson = JSON.stringify(withoutStats);
		if (byteLength(withoutStatsJson) <= maxBytes) {
			candidate = withoutStats;
			json = withoutStatsJson;
		}
	}
	const headers = buildHeaders(apiKey, requestId);
	if (!supportsGzip || byteLength(json) < MIN_GZIP_BYTES) {
		return { body: json, headers };
	}
	try {
		const zipped = gzipSync(Buffer.from(json));
		headers.set("Content-Encoding", "gzip");
		queueStats.gzipRequests += 1;
		return { body: zipped, headers };
	} catch {
		return { body: json, headers };
	}
}

loadPersistedQueue();

export function invalidateSharedMemoryCapabilities(): void {
	invalidateCapabilitiesCache();
}
