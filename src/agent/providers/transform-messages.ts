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
 * This function handles three key scenarios:
 * 1. Converting thinking blocks to text when switching providers/APIs.
 * 2. Normalizing github-copilot tool call IDs when switching APIs.
 * 3. Inserting synthetic tool results for orphaned tool calls.
 */
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
 * Responses API generates IDs with special characters and very long lengths.
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
	// Map original tool call IDs to normalized ones for github-copilot API switches.
	const toolCallIdMap = new Map<string, string>();

	// First pass: transform messages (thinking blocks + tool call ID normalization)
	const transformed = messages.map((msg) => {
		if (msg.role === "user") {
			return msg;
		}

		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId } as T;
			}
			return msg;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const needsToolCallIdNormalization =
				assistantMsg.provider === "github-copilot" &&
				model.provider === "github-copilot" &&
				assistantMsg.api !== model.api;
			const shouldConvertThinking =
				assistantMsg.provider !== model.provider ||
				assistantMsg.api !== model.api ||
				!model.reasoning;

			if (!shouldConvertThinking && !needsToolCallIdNormalization) {
				return msg;
			}

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking" && shouldConvertThinking) {
					if (!block.thinking || block.thinking.trim() === "") return [];
					return {
						type: "text" as const,
						text: `<thinking>\n${block.thinking}\n</thinking>`,
					};
				}
				if (block.type === "toolCall" && needsToolCallIdNormalization) {
					const toolCall = block as ToolCall;
					const normalizedId = normalizeCopilotToolCallId(toolCall.id);
					if (normalizedId !== toolCall.id) {
						toolCallIdMap.set(toolCall.id, normalizedId);
						return { ...toolCall, id: normalizedId };
					}
				}
				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			} as T;
		}

		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		if (!msg) continue;

		if (msg.role === "assistant") {
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
