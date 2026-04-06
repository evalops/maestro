/**
 * @fileoverview @evalops/contracts - Shared TypeScript Definitions
 *
 * This package provides the TypeScript type definitions that form the contract
 * between Composer's frontend (Web UI) and backend (API server). All shared
 * types, interfaces, and enums are defined here to ensure type safety across
 * the client-server boundary.
 *
 * ## Key Types
 *
 * | Type | Description |
 * |------|-------------|
 * | `ComposerMessage` | Chat message with role, content, tools, and usage |
 * | `ComposerSession` | Session with metadata and message history |
 * | `ComposerChatRequest` | Request payload for the chat API |
 * | `ComposerUsage` | Token usage and cost tracking |
 * | `ComposerToolCall` | Tool invocation with status and result |
 *
 * ## Usage
 *
 * ```typescript
 * import type {
 *   ComposerMessage,
 *   ComposerSession,
 *   ComposerChatRequest
 * } from "@evalops/contracts";
 *
 * // Type-safe message handling
 * const message: ComposerMessage = {
 *   role: "user",
 *   content: "Hello, Composer!",
 *   timestamp: new Date().toISOString(),
 * };
 *
 * // Type-safe API request
 * const request: ComposerChatRequest = {
 *   messages: [message],
 *   model: "claude-sonnet-4-5",
 *   thinkingLevel: "medium",
 * };
 * ```
 *
 * @module @evalops/contracts
 */

export * from "./headless-protocol-generated.js";
export * from "./headless-protocol-schemas.generated.js";
export * from "./mcp-settings.js";

/**
 * Role of a message in the conversation.
 *
 * - `user` - Messages from the human user
 * - `assistant` - Messages from the AI assistant
 * - `system` - System prompts and instructions
 * - `tool` - Tool execution results
 */
export type ComposerRole = "user" | "assistant" | "system" | "tool";

/**
 * Content blocks used for rich message payloads.
 */
export interface ComposerTextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ComposerImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ComposerThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

export interface ComposerToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

export type ComposerContentBlock =
	| ComposerTextContent
	| ComposerImageContent
	| ComposerThinkingContent
	| ComposerToolCallContent;

/**
 * Extended thinking/reasoning level for supported models.
 *
 * Higher levels produce more detailed reasoning at the cost of latency:
 * - `off` - No extended thinking
 * - `minimal` - Brief reasoning hints
 * - `low` - Light reasoning
 * - `medium` - Moderate reasoning depth
 * - `high` - Thorough step-by-step reasoning
 */
export type ComposerThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high";

/**
 * Represents a tool invocation within a message.
 *
 * Tools are actions the agent can take like reading files, executing commands,
 * or searching the web. Each tool call tracks its execution lifecycle.
 */
export interface ComposerToolCall {
	/** Name of the tool being invoked (e.g., "read", "bash", "search") */
	name: string;
	/** Current execution status of the tool call */
	status: "pending" | "running" | "completed" | "error";
	/** Arguments passed to the tool */
	args?: Record<string, unknown>;
	/** Result returned by the tool (if completed) */
	result?: unknown;
	/** Unique identifier for this tool call (for matching results) */
	toolCallId?: string;
}

/**
 * File attachment included in a user message.
 *
 * Attachments can be images (for vision-capable models) or documents
 * (typically accompanied by extracted text for model consumption).
 *
 * `content` is base64-encoded raw bytes. Servers may omit `content` in some
 * read APIs for size reasons; when omitted, `contentOmitted` is set to true.
 */
export interface ComposerAttachment {
	/** Unique identifier for this attachment */
	id: string;
	/** Attachment type */
	type: "image" | "document";
	/** Original filename */
	fileName: string;
	/** MIME type */
	mimeType: string;
	/** Size in bytes */
	size: number;
	/** Base64-encoded file content (may be omitted) */
	content?: string;
	/** True when `content` was intentionally omitted */
	contentOmitted?: boolean;
	/** Extracted text content (for documents) */
	extractedText?: string;
	/** Preview image (typically base64, small) */
	preview?: string;
}

/**
 * A message in the Composer conversation.
 *
 * Messages can contain text content, tool calls, thinking traces,
 * and usage statistics. This is the primary data structure for
 * conversation history.
 */
export interface ComposerMessage {
	/** Role of the message sender */
	role: ComposerRole;
	/** Text content of the message */
	content: string | ComposerContentBlock[];
	/** Optional file attachments (for user messages) */
	attachments?: ComposerAttachment[];
	/** ISO 8601 timestamp when the message was created */
	timestamp?: string;
	/** Extended thinking/reasoning trace (for supported models) */
	thinking?: string;
	/** Tool calls made in this message (for assistant messages) */
	tools?: ComposerToolCall[];
	/** Name of the tool (for tool result messages) */
	toolName?: string;
	/** Whether this message represents an error */
	isError?: boolean;
	/** Token usage and cost for this message */
	usage?: ComposerUsage;
	/** Original provider for assistant messages (for cross-provider resume) */
	provider?: string;
	/** Original API for assistant messages (for cross-provider resume) */
	api?: string;
	/** Original model ID for assistant messages (for cross-provider resume) */
	model?: string;
}

/**
 * Cost breakdown for token usage.
 *
 * Costs are typically in USD, calculated based on the model's pricing.
 */
export interface ComposerUsageCost {
	/** Cost for input tokens */
	input: number;
	/** Cost for output tokens */
	output: number;
	/** Cost savings from cache reads (if applicable) */
	cacheRead?: number;
	/** Cost for cache writes (if applicable) */
	cacheWrite?: number;
	/** Total cost for this message */
	total?: number;
}

/**
 * Token usage statistics for a message or session.
 *
 * Tracks input/output tokens and cache utilization for cost monitoring.
 */
export interface ComposerUsage {
	/** Number of input tokens consumed */
	input: number;
	/** Number of output tokens generated */
	output: number;
	/** Tokens served from cache (reduces cost) */
	cacheRead?: number;
	/** Tokens written to cache */
	cacheWrite?: number;
	/** Calculated cost breakdown */
	cost?: ComposerUsageCost;
}

/**
 * Model capability metadata exposed by the API.
 */
export interface ComposerModelCapabilities {
	streaming?: boolean;
	tools?: boolean;
	vision?: boolean;
	reasoning?: boolean;
}

/**
 * Model metadata returned by `/api/models` and `/api/model`.
 */
export interface ComposerModel {
	id: string;
	provider: string;
	name: string;
	api?: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: ComposerUsageCost;
	capabilities?: ComposerModelCapabilities;
}

/**
 * Response payload for `/api/models`.
 */
export interface ComposerModelListResponse {
	models: ComposerModel[];
}

/**
 * Argument definition for a custom command.
 */
export interface ComposerCommandArg {
	name: string;
	required?: boolean;
}

/**
 * Custom command definition (safe for client consumption).
 */
export interface ComposerCommand {
	name: string;
	description?: string;
	prompt: string;
	args?: ComposerCommandArg[];
}

/**
 * Response payload for `/api/commands`.
 */
export interface ComposerCommandListResponse {
	commands: ComposerCommand[];
}

/**
 * Command favorites/recents preferences.
 */
export interface ComposerCommandPrefs {
	favorites: string[];
	recents: string[];
}

/**
 * Update payload for command preferences.
 */
export interface ComposerCommandPrefsUpdate {
	favorites?: string[];
	recents?: string[];
}

/**
 * Response payload for command preference updates.
 */
export interface ComposerCommandPrefsWriteResponse {
	ok: boolean;
}

/**
 * Request payload for `/api/config`.
 */
export interface ComposerConfigWriteRequest {
	config: Record<string, unknown>;
}

/**
 * Response payload for `/api/config` GET.
 */
export interface ComposerConfigResponse {
	config: Record<string, unknown>;
	configPath: string;
}

/**
 * Response payload for `/api/config` POST.
 */
export interface ComposerConfigWriteResponse {
	success: boolean;
}

/**
 * Response payload for `/api/files`.
 */
export interface ComposerFilesResponse {
	files: string[];
}

/**
 * Request payload for the chat API endpoint.
 *
 * Sent to `POST /api/chat` to initiate or continue a conversation.
 */
export interface ComposerChatRequest {
	/** Model ID to use (e.g., "claude-sonnet-4-5-20250929") */
	model?: string;
	/** Conversation history including the current user message */
	messages: ComposerMessage[];
	/** Extended thinking level for supported models */
	thinkingLevel?: ComposerThinkingLevel;
	/** Session ID to resume (optional - creates new session if omitted) */
	sessionId?: string;
	/** Whether to stream the response via SSE (default: true) */
	stream?: boolean;
}

/**
 * Summary metadata for a session (without full message history).
 *
 * Used in session list views for performance.
 */
export interface ComposerSessionSummary {
	/** Unique session identifier */
	id: string;
	/** User-assigned or auto-generated title */
	title?: string;
	/** ISO 8601 timestamp when session was created */
	createdAt: string;
	/** ISO 8601 timestamp when session was last updated */
	updatedAt: string;
	/** Total number of messages in the session */
	messageCount: number;
	/** Whether the session is marked as a favorite */
	favorite?: boolean;
	/** User-assigned tags for organization */
	tags?: string[];
}

export interface ComposerPendingClientToolRequest {
	toolCallId: string;
	toolName: string;
	args: unknown;
	kind?: "client_tool" | "mcp_elicitation" | "user_input";
	reason?: string;
}

/**
 * Full session data including message history.
 *
 * Returned when loading a specific session.
 */
export interface ComposerSession extends ComposerSessionSummary {
	/** Complete conversation history */
	messages: ComposerMessage[];
	/** Pending approval requests that still require a decision */
	pendingApprovalRequests?: ComposerActionApprovalRequest[];
	/** Pending client or ask_user requests that still require client handling */
	pendingClientToolRequests?: ComposerPendingClientToolRequest[];
	/** Pending tool retry requests that still require a decision */
	pendingToolRetryRequests?: ComposerToolRetryRequest[];
}

/**
 * Streaming events emitted while generating assistant messages.
 */
export type ComposerAssistantMessageEvent =
	| {
			type: "start";
			partial: ComposerMessage;
	  }
	| {
			type: "text_start";
			contentIndex: number;
			partial: ComposerMessage;
	  }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partial?: ComposerMessage;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: string;
			partial: ComposerMessage;
	  }
	| {
			type: "thinking_start";
			contentIndex: number;
			partial: ComposerMessage;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partial?: ComposerMessage;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			partial: ComposerMessage;
	  }
	| {
			type: "toolcall_start";
			contentIndex: number;
			partial?: ComposerMessage;
			toolCallId?: string;
			toolCallName?: string;
			toolCallArgs?: Record<string, unknown>;
			toolCallArgsTruncated?: boolean;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial?: ComposerMessage;
			toolCallId?: string;
			toolCallName?: string;
			toolCallArgs?: Record<string, unknown>;
			toolCallArgsTruncated?: boolean;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ComposerToolCallContent;
			partial?: ComposerMessage;
	  }
	| {
			type: "done";
			reason: "stop" | "length" | "toolUse";
			message: ComposerMessage;
	  }
	| {
			type: "error";
			reason: "aborted" | "error";
			error: ComposerMessage;
	  };

export interface ComposerActionApprovalRequest {
	id: string;
	toolName: string;
	displayName?: string;
	summaryLabel?: string;
	actionDescription?: string;
	args: unknown;
	reason: string;
}

export interface ComposerActionApprovalDecision {
	approved: boolean;
	reason?: string;
	resolvedBy: "policy" | "user";
}

export interface ComposerToolRetryRequest {
	id: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
	errorMessage: string;
	attempt: number;
	maxAttempts?: number;
	summary?: string;
}

export interface ComposerToolRetryDecision {
	action: "retry" | "skip" | "abort";
	reason?: string;
	resolvedBy: "policy" | "user" | "runtime";
}

/**
 * Agent-level streaming events (SSE payloads).
 */
export type ComposerAgentEvent =
	| { type: "agent_start" }
	| {
			type: "agent_end";
			messages: ComposerMessage[];
			aborted?: boolean;
			partialAccepted?: ComposerMessage;
			stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
	  }
	| { type: "status"; status: string; details: Record<string, unknown> }
	| { type: "error"; message: string }
	| { type: "turn_start" }
	| {
			type: "turn_end";
			message: ComposerMessage;
			toolResults: ComposerMessage[];
	  }
	| { type: "message_start"; message: ComposerMessage }
	| {
			type: "message_update";
			message?: ComposerMessage;
			assistantMessageEvent: ComposerAssistantMessageEvent;
	  }
	| { type: "message_end"; message: ComposerMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			displayName?: string;
			summaryLabel?: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			displayName?: string;
			summaryLabel?: string;
			args: Record<string, unknown>;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			displayName?: string;
			summaryLabel?: string;
			result: unknown;
			isError: boolean;
	  }
	| {
			type: "tool_batch_summary";
			summary: string;
			summaryLabels: string[];
			toolCallIds: string[];
			toolNames: string[];
			callsSucceeded: number;
			callsFailed: number;
	  }
	| { type: "action_approval_required"; request: ComposerActionApprovalRequest }
	| {
			type: "action_approval_resolved";
			request: ComposerActionApprovalRequest;
			decision: ComposerActionApprovalDecision;
	  }
	| {
			type: "client_tool_request";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| { type: "tool_retry_required"; request: ComposerToolRetryRequest }
	| {
			type: "tool_retry_resolved";
			request: ComposerToolRetryRequest;
			decision: ComposerToolRetryDecision;
	  }
	| {
			type: "compaction";
			summary: string;
			firstKeptEntryIndex: number;
			tokensBefore: number;
			auto?: boolean;
			customInstructions?: string;
			timestamp: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| { type: "session_update"; sessionId: string }
	| { type: "heartbeat" }
	| { type: "aborted" }
	| { type: "done" };

/**
 * Error severity levels for API payloads.
 */
export type ComposerErrorSeverity = "error" | "warning" | "info";

/**
 * Error categories for API payloads.
 */
export type ComposerErrorCategory =
	| "validation"
	| "permission"
	| "network"
	| "timeout"
	| "filesystem"
	| "tool"
	| "session"
	| "config"
	| "api"
	| "internal";

/**
 * Structured error payload for API responses.
 */
export interface ComposerErrorPayload {
	code: string;
	category: ComposerErrorCategory;
	severity?: ComposerErrorSeverity;
	retriable?: boolean;
	context?: Record<string, unknown>;
}

/**
 * Standard API error response shape.
 */
export interface ComposerErrorResponse {
	error: string;
	code?: string;
	details?: Record<string, unknown>[];
	composer?: ComposerErrorPayload;
}

/**
 * Response payload for session list endpoint.
 */
export interface ComposerSessionListResponse {
	/** Array of session summaries */
	sessions: ComposerSessionSummary[];
}

/**
 * SSE event sent when a session is created or updated.
 *
 * Allows clients to sync session state in real-time.
 */
export interface ComposerSessionUpdateEvent {
	type: "session_update";
	/** ID of the created/updated session */
	sessionId: string;
}

/**
 * Background task resource limit breach metadata.
 */
export interface ComposerBackgroundTaskLimitBreach {
	kind: "memory" | "cpu";
	limit: number;
	actual: number;
}

/**
 * Background task history record.
 */
export interface ComposerBackgroundTaskHistoryEntry {
	event: "started" | "restarted" | "exited" | "failed" | "stopped";
	taskId: string;
	status: string;
	command: string;
	timestamp: string;
	restartAttempts: number;
	failureReason?: string;
	limitBreach?: ComposerBackgroundTaskLimitBreach;
}

/**
 * Background task health entry.
 */
export interface ComposerBackgroundTaskHealthEntry {
	id: string;
	status: string;
	summary: string;
	command: string;
	restarts?: string;
	issues: string[];
	lastLogLine?: string;
	logTruncated?: boolean;
	durationSeconds: number;
}

/**
 * Background task health snapshot.
 */
export interface ComposerBackgroundTaskHealth {
	total: number;
	running: number;
	restarting: number;
	failed: number;
	entries: ComposerBackgroundTaskHealthEntry[];
	truncated: boolean;
	notificationsEnabled: boolean;
	detailsRedacted: boolean;
	history: ComposerBackgroundTaskHistoryEntry[];
	historyTruncated: boolean;
}

export type ComposerGuardianTarget = "staged" | "all";

export type ComposerGuardianStatus = "passed" | "failed" | "skipped" | "error";

export interface ComposerGuardianToolResult {
	tool: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	skipped?: boolean;
	reason?: string;
}

export interface ComposerGuardianRunResult {
	status: ComposerGuardianStatus;
	exitCode: number;
	startedAt: number;
	durationMs: number;
	target: ComposerGuardianTarget;
	trigger?: string;
	filesScanned: number;
	files?: string[];
	summary: string;
	skipReason?: string;
	toolResults: ComposerGuardianToolResult[];
}

export interface ComposerGuardianState {
	enabled: boolean;
	lastRun?: ComposerGuardianRunResult;
}

export interface ComposerGuardianStatusResponse {
	enabled: boolean;
	state: ComposerGuardianState;
}

export type ComposerGuardianRunResponse = ComposerGuardianRunResult;

export interface ComposerGuardianConfigRequest {
	enabled: boolean;
}

export interface ComposerGuardianConfigResponse {
	success: boolean;
	enabled: boolean;
}

export interface ComposerPlanModeState {
	active: boolean;
	filePath: string;
	sessionId?: string;
	gitBranch?: string;
	gitCommitSha?: string;
	createdAt: string;
	updatedAt: string;
	name?: string;
}

export interface ComposerPlanStatusResponse {
	state: ComposerPlanModeState | null;
	content: string | null;
}

export type ComposerPlanRequest =
	| { action: "enter"; name?: string; sessionId?: string }
	| { action: "exit" }
	| { action: "update"; content: string };

export type ComposerPlanActionResponse =
	| { success: boolean; state: ComposerPlanModeState }
	| { success: boolean };

export interface ComposerBackgroundSettings {
	notificationsEnabled: boolean;
	statusDetailsEnabled: boolean;
}

export interface ComposerBackgroundStatusSnapshot {
	running: number;
	total: number;
	failed: number;
	detailsRedacted: boolean;
}

export interface ComposerBackgroundStatusResponse {
	settings: ComposerBackgroundSettings;
	snapshot: ComposerBackgroundStatusSnapshot | null;
}

export interface ComposerBackgroundHistoryEntry {
	timestamp: string;
	event: "started" | "restarted" | "exited" | "failed" | "stopped";
	taskId: string;
	command: string;
	failureReason?: string;
	limitBreach?: ComposerBackgroundTaskLimitBreach;
}

export interface ComposerBackgroundHistoryResponse {
	history: ComposerBackgroundHistoryEntry[];
	truncated: boolean;
}

export interface ComposerBackgroundPathResponse {
	path: string;
	exists: boolean;
	overridden: boolean;
}

export interface ComposerBackgroundUpdateRequest {
	enabled: boolean;
}

export interface ComposerBackgroundUpdateResponse {
	success: boolean;
	message: string;
}

export type ComposerApprovalMode = "auto" | "prompt" | "fail";

export interface ComposerApprovalsStatusResponse {
	mode: ComposerApprovalMode;
	availableModes: ComposerApprovalMode[];
}

export interface ComposerApprovalsUpdateRequest {
	mode: ComposerApprovalMode;
	sessionId?: string;
}

export interface ComposerApprovalsUpdateResponse {
	success: boolean;
	mode: ComposerApprovalMode;
	message: string;
}

export type ComposerFrameworkScope = "user" | "workspace";

export interface ComposerFrameworkStatusResponse {
	framework: string;
	source: string;
	locked: boolean;
	scope: ComposerFrameworkScope;
}

export interface ComposerFrameworkListEntry {
	id: string;
	summary: string;
}

export interface ComposerFrameworkListResponse {
	frameworks: ComposerFrameworkListEntry[];
}

export interface ComposerFrameworkUpdateRequest {
	framework?: string | null;
	scope?: ComposerFrameworkScope;
}

export interface ComposerFrameworkUpdateResponse {
	success: boolean;
	message: string;
	framework: string | null;
	summary?: string;
	scope?: ComposerFrameworkScope;
}

export type ComposerChangeType = "create" | "modify" | "delete";

export interface ComposerFileChange {
	id: string;
	type: ComposerChangeType;
	path: string;
	before: string | null;
	after: string | null;
	toolName: string;
	toolCallId: string;
	timestamp: number;
	isGitTracked: boolean;
	messageId?: string;
}

export type ComposerUndoRestoreAction = "restore" | "delete" | "recreate";

export interface ComposerUndoPreview {
	changes: ComposerFileChange[];
	restores: Array<{ path: string; action: ComposerUndoRestoreAction }>;
	conflicts: Array<{ path: string; reason: string }>;
}

export interface ComposerUndoCheckpoint {
	name: string;
	description?: string;
	changeCount: number;
	timestamp: number;
}

export interface ComposerUndoStatusResponse {
	totalChanges: number;
	canUndo: boolean;
	checkpoints: ComposerUndoCheckpoint[];
}

export interface ComposerUndoHistoryEntry {
	description: string;
	fileCount: number;
	timestamp: number;
}

export interface ComposerUndoHistoryResponse {
	history: ComposerUndoHistoryEntry[];
}

export interface ComposerUndoPreviewMessage {
	message: string;
	fileCount?: number;
	description?: string;
}

export interface ComposerUndoRequest {
	action?: "undo" | "checkpoint" | "restore";
	count?: number;
	preview?: boolean;
	force?: boolean;
	name?: string;
	description?: string;
}

export type ComposerUndoOperationResponse =
	| { success: boolean; undone: number; errors: string[] }
	| { success: boolean; message: string; files?: string[] }
	| { message: string }
	| { preview: ComposerUndoPreview | ComposerUndoPreviewMessage }
	| {
			success: boolean;
			checkpoint: { name: string; changeCount: number; timestamp: number };
	  }
	| { checkpoints: ComposerUndoCheckpoint[] };

/**
 * Workspace status response payload.
 */
export interface ComposerStatusResponse {
	cwd: string;
	git: {
		branch: string;
		status: {
			modified: number;
			added: number;
			deleted: number;
			untracked: number;
			total: number;
		};
	} | null;
	context: {
		agentMd: boolean;
		claudeMd: boolean;
	};
	server: {
		uptime: number;
		version: string;
		staticCacheMaxAgeSeconds?: number;
	};
	database: {
		configured: boolean;
		connected: boolean;
	};
	backgroundTasks: ComposerBackgroundTaskHealth | null;
	hooks: {
		asyncInFlight: number;
		concurrency: {
			max: number;
			active: number;
			queued: number;
		};
	};
	lastUpdated: number;
	lastLatencyMs: number;
}

/**
 * Token totals for usage summaries.
 */
export interface ComposerUsageTokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/**
 * Usage breakdown entry.
 */
export interface ComposerUsageBreakdown {
	cost: number;
	requests: number;
	tokens: number;
	tokensDetailed: ComposerUsageTokenTotals;
	calls: number;
	cachedTokens: number;
}

/**
 * Usage summary response payload.
 */
export interface ComposerUsageSummary {
	totalCost: number;
	totalRequests: number;
	totalTokens: number;
	tokensDetailed: ComposerUsageTokenTotals;
	totalTokensDetailed: ComposerUsageTokenTotals;
	totalTokensBreakdown: ComposerUsageTokenTotals;
	totalCachedTokens: number;
	byProvider: Record<string, ComposerUsageBreakdown>;
	byModel: Record<string, ComposerUsageBreakdown>;
}

/**
 * Usage API response payload.
 */
export interface ComposerUsageResponse {
	summary: ComposerUsageSummary;
	hasData: boolean;
}

// Runtime schemas + validators
export * from "./schemas.js";
export * from "./validators.js";
