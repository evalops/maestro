/**
 * @fileoverview Type Guards for Composer Agent Messages and Content
 *
 * This module provides type guard functions for safely narrowing message
 * and content types at runtime. Use these guards when working with the
 * discriminated union types to get proper TypeScript type inference.
 *
 * @example
 * ```typescript
 * import { isUserMessage, isToolCall } from "./type-guards.js";
 *
 * function processMessage(msg: AppMessage) {
 *   if (isUserMessage(msg)) {
 *     // TypeScript knows msg is UserMessage here
 *     console.log("User said:", msg.content);
 *   }
 * }
 * ```
 *
 * @module agent/type-guards
 */

import type {
	AppMessage,
	AssistantMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	HookMessage,
	ImageContent,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
	UserMessageWithAttachments,
} from "./types.js";

// ============================================================================
// Message Type Guards
// ============================================================================

/**
 * Check if a message is a UserMessage.
 *
 * @example
 * ```typescript
 * if (isUserMessage(msg)) {
 *   // msg is UserMessage - can access msg.content safely
 * }
 * ```
 */
export function isUserMessage(
	msg: AppMessage | Message | unknown,
): msg is UserMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: string }).role === "user"
	);
}

/**
 * Check if a message is an AssistantMessage.
 *
 * @example
 * ```typescript
 * if (isAssistantMessage(msg)) {
 *   // msg is AssistantMessage - can access msg.content, msg.usage, etc.
 * }
 * ```
 */
export function isAssistantMessage(
	msg: AppMessage | Message | unknown,
): msg is AssistantMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: string }).role === "assistant"
	);
}

/**
 * Check if a message is a ToolResultMessage.
 *
 * @example
 * ```typescript
 * if (isToolResultMessage(msg)) {
 *   // msg is ToolResultMessage - can access msg.toolCallId, msg.toolName, etc.
 * }
 * ```
 */
export function isToolResultMessage(
	msg: AppMessage | Message | unknown,
): msg is ToolResultMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: string }).role === "toolResult"
	);
}

/**
 * Check if a message is a HookMessage.
 *
 * @example
 * ```typescript
 * if (isHookMessage(msg)) {
 *   // msg is HookMessage - can access msg.customType, msg.display, etc.
 * }
 * ```
 */
export function isHookMessage(msg: AppMessage | unknown): msg is HookMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: string }).role === "hookMessage"
	);
}

/**
 * Check if a message is a BranchSummaryMessage.
 *
 * @example
 * ```typescript
 * if (isBranchSummaryMessage(msg)) {
 *   // msg is BranchSummaryMessage - can access msg.summary, msg.fromId
 * }
 * ```
 */
export function isBranchSummaryMessage(
	msg: AppMessage | unknown,
): msg is BranchSummaryMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: string }).role === "branchSummary"
	);
}

/**
 * Check if a message is a CompactionSummaryMessage.
 *
 * @example
 * ```typescript
 * if (isCompactionSummaryMessage(msg)) {
 *   // msg is CompactionSummaryMessage - can access msg.summary, msg.tokensBefore
 * }
 * ```
 */
export function isCompactionSummaryMessage(
	msg: AppMessage | unknown,
): msg is CompactionSummaryMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"role" in msg &&
		(msg as { role: string }).role === "compactionSummary"
	);
}

/**
 * Check if a message is a UserMessageWithAttachments.
 *
 * Note: This returns true for any UserMessage. To check specifically
 * for attachments, use `isUserMessageWithAttachments(msg) && msg.attachments?.length`.
 *
 * @example
 * ```typescript
 * if (isUserMessageWithAttachments(msg) && msg.attachments?.length) {
 *   // msg has attachments
 * }
 * ```
 */
export function isUserMessageWithAttachments(
	msg: AppMessage | unknown,
): msg is UserMessageWithAttachments {
	return isUserMessage(msg);
}

/**
 * Check if a message has attachments (is a UserMessage with non-empty attachments array).
 *
 * @example
 * ```typescript
 * if (hasAttachments(msg)) {
 *   // msg.attachments is guaranteed to be a non-empty array
 * }
 * ```
 */
export function hasAttachments(
	msg: AppMessage | unknown,
): msg is UserMessageWithAttachments & {
	attachments: NonNullable<UserMessageWithAttachments["attachments"]>;
} {
	if (!isUserMessage(msg) || !("attachments" in msg)) {
		return false;
	}
	const attachments = (msg as UserMessageWithAttachments).attachments;
	return Array.isArray(attachments) && attachments.length > 0;
}

/**
 * Check if a message is a core LLM message type (user, assistant, or toolResult).
 *
 * @example
 * ```typescript
 * if (isLLMMessage(msg)) {
 *   // msg is Message (UserMessage | AssistantMessage | ToolResultMessage)
 * }
 * ```
 */
export function isLLMMessage(msg: AppMessage | unknown): msg is Message {
	return (
		isUserMessage(msg) || isAssistantMessage(msg) || isToolResultMessage(msg)
	);
}

// ============================================================================
// Content Type Guards
// ============================================================================

/**
 * Check if content is TextContent.
 *
 * @example
 * ```typescript
 * for (const block of assistantMsg.content) {
 *   if (isTextContent(block)) {
 *     console.log(block.text);
 *   }
 * }
 * ```
 */
export function isTextContent(
	content: TextContent | ThinkingContent | ImageContent | ToolCall | unknown,
): content is TextContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		(content as { type: string }).type === "text"
	);
}

/**
 * Check if content is ThinkingContent.
 *
 * @example
 * ```typescript
 * for (const block of assistantMsg.content) {
 *   if (isThinkingContent(block)) {
 *     console.log("Thinking:", block.thinking);
 *   }
 * }
 * ```
 */
export function isThinkingContent(
	content: TextContent | ThinkingContent | ImageContent | ToolCall | unknown,
): content is ThinkingContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		(content as { type: string }).type === "thinking"
	);
}

/**
 * Check if content is ImageContent.
 *
 * @example
 * ```typescript
 * for (const block of toolResult.content) {
 *   if (isImageContent(block)) {
 *     console.log("Image:", block.mimeType);
 *   }
 * }
 * ```
 */
export function isImageContent(
	content: TextContent | ThinkingContent | ImageContent | ToolCall | unknown,
): content is ImageContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		(content as { type: string }).type === "image"
	);
}

/**
 * Check if content is a ToolCall.
 *
 * @example
 * ```typescript
 * for (const block of assistantMsg.content) {
 *   if (isToolCall(block)) {
 *     console.log("Tool:", block.name, "Args:", block.arguments);
 *   }
 * }
 * ```
 */
export function isToolCall(
	content: TextContent | ThinkingContent | ImageContent | ToolCall | unknown,
): content is ToolCall {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		(content as { type: string }).type === "toolCall"
	);
}

// ============================================================================
// Utility Type Guards
// ============================================================================

/**
 * Get all tool calls from an AssistantMessage.
 *
 * @example
 * ```typescript
 * const toolCalls = getToolCalls(assistantMsg);
 * for (const call of toolCalls) {
 *   console.log(`Calling ${call.name} with`, call.arguments);
 * }
 * ```
 */
export function getToolCalls(msg: AssistantMessage): ToolCall[] {
	return msg.content.filter(isToolCall);
}

/**
 * Get all text content from an AssistantMessage, concatenated.
 *
 * @example
 * ```typescript
 * const text = getTextContent(assistantMsg);
 * console.log("Assistant said:", text);
 * ```
 */
export function getTextContent(msg: AssistantMessage): string {
	return msg.content
		.filter(isTextContent)
		.map((block) => block.text)
		.join("");
}

/**
 * Get all thinking content from an AssistantMessage, concatenated.
 *
 * @example
 * ```typescript
 * const thinking = getThinkingContent(assistantMsg);
 * if (thinking) {
 *   console.log("Assistant thought:", thinking);
 * }
 * ```
 */
export function getThinkingContent(msg: AssistantMessage): string {
	return msg.content
		.filter(isThinkingContent)
		.map((block) => block.thinking)
		.join("");
}

/**
 * Check if an AssistantMessage contains any tool calls.
 *
 * @example
 * ```typescript
 * if (hasToolCalls(assistantMsg)) {
 *   // Message contains tool invocations
 * }
 * ```
 */
export function hasToolCalls(msg: AssistantMessage): boolean {
	return msg.content.some(isToolCall);
}

/**
 * Get the plain text content from a UserMessage.
 *
 * Handles both string content and array content formats.
 *
 * @example
 * ```typescript
 * const text = getUserMessageText(userMsg);
 * console.log("User said:", text);
 * ```
 */
export function getUserMessageText(msg: UserMessage): string {
	if (typeof msg.content === "string") {
		return msg.content;
	}
	return msg.content
		.filter(isTextContent)
		.map((block) => block.text)
		.join("");
}
