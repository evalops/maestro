/**
 * Comprehensive hook system for Claude Code-style lifecycle events.
 *
 * This module provides a hook system that allows external programs to intercept,
 * modify, or block agent operations at various points in the execution lifecycle.
 *
 * ## Hook Events
 *
 * - **PreToolUse**: Before a tool is executed (can block or modify input)
 * - **PostToolUse**: After successful tool execution (can add context)
 * - **PostToolUseFailure**: After tool execution fails
 * - **SessionStart**: When a session begins
 * - **SessionEnd**: When a session ends
 * - **SubagentStart**: Before spawning a subagent
 * - **SubagentStop**: When a subagent completes
 * - **UserPromptSubmit**: When user submits a prompt
 * - **Notification**: On various notifications
 * - **PreCompact**: Before context compaction
 * - **PermissionRequest**: When permission is required
 *
 * ## Configuration
 *
 * Hooks can be configured via:
 * - Environment variables: `COMPOSER_HOOKS_PRE_TOOL_USE="my-script.sh"`
 * - User config: `~/.composer/hooks.json`
 * - Project config: `.composer/hooks.json`
 * - Programmatic registration: `registerHook(...)`
 *
 * ## Hook Output Format
 *
 * Hook commands receive JSON via stdin and should output JSON:
 *
 * ```json
 * {
 *   "continue": true,
 *   "decision": "approve",
 *   "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "permissionDecision": "allow"
 *   }
 * }
 * ```
 *
 * @module hooks
 */

// Type exports
export type {
	// Event types
	HookEventType,
	// Input types
	HookInput,
	HookInputBase,
	PreToolUseHookInput,
	PostToolUseHookInput,
	PostToolUseFailureHookInput,
	SessionStartHookInput,
	SessionEndHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
	UserPromptSubmitHookInput,
	NotificationHookInput,
	PreCompactHookInput,
	PermissionRequestHookInput,
	// Output types
	HookJsonOutput,
	HookSpecificOutput,
	HookPermissionDecision,
	PreToolUseHookOutput,
	PostToolUseHookOutput,
	PostToolUseFailureHookOutput,
	SessionStartHookOutput,
	SubagentStartHookOutput,
	SubagentStopHookOutput,
	UserPromptSubmitHookOutput,
	PermissionRequestHookOutput,
	// Result types
	HookExecutionResult,
	HookResultMessage,
	HookResultMessageType,
	// Config types
	HookConfig,
	HookCommandConfig,
	HookPromptConfig,
	HookAgentConfig,
	HookCallbackConfig,
	HookMatcher,
	HookConfiguration,
	HookCommandResult,
	AsyncHookResponse,
} from "./types.js";

export { isAsyncHookResponse } from "./types.js";

// Configuration exports
export {
	loadHookConfiguration,
	clearHookConfigCache,
	registerHook,
	clearRegisteredHooks,
	getMatchingHooks,
	matchesPattern,
	getMatchTarget,
	getUserHooksConfigPath,
	getProjectHooksConfigPath,
} from "./config.js";

// Executor exports
export {
	executeHook,
	executeHooks,
	hasHooksForEvent,
	createHookMessage,
	getAsyncHookCount,
	cleanupAsyncHooks,
} from "./executor.js";

// Output parsing exports
export {
	parseHookOutput,
	validateHookOutput,
	safeParseHookOutput,
	getHookOutputSchema,
} from "./output.js";

// Re-export notification hooks for backwards compatibility
export {
	sendNotification,
	isNotificationEnabled,
	loadNotificationConfig,
	clearNotificationConfigCache,
	createNotificationFromAgentEvent,
	type NotificationEventType,
	type NotificationPayload,
	type NotificationHooksConfig,
} from "./notification-hooks.js";

// Integration module exports
export {
	createToolHookService,
	type ToolHookService,
	type ToolHookContext,
} from "./tool-integration.js";

export {
	createSessionHookService,
	type SessionHookService,
	type SessionHookContext,
} from "./session-integration.js";
