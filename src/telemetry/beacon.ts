import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Settings, defaultSettings } from "../runtime/settings.js";
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
	telemetry?: Settings["telemetry"];
	fetchFn?: typeof fetch;
}

const DEFAULT_BEACON_TIMEOUT_MS = 100;

function effectiveSampleRate(telemetry: Settings["telemetry"]): number {
	return telemetry.sampleRate ?? 1;
}

export function beaconTimeoutMs(telemetry: Settings["telemetry"]): number {
	return telemetry.timeoutMs ?? DEFAULT_BEACON_TIMEOUT_MS;
}

export function isBeaconEnabled(
	telemetry: Settings["telemetry"] = defaultSettings().telemetry,
): boolean {
	if (isInternalTelemetryDisabled()) {
		return false;
	}
	if (telemetry.enabled === false) {
		return false;
	}
	if (effectiveSampleRate(telemetry) <= 0) {
		return false;
	}
	return Boolean(telemetry.endpoint || telemetry.beaconFile);
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
	const telemetry = options.telemetry ?? defaultSettings().telemetry;
	if (!events.length || !isBeaconEnabled(telemetry)) {
		return false;
	}
	const rate = effectiveSampleRate(telemetry);
	if (rate < 1 && Math.random() > rate) {
		return false;
	}

	try {
		const normalizedEvents = events.map(normalizeBeaconEvent);
		const [fileEmitted, endpointEmitted] = await Promise.all([
			writeBeaconFile(normalizedEvents, telemetry).catch(() => false),
			postBeaconEvents(
				normalizedEvents,
				telemetry,
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
	telemetry: Settings["telemetry"],
): Promise<boolean> {
	const file = telemetry.beaconFile;
	if (!file) {
		return false;
	}
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(events)}\n`, "utf8");
	return true;
}

async function postBeaconEvents(
	events: BeaconEvent[],
	telemetry: Settings["telemetry"],
	fetchFn: typeof fetch | undefined,
): Promise<boolean> {
	const endpoint = telemetry.endpoint;
	if (!endpoint || !fetchFn) {
		return false;
	}
	try {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (telemetry.apiKey) {
			headers.authorization = `Bearer ${telemetry.apiKey}`;
		}
		const controller = new AbortController();
		const timeout = setTimeout(
			() => controller.abort(),
			beaconTimeoutMs(telemetry),
		);
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
