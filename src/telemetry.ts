import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Span, SpanStatusCode } from "@opentelemetry/api";

import {
	getTelemetryTracer,
	initOpenTelemetry,
	isOpenTelemetryEnabled,
} from "./opentelemetry.js";
import {
	sanitizeOptionalWithStaticMask,
	sanitizeWithStaticMask,
} from "./utils/secret-redactor.js";

type BaseTelemetryEvent = {
	type:
		| "tool-execution"
		| "evaluation"
		| "loader-stage"
		| "sse"
		| "background-task"
		| "api-request";
	timestamp: string;
};

export interface ApiRequestTelemetry extends BaseTelemetryEvent {
	type: "api-request";
	method: string;
	path: string;
	statusCode: number;
	durationMs: number;
	metadata?: Record<string, unknown>;
}

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

export interface SseTelemetry extends BaseTelemetryEvent {
	type: "sse";
	event: "skip";
	sent: number;
	skipped: number;
	metadata?: Record<string, unknown>;
}

type BackgroundTaskStatusTelemetry =
	| "running"
	| "restarting"
	| "failed"
	| "exited"
	| "stopped";

export interface BackgroundTaskTelemetry extends BaseTelemetryEvent {
	type: "background-task";
	event: "started" | "restarted" | "exited" | "failed" | "stopped";
	taskId: string;
	status: BackgroundTaskStatusTelemetry;
	command: string;
	shellMode: "shell" | "exec";
	cwd?: string;
	restartAttempts: number;
	logTruncated: boolean;
	exitCode?: number | null;
	signal?: string | null;
	resourceUsage?: {
		maxRssKb?: number;
		userMs?: number;
		systemMs?: number;
	};
	failureReason?: string;
	limitBreach?: {
		kind: "memory" | "cpu";
		limit: number;
		actual: number;
	};
}

type TelemetryEvent =
	| ToolExecutionTelemetry
	| EvaluationTelemetry
	| LoaderStageTelemetry
	| SseTelemetry
	| BackgroundTaskTelemetry
	| ApiRequestTelemetry;

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
const initialTelemetryEnabled = shouldEnableTelemetry();
let telemetryEnabled = initialTelemetryEnabled;
let telemetryOverride: boolean | null = null;
let telemetryOverrideReason: string | undefined;

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
const toolFailureLogFile = join(homedir(), ".composer", "tool-failures.log");
const BACKGROUND_TASK_HISTORY_LIMIT = 50;
const backgroundTaskHistory: BackgroundTaskTelemetry[] = [];

export interface TelemetryStatus {
	enabled: boolean;
	reason: string;
	endpoint?: string;
	filePath?: string;
	sampleRate: number;
	flagValue?: string;
	runtimeOverride?: "enabled" | "disabled";
	overrideReason?: string;
}

export function getTelemetryStatus(): TelemetryStatus {
	let reason = "disabled";
	const baseEnabled = initialTelemetryEnabled && samplingRate > 0;
	if (!shouldEnableTelemetry()) {
		reason = "flag disabled";
	} else if (samplingRate === 0) {
		reason = "sampling=0";
	} else if (telemetryEndpointEnv) {
		reason = "endpoint";
	} else if (telemetryFileEnv || baseEnabled) {
		reason = "file";
	}
	const runtimeOverride =
		telemetryOverride === null
			? undefined
			: telemetryOverride
				? "enabled"
				: "disabled";

	return {
		enabled: telemetryEnabled && samplingRate > 0,
		reason,
		endpoint: telemetryEndpointEnv,
		filePath: telemetryFileEnv || defaultTelemetryFile,
		sampleRate: samplingRate,
		flagValue: telemetryFlag,
		runtimeOverride,
		overrideReason: telemetryOverrideReason,
	};
}

export function setTelemetryRuntimeOverride(
	enabled: boolean | null,
	reason?: string,
): void {
	telemetryOverride = enabled;
	telemetryOverrideReason = reason;
	telemetryEnabled = enabled === null ? initialTelemetryEnabled : enabled;
}

async function writeToFile(payload: string) {
	const filePath = telemetryFileEnv || defaultTelemetryFile;
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${payload}\n`, "utf-8");
}

async function appendToolFailure(payload: string): Promise<void> {
	await mkdir(dirname(toolFailureLogFile), { recursive: true });
	await appendFile(toolFailureLogFile, `${payload}\n`, "utf-8");
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

function recordOpenTelemetrySpan(event: TelemetryEvent): void {
	try {
		const tracer = getTelemetryTracer();
		tracer.startActiveSpan(`telemetry.${event.type}`, (span: Span) => {
			span.setAttributes({
				"composer.telemetry.type": event.type,
				"composer.telemetry.timestamp": event.timestamp,
			});

			switch (event.type) {
				case "tool-execution":
					span.setAttributes({
						"composer.tool.name": event.toolName,
						"composer.tool.success": event.success,
						"composer.tool.duration_ms": event.durationMs,
					});
					span.setStatus({
						code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					break;
				case "evaluation":
					span.setAttributes({
						"composer.eval.scenario": event.scenario,
						"composer.eval.success": event.success,
					});
					span.setStatus({
						code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					break;
				case "loader-stage":
					span.setAttributes({
						"composer.loader.stage": event.stage,
						"composer.loader.duration_ms": event.durationMs,
					});
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "sse":
					span.setAttributes({
						"composer.sse.sent": event.sent,
						"composer.sse.skipped": event.skipped,
					});
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "background-task":
					span.setAttributes({
						"composer.background.id": event.taskId,
						"composer.background.event": event.event,
						"composer.background.status": event.status,
						"composer.background.restart_attempts": event.restartAttempts,
						"composer.background.exit_code": event.exitCode ?? -1,
						"composer.background.shell_mode": event.shellMode,
					});
					span.setStatus(
						event.failureReason || event.status === "failed"
							? { code: SpanStatusCode.ERROR, message: event.failureReason }
							: { code: SpanStatusCode.OK },
					);
					break;
				case "api-request":
					span.setAttributes({
						"http.method": event.method,
						"http.route": event.path,
						"http.status_code": event.statusCode,
						"composer.api.duration_ms": event.durationMs,
					});
					span.setStatus({
						code:
							event.statusCode >= 500
								? SpanStatusCode.ERROR
								: SpanStatusCode.OK,
					});
					break;
				default:
					span.setStatus({ code: SpanStatusCode.UNSET });
			}

			if ("metadata" in event && event.metadata) {
				span.setAttributes({ "composer.telemetry.has_metadata": true });
			}

			span.end();
		});
	} catch {
		// Never let tracing failures affect runtime
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

function cloneBackgroundTaskTelemetry(
	event: BackgroundTaskTelemetry,
): BackgroundTaskTelemetry {
	return {
		...event,
		resourceUsage: event.resourceUsage ? { ...event.resourceUsage } : undefined,
		limitBreach: event.limitBreach ? { ...event.limitBreach } : undefined,
	};
}

function recordBackgroundHistory(event: BackgroundTaskTelemetry): void {
	backgroundTaskHistory.push(cloneBackgroundTaskTelemetry(event));
	if (backgroundTaskHistory.length > BACKGROUND_TASK_HISTORY_LIMIT) {
		backgroundTaskHistory.shift();
	}
}

export function getBackgroundTaskHistory(
	limit = 10,
): BackgroundTaskTelemetry[] {
	if (limit <= 0) {
		return [];
	}
	return backgroundTaskHistory
		.slice(-limit)
		.map((entry) => cloneBackgroundTaskTelemetry(entry));
}

export async function recordTelemetry(event: TelemetryEvent): Promise<void> {
	const openTelemetryEnabled = isOpenTelemetryEnabled();
	if (openTelemetryEnabled) {
		recordOpenTelemetrySpan(event);
	}

	const legacyEnabled = telemetryEnabled && samplingRate > 0;
	if (!legacyEnabled) {
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

export function recordSseSkip(
	sent: number,
	skipped: number,
	metadata?: Record<string, unknown>,
): void {
	void recordTelemetry({
		type: "sse",
		event: "skip",
		timestamp: new Date().toISOString(),
		sent,
		skipped,
		metadata,
	});
}

export function logToolFailure(
	toolName: string,
	errorMessage: string,
	metadata?: Record<string, unknown>,
): void {
	const payload = {
		tool: toolName,
		error: errorMessage,
		metadata,
		timestamp: new Date().toISOString(),
	};
	void appendToolFailure(JSON.stringify(payload));
}

export function recordBackgroundTaskEvent(
	event: Omit<BackgroundTaskTelemetry, "type" | "timestamp">,
): void {
	const sanitizedCommand = sanitizeWithStaticMask(event.command);
	const sanitizedFailure = sanitizeOptionalWithStaticMask(event.failureReason);
	const payload: BackgroundTaskTelemetry = {
		...event,
		command: sanitizedCommand,
		failureReason: sanitizedFailure,
		type: "background-task",
		timestamp: new Date().toISOString(),
	};
	recordBackgroundHistory(payload);
	void recordTelemetry(payload);
}

export function recordApiRequest(
	method: string,
	path: string,
	statusCode: number,
	durationMs: number,
	metadata?: Record<string, unknown>,
): void {
	void recordTelemetry({
		type: "api-request",
		timestamp: new Date().toISOString(),
		method,
		path,
		statusCode,
		durationMs,
		metadata,
	});
}
