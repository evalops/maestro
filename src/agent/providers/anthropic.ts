/**
 * Anthropic Provider - Claude LLM Integration
 *
 * This module implements streaming communication with Anthropic's Messages API
 * for all Claude models. It handles the full request/response lifecycle including
 * tool calls, extended thinking, and prompt caching.
 *
 * ## API Endpoint
 *
 * The provider communicates with `https://api.anthropic.com/v1/messages`:
 *
 * ```json
 * {
 *   "model": "claude-opus-4-5-20251101",
 *   "max_tokens": 8192,
 *   "system": "You are a helpful assistant...",
 *   "messages": [{"role": "user", "content": "Hello"}],
 *   "tools": [...],
 *   "stream": true
 * }
 * ```
 *
 * ## Streaming Architecture
 *
 * Anthropic uses Server-Sent Events (SSE) with typed event payloads:
 *
 * ```
 * event: message_start
 * data: {"type":"message_start","message":{...}}
 *
 * event: content_block_start
 * data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}
 *
 * event: content_block_delta
 * data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 * event: content_block_stop
 * data: {"type":"content_block_stop","index":0}
 *
 * event: message_stop
 * data: {"type":"message_stop"}
 * ```
 *
 * ## Content Block Types
 *
 * | Type       | Description                                    |
 * |------------|------------------------------------------------|
 * | text       | Regular text content                           |
 * | thinking   | Extended thinking/reasoning (Claude 3.5+)      |
 * | tool_use   | Tool call request                              |
 * | tool_result| Result returned to the model                   |
 *
 * ## Extended Thinking
 *
 * Claude models support extended thinking for complex reasoning:
 *
 * ```json
 * {
 *   "thinking": {
 *     "type": "enabled",
 *     "budget_tokens": 16000
 *   }
 * }
 * ```
 *
 * Thinking content is streamed in `thinking` content blocks and can be
 * displayed to users or hidden. Budget is calculated based on reasoning effort:
 *
 * | Effort  | Budget Tokens |
 * |---------|---------------|
 * | minimal | 1,024         |
 * | low     | 4,096         |
 * | medium  | 8,192         |
 * | high    | 16,000        |
 *
 * ## Prompt Caching
 *
 * Anthropic supports prompt caching to reduce latency and costs:
 *
 * ```json
 * {
 *   "cache_control": { "type": "ephemeral" }
 * }
 * ```
 *
 * Cache control can be applied to:
 * - System prompt
 * - Messages
 * - Tool definitions
 *
 * ## Tool Calling
 *
 * Tools are converted to Anthropic's format:
 *
 * ```json
 * {
 *   "name": "read_file",
 *   "description": "Reads a file from disk",
 *   "input_schema": {...json-schema...}
 * }
 * ```
 *
 * Tool results are sent as user messages with `tool_result` content blocks.
 *
 * @module agent/providers/anthropic
 */

import { CLAUDE_CODE_BETA_HEADER } from "../../providers/anthropic-auth.js";
import { fetchWithRetry } from "../../providers/network-config.js";
import {
	createTimeoutReader,
	isStreamIdleTimeoutError,
} from "../../providers/stream-idle-timeout.js";
import { createLogger } from "../../utils/logger.js";
import type {
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	PromptCacheControl,
	ReasoningEffort,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.js";
import {
	createToolArgumentNormalizer,
	describeValueType,
	isRecord,
} from "./tool-arguments.js";
import { transformMessages } from "./transform-messages.js";

const logger = createLogger("agent:providers:anthropic");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "Anthropic",
});

const ANTHROPIC_TOOL_ID_MAX = 64;

function shortHash(value: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < value.length; i++) {
		const ch = value.charCodeAt(i);
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

function createAnthropicToolCallIdNormalizer() {
	const mapping = new Map<string, string>();
	const used = new Set<string>();

	return (id: string): string => {
		const existing = mapping.get(id);
		if (existing) return existing;

		let sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitized) {
			sanitized = `tool_${shortHash(id)}`;
		}

		const fitToLimit = (base: string, suffix?: string) => {
			if (!suffix) return base.slice(0, ANTHROPIC_TOOL_ID_MAX);
			const maxPrefix = ANTHROPIC_TOOL_ID_MAX - suffix.length - 1;
			const prefix = maxPrefix > 0 ? base.slice(0, maxPrefix) : "";
			return `${prefix}_${suffix}`.slice(0, ANTHROPIC_TOOL_ID_MAX);
		};

		let candidate =
			sanitized.length <= ANTHROPIC_TOOL_ID_MAX
				? sanitized
				: fitToLimit(sanitized, shortHash(sanitized));

		let attempt = 0;
		while (used.has(candidate)) {
			attempt += 1;
			const suffix = shortHash(`${id}:${attempt}`);
			candidate = fitToLimit(sanitized, suffix);
		}

		mapping.set(id, candidate);
		used.add(candidate);
		return candidate;
	};
}

export interface AnthropicOptions extends StreamOptions {
	thinking?: ReasoningEffort;
}

interface AnthropicTextContent {
	type: "text";
	text: string;
	cache_control?: PromptCacheControl;
}

interface AnthropicImageContent {
	type: "image";
	source: { type: "base64"; media_type: string; data: string };
	cache_control?: PromptCacheControl;
}

interface AnthropicToolUseContent {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

interface AnthropicToolResultContent {
	type: "tool_result";
	tool_use_id: string;
	content:
		| string
		| Array<
				| { type: "text"; text: string }
				| {
						type: "image";
						source: {
							type: "base64";
							media_type: string;
							data: string;
						};
				  }
		  >;
	is_error?: boolean;
	cache_control?: PromptCacheControl;
}

type AnthropicContentPart =
	| AnthropicTextContent
	| AnthropicImageContent
	| AnthropicToolUseContent
	| AnthropicToolResultContent;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentPart[];
}

interface AnthropicInputSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: AnthropicInputSchema;
	cache_control?: PromptCacheControl;
	type?: string;
	input_examples?: unknown[];
	allowed_callers?: string[];
	defer_loading?: boolean;
}

// Anthropic SSE Event Types
interface AnthropicMessageStartEvent {
	type: "message_start";
	message?: {
		usage?: {
			input_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
}

interface AnthropicContentBlockStartEvent {
	type: "content_block_start";
	index: number;
	content_block: {
		type: "text" | "thinking" | "tool_use";
		id?: string;
		name?: string;
	};
}

interface AnthropicContentBlockDeltaEvent {
	type: "content_block_delta";
	index: number;
	delta: {
		type: "text_delta" | "thinking_delta" | "input_json_delta";
		text?: string;
		thinking?: string;
		partial_json?: string;
	};
}

interface AnthropicContentBlockStopEvent {
	type: "content_block_stop";
	index: number;
}

interface AnthropicMessageDeltaEvent {
	type: "message_delta";
	delta?: {
		stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
	};
	usage?: {
		output_tokens?: number;
	};
}

interface AnthropicMessageStopEvent {
	type: "message_stop";
}

interface AnthropicErrorEvent {
	type: "error";
	error?: {
		message?: string;
	};
}

type AnthropicEvent =
	| AnthropicMessageStartEvent
	| AnthropicContentBlockStartEvent
	| AnthropicContentBlockDeltaEvent
	| AnthropicContentBlockStopEvent
	| AnthropicMessageDeltaEvent
	| AnthropicMessageStopEvent
	| AnthropicErrorEvent;

interface AnthropicRequestBody {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	stream: boolean;
	system?: Array<{
		type: "text";
		text: string;
		cache_control?: PromptCacheControl;
	}>;
	tools?: AnthropicTool[];
	temperature?: number;
	thinking?: {
		type: "enabled";
		budget_tokens: number;
	};
}

export async function* streamAnthropic(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const apiKey = options.apiKey;
	if (!apiKey) {
		throw new Error("API key is required for Anthropic");
	}

	// Convert messages
	const messages: AnthropicMessage[] = [];
	const pushMessage = (message: AnthropicMessage): void => {
		if (typeof message.content === "string") {
			if (message.content.trim().length === 0) {
				return;
			}
		} else if (Array.isArray(message.content) && message.content.length === 0) {
			return;
		}
		messages.push(message);
	};
	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(context.messages, model);
	const normalizeToolCallId = createAnthropicToolCallIdNormalizer();

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (!msg) continue;

		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content.map((c) => {
							if (c.type === "text") {
								return { type: "text" as const, text: c.text };
							}
							return {
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: c.mimeType,
									data: c.data,
								},
							};
						});
			pushMessage({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content: Array<AnthropicTextContent | AnthropicToolUseContent> = [];
			for (const c of msg.content) {
				if (c.type === "text") {
					content.push({ type: "text", text: c.text });
				} else if (c.type === "toolCall") {
					content.push({
						type: "tool_use",
						id: normalizeToolCallId(c.id),
						name: c.name,
						input: c.arguments,
					});
				}
			}
			pushMessage({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages into one user message
			const toolResults: AnthropicToolResultContent[] = [];

			// Helper to convert tool result content
			type ToolResultContentInput = (
				| TextContent
				| { type: "image"; data: string; mimeType: string }
			)[];
			const convertToolResultContent = (
				contentInput: string | ToolResultContentInput,
			): AnthropicToolResultContent["content"] =>
				typeof contentInput === "string"
					? contentInput
					: contentInput.map((c) => {
							if (c.type === "text") {
								return { type: "text" as const, text: c.text };
							}
							return {
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: c.mimeType,
									data: c.data,
								},
							};
						});

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: normalizeToolCallId(msg.toolCallId),
				content: convertToolResultContent(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (
				j < context.messages.length &&
				context.messages[j]?.role === "toolResult"
			) {
				const nextMsg = context.messages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: normalizeToolCallId(nextMsg.toolCallId),
					content: convertToolResultContent(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			pushMessage({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Apply prompt caching - mark last 4 items for caching
	let cacheAppliedCount = 0;
	const maxCacheItems = 4;

	// Cache tools (last tool)
	const tools: AnthropicTool[] =
		context.tools?.map((tool, idx, arr) => {
			const params = tool.parameters as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			const schema: AnthropicInputSchema = {
				type: "object",
				properties: params.properties || {},
				required: params.required || [],
			};
			const mappedTool: AnthropicTool = {
				name: tool.name,
				description: tool.description,
				input_schema: schema,
				...(tool.toolType ? { type: tool.toolType } : {}),
				...(tool.inputExamples && tool.inputExamples.length > 0
					? { input_examples: tool.inputExamples }
					: {}),
				...(tool.allowedCallers && tool.allowedCallers.length > 0
					? { allowed_callers: tool.allowedCallers }
					: {}),
				...(tool.deferApiDefinition
					? { defer_loading: tool.deferApiDefinition }
					: {}),
				...(idx === arr.length - 1 && cacheAppliedCount < maxCacheItems
					? { cache_control: { type: "ephemeral" as const } }
					: {}),
			};
			return mappedTool;
		}) || [];

	if (tools.length > 0 && tools[tools.length - 1]?.cache_control) {
		cacheAppliedCount++;
	}

	const hasAdvancedToolFeatures = tools.some(
		(tool) =>
			tool.defer_loading ||
			(tool.input_examples && tool.input_examples.length > 0) ||
			(tool.allowed_callers && tool.allowed_callers.length > 0) ||
			!!tool.type,
	);

	// Cache system prompt
	const systemBlocks: Array<{
		type: "text";
		text: string;
		cache_control?: PromptCacheControl;
	}> = [];
	if (context.systemPrompt) {
		systemBlocks.push({
			type: "text",
			text: context.systemPrompt,
			...(cacheAppliedCount < maxCacheItems
				? { cache_control: { type: "ephemeral" as const } }
				: {}),
		});
		if (systemBlocks[0]?.cache_control) {
			cacheAppliedCount++;
		}
	}

	// Cache messages (mark breakpoints from end)
	for (
		let i = messages.length - 1;
		i >= 0 && cacheAppliedCount < maxCacheItems;
		i--
	) {
		const msg = messages[i];
		if (msg?.role === "user" && Array.isArray(msg.content)) {
			const lastContent = msg.content[msg.content.length - 1];
			if (
				lastContent &&
				(lastContent.type === "text" || lastContent.type === "image")
			) {
				lastContent.cache_control = { type: "ephemeral" };
				cacheAppliedCount++;
			}
		}
	}

	const requestBody: AnthropicRequestBody = {
		model: model.id,
		max_tokens: options.maxTokens || model.maxTokens,
		messages,
		stream: true,
	};

	if (systemBlocks.length > 0) {
		requestBody.system = systemBlocks;
	}

	if (tools.length > 0) {
		requestBody.tools = tools;
	}

	if (options.temperature !== undefined) {
		requestBody.temperature = options.temperature;
	}

	if (options.thinking && model.reasoning) {
		// Budget tokens based on reasoning effort level
		const thinkingBudgets: Record<ReasoningEffort, number> = {
			minimal: 1024,
			low: 4096,
			medium: 8192,
			high: 16000,
			ultra: 32000, // Maximum thinking budget for complex problems
		};
		requestBody.thinking = {
			type: "enabled",
			budget_tokens: thinkingBudgets[options.thinking] ?? 10000,
		};
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		...options.headers,
	};

	const isOAuth = options.authType === "anthropic-oauth";
	if (isOAuth) {
		headers.authorization = `Bearer ${apiKey}`;
		headers["anthropic-beta"] = CLAUDE_CODE_BETA_HEADER;
	} else {
		headers["x-api-key"] = apiKey;
		const betaHeaders = ["prompt-caching-2024-07-31"];
		if (options.thinking && model.reasoning) {
			betaHeaders.push("extended-thinking-2024-12-12");
		}
		if (hasAdvancedToolFeatures) {
			betaHeaders.push("advanced-tool-use-2025-11-20");
		}
		headers["anthropic-beta"] = betaHeaders.join(",");
	}

	const response = await fetchWithRetry(
		model.baseUrl,
		{
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: options.signal,
		},
		model.provider,
		{ modelId: model.id },
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			buildAnthropicErrorMessage(response.status, errorText, model),
		);
	}

	if (!response.body) {
		throw new Error("Response body is null");
	}

	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
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
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	yield { type: "start", partial };

	// Wrap reader with idle timeout detection
	const rawReader = response.body.getReader();
	const reader = createTimeoutReader(rawReader, {
		provider: model.provider,
		signal: options.signal,
	});
	const decoder = new TextDecoder();
	let buffer = "";
	const toolArgBuffers = new Map<number, string>();
	const toolArgOverrides = new Map<number, Record<string, unknown>>();
	const appendDelta = (
		existing: string,
		delta: string,
	): { next: string; skipped: boolean } => {
		if (!delta) return { next: existing, skipped: true };
		if (existing.endsWith(delta)) {
			return { next: existing, skipped: true };
		}
		const overlap = Math.min(existing.length, delta.length);
		let shared = 0;
		for (let i = overlap; i > 0; i--) {
			if (existing.endsWith(delta.slice(0, i))) {
				shared = i;
				break;
			}
		}
		return { next: existing + delta.slice(shared), skipped: false };
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim() || !line.startsWith("data: ")) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;

				try {
					const event = JSON.parse(data);

					if (event.type === "message_start") {
						if (event.message?.usage) {
							partial.usage.input = event.message.usage.input_tokens || 0;
							partial.usage.cacheRead =
								event.message.usage.cache_read_input_tokens || 0;
							partial.usage.cacheWrite =
								event.message.usage.cache_creation_input_tokens || 0;
						}
					} else if (event.type === "content_block_start") {
						const block = event.content_block;
						if (block.type === "text") {
							const idx = partial.content.length;
							partial.content.push({ type: "text", text: "" });
							yield { type: "text_start", contentIndex: idx, partial };
						} else if (block.type === "thinking") {
							const idx = partial.content.length;
							partial.content.push({ type: "thinking", thinking: "" });
							yield { type: "thinking_start", contentIndex: idx, partial };
						} else if (block.type === "tool_use") {
							if (!block.id || !block.name) {
								logger.warn("Missing required fields for tool_use block", {
									id: block.id,
									name: block.name,
								});
								continue;
							}
							const idx = partial.content.length;
							let initialArguments: Record<string, unknown> = {};
							if ("input" in block && block.input !== undefined) {
								if (isRecord(block.input)) {
									initialArguments = block.input;
									toolArgOverrides.set(idx, block.input);
								} else if (typeof block.input === "string") {
									toolArgBuffers.set(idx, block.input);
									initialArguments = toolArgumentNormalizer.parseFromString(
										block.input,
										{ toolId: block.id, name: block.name, stage: "delta" },
										{ logInvalid: false },
									);
								} else if (block.input !== null) {
									const rawType = describeValueType(block.input);
									toolArgumentNormalizer.warnOnce(
										`raw:${rawType}`,
										"Anthropic tool_use input had unexpected type",
										{
											toolId: block.id,
											name: block.name,
											rawType,
										},
									);
								}
							}
							const toolCall: ToolCall = {
								type: "toolCall",
								id: block.id,
								name: block.name,
								arguments: initialArguments,
							};
							partial.content.push(toolCall);
							yield { type: "toolcall_start", contentIndex: idx, partial };
						}
					} else if (event.type === "content_block_delta") {
						const delta = event.delta;
						const idx = event.index;
						const block = partial.content[idx];

						if (delta.type === "text_delta" && block?.type === "text") {
							const chunk = delta.text;
							const previousLength = block.text.length;
							const { next, skipped } = appendDelta(block.text, chunk);
							if (skipped) continue;
							block.text = next;
							yield {
								type: "text_delta",
								contentIndex: idx,
								delta: next.slice(previousLength),
								partial,
							};
						} else if (
							delta.type === "thinking_delta" &&
							block?.type === "thinking"
						) {
							const chunk = delta.thinking;
							const previousLength = block.thinking.length;
							const { next, skipped } = appendDelta(block.thinking, chunk);
							if (skipped) continue;
							block.thinking = next;
							yield {
								type: "thinking_delta",
								contentIndex: idx,
								delta: next.slice(previousLength),
								partial,
							};
						} else if (
							delta.type === "input_json_delta" &&
							block?.type === "toolCall"
						) {
							const partialJson = delta.partial_json || "";
							toolArgOverrides.delete(idx);
							const existing = toolArgBuffers.get(idx) ?? "";
							const combined = existing + partialJson;
							toolArgBuffers.set(idx, combined);

							block.arguments = toolArgumentNormalizer.parseFromString(
								combined,
								{ toolId: block.id, name: block.name, stage: "delta" },
								{ logInvalid: false },
							);

							yield {
								type: "toolcall_delta",
								contentIndex: idx,
								delta: partialJson,
								partial,
							};
						}
					} else if (event.type === "content_block_stop") {
						const idx = event.index;
						const block = partial.content[idx];

						if (block?.type === "text") {
							yield {
								type: "text_end",
								contentIndex: idx,
								content: block.text,
								partial,
							};
						} else if (block?.type === "thinking") {
							yield {
								type: "thinking_end",
								contentIndex: idx,
								content: block.thinking,
								partial,
							};
						} else if (block?.type === "toolCall") {
							const overrideArgs = toolArgOverrides.get(idx);
							if (overrideArgs) {
								block.arguments = overrideArgs;
							} else {
								const buf = toolArgBuffers.get(idx) ?? "";
								if (buf.length > 0) {
									block.arguments = toolArgumentNormalizer.parseFromString(
										buf,
										{ toolId: block.id, name: block.name, stage: "done" },
										{ logInvalid: true },
									);
								} else {
									block.arguments = isRecord(block.arguments)
										? block.arguments
										: {};
								}
							}
							toolArgBuffers.delete(idx);
							toolArgOverrides.delete(idx);

							yield {
								type: "toolcall_end",
								contentIndex: idx,
								toolCall: block,
								partial,
							};
						}
					} else if (event.type === "message_delta") {
						if (event.delta?.stop_reason) {
							partial.stopReason =
								event.delta.stop_reason === "end_turn"
									? "stop"
									: event.delta.stop_reason === "max_tokens"
										? "length"
										: event.delta.stop_reason === "tool_use"
											? "toolUse"
											: "stop";
						}
						if (event.usage) {
							partial.usage.output = event.usage.output_tokens || 0;
						}
					} else if (event.type === "message_stop") {
						// Calculate costs
						partial.usage.cost = {
							input: (partial.usage.input * model.cost.input) / 1_000_000,
							output: (partial.usage.output * model.cost.output) / 1_000_000,
							cacheRead:
								(partial.usage.cacheRead * model.cost.cacheRead) / 1_000_000,
							cacheWrite:
								(partial.usage.cacheWrite * model.cost.cacheWrite) / 1_000_000,
							total: 0,
						};
						partial.usage.cost.total =
							partial.usage.cost.input +
							partial.usage.cost.output +
							partial.usage.cost.cacheRead +
							partial.usage.cost.cacheWrite;

						if (
							partial.stopReason === "error" ||
							partial.stopReason === "aborted"
						) {
							yield {
								type: "error",
								reason: partial.stopReason,
								error: partial,
							};
						} else {
							yield {
								type: "done",
								reason: partial.stopReason,
								message: partial,
							};
						}
					} else if (event.type === "error") {
						partial.stopReason = "error";
						partial.errorMessage = event.error?.message || "Unknown error";
						yield { type: "error", reason: "error", error: partial };
					}
				} catch (e) {
					// Skip malformed event
					logger.warn("Failed to parse Anthropic event", {
						error: e instanceof Error ? e.message : String(e),
						stack: e instanceof Error ? e.stack : undefined,
					});
				}
			}
		}
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			partial.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: partial };
		} else if (isStreamIdleTimeoutError(error)) {
			// Re-throw idle timeout errors so caller can retry
			throw error;
		} else {
			throw error;
		}
	} finally {
		toolArgBuffers.clear();
		toolArgOverrides.clear();
	}
}

function buildAnthropicErrorMessage(
	status: number,
	rawText: string,
	model: Model<"anthropic-messages">,
): string {
	try {
		const payload = JSON.parse(rawText);
		const requestId = payload?.request_id ?? payload?.error?.request_id;
		const message = payload?.error?.message ?? payload?.message;
		const type = payload?.error?.type;
		if (
			type === "invalid_request_error" &&
			typeof message === "string" &&
			/(prompt is too long|context (?:length|window))/i.test(message)
		) {
			const formatter = new Intl.NumberFormat("en-US");
			const limitLabel = model.contextWindow
				? `${formatter.format(model.contextWindow)} tokens`
				: "its context window";
			let friendly = `Anthropic rejected this request because the prompt exceeded ${limitLabel}. Use /compact to summarize prior messages or remove large attachments, then retry.`;
			if (requestId) {
				friendly += ` (request ${requestId})`;
			}
			return friendly;
		}
		if (typeof message === "string") {
			return requestId ? `${message} (request ${requestId})` : message;
		}
	} catch {
		// ignore parse failures
	}
	return `Anthropic API error (${status}): ${rawText}`;
}
