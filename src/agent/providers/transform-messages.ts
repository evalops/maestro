import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	ToolCall,
} from "../types.js";

/**
 * Transforms messages for cross-provider compatibility.
 *
 * This function handles two key scenarios:
 * 1. Converting thinking blocks to text when switching providers
 *    (e.g., Claude thinking → <thinking> tags for OpenAI)
 * 2. Filtering out orphaned tool calls (tool calls without results)
 *
 * @param messages Original message array
 * @param model Target model to transform messages for
 * @returns Transformed messages compatible with the target model
 */
export function transformMessages<T extends Message>(
	messages: T[],
	model: Model<Api>,
): T[] {
	// First pass: Transform thinking blocks when crossing provider/API boundaries
	const transformedMessages = messages.map((msg) => {
		// User and toolResult messages pass through unchanged
		if (msg.role === "user" || msg.role === "toolResult") {
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;

			// If message is from the same provider and API, keep as is
			if (
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api
			) {
				return msg;
			}

			// Transform message from different provider/model
			const transformedContent = assistantMsg.content.map((block) => {
				if (block.type === "thinking") {
					// Convert thinking block to text block with <thinking> tags
					// This preserves the reasoning for the target model to see
					return {
						type: "text" as const,
						text: `<thinking>\n${block.thinking}\n</thinking>`,
					};
				}
				// All other blocks (text, toolCall) pass through unchanged
				return block;
			});

			// Return transformed assistant message
			return {
				...assistantMsg,
				content: transformedContent,
			} as T;
		}

		return msg;
	});

	// Second pass: Filter out tool calls without corresponding tool results
	// This prevents sending incomplete tool execution sequences to the LLM
	return transformedMessages.map((msg, index, allMessages) => {
		if (msg.role !== "assistant") {
			return msg;
		}

		const assistantMsg = msg as AssistantMessage;
		const isLastMessage = index === allMessages.length - 1;

		// If this is the last message, keep all tool calls (ongoing turn)
		if (isLastMessage) {
			return msg;
		}

		// Extract tool call IDs from this message
		const toolCallIds = assistantMsg.content
			.filter((block) => block.type === "toolCall")
			.map((block) => (block as ToolCall).id);

		// If no tool calls, return as is
		if (toolCallIds.length === 0) {
			return msg;
		}

		// Scan forward through subsequent messages to find matching tool results
		const matchedToolCallIds = new Set<string>();
		for (let i = index + 1; i < allMessages.length; i++) {
			const nextMsg = allMessages[i];

			// Stop scanning when we hit another assistant message
			if (nextMsg.role === "assistant") {
				break;
			}

			// Check tool result messages for matching IDs
			if (nextMsg.role === "toolResult") {
				matchedToolCallIds.add(nextMsg.toolCallId);
			}
		}

		// Filter out tool calls that don't have corresponding results
		const filteredContent = assistantMsg.content.filter((block) => {
			if (block.type === "toolCall") {
				return matchedToolCallIds.has((block as ToolCall).id);
			}
			return true; // Keep all non-toolCall blocks
		});

		return {
			...assistantMsg,
			content: filteredContent,
		} as T;
	}) as T[];
}
