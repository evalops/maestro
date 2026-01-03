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

/**
 * Full session data including message history.
 *
 * Returned when loading a specific session.
 */
export interface ComposerSession extends ComposerSessionSummary {
	/** Complete conversation history */
	messages: ComposerMessage[];
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
			partial: ComposerMessage;
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
			partial: ComposerMessage;
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
			partial: ComposerMessage;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: ComposerMessage;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ComposerToolCallContent;
			partial: ComposerMessage;
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
	args: unknown;
	reason: string;
}

export interface ComposerActionApprovalDecision {
	approved: boolean;
	reason?: string;
	resolvedBy: "policy" | "user";
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
			message: ComposerMessage;
			assistantMessageEvent: ComposerAssistantMessageEvent;
	  }
	| { type: "message_end"; message: ComposerMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
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
	| { type: "aborted" };

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
