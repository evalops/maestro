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
 * - **EvalGate**: After tool execution to emit structured assertions/scores
 * - **PostToolUseFailure**: After tool execution fails
 * - **SessionStart**: When a session begins
 * - **SessionEnd**: When a session ends
 * - **SessionBeforeTree**: Before session tree navigation
 * - **SessionTree**: After session tree navigation
 * - **SubagentStart**: Before spawning a subagent
 * - **SubagentStop**: When a subagent completes
 * - **UserPromptSubmit**: When user submits a prompt
 * - **Notification**: On various notifications
 * - **PreCompact**: Before context compaction
 * - **PermissionRequest**: When permission is required
 * - **Overflow**: When context overflow is detected
 * - **PreMessage**: Before user message is sent to model
 * - **PostMessage**: After assistant response is generated
 * - **OnError**: When an error occurs
 *
 * ## Configuration
 *
 * Hooks can be configured via:
 * - Environment variables: `MAESTRO_HOOKS_PRE_TOOL_USE="my-script.sh"`
 * - User config: `~/.maestro/hooks.json`
 * - Project config: `.maestro/hooks.json`
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
	EvalGateHookInput,
	SessionStartHookInput,
	SessionEndHookInput,
	SessionBeforeTreeHookInput,
	SessionTreeHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
	UserPromptSubmitHookInput,
	NotificationHookInput,
	PreCompactHookInput,
	PermissionRequestHookInput,
	OverflowHookInput,
	PreMessageHookInput,
	PostMessageHookInput,
	OnErrorHookInput,
	// Tool-specific hook input types
	BashToolHookInput,
	ReadToolHookInput,
	WriteToolHookInput,
	EditToolHookInput,
	GlobToolHookInput,
	GrepToolHookInput,
	TaskToolHookInput,
	WebFetchToolHookInput,
	WebSearchToolHookInput,
	// Output types
	HookJsonOutput,
	HookSpecificOutput,
	HookPermissionDecision,
	PreToolUseHookOutput,
	PostToolUseHookOutput,
	PostToolUseFailureHookOutput,
	EvalGateHookOutput,
	SessionStartHookOutput,
	SessionBeforeTreeHookOutput,
	SubagentStartHookOutput,
	SubagentStopHookOutput,
	UserPromptSubmitHookOutput,
	PermissionRequestHookOutput,
	EvalAssertion,
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
	HookTypeScriptConfig,
	HookMatcher,
	HookConfiguration,
	HookCommandResult,
	AsyncHookResponse,
	// TypeScript hook API types
	HookAttachment,
	HookSendHandler,
	HookSendMessageHandler,
	HookAppendEntryHandler,
	HookUIContext,
	HookEventContext,
	HookCommandContext,
	ExecResult,
	HookHandler,
	HookMessageRenderer,
	HookMessageRenderOptions,
	RegisteredCommand,
	HookAPI,
	HookFactory,
	LoadedTypeScriptHook,
} from "./types.js";

export {
	isAsyncHookResponse,
	// Type guards for tool-specific hook inputs
	isBashToolHook,
	isReadToolHook,
	isWriteToolHook,
	isEditToolHook,
	isGlobToolHook,
	isGrepToolHook,
	isTaskToolHook,
	isWebFetchToolHook,
	isWebSearchToolHook,
	isFileToolHook,
	isSearchToolHook,
} from "./types.js";

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
	getHookConcurrencySnapshot,
	markAsyncHookCompleted,
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

// TypeScript hook loader exports
export {
	discoverAndLoadTypeScriptHooks,
	getLoadedTypeScriptHooks,
	getTypeScriptHookMessageRenderer,
	getTypeScriptHookCommands,
	getTypeScriptHookCommand,
	hasTypeScriptHookHandlers,
	executeTypeScriptHooks,
	setGlobalSendHandler,
	getGlobalSendHandler,
	setGlobalSendMessageHandler,
	setGlobalAppendEntryHandler,
	setGlobalUIContext,
	setGlobalCwd,
	setGlobalSessionFile,
	clearLoadedTypeScriptHooks,
	getExtensionRegisteredTools,
} from "./typescript-loader.js";

// UI context exports
export {
	createRpcUIContext,
	createNoOpUIContext,
	createConsoleUIContext,
	registerUIContext,
	getUIContext,
	clearUIContextRegistry,
	type HookUIRequest,
	type HookUIResponse,
	type HookUIRequestHandler,
} from "./ui-context.js";
