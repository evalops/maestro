import type {
	ComposerMessage,
	ComposerToolCall,
	ComposerUsage,
} from "@evalops/contracts";
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

export type SessionSerializationDirection = "app->composer" | "composer->app";

export interface SessionSerializationContext {
	index?: number;
	role?: string;
	source?: SessionSerializationDirection;
}

function toComposerUsage(usage?: Usage): ComposerUsage | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: usage.cost
			? {
					input: usage.cost.input ?? 0,
					output: usage.cost.output ?? 0,
					cacheRead: usage.cost.cacheRead ?? 0,
					cacheWrite: usage.cost.cacheWrite ?? 0,
					total: usage.cost.total ?? 0,
				}
			: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
	};
}

export class SessionSerializationError extends Error {
	readonly context?: SessionSerializationContext;

	constructor(message: string, context?: SessionSerializationContext) {
		super(context ? `${message} (${JSON.stringify(context)})` : message);
		this.name = "SessionSerializationError";
		this.context = context;
	}
}

const IMAGE_PLACEHOLDER_PREFIX = "[image:";
const UNKNOWN_IMAGE_PLACEHOLDER = "[image]";

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildContext(
	source: SessionSerializationDirection,
	index: number,
	role?: string,
): SessionSerializationContext {
	return { source, index, role };
}

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
	if (typeof tool.result === "number" || typeof tool.result === "boolean") {
		return String(tool.result);
	}
	if (tool.result && typeof tool.result === "object") {
		return safeStringify(tool.result);
	}
	if (tool.args && typeof tool.args === "object") {
		return safeStringify(tool.args);
	}
	return "";
}

function toIsoString(
	input: number | string | undefined,
	context: SessionSerializationContext,
): string {
	if (typeof input === "number") {
		if (!Number.isFinite(input)) {
			throw new SessionSerializationError("Invalid numeric timestamp", context);
		}
		return new Date(input).toISOString();
	}
	if (typeof input === "string") {
		const parsed = Date.parse(input);
		if (!Number.isFinite(parsed)) {
			throw new SessionSerializationError("Invalid timestamp", context);
		}
		return new Date(parsed).toISOString();
	}
	return new Date().toISOString();
}

function toTimestamp(
	input: string | undefined,
	context: SessionSerializationContext,
): number {
	if (!input) return Date.now();
	const parsed = Date.parse(input);
	if (!Number.isFinite(parsed)) {
		throw new SessionSerializationError("Invalid timestamp", context);
	}
	return parsed;
}

function extractTextContent(
	content?:
		| string
		| Array<TextContent | ThinkingContent | ToolCall | ImageContent>,
): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	const fragments: string[] = [];
	for (const block of content) {
		if (!block) continue;
		if (block.type === "text") {
			fragments.push(block.text);
			continue;
		}
		if (block.type === "image") {
			const descriptor = block.mimeType
				? `${IMAGE_PLACEHOLDER_PREFIX}${block.mimeType}]`
				: UNKNOWN_IMAGE_PLACEHOLDER;
			fragments.push(descriptor);
			continue;
		}
		if (block.type === "thinking" || block.type === "toolCall") {
			continue;
		}
		const fallbackType = (block as { type?: string }).type || "unknown";
		fragments.push(`[content:${fallbackType}]`);
	}
	return fragments.join("\n\n");
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
			name: toolCall.name?.trim() || "unnamed_tool",
			status: "completed",
			args: toolCall.arguments || {},
			toolCallId: toolCall.id,
		}));
}

export function convertAppMessageToComposer(
	message: AppMessage,
	index = 0,
): ComposerMessage {
	const context = buildContext("app->composer", index, message.role);
	const timestamp = toIsoString(
		"timestamp" in message ? message.timestamp : undefined,
		context,
	);
	if (message.role === "user") {
		return {
			role: "user",
			content: extractTextContent(message.content),
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
			usage: toComposerUsage(assistant.usage),
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
	const systemLike = message as {
		role?: string;
		content?: string | Array<TextContent | ImageContent>;
	};
	if (systemLike.role === "system") {
		return {
			role: "system",
			content: extractTextContent(systemLike.content),
			timestamp,
		};
	}

	throw new SessionSerializationError("Unsupported App role", context);
}

export function convertAppMessagesToComposer(
	messages: AppMessage[],
): ComposerMessage[] {
	return messages.map((message, index) =>
		convertAppMessageToComposer(message, index),
	);
}

function normalizeToolCall(
	tool: ComposerToolCall,
	messageIndex: number,
	contentIndex: number,
): ToolCall {
	const name = tool.name?.trim() || `tool_${messageIndex}_${contentIndex}`;
	const toolCallId =
		tool.toolCallId || `web-tool-${messageIndex}-${contentIndex}`;
	const args: Record<string, unknown> = isRecord(tool.args) ? tool.args : {};
	return {
		type: "toolCall",
		id: toolCallId,
		name,
		arguments: args,
	};
}

function normalizeToolResult(
	tool: ComposerToolCall,
	normalizedCall: ToolCall,
	timestamp: string | undefined,
	context: SessionSerializationContext,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: normalizedCall.id,
		toolName: normalizedCall.name,
		content: [
			{
				type: "text",
				text: serializeToolContent(tool),
			},
		],
		isError: tool.status === "error",
		timestamp: toTimestamp(timestamp, context),
	};
}

export function convertComposerMessageToApp(
	message: ComposerMessage,
	model: RegisteredModel,
	index = 0,
): AppMessage[] {
	const context = buildContext("composer->app", index, message.role);
	if (message.role === "user") {
		return [
			{
				role: "user",
				content: [{ type: "text", text: message.content || "" }],
				timestamp: toTimestamp(message.timestamp, context),
			},
		];
	}

	if (message.role === "assistant") {
		const normalizedSequence: Array<TextContent | ThinkingContent | ToolCall> =
			[];
		if (message.thinking?.trim()) {
			normalizedSequence.push({
				type: "thinking",
				thinking: message.thinking.trim(),
			});
		}
		if (message.content) {
			normalizedSequence.push({
				type: "text",
				text: message.content,
			});
		}
		const tools = message.tools ?? [];
		const baseContentLength = normalizedSequence.length;
		const toolCalls: ToolCall[] = tools.map((tool, toolIndex) =>
			normalizeToolCall(tool, index, baseContentLength + toolIndex),
		);
		normalizedSequence.push(...toolCalls);

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: normalizedSequence,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: message.usage
				? {
						input: message.usage.input ?? 0,
						output: message.usage.output ?? 0,
						cacheRead: message.usage.cacheRead ?? 0,
						cacheWrite: message.usage.cacheWrite ?? 0,
						cost: {
							input: message.usage.cost?.input ?? 0,
							output: message.usage.cost?.output ?? 0,
							cacheRead: message.usage.cost?.cacheRead ?? 0,
							cacheWrite: message.usage.cost?.cacheWrite ?? 0,
							total: message.usage.cost?.total ?? 0,
						},
					}
				: createEmptyUsage(),
			stopReason: "stop",
			timestamp: toTimestamp(message.timestamp, context),
		};

		const results: AppMessage[] = [assistantMessage];

		tools.forEach((tool, toolIndex) => {
			const normalizedCall = toolCalls[toolIndex];
			results.push(
				normalizeToolResult(tool, normalizedCall, message.timestamp, context),
			);
		});

		return results;
	}

	if (message.role === "tool") {
		const toolName = message.toolName || "web_tool";
		return [
			{
				role: "toolResult",
				toolCallId: `${toolName}-${index}`,
				toolName,
				content: [
					{
						type: "text",
						text: message.content || "",
					},
				],
				isError: Boolean(message.isError),
				timestamp: toTimestamp(message.timestamp, context),
			},
		];
	}

	if (message.role === "system") {
		return [
			{
				role: "assistant",
				content: [{ type: "text", text: message.content || "" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: toTimestamp(message.timestamp, context),
			},
		];
	}

	throw new SessionSerializationError("Unsupported Composer role", context);
}

export function convertComposerMessagesToApp(
	messages: ComposerMessage[],
	model: RegisteredModel,
): AppMessage[] {
	const result: AppMessage[] = [];
	for (const [index, message] of messages.entries()) {
		// Preserve relative ordering by pushing each expanded block in sequence
		result.push(...convertComposerMessageToApp(message, model, index));
	}
	return result;
}
