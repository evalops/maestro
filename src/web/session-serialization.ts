import type { ComposerMessage, ComposerToolCall } from "@evalops/contracts";
import type {
	AppMessage,
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../agent/types.js";
import type { RegisteredModel } from "../models/registry.js";

export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function serializeToolContent(tool: ComposerToolCall): string {
	if (typeof tool.result === "string") {
		return tool.result;
	}
	if (tool.result && typeof tool.result === "object") {
		return JSON.stringify(tool.result);
	}
	if (tool.args && typeof tool.args === "object") {
		return JSON.stringify(tool.args);
	}
	return "";
}

function toIsoString(input?: number | string): string {
	if (!input) return new Date().toISOString();
	if (typeof input === "number") {
		return new Date(input).toISOString();
	}
	return input;
}

function toTimestamp(input?: string): number {
	if (!input) return Date.now();
	const parsed = Date.parse(input);
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function extractTextContent(
	content?:
		| string
		| Array<TextContent | ThinkingContent | ToolCall | ImageContent>,
): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

function extractThinking(
	content?:
		| string
		| Array<TextContent | ThinkingContent | ToolCall | ImageContent>,
): string | undefined {
	if (!content || typeof content === "string") return undefined;
	const thought = content
		.filter((block): block is ThinkingContent => block.type === "thinking")
		.map((block) => block.thinking.trim())
		.filter(Boolean)
		.join("\n\n");
	return thought.length ? thought : undefined;
}

function extractToolCalls(
	content?:
		| string
		| Array<TextContent | ThinkingContent | ToolCall | ImageContent>,
): ComposerToolCall[] {
	if (!content || typeof content === "string") return [];
	return content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map((toolCall) => ({
			name: toolCall.name,
			status: "completed",
			args: toolCall.arguments,
			toolCallId: toolCall.id,
		}));
}

export function appMessageToComposer(message: AppMessage): ComposerMessage {
	const timestamp = toIsoString((message as any).timestamp);
	if (message.role === "user") {
		return {
			role: "user",
			content: extractTextContent((message as any).content),
			timestamp,
		};
	}
	if (message.role === "assistant") {
		const assistant = message as AssistantMessage;
		const tools = extractToolCalls(assistant.content);
		return {
			role: "assistant",
			content: extractTextContent(assistant.content),
			thinking: extractThinking(assistant.content),
			timestamp,
			tools: tools.length ? tools : undefined,
		};
	}
	if (message.role === "toolResult") {
		const toolMessage = message as ToolResultMessage;
		return {
			role: "tool",
			content: extractTextContent(toolMessage.content),
			timestamp,
			toolName: toolMessage.toolName,
			isError: toolMessage.isError,
		};
	}
	return {
		role: "system",
		content: extractTextContent((message as any).content),
		timestamp,
	};
}

export function convertAppMessagesToComposer(
	messages: AppMessage[],
): ComposerMessage[] {
	return messages.map((message) => appMessageToComposer(message));
}

export function convertComposerMessagesToApp(
	messages: ComposerMessage[],
	model: RegisteredModel,
): AppMessage[] {
	const result: AppMessage[] = [];

	for (const [index, message] of messages.entries()) {
		if (message.role === "user") {
			result.push({
				role: "user",
				content: [{ type: "text", text: message.content || "" }],
				timestamp: toTimestamp(message.timestamp),
			});
			continue;
		}

		if (message.role === "assistant") {
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: toTimestamp(message.timestamp),
			};

			if (message.thinking?.trim()) {
				assistantMessage.content.push({
					type: "thinking",
					thinking: message.thinking.trim(),
				});
			}

			if (message.content) {
				assistantMessage.content.push({
					type: "text",
					text: message.content,
				});
			}

			if (message.tools?.length) {
				for (const tool of message.tools) {
					assistantMessage.content.push({
						type: "toolCall",
						id:
							tool.toolCallId ||
							`web-tool-${index}-${assistantMessage.content.length}`,
						name: tool.name,
						arguments: tool.args || {},
					} as ToolCall);
				}
			}

			result.push(assistantMessage);

			if (message.tools?.length) {
				message.tools.forEach((tool, toolIndex) => {
					const toolResult: ToolResultMessage = {
						role: "toolResult",
						toolCallId: tool.toolCallId || `web-tool-${index}-${toolIndex}`,
						toolName: tool.name,
						content: [
							{
								type: "text",
								text: serializeToolContent(tool),
							},
						],
						isError: tool.status === "error",
						timestamp: toTimestamp(message.timestamp),
					};
					result.push(toolResult);
				});
			}
			continue;
		}

		if (message.role === "tool") {
			result.push({
				role: "toolResult",
				toolCallId: `${message.toolName || "web-tool"}-${index}`,
				toolName: message.toolName || "web_tool",
				content: [
					{
						type: "text",
						text: message.content || "",
					},
				],
				isError: Boolean(message.isError),
				timestamp: toTimestamp(message.timestamp),
			});
			continue;
		}

		if (message.role === "system") {
			result.push({
				role: "assistant",
				content: [{ type: "text", text: message.content || "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: toTimestamp(message.timestamp),
			});
		}
	}

	return result;
}
