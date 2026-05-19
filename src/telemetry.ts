import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Span, SpanStatusCode } from "@opentelemetry/api";

import { PATHS } from "./config/constants.js";
import {
	getTelemetryTracer,
	initOpenTelemetry,
	isOpenTelemetryEnabled,
} from "./opentelemetry.js";
import { isInternalTelemetryDisabled } from "./telemetry/disablement.js";
import {
	type MaestroCorrelation,
	mirrorTelemetryToMaestroEventBus,
	resolveMaestroEventBusConfig,
} from "./telemetry/maestro-event-bus.js";
import { normalizeTelemetryMetadataInputs } from "./telemetry/metadata-normalization.js";
import {
	hasRemoteMeterDestination,
	mirrorCanonicalTurnEventToMeter,
} from "./telemetry/meter-service-client.js";
import {
	recordCompactionMetric,
	recordSubagentDispatchMetric,
	recordToolInvocationMetric,
} from "./telemetry/metrics.js";
import {
	type CanonicalTurnEvent,
	setDefaultTelemetryRecorder,
} from "./telemetry/wide-events.js";
import { resolveEnvPath } from "./utils/path-expansion.js";
import {
	sanitizeOptionalWithStaticMask,
	sanitizeWithStaticMask,
} from "./utils/secret-redactor.js";

export { splitTelemetryMetadata } from "./telemetry/metadata-normalization.js";

type BaseTelemetryEvent = {
	type:
		| "tool-execution"
		| "evaluation"
		| "loader-stage"
		| "sse"
		| "background-task"
		| "api-request"
		| "business-metric"
		| "staged-rollout-surface"
		| "sandbox-violation"
		| "subagent-dispatch";
	timestamp: string;
	sensitiveMetadata?: Record<string, unknown>;
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

export interface StagedRolloutSurfaceTelemetry extends BaseTelemetryEvent {
	type: "staged-rollout-surface";
	event: "hidden_flag_used" | "hidden_mode_used" | "internal_gate_used";
	surfaceId: string;
	surfaceType: "cli_flag" | "mode" | "internal_gate" | "protocol_capability";
	metadata?: {
		owner?: string;
		source?: string;
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
 * Subagent dispatch tracking for multi-agent routing and audit.
 */
export interface SubagentDispatchTelemetry extends BaseTelemetryEvent {
	type: "subagent-dispatch";
	event: "subagent_dispatched";
	mode: string;
	subagentType: string;
	model: string;
	provider: string;
	reasoningEffort: string;
	latencyMs: number;
	success: boolean;
	source?: string;
	metadata?: Record<string, unknown>;
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
	| StagedRolloutSurfaceTelemetry
	| SandboxViolationTelemetry
	| SubagentDispatchTelemetry
	| CanonicalTurnEventBase
	| CanonicalTurnEvent;

const telemetryFlag =
	process.env.MAESTRO_TELEMETRY ?? process.env.PLAYWRIGHT_TELEMETRY;

const telemetryFileEnv =
	resolveEnvPath(process.env.MAESTRO_TELEMETRY_FILE) ??
	resolveEnvPath(process.env.PLAYWRIGHT_TELEMETRY_FILE);

const telemetryEndpointEnv =
	process.env.MAESTRO_TELEMETRY_ENDPOINT ??
	process.env.PLAYWRIGHT_TELEMETRY_ENDPOINT;

const telemetrySampleEnv =
	process.env.MAESTRO_TELEMETRY_SAMPLE ??
	process.env.PLAYWRIGHT_TELEMETRY_SAMPLE;

const shouldEnableTelemetry = (): boolean => {
	const flag = telemetryFlag?.toLowerCase();
	if (flag === "0" || flag === "false") {
		return false;
	}
	if (flag === "1" || flag === "true") {
		return true;
	}
	return Boolean(
		telemetryEndpointEnv || telemetryFileEnv || hasRemoteMeterDestination(),
	);
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
	} else if (hasRemoteMeterDestination()) {
		reason = "meter";
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

function normalizeTelemetryEventMetadata(
	event: TelemetryEvent,
): TelemetryEvent {
	if (!("metadata" in event) && !("sensitiveMetadata" in event)) {
		return event;
	}
	const existingMetadata =
		"metadata" in event ? stringRecord(event.metadata) : undefined;
	const existingSensitiveMetadata =
		"sensitiveMetadata" in event
			? stringRecord(event.sensitiveMetadata)
			: undefined;
	const { metadata, sensitiveMetadata } = normalizeTelemetryMetadataInputs(
		existingMetadata,
		existingSensitiveMetadata,
	);
	const normalized = { ...event };
	if ("metadata" in normalized) {
		if (metadata) {
			normalized.metadata = metadata;
		} else {
			delete normalized.metadata;
		}
	}
	if (sensitiveMetadata) {
		normalized.sensitiveMetadata = sensitiveMetadata;
	} else {
		delete normalized.sensitiveMetadata;
	}
	return normalized;
}

function isCanonicalTurnTelemetryEvent(
	event: TelemetryEvent,
): event is CanonicalTurnEvent {
	return (
		event.type === "canonical-turn" && "model" in event && "tokens" in event
	);
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
		const correlationAttributes = maestroCorrelationSpanAttributes(event);
		const tracer = getTelemetryTracer();
		tracer.startActiveSpan(`telemetry.${event.type}`, (span: Span) => {
			span.setAttributes({
				...correlationAttributes,
				"maestro.telemetry.type": event.type,
				"maestro.telemetry.timestamp": event.timestamp,
			});

			switch (event.type) {
				case "tool-execution":
					span.setAttributes({
						"maestro.tool.name": event.toolName,
						"maestro.tool.success": event.success,
						"maestro.tool.duration_ms": event.durationMs,
					});
					span.setStatus({
						code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					break;
				case "evaluation":
					span.setAttributes({
						"maestro.eval.scenario": event.scenario,
						"maestro.eval.success": event.success,
					});
					span.setStatus({
						code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					break;
				case "loader-stage":
					span.setAttributes({
						"maestro.loader.stage": event.stage,
						"maestro.loader.duration_ms": event.durationMs,
					});
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "sse":
					span.setAttributes({
						"maestro.sse.sent": event.sent,
						"maestro.sse.skipped": event.skipped,
					});
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "background-task":
					span.setAttributes({
						"maestro.background.id": event.taskId,
						"maestro.background.event": event.event,
						"maestro.background.status": event.status,
						"maestro.background.restart_attempts": event.restartAttempts,
						"maestro.background.exit_code": event.exitCode ?? -1,
						"maestro.background.shell_mode": event.shellMode,
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
						"maestro.api.duration_ms": event.durationMs,
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
						"maestro.metric.name": event.metric,
						"maestro.metric.value": event.value,
					});
					if (event.metadata?.model) {
						span.setAttribute("maestro.metric.model", event.metadata.model);
					}
					if (event.metadata?.provider) {
						span.setAttribute(
							"maestro.metric.provider",
							event.metadata.provider,
						);
					}
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "staged-rollout-surface":
					span.setAttributes({
						"maestro.staged_rollout.event": event.event,
						"maestro.staged_rollout.surface_id": event.surfaceId,
						"maestro.staged_rollout.surface_type": event.surfaceType,
					});
					if (event.metadata?.owner) {
						span.setAttribute(
							"maestro.staged_rollout.owner",
							String(event.metadata.owner),
						);
					}
					span.setStatus({ code: SpanStatusCode.OK });
					break;
				case "sandbox-violation":
					span.setAttributes({
						"maestro.sandbox.event": event.event,
						"maestro.sandbox.tool": event.tool,
						"maestro.sandbox.action": event.action,
						"maestro.sandbox.reason": event.reason,
					});
					if (event.path) {
						span.setAttribute("maestro.sandbox.path", event.path);
					}
					span.setStatus({
						code:
							event.event === "blocked"
								? SpanStatusCode.ERROR
								: SpanStatusCode.OK,
					});
					break;
				case "subagent-dispatch":
					span.setAttributes({
						"maestro.subagent.event": event.event,
						"maestro.subagent.mode": event.mode,
						"maestro.subagent.type": event.subagentType,
						"maestro.subagent.reasoning_effort": event.reasoningEffort,
						"maestro.subagent.source": event.source ?? "unknown",
						"maestro.subagent.success": event.success,
						"maestro.subagent.latency_ms": event.latencyMs,
						"llm.model.id": event.model,
						"llm.model.provider": event.provider,
					});
					span.setStatus({
						code: event.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
					});
					break;
				case "canonical-turn": {
					const canonicalTurn = isCanonicalTurnTelemetryEvent(event)
						? event
						: undefined;
					span.setAttributes({
						"maestro.turn.id": event.turnId,
						"maestro.turn.number": event.turnNumber,
						"maestro.turn.session_id": event.sessionId,
						"agent.session.id": event.sessionId,
						...(canonicalTurn
							? {
									"llm.model.id": canonicalTurn.model.id,
									"llm.model.provider": canonicalTurn.model.provider,
									"llm.usage.input_tokens": canonicalTurn.tokens.input,
									"llm.usage.output_tokens": canonicalTurn.tokens.output,
									"llm.usage.cache_read_tokens": canonicalTurn.tokens.cacheRead,
									"llm.usage.cache_write_tokens":
										canonicalTurn.tokens.cacheWrite,
								}
							: {}),
						"maestro.turn.status": String(
							"status" in event ? event.status : "unknown",
						),
						"maestro.turn.tool_count": Number(
							"toolCount" in event ? event.toolCount : 0,
						),
						"maestro.turn.total_duration_ms": Number(
							"totalDurationMs" in event ? event.totalDurationMs : 0,
						),
						"maestro.turn.cost_usd": Number(
							"costUsd" in event ? event.costUsd : 0,
						),
						"maestro.turn.sampled": Boolean(
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
				}
				default:
					span.setStatus({ code: SpanStatusCode.UNSET });
			}

			if ("metadata" in event && event.metadata) {
				span.setAttributes({ "maestro.telemetry.has_metadata": true });
			}

			span.end();
		});
	} catch {
		// Never let tracing failures affect runtime
	}
}

function recordOpenTelemetryMetric(event: TelemetryEvent): void {
	try {
		switch (event.type) {
			case "tool-execution":
				recordToolInvocationMetric({
					toolName: event.toolName,
					durationMs: event.durationMs,
					success: event.success,
					agentRunId: metadataString(event.metadata, [
						"agentRunId",
						"agent_run_id",
					]),
					skillName: skillNameFromMetadata(event.metadata),
				});
				break;
			case "business-metric":
				if (event.metric === "compaction.triggered") {
					recordCompactionMetric({
						"maestro.session_id": event.metadata?.sessionId,
						"llm.model.id": event.metadata?.model,
						"llm.model.provider": event.metadata?.provider,
					});
				}
				break;
			case "subagent-dispatch":
				recordSubagentDispatchMetric({
					mode: event.mode,
					subagentType: event.subagentType,
					provider: event.provider,
					model: event.model,
					reasoningEffort: event.reasoningEffort,
					source: event.source,
					success: event.success,
					latencyMs: event.latencyMs,
					agentRunId: metadataString(event.metadata, [
						"agentRunId",
						"agent_run_id",
					]),
				});
				break;
			default:
				break;
		}
	} catch {
		// Never let metric recording affect runtime behavior.
	}
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function skillNameFromMetadata(
	metadata: Record<string, unknown> | undefined,
): string | undefined {
	return (
		metadataString(metadata, ["skillName", "skill_name"]) ??
		metadataString(stringRecord(metadata?.skillMetadata), ["name"]) ??
		metadataString(stringRecord(metadata?.skill_metadata), ["name"])
	);
}

function metadataString(
	record: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

function eventCorrelationOverrides(
	event: TelemetryEvent,
): Partial<MaestroCorrelation> {
	const metadata = stringRecord(
		"metadata" in event ? event.metadata : undefined,
	);
	const topLevelTraceId =
		"traceId" in event &&
		typeof event.traceId === "string" &&
		event.traceId.trim().length > 0
			? event.traceId
			: undefined;
	return {
		organization_id: metadataString(metadata, [
			"organizationId",
			"organization_id",
			"orgId",
			"org_id",
		]),
		user_id: metadataString(metadata, ["userId", "user_id"]),
		workspace_id: metadataString(metadata, ["workspaceId", "workspace_id"]),
		session_id:
			("sessionId" in event && typeof event.sessionId === "string"
				? event.sessionId
				: undefined) ??
			metadataString(metadata, [
				"sessionId",
				"session_id",
				"maestroSessionId",
				"maestro_session_id",
			]),
		agent_run_id: metadataString(metadata, ["agentRunId", "agent_run_id"]),
		agent_run_step_id: metadataString(metadata, [
			"agentRunStepId",
			"agent_run_step_id",
			"toolCallId",
			"tool_call_id",
		]),
		agent_id: metadataString(metadata, ["agentId", "agent_id"]),
		actor_id: metadataString(metadata, ["actorId", "actor_id"]),
		principal_id: metadataString(metadata, ["principalId", "principal_id"]),
		trace_id:
			topLevelTraceId ?? metadataString(metadata, ["traceId", "trace_id"]),
		traceparent: metadataString(metadata, ["traceparent", "trace_parent"]),
		tracestate: metadataString(metadata, ["tracestate", "trace_state"]),
		request_id: metadataString(metadata, ["requestId", "request_id"]),
		remote_runner_session_id: metadataString(metadata, [
			"remoteRunnerSessionId",
			"remote_runner_session_id",
		]),
		objective_id: metadataString(metadata, ["objectiveId", "objective_id"]),
		conversation_id: metadataString(metadata, [
			"conversationId",
			"conversation_id",
		]),
	};
}

function maestroCorrelationSpanAttributes(
	event: TelemetryEvent,
): Record<string, string> {
	const config = resolveMaestroEventBusConfig();
	const overrides = eventCorrelationOverrides(event);
	const correlation = {
		...config.defaultCorrelation,
		...Object.fromEntries(
			Object.entries(overrides).filter(([, value]) => value !== undefined),
		),
	};
	const principal = config.defaultPrincipal;
	const attributes: Record<string, string | undefined> = {
		"enduser.id": correlation.user_id ?? principal?.user_id,
		"user.id": correlation.user_id ?? principal?.user_id,
		"agent.user.id": correlation.user_id ?? principal?.user_id,
		"organization.id":
			correlation.organization_id ?? principal?.organization_id,
		"evalops.organization_id":
			correlation.organization_id ?? principal?.organization_id,
		"workspace.id": correlation.workspace_id ?? principal?.workspace_id,
		"evalops.workspace_id": correlation.workspace_id ?? principal?.workspace_id,
		"maestro.session_id": correlation.session_id,
		"agent.id": correlation.agent_id,
		"agent.actor.id": correlation.actor_id,
		"evalops.principal_id": correlation.principal_id,
		"maestro.agent_run_id": correlation.agent_run_id,
		"maestro.agent_run_step_id": correlation.agent_run_step_id,
		"trace.id": correlation.trace_id,
		traceparent: correlation.traceparent,
		tracestate: correlation.tracestate,
		"request.id": correlation.request_id,
		"evalops.remote_runner_session_id": correlation.remote_runner_session_id,
		"evalops.objective_id": correlation.objective_id,
		"evalops.conversation_id": correlation.conversation_id,
		"maestro.surface": config.defaultSurface,
	};

	return Object.fromEntries(
		Object.entries(attributes).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" &&
				entry[1].trim().length > 0 &&
				entry[1] !== "unknown",
		),
	);
}

async function persistTelemetry(event: TelemetryEvent) {
	const payload = JSON.stringify(event);
	const tasks: Promise<void>[] = [];

	if (isCanonicalTurnTelemetryEvent(event)) {
		tasks.push(mirrorCanonicalTurnEventToMeter(event).then(() => undefined));
	}

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
	if (isInternalTelemetryDisabled()) {
		return;
	}

	const normalizedEvent = normalizeTelemetryEventMetadata(event);
	const openTelemetryEnabled = isOpenTelemetryEnabled();
	if (openTelemetryEnabled) {
		recordOpenTelemetrySpan(normalizedEvent);
		recordOpenTelemetryMetric(normalizedEvent);
	}
	const eventBusTask = mirrorTelemetryToMaestroEventBus(normalizedEvent);

	const legacyEnabled = telemetryEnabled && samplingRate > 0;
	if (!legacyEnabled) {
		await eventBusTask;
		return;
	}

	if (samplingRate < 1 && Math.random() > samplingRate) {
		await eventBusTask;
		return;
	}

	try {
		await Promise.all([persistTelemetry(normalizedEvent), eventBusTask]);
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
): Promise<void> {
	return recordTelemetry({
		type: "business-metric",
		timestamp: new Date().toISOString(),
		metric: "session.duration",
		value: durationMs,
		metadata: {
			...metadata,
			sessionId,
		},
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

export function recordStagedRolloutSurfaceUsage(
	event: StagedRolloutSurfaceTelemetry["event"],
	options: {
		surfaceId: string;
		surfaceType: StagedRolloutSurfaceTelemetry["surfaceType"];
		owner?: string;
		source?: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	return recordTelemetry({
		type: "staged-rollout-surface",
		timestamp: new Date().toISOString(),
		event,
		surfaceId: options.surfaceId,
		surfaceType: options.surfaceType,
		metadata: {
			...options.metadata,
			owner: options.owner,
			source: options.source,
		},
	});
}

export function recordSubagentDispatch(
	event: Omit<SubagentDispatchTelemetry, "type" | "timestamp" | "event">,
): void {
	void recordTelemetry({
		...event,
		type: "subagent-dispatch",
		event: "subagent_dispatched",
		timestamp: new Date().toISOString(),
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
