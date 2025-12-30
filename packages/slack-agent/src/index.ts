/**
 * @evalops/slack-agent
 *
 * Slack bot agent with Docker sandbox support for Composer
 */

// Slack integration
export {
	SlackBot,
	type SlackBotConfig,
	type SlackAgentHandler,
	type SlackContext,
	type SlackMessage,
	type ReactionContext,
	type ChannelInfo,
	type UserInfo,
} from "./slack/bot.js";

// Sandbox execution
export {
	createExecutor,
	parseSandboxArg,
	validateSandbox,
	type Executor,
	type ExecOptions,
	type ExecResult,
	type SandboxConfig,
} from "./sandbox.js";

// Storage
export {
	ChannelStore,
	type ChannelStoreConfig,
	type Attachment,
	type LoggedMessage,
} from "./store.js";

// Scheduler
export {
	Scheduler,
	parseTimeExpression,
	parseRecurringSchedule,
	getNextRunFromSchedule,
	type ScheduledTask,
	type SchedulerConfig,
} from "./scheduler.js";

// Approval workflows
export {
	ApprovalManager,
	isDestructiveCommand,
	describeDestructiveOperation,
	DESTRUCTIVE_PATTERNS,
	type PendingApproval,
	type ApprovalManagerConfig,
} from "./approval.js";

// Cost tracking
export {
	CostTracker,
	type UsageRecord,
	type ChannelUsage,
	type UsageSummary,
} from "./cost-tracker.js";

// Rate limiting
export { RateLimiter, formatRateLimitMessage } from "./rate-limiter.js";

// Tools
export {
	createSlackAgentTools,
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	attachTool,
	setUploadFunction,
	type AgentTool,
} from "./tools/index.js";

// Logging
export * as logger from "./logger.js";

// Enterprise Features

// Storage abstraction (file or Redis)
export {
	FileStorageBackend,
	createRedisBackend,
	createStorageBackend,
	type StorageBackend,
	type StorageConfig,
	type StorageType,
	type RedisConfig,
} from "./storage.js";

// OAuth & Multi-workspace
export {
	WorkspaceManager,
	startOAuthServer,
	verifySlackSignature,
	DEFAULT_BOT_SCOPES,
	type OAuthConfig,
	type OAuthServerConfig,
	type WorkspaceCredentials,
} from "./oauth.js";

// Permissions (RBAC)
export {
	PermissionManager,
	type SlackRole,
	type UserPermissions,
	type PermissionCheck,
} from "./permissions.js";

// Thread memory (conversation context)
export {
	ThreadMemoryManager,
	type ThreadMessage,
	type ThreadContext,
	type ThreadMemoryConfig,
} from "./thread-memory.js";

// Idempotency (duplicate event prevention)
export {
	IdempotencyManager,
	withIdempotency,
	type IdempotencyConfig,
	type IdempotencyCheckResult,
} from "./idempotency.js";

// Audit logging
export {
	AuditLogger,
	type AuditAction,
	type AuditEntry,
	type AuditLoggerConfig,
} from "./audit.js";

// Error handling
export {
	SlackAgentError,
	ApiError,
	ConfigError,
	FileSystemError,
	ValidationError,
	getErrorMessage,
	getErrorStack,
	wrapError,
	logError,
	tryAsync,
	trySync,
	retryAsync,
	isRetryableError,
	assertValid,
	assertDefined,
} from "./errors.js";

// Utilities
export {
	ok,
	err,
	isOk,
	isErr,
	unwrap,
	unwrapOr,
	map,
	mapErr,
	andThen,
	tryCatch,
	tryCatchAsync,
	all,
	tap,
	tapErr,
	toPromise,
	fromPromise,
	type Result,
} from "./utils/result.js";

export {
	ApiQueue,
	createApiQueue,
	RATE_LIMIT_TIERS,
	METHOD_TIERS,
	type ApiQueueOptions,
	type RateLimitTier,
} from "./utils/api-queue.js";

export {
	MessageQueue,
	type MessageHandler,
	type MessageQueueOptions,
} from "./utils/message-queue.js";

export {
	createTimestampGenerator,
	parseSlackTimestamp,
	compareSlackTimestamps,
	type TimestampGenerator,
} from "./utils/slack-timestamp.js";

export { TtlCache, type TtlCacheConfig } from "./utils/ttl-cache.js";

export {
	ShutdownManager,
	createShutdownManager,
	setupGracefulShutdown,
	type ShutdownHandler,
	type ShutdownManagerConfig,
	type ShutdownResult,
} from "./utils/graceful-shutdown.js";

export {
	CircuitBreaker,
	CircuitOpenError,
	createCircuitBreaker,
	createSlackCircuitBreaker,
	type CircuitState,
	type CircuitBreakerConfig,
	type CircuitBreakerStats,
} from "./utils/circuit-breaker.js";

export {
	HealthChecker,
	createHealthChecker,
	createHealthEndpoints,
	standardChecks,
	type HealthStatus,
	type ComponentHealth,
	type HealthCheckResult,
	type HealthCheckFn,
	type HealthCheckerConfig,
} from "./utils/health-check.js";

export {
	MetricsCollector,
	createMetricsCollector,
	createSlackMetrics,
	type Tags,
	type Timer,
	type HistogramSummary,
	type MetricSummary,
	type MetricsCollectorConfig,
	type SlackMetrics,
} from "./utils/metrics.js";

export {
	TypedEmitter,
	createTypedEmitter,
	createSlackAgentEmitter,
	type EventHandler,
	type AsyncEventHandler,
	type SlackAgentEvents,
} from "./utils/typed-emitter.js";
