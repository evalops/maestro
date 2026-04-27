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

// Maestro event bus catalog shared with the public mirror.
export {
	MAESTRO_BUS_EVENT_CATALOG,
	MAESTRO_BUS_EVENT_TYPES,
	MaestroBusEventType,
	getMaestroBusEventCatalogEntry,
	isMaestroBusEventType,
	listMaestroBusEventCatalog,
	type MaestroBusEventCatalogEntry,
	type MaestroBusEventCategory,
} from "./maestro-event-catalog.js";

export {
	buildMaestroCloudEvent,
	closeMaestroEventBusTransport,
	getMaestroEventBusStatus,
	publishMaestroCloudEvent,
	recordMaestroApprovalHit,
	recordMaestroEvalScored,
	recordMaestroFirewallBlock,
	recordMaestroPromptVariantSelected,
	recordMaestroSessionEvent,
	recordMaestroSkillInvoked,
	recordMaestroSkillOutcome,
	recordMaestroToolCallAttempt,
	recordMaestroToolCallCompleted,
	resolveMaestroEventBusConfig,
	setMaestroEventBusTransportForTests,
	type ApprovalHitEventData,
	type EvalScoredEventData,
	type FirewallBlockEventData,
	type MaestroCloudEvent,
	type MaestroCloseReason,
	type MaestroCorrelation,
	type MaestroDecisionMode,
	type MaestroEventBusConfig,
	type MaestroEventBusStatus,
	type MaestroEventBusTransport,
	type MaestroPrincipal,
	type MaestroRuntimeMode,
	type MaestroSessionEventData,
	type MaestroSessionState,
	type MaestroSkillOutcomeProtoStatus,
	type MaestroSkillOutcomeStatus,
	type MaestroSurface,
	type MaestroToolCallStatus,
	type PublishMaestroEventOptions,
	type RecordMaestroApprovalHitInput,
	type RecordMaestroEvalScoredInput,
	type RecordMaestroFirewallBlockInput,
	type RecordMaestroPromptVariantSelectedInput,
	type RecordMaestroSkillInvokedInput,
	type RecordMaestroSkillOutcomeInput,
	type RecordMaestroToolCallAttemptInput,
	type RecordMaestroToolCallCompletedInput,
	type SandboxViolationEventData,
	type SkillInvocationEventData,
	type SkillOutcomeEventData,
	type ToolCallAttemptEventData,
	type ToolCallResultEventData,
} from "./maestro-event-bus.js";

export {
	CANONICAL_MAESTRO_PUBLISHER_CONFORMANCE_FIXTURE_NAME,
	buildCanonicalMaestroPublisherConformanceFixture,
	canonicalMaestroPublisherConformanceFixtureJson,
	type BuildMaestroPublisherConformanceFixtureOptions,
	type MaestroPublisherConformanceFixture,
	type MaestroPublisherConformanceFixtureEvent,
} from "./maestro-publisher-conformance-fixture.js";

export {
	CANONICAL_MAESTRO_PLATFORM_REPLAY_FIXTURE_NAME,
	buildCanonicalMaestroPlatformReplayFixture,
	canonicalMaestroPlatformReplayFixtureJson,
	type MaestroPlatformReplayFixture,
	type MaestroPlatformReplayFixtureEvent,
} from "./maestro-platform-replay-fixture.js";

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
