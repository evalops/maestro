import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type BaseTelemetryEvent = {
	type: "tool-execution" | "evaluation";
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

type TelemetryEvent = ToolExecutionTelemetry | EvaluationTelemetry;

const shouldEnableTelemetry = (): boolean => {
	const flag = process.env.PLAYWRIGHT_TELEMETRY?.toLowerCase();
	if (flag === "0" || flag === "false") {
		return false;
	}
	if (flag === "1" || flag === "true") {
		return true;
	}
	return Boolean(
		process.env.PLAYWRIGHT_TELEMETRY_ENDPOINT ||
			process.env.PLAYWRIGHT_TELEMETRY_FILE,
	);
};

const telemetryEnabled = shouldEnableTelemetry();

const defaultTelemetryFile = join(homedir(), ".playwright", "telemetry.log");

async function writeToFile(payload: string) {
	const filePath =
		process.env.PLAYWRIGHT_TELEMETRY_FILE || defaultTelemetryFile;
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${payload}\n`, "utf-8");
}

async function postToEndpoint(payload: string) {
	const endpoint = process.env.PLAYWRIGHT_TELEMETRY_ENDPOINT;
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

	if (process.env.PLAYWRIGHT_TELEMETRY_ENDPOINT) {
		tasks.push(postToEndpoint(payload));
	}

	if (process.env.PLAYWRIGHT_TELEMETRY_ENDPOINT === undefined) {
		// Default to file storage when no endpoint is configured
		tasks.push(writeToFile(payload));
	} else if (process.env.PLAYWRIGHT_TELEMETRY_FILE) {
		tasks.push(writeToFile(payload));
	}

	await Promise.all(tasks);
}

export async function recordTelemetry(event: TelemetryEvent): Promise<void> {
	if (!telemetryEnabled) {
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
