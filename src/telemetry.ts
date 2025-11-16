import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type BaseTelemetryEvent = {
	type: "tool-execution" | "evaluation" | "loader-stage";
	timestamp: string;
};

export interface ToolExecutionTelemetry extends BaseTelemetryEvent {
	type: "tool-execution";
	toolName: string;
	success: boolean;
	durationMs: number;
	metadata?: Record<string, unknown>;
}

export interface EvaluationTelemetry extends BaseTelemetryEvent {
	type: "evaluation";
	scenario: string;
	success: boolean;
	details?: Record<string, unknown>;
}

export interface LoaderStageTelemetry extends BaseTelemetryEvent {
	type: "loader-stage";
	stage: string;
	durationMs: number;
	metadata?: Record<string, unknown>;
}

type TelemetryEvent =
	| ToolExecutionTelemetry
	| EvaluationTelemetry
	| LoaderStageTelemetry;

const telemetryFlag =
	process.env.COMPOSER_TELEMETRY ?? process.env.PLAYWRIGHT_TELEMETRY;

const telemetryFileEnv =
	process.env.COMPOSER_TELEMETRY_FILE ?? process.env.PLAYWRIGHT_TELEMETRY_FILE;

const telemetryEndpointEnv =
	process.env.COMPOSER_TELEMETRY_ENDPOINT ??
	process.env.PLAYWRIGHT_TELEMETRY_ENDPOINT;

const telemetrySampleEnv =
	process.env.COMPOSER_TELEMETRY_SAMPLE ??
	process.env.PLAYWRIGHT_TELEMETRY_SAMPLE;

const shouldEnableTelemetry = (): boolean => {
	const flag = telemetryFlag?.toLowerCase();
	if (flag === "0" || flag === "false") {
		return false;
	}
	if (flag === "1" || flag === "true") {
		return true;
	}
	return Boolean(telemetryEndpointEnv || telemetryFileEnv);
};

const telemetryEnabled = shouldEnableTelemetry();

const parseSamplingRate = (): number => {
	const raw = telemetrySampleEnv;
	if (!raw) {
		return 1;
	}
	const rate = Number.parseFloat(raw);
	if (Number.isNaN(rate)) {
		return 1;
	}
	return Math.min(Math.max(rate, 0), 1);
};

const samplingRate = parseSamplingRate();

const defaultTelemetryFile = join(homedir(), ".composer", "telemetry.log");

export interface TelemetryStatus {
	enabled: boolean;
	reason: string;
	endpoint?: string;
	filePath?: string;
	sampleRate: number;
	flagValue?: string;
}

export function getTelemetryStatus(): TelemetryStatus {
	let reason = "disabled";
	if (!shouldEnableTelemetry()) {
		reason = "flag disabled";
	} else if (samplingRate === 0) {
		reason = "sampling=0";
	} else if (telemetryEndpointEnv) {
		reason = "endpoint";
	} else if (telemetryFileEnv || telemetryEnabled) {
		reason = "file";
	}

	return {
		enabled: telemetryEnabled && samplingRate > 0,
		reason,
		endpoint: telemetryEndpointEnv,
		filePath: telemetryFileEnv || defaultTelemetryFile,
		sampleRate: samplingRate,
		flagValue: telemetryFlag,
	};
}

async function writeToFile(payload: string) {
	const filePath = telemetryFileEnv || defaultTelemetryFile;
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${payload}\n`, "utf-8");
}

async function postToEndpoint(payload: string) {
	const endpoint = telemetryEndpointEnv;
	if (!endpoint) {
		return;
	}
	try {
		await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: payload,
		});
	} catch (_error) {
		// Swallow telemetry transport errors
	}
}

async function persistTelemetry(event: TelemetryEvent) {
	const payload = JSON.stringify(event);
	const tasks: Promise<void>[] = [];

	if (telemetryEndpointEnv) {
		tasks.push(postToEndpoint(payload));
	}

	if (telemetryEndpointEnv === undefined) {
		// Default to file storage when no endpoint is configured
		tasks.push(writeToFile(payload));
	} else if (telemetryFileEnv) {
		tasks.push(writeToFile(payload));
	}

	await Promise.all(tasks);
}

export async function recordTelemetry(event: TelemetryEvent): Promise<void> {
	if (!telemetryEnabled || samplingRate === 0) {
		return;
	}

	if (samplingRate < 1 && Math.random() > samplingRate) {
		return;
	}

	try {
		await persistTelemetry(event);
	} catch (_error) {
		// Ignore telemetry persistence failures
	}
}

export function recordToolExecution(
	toolName: string,
	success: boolean,
	durationMs: number,
	metadata?: Record<string, unknown>,
): void {
	void recordTelemetry({
		type: "tool-execution",
		timestamp: new Date().toISOString(),
		toolName,
		success,
		durationMs,
		metadata,
	});
}

export function recordEvaluationResult(
	scenario: string,
	success: boolean,
	details?: Record<string, unknown>,
): void {
	void recordTelemetry({
		type: "evaluation",
		timestamp: new Date().toISOString(),
		scenario,
		success,
		details,
	});
}

export function recordLoaderStage(
	stage: string,
	durationMs: number,
	metadata?: Record<string, unknown>,
): void {
	void recordTelemetry({
		type: "loader-stage",
		timestamp: new Date().toISOString(),
		stage,
		durationMs,
		metadata,
	});
}
