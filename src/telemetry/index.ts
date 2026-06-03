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
	recordSubagentDispatch,
	recordA2ADelegationTelemetry,
	recordA2APeerExclusionTelemetry,
	recordA2APolicyDenialTelemetry,
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
	type SubagentDispatchTelemetry,
	type A2ADelegationTelemetryInput,
	type A2ADelegationTelemetryPhase,
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
	hashA2AEndpointUrl,
	maestroCorrelationToChronicleMetadata,
	publishMaestroCloudEvent,
	publishMaestroCloudEventStrict,
	recordMaestroA2ADelegationEvent,
	recordMaestroApprovalHit,
	recordMaestroEvalScored,
	recordMaestroFirewallBlock,
	recordMaestroLearnedContext,
	recordMaestroPromptVariantSelected,
	recordMaestroSessionEvent,
	recordMaestroSkillInvoked,
	recordMaestroSkillOutcome,
	recordMaestroSubagentDispatch,
	recordMaestroToolCallAttempt,
	recordMaestroToolCallCompleted,
	resolveMaestroEventBusConfig,
	setMaestroEventBusTransportForTests,
	type ApprovalHitEventData,
	type EvalScoredEventData,
	type FirewallBlockEventData,
	type MaestroA2ADelegationEventData,
	type MaestroCloudEvent,
	type MaestroCloseReason,
	type MaestroCorrelation,
	type MaestroDecisionMode,
	type MaestroEventBusConfig,
	type MaestroEventBusStatus,
	type MaestroEventBusTransport,
	type MaestroLearnedContextEventData,
	type MaestroLearnedContextEvidence,
	type MaestroPrincipal,
	type MaestroRuntimeMode,
	type MaestroSessionEventData,
	type MaestroSessionState,
	type MaestroSkillOutcomeProtoStatus,
	type MaestroSkillOutcomeStatus,
	type MaestroSurface,
	type MaestroToolCallStatus,
	type PublishMaestroEventOptions,
	type RecordMaestroA2ADelegationEventInput,
	type RecordMaestroApprovalHitInput,
	type RecordMaestroEvalScoredInput,
	type RecordMaestroFirewallBlockInput,
	type RecordMaestroLearnedContextInput,
	type RecordMaestroPromptVariantSelectedInput,
	type PromptVariantSelectedEventData,
	type RecordMaestroSkillInvokedInput,
	type RecordMaestroSkillOutcomeInput,
	type RecordMaestroSubagentDispatchInput,
	type RecordMaestroToolCallAttemptInput,
	type RecordMaestroToolCallCompletedInput,
	type SandboxViolationEventData,
	type SkillInvocationEventData,
	type SkillOutcomeEventData,
	type SubagentDispatchEventData,
	type ToolCallAttemptEventData,
	type ToolCallResultEventData,
} from "./maestro-event-bus.js";

export {
	AGENT_WORKFORCE_NATIVE_EVENT_SCHEMA_VERSION,
	AgentWorkforceNativeEventProjector,
	projectAgentWorkforceNativeEvents,
	verifyAgentWorkforceNativeEventChain,
	type AgentWorkforceAction,
	type AgentWorkforceAssociatedHuman,
	type AgentWorkforceCredentialAssumption,
	type AgentWorkforceCredentialDeclaredAuthority,
	type AgentWorkforceCredentialJoinKind,
	type AgentWorkforceCredentialJoinRef,
	type AgentWorkforceCredentialProofStatus,
	type AgentWorkforceDeclaredCredential,
	type AgentWorkforceEmitter,
	type AgentWorkforceEvidence,
	type AgentWorkforceEvidenceAuthority,
	type AgentWorkforceEvidenceKind,
	type AgentWorkforceEvidenceRef,
	type AgentWorkforceMissingEvidence,
	type AgentWorkforceModelUsage,
	type AgentWorkforceNativeChainVerification,
	type AgentWorkforceNativeEvent,
	type AgentWorkforceNativeEventType,
	type AgentWorkforceNativeProjectionOptions,
	type AgentWorkforcePolicy,
	type AgentWorkforcePlatformCredentialAuthority,
	type AgentWorkforceRun,
	type AgentWorkforceSourceAuthority,
	type AgentWorkforceTenant,
	type AgentWorkforceTimelineCorrelation,
	type AgentWorkforceVerifiedCredentialAuthority,
	type AgentWorkforceVerifiedProvenance,
	type AgentWorkforceVerifiedRevocationStatus,
} from "./agent-workforce-native-event.js";

export {
	AGENT_WORKFORCE_NATIVE_EVENT_BATCH_SCHEMA_VERSION,
	DEFAULT_AGENT_WORKFORCE_NATIVE_EVENT_MAX_ATTEMPTS,
	DEFAULT_AGENT_WORKFORCE_NATIVE_EVENT_TIMEOUT_MS,
	buildAgentWorkforceNativeEventBatchBody,
	mirrorAgentWorkforceNativeEventsToPlatform,
	postAgentWorkforceNativeEventBatchToPlatform,
	resolveAgentWorkforceNativeEventPlatformConfig,
	sanitizeAgentWorkforceNativeEventForPlatformPost,
	type AgentWorkforceNativeEventBatchBody,
	type AgentWorkforceNativeEventPlatformConfig,
	type AgentWorkforceNativeEventPostOptions,
	type AgentWorkforceNativeEventPostResult,
} from "./agent-workforce-native-event-client.js";

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

export {
	buildAgentOperatingPlaneContext,
	buildAgentOperatingPlaneCorrelation,
	buildAgentOperatingPlaneMetadata,
	type AgentOperatingPlaneContext,
	type AgentOperatingPlaneContextInput,
	type AgentOperatingPlaneCorrelationInput,
	type AgentOperatingPlaneDataClassification,
	type AgentOperatingPlaneMetadataInput,
	type AgentOperatingPlaneRetentionClass,
} from "./agent-operating-plane-context.js";

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

export {
	emitBeacon,
	emitBeaconBatch,
	isBeaconEnabled,
	normalizeBeaconEvent,
	type BeaconEvent,
	type EmitBeaconOptions,
} from "./beacon.js";

export {
	CliCommandAggregator,
	getGlobalCliCommandAggregator,
	normalizeCommandAction,
	resetGlobalCliCommandAggregatorForTests,
	type CliCommandAggregatorOptions,
} from "./cli-command-aggregator.js";

export {
	cliCommandName,
	recordCliStartupTelemetry,
	type RecordCliStartupTelemetryOptions,
} from "./cli-startup.js";
