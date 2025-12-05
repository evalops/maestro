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
