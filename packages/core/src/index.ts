// @evalops/maestro-core — Agent loop, transport, types, and sandbox primitives

// ── Agent Core ──
export { Agent } from "../../../src/agent/agent.js";
export type { AgentOptions } from "../../../src/agent/agent.js";
export type {
	AgentState,
	AgentEvent,
	AgentRunConfig,
	Message,
	UserMessage,
	AssistantMessage,
	ToolResultMessage,
	TextContent,
	ToolCall,
} from "../../../src/agent/types.js";

// ── Transport ──
export { ProviderTransport } from "../../../src/agent/transport.js";
export type { ProviderTransportOptions } from "../../../src/agent/transport.js";

// ── Subagent Specs ──
export {
	getSubagentSpec,
	isToolAllowed,
	getAllowedTools,
	filterToolsForSubagent,
	TOOL_CATEGORIES,
} from "../../../src/agent/subagent-specs.js";
export type {
	SubagentType,
	SubagentSpec,
} from "../../../src/agent/subagent-specs.js";

// ── Context Handoff ──
export { ContextHandoffManager } from "../../../src/agent/context-handoff.js";
export type {
	HandoffContext,
	ContextThresholds,
} from "../../../src/agent/context-handoff.js";

// ── Type Guards ──
export {
	isUserMessage,
	isAssistantMessage,
	isToolResultMessage,
	isTextContent,
	isToolCall,
} from "../../../src/agent/type-guards.js";

// ── Background Task Primitives ──
export {
	createRestartPolicy,
	canRestart,
	computeRestartDelay,
	incrementAttempts,
} from "../../../src/tools/background/restart-policy.js";
export type {
	RestartPolicy,
	RestartPolicyOptions,
} from "../../../src/tools/background/restart-policy.js";
export type {
	BackgroundTaskStatus,
	BackgroundTaskNotification,
	BackgroundTaskHealth,
	BackgroundTaskHealthEntry,
} from "../../../src/tools/background/task-types.js";
export {
	formatTaskSummary,
	formatUsageSummary,
} from "../../../src/tools/background/task-types.js";
