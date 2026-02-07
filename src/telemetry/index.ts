/**
 * Telemetry Module
 *
 * Centralized telemetry exports including wide events pattern.
 */

// Re-export from main telemetry module
export {
	recordTelemetry,
	recordToolExecution,
	recordEvaluationResult,
	recordLoaderStage,
	recordSseSkip,
	logToolFailure,
	recordBackgroundTaskEvent,
	recordApiRequest,
	recordBusinessMetric,
	recordSessionStart,
	recordSessionDuration,
	recordTokenUsage,
	recordCost,
	recordCompaction,
	recordModelSwitch,
	recordSandboxViolation,
	getTelemetryStatus,
	setTelemetryRuntimeOverride,
	getBackgroundTaskHistory,
	type TelemetryStatus,
	type ApiRequestTelemetry,
	type ToolExecutionTelemetry,
	type EvaluationTelemetry,
	type LoaderStageTelemetry,
	type SseTelemetry,
	type BackgroundTaskTelemetry,
	type BusinessMetricTelemetry,
	type SandboxViolationTelemetry,
} from "../telemetry.js";

// Wide events (canonical turn events)
export {
	TurnCollector,
	createTurnCollector,
	getSamplingConfigFromEnv,
	type CanonicalTurnEvent,
	type ToolExecution,
	type TokenUsage as WideEventTokenUsage,
	type ModelInfo,
	type TailSamplingConfig,
} from "./wide-events.js";

// Turn tracking integration
export {
	TurnTracker,
	createTurnTracker,
	type TurnTrackerConfig,
	type TurnTrackerContext,
} from "./turn-tracker.js";

// Session performance aggregation
export {
	SessionPerfCollector,
	formatPerfReport,
	type SessionPerfSnapshot,
} from "./session-perf.js";
