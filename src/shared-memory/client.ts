import { randomUUID } from "node:crypto";
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

const logger = createLogger("shared-memory");
const FLUSH_DELAY_MS = 150;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_PENDING_EVENTS = 50;
const MAX_BACKOFF_MS = 5000;
const instanceId = randomUUID();

let pendingSessionKey: string | null = null;
let pendingState: Record<string, JsonValue> | null = null;
let pendingEvents: SharedMemoryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
let eventCounter = 0;
let retryDelayMs = FLUSH_DELAY_MS;

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

function buildHeaders(apiKey?: string): Headers {
	const headers = new Headers({
		"Content-Type": "application/json; charset=utf-8",
	});
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	return headers;
}

async function safeFetch(url: string, init: RequestInit): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			const message = await response.text().catch(() => "");
			throw new Error(
				message
					? `Shared memory error: ${response.status} ${message}`
					: `Shared memory error: ${response.status}`,
			);
		}
	} finally {
		clearTimeout(timeout);
	}
}

async function syncSession(
	config: SharedMemoryConfig,
	sessionId: string,
	state: Record<string, JsonValue> | null,
	events: SharedMemoryEvent[],
): Promise<void> {
	const payload: Record<string, JsonValue> = {};
	if (state) {
		payload.state = { composer: state } as JsonValue;
	}
	if (events.length) {
		payload.events = events.map((event) => ({
			...event,
			actor: event.actor ?? "composer",
		})) as JsonValue;
	}
	await safeFetch(
		`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/sync`,
		{
			method: "PATCH",
			headers: buildHeaders(config.apiKey),
			body: JSON.stringify(payload),
		},
	);
}

function nextEventId(prefix: string): string {
	eventCounter = (eventCounter + 1) % 1_000_000;
	return `${prefix}-${Date.now()}-${eventCounter}`;
}

function scheduleFlush(delayMs = FLUSH_DELAY_MS): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushQueue();
	}, delayMs);
}

async function flushQueue(): Promise<void> {
	if (flushInFlight) {
		scheduleFlush();
		return;
	}
	if (!pendingSessionKey) return;
	flushInFlight = true;

	const sessionKey = pendingSessionKey;
	const state = pendingState;
	const events = pendingEvents;

	pendingSessionKey = null;
	pendingState = null;
	pendingEvents = [];

	const config = readConfig();
	if (!config) {
		flushInFlight = false;
		return;
	}

	try {
		if (state || events.length) {
			await syncSession(config, sessionKey, state, events);
		}
		retryDelayMs = FLUSH_DELAY_MS;
	} catch (error) {
		if (state) {
			pendingState = state;
		}
		if (events.length) {
			pendingEvents = events.concat(pendingEvents).slice(-MAX_PENDING_EVENTS);
		}
		retryDelayMs = Math.min(
			MAX_BACKOFF_MS,
			Math.max(FLUSH_DELAY_MS, retryDelayMs * 2),
		);
		logger.debug("Shared memory update failed", { error });
	} finally {
		flushInFlight = false;
		if (pendingState || pendingEvents.length) {
			const jitter = Math.floor(Math.random() * 100);
			scheduleFlush(retryDelayMs + jitter);
		}
	}
}

export function queueSharedMemoryUpdate(update: SharedMemoryUpdate): void {
	const config = readConfig();
	if (!config) return;
	const sessionKey = config.sessionIdOverride ?? update.sessionId;

	pendingSessionKey = sessionKey;
	if (update.state) {
		pendingState = { ...update.state, instanceId, source: "composer" };
	}
	if (update.event) {
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
		pendingEvents.push({
			...update.event,
			payload,
			id: update.event.id ?? nextEventId(`composer-${update.sessionId}`),
		});
		if (pendingEvents.length > MAX_PENDING_EVENTS) {
			pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS);
		}
	}

	scheduleFlush();
}
