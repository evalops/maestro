/**
 * Comprehensive hook system for Claude Code-style lifecycle events.
 *
 * Hooks allow external programs to intercept, modify, or block agent operations
 * at various points in the execution lifecycle.
 */

import type { ToolCall, ToolResultMessage } from "../agent/types.js";

/**
 * All supported hook event types.
 */
export type HookEventType =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "EvalGate"
	| "SessionStart"
	| "SessionEnd"
	| "SessionSwitch"
	| "SubagentStart"
	| "SubagentStop"
	| "UserPromptSubmit"
	| "Notification"
	| "PreCompact"
	| "PermissionRequest"
	| "Overflow"
	| "PreMessage"
	| "PostMessage"
	| "OnError"
	| "Branch";

/**
 * Base hook input shared across all hook types.
 */
export interface HookInputBase {
	/** Event type identifier */
	hook_event_name: HookEventType;
	/** Session ID if available */
	session_id?: string;
	/** Current working directory */
	cwd: string;
	/** Timestamp in ISO format */
	timestamp: string;
}

/**
 * Input for PreToolUse hooks - called before a tool is executed.
 */
export interface PreToolUseHookInput extends HookInputBase {
	hook_event_name: "PreToolUse";
	/** Name of the tool about to be executed */
	tool_name: string;
	/** Tool call ID */
	tool_call_id: string;
	/** Arguments passed to the tool */
	tool_input: Record<string, unknown>;
}

/**
 * Input for PostToolUse hooks - called after successful tool execution.
 */
export interface PostToolUseHookInput extends HookInputBase {
	hook_event_name: "PostToolUse";
	/** Name of the tool that was executed */
	tool_name: string;
	/** Tool call ID */
	tool_call_id: string;
	/** Arguments that were passed to the tool */
	tool_input: Record<string, unknown>;
	/** Result from tool execution (truncated if large) */
	tool_output: string;
	/** Whether the tool result was an error */
	is_error: boolean;
}

/**
 * Input for EvalGate hooks - called to score tool execution.
 */
export interface EvalGateHookInput extends HookInputBase {
	hook_event_name: "EvalGate";
	/** Name of the tool that was executed */
	tool_name: string;
	/** Tool call ID */
	tool_call_id: string;
	/** Arguments that were passed to the tool */
	tool_input: Record<string, unknown>;
	/** Result from tool execution (truncated if large) */
	tool_output: string;
	/** Whether the tool result was an error */
	is_error: boolean;
}

/**
 * Input for PostToolUseFailure hooks - called when tool execution fails.
 */
export interface PostToolUseFailureHookInput extends HookInputBase {
	hook_event_name: "PostToolUseFailure";
	/** Name of the tool that failed */
	tool_name: string;
	/** Tool call ID */
	tool_call_id: string;
	/** Arguments that were passed to the tool */
	tool_input: Record<string, unknown>;
	/** Error message */
	error: string;
}

/**
 * Input for SessionStart hooks - called when a session begins.
 */
export interface SessionStartHookInput extends HookInputBase {
	hook_event_name: "SessionStart";
	/** Source of the session (interactive, headless, api, etc.) */
	source: string;
	/** User ID if available */
	user_id?: string;
	/** Organization ID if available */
	org_id?: string;
}

/**
 * Input for SessionEnd hooks - called when a session ends.
 */
export interface SessionEndHookInput extends HookInputBase {
	hook_event_name: "SessionEnd";
	/** Reason for session ending */
	reason: "user_exit" | "error" | "timeout" | "abort" | "complete";
	/** Duration in milliseconds */
	duration_ms: number;
	/** Number of turns in the session */
	turn_count: number;
}

/**
 * Input for SessionSwitch hooks - called when switching to a different session.
 */
export interface SessionSwitchHookInput extends HookInputBase {
	hook_event_name: "SessionSwitch";
	/** Session ID being switched from (null if no previous session) */
	from_session_id?: string;
	/** Session ID being switched to */
	to_session_id: string;
	/** Number of messages in the target session */
	message_count: number;
	/** Whether this is a resume operation */
	is_resume: boolean;
}

/**
 * Input for SubagentStart hooks - called before spawning a subagent.
 */
export interface SubagentStartHookInput extends HookInputBase {
	hook_event_name: "SubagentStart";
	/** Type of agent being spawned */
	agent_type: string;
	/** Prompt being sent to the subagent */
	prompt: string;
	/** Parent session ID */
	parent_session_id?: string;
}

/**
 * Input for SubagentStop hooks - called when a subagent completes.
 */
export interface SubagentStopHookInput extends HookInputBase {
	hook_event_name: "SubagentStop";
	/** Type of agent that completed */
	agent_type: string;
	/** Agent's unique ID */
	agent_id: string;
	/** Whether the agent completed successfully */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Duration of subagent execution in milliseconds */
	duration_ms: number;
	/** Number of turns the subagent took */
	turn_count: number;
	/** Path to the subagent transcript */
	transcript_path?: string;
	/** Parent session ID */
	parent_session_id?: string;
}

/**
 * Input for UserPromptSubmit hooks - called when user submits a prompt.
 */
export interface UserPromptSubmitHookInput extends HookInputBase {
	hook_event_name: "UserPromptSubmit";
	/** The user's prompt text */
	prompt: string;
	/** Number of attachments */
	attachment_count: number;
}

/**
 * Input for Notification hooks - called on various notifications.
 */
export interface NotificationHookInput extends HookInputBase {
	hook_event_name: "Notification";
	/** Type of notification */
	notification_type: string;
	/** Notification message */
	message: string;
}

/**
 * Input for PreCompact hooks - called before context compaction.
 */
export interface PreCompactHookInput extends HookInputBase {
	hook_event_name: "PreCompact";
	/** What triggered the compaction */
	trigger: "auto" | "manual" | "token_limit";
	/** Current token count */
	token_count: number;
	/** Target token count after compaction */
	target_token_count: number;
}

/**
 * Input for PermissionRequest hooks - called when permission is required.
 */
export interface PermissionRequestHookInput extends HookInputBase {
	hook_event_name: "PermissionRequest";
	/** Tool requesting permission */
	tool_name: string;
	/** Tool call ID */
	tool_call_id: string;
	/** Arguments for the tool */
	tool_input: Record<string, unknown>;
	/** Reason permission is required */
	reason: string;
}

/**
 * Input for Overflow hooks - called when context overflow is detected.
 */
export interface OverflowHookInput extends HookInputBase {
	hook_event_name: "Overflow";
	/** Current token count */
	token_count: number;
	/** Maximum allowed tokens */
	max_tokens: number;
	/** Model being used */
	model?: string;
}

/**
 * Input for PreMessage hooks - called before user message is sent to model.
 */
export interface PreMessageHookInput extends HookInputBase {
	hook_event_name: "PreMessage";
	/** The user's message content */
	message: string;
	/** Attached files (paths) */
	attachments: string[];
	/** Current model being used */
	model?: string;
}

/**
 * Input for PostMessage hooks - called after assistant response is generated.
 */
export interface PostMessageHookInput extends HookInputBase {
	hook_event_name: "PostMessage";
	/** The assistant's response (text content only) */
	response: string;
	/** Number of tokens used in input */
	input_tokens: number;
	/** Number of tokens in output */
	output_tokens: number;
	/** Total turn duration in milliseconds */
	duration_ms: number;
	/** Stop reason (if available) */
	stop_reason?: string;
}

/**
 * Input for OnError hooks - called when an error occurs.
 */
export interface OnErrorHookInput extends HookInputBase {
	hook_event_name: "OnError";
	/** Error message */
	error: string;
	/** Error kind/type */
	error_kind: string;
	/** Context where error occurred (tool name, api call, etc.) */
	context?: string;
	/** Whether the error is recoverable */
	recoverable: boolean;
}

/**
 * Input for Branch hooks - called when a session branch is created.
 */
export interface BranchHookInput extends HookInputBase {
	hook_event_name: "Branch";
	/** Session ID of the parent session */
	parent_session_id?: string;
	/** Index of the message being branched from */
	branch_from_index: number;
	/** Number of messages being kept in the new branch */
	messages_kept: number;
	/** The new session ID for the branched session */
	new_session_id?: string;
}

/**
 * Union of all hook input types.
 */
export type HookInput =
	| PreToolUseHookInput
	| PostToolUseHookInput
	| PostToolUseFailureHookInput
	| EvalGateHookInput
	| SessionStartHookInput
	| SessionEndHookInput
	| SessionSwitchHookInput
	| SubagentStartHookInput
	| SubagentStopHookInput
	| UserPromptSubmitHookInput
	| NotificationHookInput
	| PreCompactHookInput
	| PermissionRequestHookInput
	| OverflowHookInput
	| PreMessageHookInput
	| PostMessageHookInput
	| OnErrorHookInput
	| BranchHookInput;

/**
 * Permission decision that hooks can return.
 */
export type HookPermissionDecision = "allow" | "deny" | "ask";

/**
 * Hook-specific output for PreToolUse events.
 */
export interface PreToolUseHookOutput {
	hookEventName: "PreToolUse";
	/** Permission decision for this tool call */
	permissionDecision?: HookPermissionDecision;
	/** Reason for the permission decision */
	permissionDecisionReason?: string;
	/** Modified tool input to use instead of original */
	updatedInput?: Record<string, unknown>;
}

/**
 * Hook-specific output for PostToolUse events.
 */
export interface PostToolUseHookOutput {
	hookEventName: "PostToolUse";
	/** Additional context to inject into conversation */
	additionalContext?: string;
	/** Updated MCP tool output (for MCP tools only) */
	updatedMCPToolOutput?: unknown;
	/** Structured assertions produced by the tool */
	assertions?: EvalAssertion[];
}

/**
 * Structured evaluation assertion.
 */
export interface EvalAssertion {
	/** Unique identifier for the assertion */
	id?: string;
	/** Human-friendly assertion name */
	name: string;
	/** Description or notes about the assertion */
	description?: string;
	/** Whether the assertion passed */
	passed?: boolean;
	/** Numerical score for the assertion */
	score?: number;
	/** Passing threshold */
	threshold?: number;
	/** Severity if the assertion fails */
	severity?: "info" | "warn" | "error";
	/** Evidence string supporting the assertion */
	evidence?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Hook-specific output for EvalGate events.
 */
export interface EvalGateHookOutput {
	hookEventName: "EvalGate";
	/** Assertions reported by the evaluation */
	assertions?: EvalAssertion[];
	/** Aggregate evaluation score */
	score?: number;
	/** Required threshold */
	threshold?: number;
	/** Whether the evaluation passed */
	passed?: boolean;
	/** Optional rationale */
	rationale?: string;
}

/**
 * Hook-specific output for PostToolUseFailure events.
 */
export interface PostToolUseFailureHookOutput {
	hookEventName: "PostToolUseFailure";
	/** Additional context about the failure */
	additionalContext?: string;
}

/**
 * Hook-specific output for SessionStart events.
 */
export interface SessionStartHookOutput {
	hookEventName: "SessionStart";
	/** Additional context to inject at session start */
	additionalContext?: string;
}

/**
 * Hook-specific output for SubagentStart events.
 */
export interface SubagentStartHookOutput {
	hookEventName: "SubagentStart";
	/** Additional context for the subagent */
	additionalContext?: string;
}

/**
 * Hook-specific output for SubagentStop events.
 */
export interface SubagentStopHookOutput {
	hookEventName: "SubagentStop";
	/** Additional context about subagent completion */
	additionalContext?: string;
}

/**
 * Hook-specific output for SessionSwitch events.
 */
export interface SessionSwitchHookOutput {
	hookEventName: "SessionSwitch";
	/** Additional context to inject after session switch */
	additionalContext?: string;
	/** If true, skip restoring the conversation view */
	skipConversationRestore?: boolean;
	/** Custom message to display after switch */
	message?: string;
}

/**
 * Hook-specific output for UserPromptSubmit events.
 */
export interface UserPromptSubmitHookOutput {
	hookEventName: "UserPromptSubmit";
	/** Additional context to inject with the prompt */
	additionalContext: string;
}

/**
 * Hook-specific output for PermissionRequest events.
 */
export interface PermissionRequestHookOutput {
	hookEventName: "PermissionRequest";
	/** Decision from the hook */
	decision?: {
		behavior: "allow" | "deny";
		updatedInput?: Record<string, unknown>;
	};
}

/**
 * Hook-specific output for Branch events.
 */
export interface BranchHookOutput {
	hookEventName: "Branch";
	/** If true, skip the default conversation restore behavior */
	skipConversationRestore?: boolean;
	/** Optional git ref to checkout when branching */
	gitCheckout?: string;
	/** Custom message to display after branching */
	message?: string;
}

/**
 * Union of all hook-specific outputs.
 */
export type HookSpecificOutput =
	| PreToolUseHookOutput
	| PostToolUseHookOutput
	| PostToolUseFailureHookOutput
	| EvalGateHookOutput
	| SessionStartHookOutput
	| SubagentStartHookOutput
	| SubagentStopHookOutput
	| SessionSwitchHookOutput
	| UserPromptSubmitHookOutput
	| PermissionRequestHookOutput
	| BranchHookOutput;

/**
 * JSON output format that hooks should return.
 */
export interface HookJsonOutput {
	/** If false, prevents the agent from continuing */
	continue?: boolean;
	/** If continue is false, this explains why */
	stopReason?: string;
	/** Suppress normal output display */
	suppressOutput?: boolean;
	/** Legacy decision field (approve/block) */
	decision?: "approve" | "block";
	/** Reason for the decision */
	reason?: string;
	/** System message to inject */
	systemMessage?: string;
	/** Legacy permission decision field */
	permissionDecision?: HookPermissionDecision;
	/** Hook-specific output based on event type */
	hookSpecificOutput?: HookSpecificOutput;
}

/**
 * Parsed result from hook execution.
 */
export interface HookExecutionResult {
	/** Whether to prevent continuation */
	preventContinuation?: boolean;
	/** Reason for stopping */
	stopReason?: string;
	/** Permission behavior override */
	permissionBehavior?: "allow" | "deny" | "ask";
	/** Reason for permission decision */
	hookPermissionDecisionReason?: string;
	/** Blocking error details */
	blockingError?: {
		blockingError: string;
		command: string;
	};
	/** System message to inject */
	systemMessage?: string;
	/** Additional context to add */
	additionalContext?: string;
	/** Updated tool input */
	updatedInput?: Record<string, unknown>;
	/** Updated MCP tool output */
	updatedMCPToolOutput?: unknown;
	/** Evaluation assertions */
	assertions?: EvalAssertion[];
	/** Evaluation summary */
	evaluation?: {
		score?: number;
		threshold?: number;
		passed?: boolean;
		rationale?: string;
	};
	/** Permission request result */
	permissionRequestResult?: {
		behavior: "allow" | "deny";
		updatedInput?: Record<string, unknown>;
	};
	/** Message attachment for UI display */
	message: HookResultMessage;
}

/**
 * Types of hook result messages for UI display.
 */
export type HookResultMessageType =
	| "hook_success"
	| "hook_blocking_error"
	| "hook_non_blocking_error"
	| "hook_error_during_execution"
	| "hook_cancelled"
	| "hook_system_message"
	| "hook_additional_context"
	| "hook_stopped_continuation"
	| "hook_evaluation";

/**
 * Message attachment from hook execution.
 */
export interface HookResultMessage {
	type: HookResultMessageType;
	hookName: string;
	hookEvent: HookEventType;
	toolUseID?: string;
	content?: string;
	blockingError?: {
		blockingError: string;
		command: string;
	};
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

/**
 * Configuration for a single hook command.
 */
export interface HookCommandConfig {
	type: "command";
	/** Shell command to execute */
	command: string;
	/** Timeout in seconds (default: 60) */
	timeout?: number;
}

/**
 * Configuration for a hook that uses a prompt.
 */
export interface HookPromptConfig {
	type: "prompt";
	/** Prompt template */
	prompt: string;
}

/**
 * Configuration for a hook that spawns an agent.
 */
export interface HookAgentConfig {
	type: "agent";
	/** Function to generate the prompt */
	prompt: (context: unknown[]) => string;
}

/**
 * Configuration for a callback-based hook.
 */
export interface HookCallbackConfig {
	type: "callback";
	/** Callback function */
	callback: (input: HookInput) => Promise<HookJsonOutput | null>;
}

/**
 * Configuration for a TypeScript hook file.
 * TypeScript hooks are loaded via jiti and export a default function.
 */
export interface HookTypeScriptConfig {
	type: "typescript";
	/** Path to the TypeScript file */
	path: string;
	/** Resolved absolute path */
	resolvedPath?: string;
}

/**
 * Union of all hook configuration types.
 */
export type HookConfig =
	| HookCommandConfig
	| HookPromptConfig
	| HookAgentConfig
	| HookCallbackConfig
	| HookTypeScriptConfig;

/**
 * A matcher with associated hooks.
 */
export interface HookMatcher {
	/** Pattern to match (tool name, source, etc.) - "*" or undefined matches all */
	matcher?: string;
	/** Hooks to execute when matcher matches */
	hooks: HookConfig[];
}

/**
 * Full hook configuration by event type.
 */
export type HookConfiguration = Partial<Record<HookEventType, HookMatcher[]>>;

/**
 * Result of running a single hook command.
 */
export interface HookCommandResult {
	stdout: string;
	stderr: string;
	status: number;
	aborted?: boolean;
}

/**
 * Async hook detection response.
 */
export interface AsyncHookResponse {
	async: true;
	processId: string;
	message?: string;
}

/**
 * Check if a response indicates async execution.
 */
export function isAsyncHookResponse(
	response: unknown,
): response is AsyncHookResponse {
	return (
		typeof response === "object" &&
		response !== null &&
		"async" in response &&
		response.async === true
	);
}

// ============================================================================
// Hook API Types (for TypeScript hooks - pi-mono style)
// ============================================================================

/**
 * Attachment that can be sent with a message.
 */
export interface HookAttachment {
	/** Unique identifier */
	id: string;
	/** Type of attachment */
	type: "image" | "document";
	/** Original file name */
	fileName: string;
	/** MIME type */
	mimeType: string;
	/** File size in bytes */
	size: number;
	/** Base64 encoded content */
	content: string;
}

/**
 * Handler for sending messages from hooks.
 */
export type HookSendHandler = (
	text: string,
	attachments?: HookAttachment[],
) => void;

/**
 * UI context available to hooks for interactive prompts.
 */
export interface HookUIContext {
	/**
	 * Show a selection list and return the selected option.
	 * Returns null if the user cancels.
	 */
	select(title: string, options: string[]): Promise<string | null>;

	/**
	 * Show a confirmation dialog.
	 * Returns true if confirmed, false otherwise.
	 */
	confirm(title: string, message: string): Promise<boolean>;

	/**
	 * Show an input prompt for text entry.
	 * Returns null if the user cancels.
	 */
	input(title: string, placeholder?: string): Promise<string | null>;

	/**
	 * Show a notification message.
	 */
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * Context passed to hook event handlers.
 */
export interface HookEventContext {
	/** Execute a command in the working directory */
	exec(command: string, args: string[]): Promise<ExecResult>;
	/** UI methods for interactive hooks */
	ui: HookUIContext;
	/** Whether interactive UI is available */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session file path or null */
	sessionFile: string | null;
}

/**
 * Result of executing a command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Handler type for hook events.
 */
export type HookHandler<E, R = void> = (
	event: E,
	ctx: HookEventContext,
) => Promise<R>;

/**
 * API provided to TypeScript hooks.
 * This is the "pi" object in pi-mono style hooks.
 */
export interface HookAPI {
	/**
	 * Register a handler for an event.
	 */
	on<E extends HookEventType>(
		event: E,
		handler: HookHandler<HookInput, HookJsonOutput | undefined>,
	): void;

	/**
	 * Send a message to the agent.
	 * If the agent is streaming, the message is queued.
	 * If the agent is idle, a new prompt cycle is started.
	 */
	send(text: string, attachments?: HookAttachment[]): void;
}

/**
 * Factory function exported by TypeScript hooks.
 */
export type HookFactory = (api: HookAPI) => void;

/**
 * A loaded TypeScript hook with its registered handlers.
 */
export interface LoadedTypeScriptHook {
	/** Original path from config */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** Registered event handlers */
	handlers: Map<
		HookEventType,
		Array<HookHandler<HookInput, HookJsonOutput | undefined>>
	>;
	/** Send handler setter */
	setSendHandler: (handler: HookSendHandler) => void;
}
