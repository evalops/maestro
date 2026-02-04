/**
 * Session Serialization Module
 *
 * This module handles bidirectional conversion between internal agent message
 * types (AppMessage, AssistantMessage, etc.) and the external Composer protocol
 * messages (ComposerMessage). This conversion is essential for:
 *
 * - Web API: Converting agent output to JSON for the web client
 * - Session persistence: Storing/loading sessions in a portable format
 * - History hydration: Reconstructing agent state from saved sessions
 *
 * The conversion handles several complexities:
 * - Multi-content messages (text, images, thinking blocks, tool calls)
 * - Tool call/result pairing across message boundaries
 * - Usage/cost tracking with nested structures
 * - Timestamp normalization between formats
 *
 * Key design decisions:
 * - Images are replaced with placeholders (too large for JSON)
 * - Thinking blocks are extracted to a separate field
 * - Tool calls are serialized with their results as separate messages
 */

import type {
	ComposerAttachment,
	ComposerContentBlock,
	ComposerMessage,
	ComposerToolCall,
	ComposerUsage,
} from "@evalops/contracts";
import {
	isAssistantMessage,
	isToolResultMessage,
	isUserMessage,
} from "../agent/type-guards.js";
import type {
	AppMessage,
	AssistantMessage,
	Attachment,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../agent/types.js";
import type { RegisteredModel } from "../models/registry.js";

/** Direction of conversion for error context */
export type SessionSerializationDirection = "app->composer" | "composer->app";

/**
 * Context provided in serialization errors for debugging.
 * Includes message index and direction to locate the problematic message.
 */
export interface SessionSerializationContext {
	/** Index of the message in the array (0-based) */
	index?: number;
	/** Role of the message being converted */
	role?: string;
	/** Direction of the conversion */
	source?: SessionSerializationDirection;
}

/**
 * Convert internal Usage to Composer protocol format.
 * Handles missing/undefined fields by defaulting to zero.
 */
function toComposerUsage(usage?: Usage): ComposerUsage | undefined {
	if (!usage) return undefined;
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		// Ensure cost object always has all required fields
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

/**
 * Error thrown when serialization/deserialization fails.
 * Includes context about which message caused the failure.
 */
export class SessionSerializationError extends Error {
	readonly context?: SessionSerializationContext;

	constructor(message: string, context?: SessionSerializationContext) {
		super(context ? `${message} (${JSON.stringify(context)})` : message);
		this.name = "SessionSerializationError";
		this.context = context;
	}
}

// Placeholder strings used when images can't be serialized to JSON
const IMAGE_PLACEHOLDER_PREFIX = "[image:";
const UNKNOWN_IMAGE_PLACEHOLDER = "[image]";

/**
 * Safely stringify a value, returning a placeholder if serialization fails.
 * Handles circular references and BigInt values gracefully.
 */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "[unserializable]";
	}
}

/** Type guard for plain objects (not arrays or null) */
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toComposerAttachments(
	attachments: Attachment[] | undefined,
	options?: { includeAttachmentContent?: boolean },
): ComposerAttachment[] | undefined {
	if (!attachments || attachments.length === 0) return undefined;
	const includeAttachmentContent = options?.includeAttachmentContent !== false;
	return attachments.map((a) => ({
		id: a.id,
		type: a.type,
		fileName: a.fileName,
		mimeType: a.mimeType,
		size: a.size,
		content: includeAttachmentContent ? a.content : undefined,
		contentOmitted: includeAttachmentContent ? undefined : true,
		extractedText: a.extractedText,
		preview: a.preview,
	}));
}

function fromComposerAttachments(
	attachments: ComposerAttachment[] | undefined,
): Attachment[] | undefined {
	if (!attachments || attachments.length === 0) return undefined;

	const out: Attachment[] = [];
	for (const a of attachments) {
		if (!a) continue;
		if (typeof a.id !== "string" || !a.id) continue;
		if (a.type !== "image" && a.type !== "document") continue;
		if (typeof a.fileName !== "string" || !a.fileName) continue;
		if (typeof a.mimeType !== "string" || !a.mimeType) continue;
		if (typeof a.size !== "number" || !Number.isFinite(a.size)) continue;
		if (typeof a.content !== "string" || a.content.length === 0) {
			// Content omitted in session responses; do not pass to agent.
			continue;
		}
		out.push({
			id: a.id,
			type: a.type,
			fileName: a.fileName,
			mimeType: a.mimeType,
			size: a.size,
			content: a.content,
			extractedText:
				typeof a.extractedText === "string" ? a.extractedText : undefined,
			preview: typeof a.preview === "string" ? a.preview : undefined,
		});
	}

	return out.length ? out : undefined;
}

/** Helper to construct error context from conversion parameters */
function buildContext(
	source: SessionSerializationDirection,
	index: number,
	role?: string,
): SessionSerializationContext {
	return { source, index, role };
}

/**
 * Create a zero-initialized usage object.
 * Used when converting messages that don't have usage data.
 */
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

/**
 * Serialize tool call content to a string for the tool result message.
 * Handles various result types: strings, primitives, objects.
 * Falls back to serializing args if result is missing.
 */
export function serializeToolContent(tool: ComposerToolCall): string {
	// String results are used directly
	if (typeof tool.result === "string") {
		return tool.result;
	}
	// Primitives are converted to string
	if (typeof tool.result === "number" || typeof tool.result === "boolean") {
		return String(tool.result);
	}
	// Objects are JSON-serialized
	if (tool.result && typeof tool.result === "object") {
		return safeStringify(tool.result);
	}
	// Fallback: serialize the args if no result
	if (tool.args && typeof tool.args === "object") {
		return safeStringify(tool.args);
	}
	return "";
}

/**
 * Convert a timestamp to ISO string format.
 * Handles both numeric (ms since epoch) and string inputs.
 * Returns current time if input is undefined.
 */
function toIsoString(
	input: number | string | undefined,
	context: SessionSerializationContext,
): string {
	if (typeof input === "number") {
		// Validate numeric timestamp (reject NaN, Infinity)
		if (!Number.isFinite(input)) {
			throw new SessionSerializationError("Invalid numeric timestamp", context);
		}
		return new Date(input).toISOString();
	}
	if (typeof input === "string") {
		// Parse and validate string timestamp
		const parsed = Date.parse(input);
		if (!Number.isFinite(parsed)) {
			throw new SessionSerializationError("Invalid timestamp", context);
		}
		return new Date(parsed).toISOString();
	}
	// Default to current time if not provided
	return new Date().toISOString();
}

/**
 * Convert an ISO string timestamp to numeric (ms since epoch).
 * Returns current time if input is undefined.
 */
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

/**
 * Extract text content from a message's content array.
 * Handles mixed content types:
 * - Text blocks are concatenated
 * - Images are replaced with placeholders
 * - Thinking and tool calls are skipped (handled separately)
 * - Unknown types get a placeholder
 */
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

		// Text blocks - include as-is
		if (block.type === "text") {
			fragments.push(block.text);
			continue;
		}

		// Image blocks - replace with placeholder (too large for JSON)
		if (block.type === "image") {
			const descriptor = block.mimeType
				? `${IMAGE_PLACEHOLDER_PREFIX}${block.mimeType}]`
				: UNKNOWN_IMAGE_PLACEHOLDER;
			fragments.push(descriptor);
			continue;
		}

		// Thinking and tool calls are extracted separately, skip here
		if (block.type === "thinking" || block.type === "toolCall") {
			continue;
		}

		// Unknown content type - add placeholder with type info
		const fallbackType = (block as { type?: string }).type || "unknown";
		fragments.push(`[content:${fallbackType}]`);
	}

	return fragments.join("\n\n");
}

/**
 * Extract thinking content from a message into a single string.
 * Returns undefined if no thinking blocks are present.
 */
function extractThinking(
	content?:
		| string
		| Array<TextContent | ThinkingContent | ToolCall | ImageContent>,
): string | undefined {
	if (!content || typeof content === "string") return undefined;

	// Filter to thinking blocks, extract text, and join
	const thought = content
		.filter((block): block is ThinkingContent => block.type === "thinking")
		.map((block) => block.thinking.trim())
		.filter(Boolean)
		.join("\n\n");

	return thought.length ? thought : undefined;
}

/**
 * Extract tool calls from a message into Composer format.
 * Returns empty array if no tool calls are present.
 */
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

function extractComposerTextContent(
	content: ComposerMessage["content"],
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function normalizeComposerContentBlocks(
	content: ComposerMessage["content"],
): Array<TextContent | ThinkingContent | ToolCall | ImageContent> {
	if (!Array.isArray(content)) return [];
	const normalized: Array<
		TextContent | ThinkingContent | ToolCall | ImageContent
	> = [];
	for (const block of content as ComposerContentBlock[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") {
			normalized.push({ type: "text", text: block.text });
		} else if (block.type === "thinking") {
			normalized.push({ type: "thinking", thinking: block.thinking });
		} else if (block.type === "toolCall") {
			normalized.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: block.arguments,
				thoughtSignature: block.thoughtSignature,
			});
		} else if (block.type === "image") {
			normalized.push({
				type: "image",
				data: block.data,
				mimeType: block.mimeType,
			});
		}
	}
	return normalized;
}

/**
 * Convert a single internal AppMessage to Composer protocol format.
 *
 * This is the main App -> Composer conversion function. It handles:
 * - User messages: Extract text content
 * - Assistant messages: Extract text, thinking, and tool calls
 * - Tool results: Extract result content and error status
 * - System messages: Extract text content
 *
 * @param message - The internal message to convert
 * @param index - Position in the message array (for error context)
 */
export function convertAppMessageToComposer(
	message: AppMessage,
	index = 0,
	options?: { includeAttachmentContent?: boolean },
): ComposerMessage {
	const context = buildContext("app->composer", index, message.role);
	const timestamp = toIsoString(
		"timestamp" in message ? message.timestamp : undefined,
		context,
	);

	// User messages - simple text extraction
	if (isUserMessage(message)) {
		const attachments = toComposerAttachments(
			"attachments" in message
				? (message as { attachments?: Attachment[] }).attachments
				: undefined,
			options,
		);
		return {
			role: "user",
			content: extractTextContent(message.content),
			timestamp,
			attachments,
		};
	}

	// Assistant messages - extract text, thinking, and tool calls
	if (isAssistantMessage(message)) {
		const tools = extractToolCalls(message.content);
		return {
			role: "assistant",
			content: extractTextContent(message.content),
			thinking: extractThinking(message.content),
			timestamp,
			tools: tools.length ? tools : undefined,
			usage: toComposerUsage(message.usage),
			provider: message.provider,
			api: message.api,
			model: message.model,
		};
	}

	// Tool result messages - include tool name and error status
	if (isToolResultMessage(message)) {
		return {
			role: "tool",
			content: extractTextContent(message.content),
			timestamp,
			toolName: message.toolName,
			isError: message.isError,
		};
	}

	// System messages (rare, but supported)
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

/**
 * Convert an array of AppMessages to Composer format.
 * Preserves message order and provides index context for errors.
 */
export function convertAppMessagesToComposer(
	messages: AppMessage[],
	options?: { includeAttachmentContent?: boolean },
): ComposerMessage[] {
	return messages.map((message, index) =>
		convertAppMessageToComposer(message, index, options),
	);
}

/**
 * Normalize a Composer tool call to internal ToolCall format.
 * Generates stable IDs if not provided.
 *
 * @param tool - The Composer tool call to normalize
 * @param messageIndex - Message position (for generating fallback IDs)
 * @param contentIndex - Content block position (for generating fallback IDs)
 */
function normalizeToolCall(
	tool: ComposerToolCall,
	messageIndex: number,
	contentIndex: number,
): ToolCall {
	// Generate fallback name/ID if not provided
	const name = tool.name?.trim() || `tool_${messageIndex}_${contentIndex}`;
	const toolCallId =
		tool.toolCallId || `web-tool-${messageIndex}-${contentIndex}`;
	// Ensure args is a record (not array or primitive)
	const args: Record<string, unknown> = isRecord(tool.args) ? tool.args : {};

	return {
		type: "toolCall",
		id: toolCallId,
		name,
		arguments: args,
	};
}

/**
 * Create a ToolResultMessage from a Composer tool call.
 * The result is derived from the tool call's embedded result field.
 */
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

/**
 * Convert a single Composer message to internal AppMessage format.
 *
 * This is the main Composer -> App conversion function. Note that a single
 * Composer message may expand to multiple AppMessages when tool calls are
 * present (the assistant message + one toolResult per tool).
 *
 * @param message - The Composer message to convert
 * @param model - Model metadata to attach to assistant messages
 * @param index - Position in the message array (for error context)
 * @returns Array of AppMessages (may be 1+ messages)
 */
export function convertComposerMessageToApp(
	message: ComposerMessage,
	model: RegisteredModel,
	index = 0,
): AppMessage[] {
	const context = buildContext("composer->app", index, message.role);

	// User messages - wrap content in text block
	if (message.role === "user") {
		const attachments = fromComposerAttachments(message.attachments);
		if (Array.isArray(message.content)) {
			const normalized = normalizeComposerContentBlocks(message.content).filter(
				(block) => block.type === "text" || block.type === "image",
			);
			return [
				{
					role: "user",
					content:
						normalized.length > 0 ? normalized : [{ type: "text", text: "" }],
					attachments,
					timestamp: toTimestamp(message.timestamp, context),
				},
			];
		}
		return [
			{
				role: "user",
				content: [
					{ type: "text", text: extractComposerTextContent(message.content) },
				],
				attachments,
				timestamp: toTimestamp(message.timestamp, context),
			},
		];
	}

	// Assistant messages - reconstruct content array from components
	if (message.role === "assistant") {
		const resolvedProvider = message.provider ?? model.provider;
		const resolvedApi = (message.api ?? model.api) as AssistantMessage["api"];
		const resolvedModel = message.model ?? model.id;
		if (Array.isArray(message.content)) {
			const normalizedSequence = normalizeComposerContentBlocks(
				message.content,
			).filter(
				(block): block is TextContent | ThinkingContent | ToolCall =>
					block.type !== "image",
			);
			const hasThinking = normalizedSequence.some(
				(block) => block.type === "thinking",
			);
			const hasToolCalls = normalizedSequence.some(
				(block) => block.type === "toolCall",
			);

			if (!hasThinking && message.thinking?.trim()) {
				normalizedSequence.unshift({
					type: "thinking",
					thinking: message.thinking.trim(),
				});
			}

			const tools = message.tools ?? [];
			if (!hasToolCalls && tools.length > 0) {
				const baseContentLength = normalizedSequence.length;
				const toolCalls: ToolCall[] = tools.map((tool, toolIndex) =>
					normalizeToolCall(tool, index, baseContentLength + toolIndex),
				);
				normalizedSequence.push(...toolCalls);
			}

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: normalizedSequence,
				api: resolvedApi,
				provider: resolvedProvider,
				model: resolvedModel,
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
			const toolCallBlocks = normalizedSequence.filter(
				(block): block is ToolCall => block.type === "toolCall",
			);

			// Generate tool result messages for each tool call
			tools.forEach((tool, toolIndex) => {
				const normalizedCall =
					(tool.toolCallId
						? toolCallBlocks.find((block) => block.id === tool.toolCallId)
						: toolCallBlocks[toolIndex]) ??
					normalizeToolCall(tool, index, normalizedSequence.length + toolIndex);
				results.push(
					normalizeToolResult(tool, normalizedCall, message.timestamp, context),
				);
			});

			return results;
		}
		// Build content array: thinking first, then text, then tool calls
		const normalizedSequence: Array<TextContent | ThinkingContent | ToolCall> =
			[];

		// Add thinking block if present
		if (message.thinking?.trim()) {
			normalizedSequence.push({
				type: "thinking",
				thinking: message.thinking.trim(),
			});
		}

		// Add text content if present
		if (extractComposerTextContent(message.content)) {
			normalizedSequence.push({
				type: "text",
				text: extractComposerTextContent(message.content),
			});
		}

		// Convert and add tool calls
		const tools = message.tools ?? [];
		const baseContentLength = normalizedSequence.length;
		const toolCalls: ToolCall[] = tools.map((tool, toolIndex) =>
			normalizeToolCall(tool, index, baseContentLength + toolIndex),
		);
		normalizedSequence.push(...toolCalls);

		// Build the assistant message with model metadata
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: normalizedSequence,
			api: resolvedApi,
			provider: resolvedProvider,
			model: resolvedModel,
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

		// Generate tool result messages for each tool call
		// These follow the assistant message in the conversation
		tools.forEach((tool, toolIndex) => {
			const normalizedCall = toolCalls[toolIndex]!;
			results.push(
				normalizeToolResult(tool, normalizedCall, message.timestamp, context),
			);
		});

		return results;
	}

	// Standalone tool messages (less common, but supported)
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
						text: extractComposerTextContent(message.content),
					},
				],
				isError: Boolean(message.isError),
				timestamp: toTimestamp(message.timestamp, context),
			},
		];
	}

	// System messages are converted to assistant messages
	// (internal format doesn't have a separate system role in conversation)
	if (message.role === "system") {
		return [
			{
				role: "assistant",
				content: [
					{ type: "text", text: extractComposerTextContent(message.content) },
				],
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

/**
 * Convert an array of Composer messages to internal AppMessage format.
 *
 * Note: The output array may be longer than the input because assistant
 * messages with tool calls expand to multiple AppMessages.
 */
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
