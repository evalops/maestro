import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { isInternalTelemetryDisabled } from "./disablement.js";
import { normalizeTelemetryMetadataInputs } from "./metadata-normalization.js";

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
	const normalizedMetadata = normalizeTelemetryMetadataInputs(
		metadata,
		sensitiveMetadata,
	);
	return {
		...event,
		parameters: normalizedMetadata,
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
