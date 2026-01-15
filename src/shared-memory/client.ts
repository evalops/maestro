import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PATHS } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";

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
	source: "composer";
	instance_id: string;
};

const logger = createLogger("shared-memory");
const FLUSH_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PENDING_EVENTS = 50;
const MAX_BACKOFF_MS = 5000;
const DEFAULT_EVENTS_PER_BATCH = 25;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const TARGET_MAX_BODY_BYTES = 220 * 1024;
const DEFAULT_EVENT_PAYLOAD_BYTES = 32 * 1024;
const DEFAULT_EVENT_TYPE_LENGTH = 128;
const DEFAULT_EVENT_ID_LENGTH = 128;
const MAX_STRING_LENGTH = 4000;
const MAX_ARRAY_LENGTH = 50;
const PERSIST_DEBOUNCE_MS = 300;
const PERSIST_TTL_MS = 24 * 60 * 60 * 1000;
const CAPABILITIES_TTL_MS = 5 * 60 * 1000;
const REQUEST_ID_PREFIX = "composer";
const instanceId = randomUUID();

const pendingBySession = new Map<string, PendingSession>();
let eventCounter = 0;
let requestCounter = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
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

	constructor(message: string, status?: number) {
		super(message);
		this.name = "SharedMemoryError";
		this.status = status;
	}
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

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

function readConfig(): SharedMemoryConfig | null {
	const base = process.env.COMPOSER_SHARED_MEMORY_BASE?.trim();
	if (!base) return null;
	const apiKey = process.env.COMPOSER_SHARED_MEMORY_API_KEY?.trim();
	const override = process.env.COMPOSER_SHARED_MEMORY_SESSION_ID?.trim();
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
			throw new SharedMemoryError(
				message
					? `Shared memory error: ${response.status} ${message}`
					: `Shared memory error: ${response.status}`,
				response.status,
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
	if (prefix.length + suffix.length + 1 <= max) {
		return `${prefix}-${suffix}`;
	}
	const prefixMax = Math.max(0, max - suffix.length - 1);
	return `${prefix.slice(0, prefixMax)}-${suffix}`;
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
	return join(PATHS.COMPOSER_HOME, "shared-memory-queue.json");
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
				updatedAt: number;
			}
		> = {};
		for (const [key, pending] of pendingBySession) {
			sessions[key] = {
				state: pending.state,
				events: pending.events,
				updatedAt: pending.updatedAt,
			};
		}
		const payload = {
			version: 1,
			updatedAt: Date.now(),
			sessions,
			stats: queueStats,
		};
		await mkdir(PATHS.COMPOSER_HOME, { recursive: true });
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
		actor: event.actor ?? "composer",
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
		source: "composer",
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
		payload.state = { composer: state } as JsonValue;
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
				{ state: { composer: state } },
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

function getPendingSession(sessionKey: string): PendingSession {
	const existing = pendingBySession.get(sessionKey);
	if (existing) return existing;
	const pending: PendingSession = {
		sessionKey,
		state: null,
		events: [],
		flushTimer: null,
		flushInFlight: false,
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
	pending.flushTimer = setTimeout(() => {
		pending.flushTimer = null;
		void flushSession(pending);
	}, delayMs);
}

async function flushSession(pending: PendingSession): Promise<void> {
	if (pending.flushInFlight) {
		scheduleFlush(pending);
		return;
	}
	if (!pending.state && pending.events.length === 0) {
		pendingBySession.delete(pending.sessionKey);
		return;
	}

	pending.flushInFlight = true;
	const state = pending.state;
	const events = pending.events.slice();
	pending.state = null;
	pending.events = [];

	const config = readConfig();
	if (!config) {
		pending.flushInFlight = false;
		return;
	}

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
		if (state && !pending.state) {
			pending.state = state;
		}
		if (events.length) {
			pending.events = events.concat(pending.events).slice(-MAX_PENDING_EVENTS);
		}
		pending.retryDelayMs = Math.min(
			MAX_BACKOFF_MS,
			Math.max(FLUSH_DELAY_MS, pending.retryDelayMs * 2),
		);
		pending.updatedAt = Date.now();
		schedulePersist();
		logger.debug("Shared memory update failed", { error });
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
	if (!config) return;
	const sessionKey = config.sessionIdOverride ?? update.sessionId;
	const pending = getPendingSession(sessionKey);

	if (update.state) {
		const fitted = fitJsonToBytes(
			{ ...update.state, instanceId, source: "composer" },
			TARGET_MAX_BODY_BYTES,
			["summary", "content", "preview", "text", "message", "body"],
		);
		if (fitted.trimmed) {
			queueStats.trimmedStates += 1;
		}
		if (!fitted.value || typeof fitted.value !== "object") {
			pending.state = { instanceId, source: "composer" };
		} else {
			pending.state = fitted.value as Record<string, JsonValue>;
		}
		pending.updatedAt = Date.now();
	}
	if (update.event) {
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
						source: "composer",
					}
				: {
						instanceId,
						source: "composer",
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
			id: update.event.id ?? nextEventId(`composer-${update.sessionId}`),
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
	const trimmed = fitJsonToBytes(payload, maxBytes, ["events", "state"]).value;
	const json = JSON.stringify(trimmed);
	const headers = buildHeaders(apiKey, requestId);
	if (!supportsGzip) {
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
