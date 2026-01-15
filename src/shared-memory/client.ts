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
};

type SharedMemoryUpdate = {
	sessionId: string;
	state?: Record<string, JsonValue>;
	event?: SharedMemoryEvent;
};

const logger = createLogger("shared-memory");
const REQUEST_TIMEOUT_MS = 5000;

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

async function patchState(
	config: SharedMemoryConfig,
	sessionId: string,
	state: Record<string, JsonValue>,
): Promise<void> {
	await safeFetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/state`, {
		method: "PATCH",
		headers: buildHeaders(config.apiKey),
		body: JSON.stringify({ state: { composer: state } }),
	});
}

async function appendEvent(
	config: SharedMemoryConfig,
	sessionId: string,
	event: SharedMemoryEvent,
): Promise<void> {
	await safeFetch(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
		method: "POST",
		headers: buildHeaders(config.apiKey),
		body: JSON.stringify({ ...event, actor: "composer" }),
	});
}

export function queueSharedMemoryUpdate(update: SharedMemoryUpdate): void {
	const config = readConfig();
	if (!config) return;
	const sessionKey = config.sessionIdOverride ?? update.sessionId;

	const runner = async () => {
		try {
			if (update.state) {
				await patchState(config, sessionKey, update.state);
			}
			if (update.event) {
				await appendEvent(config, sessionKey, update.event);
			}
		} catch (error) {
			logger.debug("Shared memory update failed", { error });
		}
	};

	if (typeof setImmediate === "function") {
		setImmediate(() => {
			void runner();
		});
	} else {
		setTimeout(() => {
			void runner();
		}, 0);
	}
}
