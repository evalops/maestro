import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { sanitizeWithStaticMask } from "../utils/secret-redactor.js";
import { isInternalTelemetryDisabled } from "./disablement.js";

export interface BeaconEvent {
	feature: string;
	action: string;
	timestamp: number;
	source: {
		client: string;
		clientVersion: string;
		surface?: string;
	};
	parameters?: {
		metadata?: Record<string, unknown>;
		sensitiveMetadata?: Record<string, unknown>;
	};
}

export interface EmitBeaconOptions {
	env?: NodeJS.ProcessEnv;
	fetchFn?: typeof fetch;
}

const SENSITIVE_METADATA_KEY_PATTERN =
	/^(api[_-]?key|authorization|auth|bearer|client[_-]?secret|cookie|credential|credentials|key|password|passwd|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|set[_-]?cookie|token)$/i;

const telemetryFlag = (env: NodeJS.ProcessEnv): string | undefined =>
	env.MAESTRO_TELEMETRY ?? env.PLAYWRIGHT_TELEMETRY;

function beaconEndpoint(env: NodeJS.ProcessEnv): string | undefined {
	return (
		env.MAESTRO_BEACON_ENDPOINT ??
		env.MAESTRO_TELEMETRY_ENDPOINT ??
		env.PLAYWRIGHT_TELEMETRY_ENDPOINT
	);
}

function beaconFile(env: NodeJS.ProcessEnv): string | undefined {
	return resolveEnvPath(env.MAESTRO_BEACON_FILE) ?? undefined;
}

function sampleRate(env: NodeJS.ProcessEnv): number {
	const raw = env.MAESTRO_TELEMETRY_SAMPLE ?? env.PLAYWRIGHT_TELEMETRY_SAMPLE;
	if (!raw) {
		return 1;
	}
	const parsed = Number.parseFloat(raw);
	return Number.isNaN(parsed) ? 1 : Math.min(Math.max(parsed, 0), 1);
}

export function beaconTimeoutMs(env: NodeJS.ProcessEnv): number {
	const parsed = Number.parseInt(env.MAESTRO_BEACON_TIMEOUT_MS ?? "100", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

export function isBeaconEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (isInternalTelemetryDisabled(env)) {
		return false;
	}
	const flag = telemetryFlag(env)?.toLowerCase();
	if (flag === "0" || flag === "false") {
		return false;
	}
	if (sampleRate(env) <= 0) {
		return false;
	}
	return Boolean(beaconEndpoint(env) || beaconFile(env));
}

export function normalizeBeaconEvent(event: BeaconEvent): BeaconEvent {
	const { metadata, sensitiveMetadata } = event.parameters ?? {};
	const split = splitBeaconMetadata(metadata);
	const maskedSensitive = maskSensitiveRecord(sensitiveMetadata);
	const mergedSensitiveMetadata = mergeRecords(
		split.sensitiveMetadata,
		maskedSensitive,
	);
	return {
		...event,
		parameters: {
			...(split.metadata ? { metadata: split.metadata } : {}),
			...(mergedSensitiveMetadata
				? { sensitiveMetadata: mergedSensitiveMetadata }
				: {}),
		},
	};
}

export async function emitBeacon(
	event: BeaconEvent,
	options: EmitBeaconOptions = {},
): Promise<boolean> {
	return emitBeaconBatch([event], options);
}

export async function emitBeaconBatch(
	events: BeaconEvent[],
	options: EmitBeaconOptions = {},
): Promise<boolean> {
	const env = options.env ?? process.env;
	if (!events.length || !isBeaconEnabled(env)) {
		return false;
	}
	if (sampleRate(env) < 1 && Math.random() > sampleRate(env)) {
		return false;
	}

	try {
		const normalizedEvents = events.map(normalizeBeaconEvent);
		const [fileEmitted, endpointEmitted] = await Promise.all([
			writeBeaconFile(normalizedEvents, env).catch(() => false),
			postBeaconEvents(
				normalizedEvents,
				env,
				options.fetchFn ?? globalThis.fetch,
			).catch(() => false),
		]);
		return fileEmitted || endpointEmitted;
	} catch {
		// Beacon emission is best effort and must never affect CLI startup.
		return false;
	}
}

async function writeBeaconFile(
	events: BeaconEvent[],
	env: NodeJS.ProcessEnv,
): Promise<boolean> {
	const file = beaconFile(env);
	if (!file) {
		return false;
	}
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(events)}\n`, "utf8");
	return true;
}

async function postBeaconEvents(
	events: BeaconEvent[],
	env: NodeJS.ProcessEnv,
	fetchFn: typeof fetch | undefined,
): Promise<boolean> {
	const endpoint = beaconEndpoint(env);
	if (!endpoint || !fetchFn) {
		return false;
	}
	try {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		const token = env.MAESTRO_BEACON_API_KEY;
		if (token) {
			headers.authorization = `Bearer ${token}`;
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), beaconTimeoutMs(env));
		timeout.unref?.();
		try {
			const response = await fetchFn(endpoint, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify(events),
			});
			return response.ok;
		} finally {
			clearTimeout(timeout);
		}
	} catch {
		// Beacon emission is best effort and must never affect CLI startup.
		return false;
	}
}

function mergeRecords(
	first?: Record<string, unknown>,
	second?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (!first && !second) {
		return undefined;
	}
	const merged = { ...(first ?? {}) };
	for (const [key, value] of Object.entries(second ?? {})) {
		merged[key] = mergeBeaconMetadataValue(merged[key], value);
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeBeaconMetadataValue(first: unknown, second: unknown): unknown {
	if (first === undefined) {
		return second;
	}
	if (second === undefined) {
		return first;
	}
	if (Array.isArray(first) && Array.isArray(second)) {
		const length = Math.max(first.length, second.length);
		return Array.from({ length }, (_, index) =>
			mergeBeaconMetadataValue(first[index], second[index]),
		);
	}
	const firstRecord = plainRecord(first);
	const secondRecord = plainRecord(second);
	if (firstRecord && secondRecord) {
		return mergeRecords(firstRecord, secondRecord);
	}
	return second;
}

function splitBeaconMetadata(
	metadata: Record<string, unknown> | undefined,
	seen = new WeakSet<object>(),
): {
	metadata?: Record<string, unknown>;
	sensitiveMetadata?: Record<string, unknown>;
} {
	if (!metadata) {
		return {};
	}
	if (seen.has(metadata)) {
		return {
			metadata: {
				value: "[circular]",
			},
		};
	}
	seen.add(metadata);
	const safe: Record<string, unknown> = {};
	const sensitive: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
			sensitive[key] = maskSensitive(value);
			continue;
		}
		const splitValue = splitBeaconMetadataValue(value, seen);
		if (splitValue.safe !== undefined) {
			safe[key] = splitValue.safe;
		}
		if (splitValue.sensitive !== undefined) {
			sensitive[key] = splitValue.sensitive;
		}
	}
	seen.delete(metadata);
	return {
		metadata: hasEntries(safe) ? safe : undefined,
		sensitiveMetadata: hasEntries(sensitive) ? sensitive : undefined,
	};
}

function splitBeaconMetadataValue(
	value: unknown,
	seen: WeakSet<object>,
): {
	safe?: unknown;
	sensitive?: unknown;
} {
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return { safe: "[circular]" };
		}
		seen.add(value);
		const safeItems: unknown[] = [];
		const sensitiveItems: unknown[] = [];
		let hasSensitive = false;
		for (const item of value) {
			const splitItem = splitBeaconMetadataValue(item, seen);
			safeItems.push(splitItem.safe ?? null);
			sensitiveItems.push(splitItem.sensitive ?? null);
			hasSensitive = hasSensitive || splitItem.sensitive !== undefined;
		}
		seen.delete(value);
		return {
			safe: safeItems,
			sensitive: hasSensitive ? sensitiveItems : undefined,
		};
	}
	if (value && typeof value === "object") {
		const record = plainRecord(value);
		if (!record) {
			return {
				safe: sanitizeBeaconMetadataValue(value),
			};
		}
		if (seen.has(value)) {
			return { safe: "[circular]" };
		}
		const nested = splitBeaconMetadata(record, seen);
		return {
			safe: nested.metadata,
			sensitive: nested.sensitiveMetadata,
		};
	}
	return {
		safe: sanitizeBeaconMetadataValue(value),
	};
}

function sanitizeBeaconMetadataValue(value: unknown): unknown {
	return typeof value === "string" ? sanitizeWithStaticMask(value) : value;
}

function hasEntries(record: Record<string, unknown>): boolean {
	return Object.keys(record).length > 0;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null
		? (value as Record<string, unknown>)
		: undefined;
}

function maskSensitiveRecord(
	record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!record) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, maskSensitive(value)]),
	);
}

function maskSensitive(value: unknown): unknown {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return null;
	}
	if (Array.isArray(value)) {
		return maskSensitiveArray(value, new WeakSet<object>());
	}
	if (value && typeof value === "object") {
		return maskSensitiveObject(value, new WeakSet<object>());
	}
	return "[sensitive]";
}

function maskSensitiveArray(
	value: unknown[],
	seen: WeakSet<object>,
): unknown[] | "[sensitive]" {
	if (seen.has(value)) {
		return "[sensitive]";
	}
	seen.add(value);
	const masked = value.map((item) => maskSensitiveNested(item, seen));
	seen.delete(value);
	return masked;
}

function maskSensitiveObject(
	value: object,
	seen: WeakSet<object>,
): Record<string, unknown> | "[sensitive]" {
	const record = plainRecord(value);
	if (!record || seen.has(value)) {
		return "[sensitive]";
	}
	seen.add(value);
	const masked = Object.fromEntries(
		Object.entries(record).map(([key, nested]) => [
			key,
			maskSensitiveNested(nested, seen),
		]),
	);
	seen.delete(value);
	return masked;
}

function maskSensitiveNested(value: unknown, seen: WeakSet<object>): unknown {
	if (Array.isArray(value)) {
		return maskSensitiveArray(value, seen);
	}
	if (value && typeof value === "object") {
		return maskSensitiveObject(value, seen);
	}
	return maskSensitive(value);
}
