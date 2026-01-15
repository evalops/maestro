import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Span, SpanStatusCode } from "@opentelemetry/api";

import { PATHS } from "./config/constants.js";
import {
	getTelemetryTracer,
	initOpenTelemetry,
	isOpenTelemetryEnabled,
} from "./opentelemetry.js";
import {
	type CanonicalTurnEvent,
	setDefaultTelemetryRecorder,
} from "./telemetry/wide-events.js";
import { resolveEnvPath } from "./utils/path-expansion.js";
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
		| "api-request"
		| "business-metric"
		| "sandbox-violation";
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

/**
 * Business metrics for tracking usage patterns.
 * Inspired by Claude Code's telemetry events.
 */
export interface BusinessMetricTelemetry extends BaseTelemetryEvent {
	type: "business-metric";
	metric:
		| "session.count"
		| "session.duration"
		| "session.migration"
		| "lines_of_code.count"
		| "tokens.input"
		| "tokens.output"
		| "tokens.cache_read"
		| "tokens.cache_write"
		| "cost.usd"
		| "compaction.triggered"
		| "model.switch";
	value: number;
	metadata?: {
		sessionId?: string;
		model?: string;
		provider?: string;
		gitBranch?: string;
		gitCommitSha?: string;
		[key: string]: unknown;
	};
}

/**
 * Sandbox violation tracking for security auditing.
 */
export interface SandboxViolationTelemetry extends BaseTelemetryEvent {
	type: "sandbox-violation";
	event: "blocked" | "warned" | "allowed";
	tool: string;
	action: string;
	reason: string;
	path?: string;
	command?: string;
	metadata?: {
		sessionId?: string;
		userId?: string;
		[key: string]: unknown;
	};
}

/**
 * Canonical Turn Event - Wide event emitted once per agent turn.
 * Re-exported from telemetry/wide-events.ts for type union.
 */
export interface CanonicalTurnEventBase {
	type: "canonical-turn";
	timestamp: string;
	sessionId: string;
	turnId: string;
	turnNumber: number;
	[key: string]: unknown;
}

type TelemetryEvent =
	| ToolExecutionTelemetry
	| EvaluationTelemetry
	| LoaderStageTelemetry
	| SseTelemetry
	| BackgroundTaskTelemetry
	| ApiRequestTelemetry
	| BusinessMetricTelemetry
	| SandboxViolationTelemetry
	| CanonicalTurnEventBase
	| CanonicalTurnEvent;

const telemetryFlag =
	process.env.COMPOSER_TELEMETRY ?? process.env.PLAYWRIGHT_TELEMETRY;

const telemetryFileEnv =
	resolveEnvPath(process.env.COMPOSER_TELEMETRY_FILE) ??
	resolveEnvPath(process.env.PLAYWRIGHT_TELEMETRY_FILE);

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

const defaultTelemetryFile = PATHS.TELEMETRY_LOG;
const toolFailureLogFile = PATHS.TOOL_FAILURE_LOG;
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
				case "business-metric":
					span.setAttributes({
						"composer.metric.name": event.metric,
						"composer.metric.value": event.value,
					});
					if (event.metadata?.model) {
						span.setAttribute("composer.metric.model", event.metadata.model);
					}
					if (event.metadata?.provider) {
						span.setAttribute(
							"composer.metric.provider",
							event.metadata.provider,
						);
					}
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "sandbox-violation":
					span.setAttributes({
						"composer.sandbox.event": event.event,
						"composer.sandbox.tool": event.tool,
						"composer.sandbox.action": event.action,
						"composer.sandbox.reason": event.reason,
					});
					if (event.path) {
						span.setAttribute("composer.sandbox.path", event.path);
					}
					span.setStatus({
						code:
							event.event === "blocked"
								? SpanStatusCode.ERROR
								: SpanStatusCode.OK,
					});
					break;
				case "canonical-turn":
					span.setAttributes({
						"composer.turn.id": event.turnId,
						"composer.turn.number": event.turnNumber,
						"composer.turn.session_id": event.sessionId,
						"composer.turn.status": String(
							"status" in event ? event.status : "unknown",
						),
						"composer.turn.tool_count": Number(
							"toolCount" in event ? event.toolCount : 0,
						),
						"composer.turn.total_duration_ms": Number(
							"totalDurationMs" in event ? event.totalDurationMs : 0,
						),
						"composer.turn.cost_usd": Number(
							"costUsd" in event ? event.costUsd : 0,
						),
						"composer.turn.sampled": Boolean(
							"sampled" in event ? event.sampled : true,
						),
					});
					span.setStatus({
						code:
							"status" in event && event.status === "error"
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

/**
 * Record a business metric for usage tracking.
 */
export function recordBusinessMetric(
	metric: BusinessMetricTelemetry["metric"],
	value: number,
	metadata?: BusinessMetricTelemetry["metadata"],
): void {
	void recordTelemetry({
		type: "business-metric",
		timestamp: new Date().toISOString(),
		metric,
		value,
		metadata,
	});
}

/**
 * Record session start.
 */
export function recordSessionStart(
	sessionId: string,
	metadata?: Omit<BusinessMetricTelemetry["metadata"], "sessionId">,
): void {
	recordBusinessMetric("session.count", 1, { ...metadata, sessionId });
}

/**
 * Record session duration on end.
 */
export function recordSessionDuration(
	sessionId: string,
	durationMs: number,
	metadata?: Omit<BusinessMetricTelemetry["metadata"], "sessionId">,
): void {
	recordBusinessMetric("session.duration", durationMs, {
		...metadata,
		sessionId,
	});
}

/**
 * Record token usage metrics.
 */
export function recordTokenUsage(
	sessionId: string,
	tokens: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	},
	metadata?: Omit<BusinessMetricTelemetry["metadata"], "sessionId">,
): void {
	if (tokens.input !== undefined && tokens.input > 0) {
		recordBusinessMetric("tokens.input", tokens.input, {
			...metadata,
			sessionId,
		});
	}
	if (tokens.output !== undefined && tokens.output > 0) {
		recordBusinessMetric("tokens.output", tokens.output, {
			...metadata,
			sessionId,
		});
	}
	if (tokens.cacheRead !== undefined && tokens.cacheRead > 0) {
		recordBusinessMetric("tokens.cache_read", tokens.cacheRead, {
			...metadata,
			sessionId,
		});
	}
	if (tokens.cacheWrite !== undefined && tokens.cacheWrite > 0) {
		recordBusinessMetric("tokens.cache_write", tokens.cacheWrite, {
			...metadata,
			sessionId,
		});
	}
}

/**
 * Record cost in USD.
 */
export function recordCost(
	sessionId: string,
	costUsd: number,
	metadata?: Omit<BusinessMetricTelemetry["metadata"], "sessionId">,
): void {
	recordBusinessMetric("cost.usd", costUsd, { ...metadata, sessionId });
}

/**
 * Record compaction event.
 */
export function recordCompaction(
	sessionId: string,
	metadata?: Omit<BusinessMetricTelemetry["metadata"], "sessionId">,
): void {
	recordBusinessMetric("compaction.triggered", 1, { ...metadata, sessionId });
}

/**
 * Record model switch.
 */
export function recordModelSwitch(
	sessionId: string,
	fromModel: string,
	toModel: string,
	metadata?: Omit<BusinessMetricTelemetry["metadata"], "sessionId">,
): void {
	recordBusinessMetric("model.switch", 1, {
		...metadata,
		sessionId,
		model: toModel,
		previousModel: fromModel,
	});
}

/**
 * Record session migration stats.
 */
export function recordSessionMigration(stats: {
	total: number;
	migrated: number;
	skipped: number;
	failures: number;
	version: number;
}): void {
	recordBusinessMetric("session.migration", stats.total, {
		migrated: stats.migrated,
		skipped: stats.skipped,
		failures: stats.failures,
		version: stats.version,
	});
}

/**
 * Record a sandbox violation event.
 */
export function recordSandboxViolation(
	event: SandboxViolationTelemetry["event"],
	tool: string,
	action: string,
	reason: string,
	options?: {
		path?: string;
		command?: string;
		sessionId?: string;
		metadata?: Record<string, unknown>;
	},
): void {
	void recordTelemetry({
		type: "sandbox-violation",
		timestamp: new Date().toISOString(),
		event,
		tool,
		action,
		reason,
		path: options?.path,
		command: options?.command
			? sanitizeWithStaticMask(options.command)
			: undefined,
		metadata: options?.metadata
			? { ...options.metadata, sessionId: options.sessionId }
			: options?.sessionId
				? { sessionId: options.sessionId }
				: undefined,
	});
}

// Initialize the wide-events telemetry recorder to break circular dependency
setDefaultTelemetryRecorder(recordTelemetry);
