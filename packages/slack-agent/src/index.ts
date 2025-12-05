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
