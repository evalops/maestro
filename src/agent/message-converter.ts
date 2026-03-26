/**
 * Message Converter
 *
 * Converts between AgentMessage (includes custom types) and Message (LLM-only).
 * Custom messages are filtered out before being sent to the LLM.
 */

import type { AgentMessage, Message } from "./types.js";

/**
 * Check if a message is an LLM-native message type.
 *
 * Returns true for user, assistant, and toolResult messages.
 * Returns false for custom message types like hookMessage, branchSummary, etc.
 *
 * @param message - Message to check
 * @returns True if message can be sent to LLM
 *
 * @example
 * ```typescript
 * if (isLlmMessage(msg)) {
 *   // Send to LLM
 * } else {
 *   // UI-only or custom message
 * }
 * ```
 */
export function isLlmMessage(message: AgentMessage): message is Message {
	return (
		message.role === "user" ||
		message.role === "assistant" ||
		message.role === "toolResult"
	);
}

/**
 * Convert agent messages to LLM-compatible messages.
 *
 * Filters out custom message types (hookMessage, branchSummary, compactionSummary,
 * and any types added via declaration merging) that should not be sent to the LLM.
 *
 * This function should be called before every LLM request to ensure only
 * valid message types are included in the prompt.
 *
 * @param messages - Array of agent messages (may include custom types)
 * @returns Array of LLM-compatible messages only
 *
 * @example
 * ```typescript
 * const agentMessages: AgentMessage[] = [
 *   { role: "user", content: "Hello", timestamp: 1 },
 *   { role: "hookMessage", customType: "status", content: "Processing", ... },
 *   { role: "assistant", content: [...], ... }
 * ];
 *
 * const llmMessages = convertToLlm(agentMessages);
 * // Result: Only user and assistant messages, hookMessage filtered out
 * ```
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(isLlmMessage);
}
