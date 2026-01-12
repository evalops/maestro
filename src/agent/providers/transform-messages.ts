import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	ToolCall,
	ToolResultMessage,
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
/** Fast deterministic hash to shorten long strings. */
function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/**
 * Normalize tool call ID for GitHub Copilot cross-API compatibility.
 * OpenAI Responses API generates IDs that can be 450+ chars with special chars like `|`.
 * Other APIs require max 40 chars and only alphanumeric + underscore + hyphen.
 */
function normalizeCopilotToolCallId(id: string): string {
	const normalized = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
	if (normalized.length > 0) {
		return normalized;
	}
	return `copilot_${shortHash(id)}`.slice(0, 40);
}

export function transformMessages<T extends Message>(
	messages: T[],
	model: Model<Api>,
): T[] {
	// Build a map of original tool call IDs to normalized IDs for github-copilot cross-API switches
	const toolCallIdMap = new Map<string, string>();

	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const transformed = messages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;

			// Check if we need to normalize tool call IDs (github-copilot cross-API)
			const needsToolCallIdNormalization =
				assistantMsg.provider === "github-copilot" &&
				model.provider === "github-copilot" &&
				assistantMsg.api !== model.api;

			// If message is from the same provider and API, keep as is
			if (
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				!needsToolCallIdNormalization
			) {
				return msg;
			}

			// Transform message from different provider/model
			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Convert thinking block to text block with <thinking> tags
					// Skip empty thinking blocks when crossing providers/APIs.
					if (!block.thinking || block.thinking.trim() === "") return [];
					return {
						type: "text" as const,
						text: `<thinking>\n${block.thinking}\n</thinking>`,
					};
				}
				// Normalize tool call IDs for github-copilot cross-API switches
				if (block.type === "toolCall" && needsToolCallIdNormalization) {
					const toolCall = block as ToolCall;
					const normalizedId = normalizeCopilotToolCallId(toolCall.id);
					if (normalizedId !== toolCall.id) {
						toolCallIdMap.set(toolCall.id, normalizedId);
						return { ...toolCall, id: normalizedId };
					}
				}
				// All other blocks pass through unchanged
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

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (!msg) continue;

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}

			// Track tool calls from this assistant message
			const assistantMsg = msg as AssistantMessage;
			const toolCalls = assistantMsg.content.filter(
				(b) => b.type === "toolCall",
			) as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	return result as T[];
}
