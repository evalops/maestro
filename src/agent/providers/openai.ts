/**
 * OpenAI Provider - LLM Integration for OpenAI-Compatible APIs
 *
 * This module implements streaming communication with OpenAI's API and
 * any OpenAI-compatible endpoints (e.g., Azure OpenAI, local models via
 * LM Studio, Ollama, vLLM, etc.).
 *
 * ## Supported APIs
 *
 * This provider supports two OpenAI API variants:
 *
 * ### 1. Chat Completions API (`openai-completions`)
 *
 * The standard OpenAI chat API at `/v1/chat/completions`:
 *
 * ```json
 * {
 *   "model": "gpt-4o",
 *   "messages": [{"role": "user", "content": "Hello"}],
 *   "stream": true,
 *   "tools": [...]
 * }
 * ```
 *
 * **Event Types:**
 * - `chat.completion.chunk`: Streaming text/tool_call deltas
 * - Final chunk has `finish_reason` and optional usage stats
 *
 * ### 2. Responses API (`openai-responses`)
 *
 * The newer stateful API at `/v1/responses`:
 *
 * ```json
 * {
 *   "model": "gpt-4o",
 *   "input": [{"role": "user", "content": [...]}],
 *   "stream": true,
 *   "tools": [...]
 * }
 * ```
 *
 * **Event Types:**
 * - `response.output_text.delta`: Text streaming
 * - `response.function_call_arguments.delta`: Tool call streaming
 * - `response.completed`: Final response with usage
 *
 * ## Streaming Architecture
 *
 * Both APIs use Server-Sent Events (SSE) for streaming:
 *
 * ```
 * Client                          Server
 *   │                                │
 *   │── POST /v1/chat/completions ──>│
 *   │                                │
 *   │<── data: {"choices":[...]} ────│
 *   │<── data: {"choices":[...]} ────│
 *   │<── data: {"choices":[...]} ────│
 *   │<── data: [DONE] ───────────────│
 *   │                                │
 * ```
 *
 * ## Tool Calling
 *
 * Tools are converted to OpenAI function format:
 *
 * ```json
 * {
 *   "type": "function",
 *   "function": {
 *     "name": "read_file",
 *     "description": "Reads a file from disk",
 *     "parameters": {...json-schema...}
 *   }
 * }
 * ```
 *
 * Tool calls are streamed as deltas and accumulated before execution.
 *
 * ## Extended Thinking / Reasoning
 *
 * For models that support it (e.g., o1, o1-mini), reasoning effort
 * can be specified via `reasoning_effort` parameter:
 *
 * | Effort  | Behavior                           |
 * |---------|------------------------------------|
 * | minimal | Brief chain-of-thought             |
 * | low     | Short reasoning                    |
 * | medium  | Moderate exploration               |
 * | high    | Deep reasoning with alternatives   |
 *
 * @module agent/providers/openai
 */

import { normalizeLLMBaseUrl } from "../../models/url-normalize.js";
import { fetchWithRetry } from "../../providers/network-config.js";
import { createLogger } from "../../utils/logger.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	StreamOptions,
} from "../types.js";

const logger = createLogger("agent:providers:openai");
import { parseStreamingJson } from "./json-parse.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

export interface OpenAIOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

// OpenAI API Types

interface OpenAITextContentPart {
	type: "text";
	text: string;
}

interface OpenAIImageContentPart {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}

type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

interface OpenAIResponsesRequestBody {
	model: string;
	input: Array<{
		role: string;
		content: Array<
			| { type: "input_text"; text: string }
			| { type: "output_text"; text: string }
		>;
	}>;
	stream: boolean;
	// Responses API uses flat tool format (name at top level, not nested under function)
	tools?: Array<{
		type: "function";
		name: string;
		description: string;
		parameters: unknown;
	}>;
	max_output_tokens?: number;
	reasoning?: { effort: string };
}

interface OpenAICompletionsRequestBody {
	model: string;
	messages: OpenAIMessage[];
	max_tokens: number;
	stream: boolean;
	stream_options: { include_usage: boolean };
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			description: string;
			parameters: unknown;
		};
	}>;
	temperature?: number;
	reasoning_effort?: string;
}

// =============================================================================
// Responses API Types
// =============================================================================

/**
 * Content part for Responses API input messages.
 * User messages use input_text, assistant messages use output_text.
 */
export type ResponsesInputTextPart = { type: "input_text"; text: string };
export type ResponsesOutputTextPart = { type: "output_text"; text: string };
export type ResponsesContentPart =
	| ResponsesInputTextPart
	| ResponsesOutputTextPart;

/**
 * Message format for Responses API input array.
 */
export interface ResponsesInputMessage {
	role: "user" | "assistant" | "system" | "developer";
	content: ResponsesContentPart[];
}

// OpenAI SSE Event Types (Responses API)
interface OpenAIResponsesTextDeltaEvent {
	type: "response.output_text.delta";
	content_index?: number;
	delta?: string;
}

interface OpenAIResponsesTextDoneEvent {
	type: "response.output_text.done";
	content_index?: number;
}

interface OpenAIResponsesFunctionCallDeltaEvent {
	type: "response.function_call_arguments.delta";
	call_id?: string;
	item_id?: string;
	output_index?: number;
	delta?: string;
}

interface OpenAIResponsesFunctionCallDoneEvent {
	type: "response.function_call_arguments.done";
	call_id?: string;
	item_id?: string;
	output_index?: number;
	name?: string;
	arguments?: string;
}

interface OpenAIResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	output_tokens_details?: {
		reasoning_tokens?: number;
	};
}

interface OpenAIResponsesCompletedEvent {
	type: "response.completed";
	response?: {
		status?: "completed" | "failed" | "cancelled";
		usage?: OpenAIResponsesUsage;
	};
}

interface OpenAIResponsesFailedEvent {
	type: "response.failed";
	response?: {
		error?: {
			message?: string;
		};
	};
}

interface OpenAIResponsesDoneEvent {
	type: "response.done";
	response?: {
		status?: "completed" | "failed" | "cancelled";
		usage?: OpenAIResponsesUsage;
	};
}

type OpenAIResponsesEvent =
	| OpenAIResponsesTextDeltaEvent
	| OpenAIResponsesTextDoneEvent
	| OpenAIResponsesFunctionCallDeltaEvent
	| OpenAIResponsesFunctionCallDoneEvent
	| OpenAIResponsesCompletedEvent
	| OpenAIResponsesFailedEvent
	| OpenAIResponsesDoneEvent;

// =============================================================================
// Responses API Helpers
// =============================================================================

/**
 * Converts OpenAI-format messages to Responses API input format.
 *
 * Key transformations:
 * - User messages → input_text content
 * - Assistant messages → output_text content
 * - Tool results → user messages with formatted text (Responses API doesn't support 'tool' role)
 * - System messages → preserved with input_text content
 *
 * @param messages - Array of OpenAI-format messages
 * @returns Array of Responses API input messages
 */
export function convertToResponsesInput(
	messages: OpenAIMessage[],
): ResponsesInputMessage[] {
	return messages
		.map((msg): ResponsesInputMessage | null => {
			// Handle tool result messages - convert to user message with tool output as text
			if (msg.role === "tool") {
				const toolContent = msg.content;
				const toolCallId =
					(msg as unknown as { tool_call_id?: string }).tool_call_id || "";
				const outputText =
					typeof toolContent === "string"
						? toolContent
						: toolContent
								.filter((c) => c.type === "text")
								.map((c) => (c as { text: string }).text)
								.join("\n");
				// Format as a tool result message that the model can understand
				const parts: ResponsesInputTextPart[] = [
					{
						type: "input_text",
						text: `[Tool Result for call_id=${toolCallId}]\n${outputText}`,
					},
				];
				return { role: "user", content: parts };
			}

			const parts: ResponsesContentPart[] = [];
			const isAssistant = msg.role === "assistant";

			if (typeof msg.content === "string") {
				if (isAssistant) {
					parts.push({ type: "output_text", text: msg.content });
				} else {
					parts.push({ type: "input_text", text: msg.content });
				}
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						if (isAssistant) {
							parts.push({ type: "output_text", text: c.text });
						} else {
							parts.push({ type: "input_text", text: c.text });
						}
					}
				}
			}

			if (parts.length === 0) {
				return null;
			}

			return { role: msg.role, content: parts };
		})
		.filter((msg): msg is ResponsesInputMessage => msg !== null);
}

/**
 * Filters tools for Responses API compatibility.
 *
 * The Responses API has stricter requirements than Chat Completions:
 * - Tool names must be non-empty
 * - Parameters schema cannot have oneOf/anyOf/allOf/enum/not at top level
 *
 * @param tools - Array of agent tools
 * @returns Filtered array of compatible tools
 */
export function filterResponsesApiTools(
	tools: Array<{ name: string; description: string; parameters: unknown }>,
): Array<{ name: string; description: string; parameters: unknown }> {
	const hasIncompatibleSchema = (params: unknown): boolean => {
		if (!params || typeof params !== "object") return false;
		const p = params as Record<string, unknown>;
		return !!(p.oneOf || p.anyOf || p.allOf || p.enum || p.not);
	};

	return tools.filter(
		(tool) =>
			tool.name &&
			tool.name.trim() !== "" &&
			!hasIncompatibleSchema(tool.parameters),
	);
}

// =============================================================================
// Shared Streaming Utilities
// =============================================================================

/**
 * Appends a delta to existing text, handling potential duplicate prefixes.
 *
 * Some providers may send overlapping deltas where the new delta starts
 * with content that was already received. This function detects and handles
 * such cases to prevent duplicate text.
 *
 * @param existing - The accumulated text so far
 * @param delta - The new delta to append
 * @returns Object with the new text and whether the delta was skipped
 */
export function appendDelta(
	existing: string,
	delta: string,
): { next: string; skipped: boolean } {
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
}

/**
 * Creates a cost calculator function for a specific model.
 *
 * @param model - The model configuration with cost rates
 * @returns A function that updates usage costs on an AssistantMessage
 */
export function createCostCalculator(model: {
	cost: { input: number; output: number; cacheRead: number };
}): (usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}) => void {
	return (usage) => {
		usage.cost = {
			input: (usage.input * model.cost.input) / 1_000_000,
			output: (usage.output * model.cost.output) / 1_000_000,
			cacheRead: (usage.cacheRead * model.cost.cacheRead) / 1_000_000,
			cacheWrite: 0, // OpenAI doesn't charge for cache writes
			total: 0,
		};
		usage.cost.total =
			usage.cost.input + usage.cost.output + usage.cost.cacheRead;
	};
}

// OpenAI SSE Event Types (Completions API)
interface OpenAICompletionsDelta {
	content?: string | Array<unknown>;
	reasoning_content?: string;
	reasoning?: string;
	tool_calls?: Array<{
		index: number;
		id?: string;
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
}

interface OpenAICompletionsChoice {
	index: number;
	delta?: OpenAICompletionsDelta;
	finish_reason?: "stop" | "length" | "tool_calls" | null;
}

interface OpenAICompletionsUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

interface OpenAICompletionsChunk {
	choices?: OpenAICompletionsChoice[];
	usage?: OpenAICompletionsUsage;
}

async function* streamResponsesApi(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIOptions,
	messages: OpenAIMessage[],
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${options.apiKey}`,
		...options.headers,
	};

	// Convert messages to Responses API format
	const input = convertToResponsesInput(messages);

	// Filter tools for Responses API compatibility
	const validTools = context.tools
		? filterResponsesApiTools(context.tools)
		: [];

	const requestBody: OpenAIResponsesRequestBody = {
		model: model.id,
		input,
		stream: true,
	};

	// Only include tools if there are valid ones
	// Responses API uses flat tool format (name at top level, not nested under function)
	if (validTools.length > 0) {
		requestBody.tools = validTools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
	}

	if (options.maxTokens !== undefined) {
		requestBody.max_output_tokens = options.maxTokens;
	}

	if (options.reasoningEffort && model.reasoning) {
		requestBody.reasoning = { effort: options.reasoningEffort };
	}

	const targetUrl = normalizeLLMBaseUrl(
		model.baseUrl,
		model.provider,
		model.api,
	);

	const response = await fetchWithRetry(
		targetUrl,
		{
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: options.signal,
		},
		model.provider,
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
	}
	if (!response.body) throw new Error("Response body is null");

	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	yield { type: "start", partial };

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const toolArgBuffers = new Map<number, string>();
	const toolEnded = new Set<number>();
	const textEnded = new Set<number>();

	const ensureTextBlock = (
		targetIndex: number,
	): { idx: number; created: boolean } => {
		while (partial.content.length <= targetIndex) {
			partial.content.push({ type: "text", text: "" });
		}
		const block = partial.content[targetIndex];
		if (block.type !== "text") {
			partial.content[targetIndex] = { type: "text", text: "" };
			return { idx: targetIndex, created: true };
		}
		return { idx: targetIndex, created: block.text.length === 0 };
	};

	const toolState = new Map<
		string,
		{ name?: string; args: string; outputIndex: number }
	>();

	const updateCosts = createCostCalculator(model);

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

				let event: OpenAIResponsesEvent;
				try {
					const parsed: unknown = JSON.parse(data);
					if (
						!parsed ||
						typeof parsed !== "object" ||
						!("type" in parsed) ||
						typeof (parsed as { type: unknown }).type !== "string"
					) {
						logger.warn("Invalid event structure from OpenAI Responses API", {
							data: data.slice(0, 100),
						});
						continue;
					}
					event = parsed as OpenAIResponsesEvent;
				} catch (e) {
					logger.warn("Failed to parse OpenAI Responses event", {
						error: e instanceof Error ? e.message : String(e),
						stack: e instanceof Error ? e.stack : undefined,
					});
					continue;
				}

				switch (event.type) {
					case "response.output_text.delta": {
						const contentIdx = event.content_index ?? 0;
						const { idx, created } = ensureTextBlock(contentIdx);
						if (created) {
							yield { type: "text_start", contentIndex: idx, partial };
						}
						const textBlock = partial.content[idx];
						if (textBlock.type === "text") {
							textBlock.text += event.delta || "";
						}
						yield {
							type: "text_delta",
							contentIndex: idx,
							delta: event.delta || "",
							partial,
						};
						break;
					}
					case "response.output_text.done": {
						const contentIdx = event.content_index ?? 0;
						const { idx, created } = ensureTextBlock(contentIdx);
						if (created) {
							yield { type: "text_start", contentIndex: idx, partial };
						}
						const doneTextBlock = partial.content[idx];
						yield {
							type: "text_end",
							contentIndex: idx,
							content: doneTextBlock.type === "text" ? doneTextBlock.text : "",
							partial,
						};
						textEnded.add(idx);
						break;
					}
					case "response.function_call_arguments.delta": {
						const callId = event.call_id || event.item_id;
						if (!callId) {
							logger.warn("Tool call delta missing both call_id and item_id", {
								outputIndex: event.output_index,
							});
							break;
						}
						const state = toolState.get(callId) ?? {
							name: undefined,
							args: "",
							outputIndex: event.output_index ?? 0,
						};
						state.args += event.delta || "";
						state.outputIndex = event.output_index ?? state.outputIndex;
						toolState.set(callId, state);

						while (partial.content.length <= state.outputIndex) {
							partial.content.push({
								type: "toolCall",
								id: "",
								name: "",
								arguments: {},
							});
						}
						const block = partial.content[state.outputIndex];
						if (block.type === "toolCall" && !block.id) {
							block.id = callId;
							yield {
								type: "toolcall_start",
								contentIndex: state.outputIndex,
								partial,
							};
						}
						if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(state.args);
							yield {
								type: "toolcall_delta",
								contentIndex: state.outputIndex,
								delta: event.delta || "",
								partial,
							};
						}
						break;
					}
					case "response.function_call_arguments.done": {
						const callId = event.call_id || event.item_id;
						if (!callId) {
							logger.warn("Tool call done missing both call_id and item_id", {
								outputIndex: event.output_index,
							});
							break;
						}
						const state = toolState.get(callId) ?? {
							name: event.name,
							args: event.arguments || "{}",
							outputIndex: event.output_index ?? 0,
						};
						state.name = event.name || state.name;
						state.args = event.arguments || state.args;
						state.outputIndex = event.output_index ?? state.outputIndex;
						toolState.set(callId, state);

						while (partial.content.length <= state.outputIndex) {
							partial.content.push({
								type: "toolCall",
								id: "",
								name: "",
								arguments: {},
							});
						}
						const block = partial.content[state.outputIndex];
						if (block.type === "toolCall") {
							if (!block.id) {
								block.id = callId;
								yield {
									type: "toolcall_start",
									contentIndex: state.outputIndex,
									partial,
								};
							}
							block.id = callId;
							block.name = state.name || "";
							try {
								block.arguments = JSON.parse(state.args);
							} catch {
								block.arguments = parseStreamingJson(state.args);
							}
							yield {
								type: "toolcall_end",
								contentIndex: state.outputIndex,
								toolCall: block,
								partial,
							};
							toolEnded.add(state.outputIndex);
						}
						break;
					}
					case "response.completed": {
						// Finalize any pending content blocks
						for (let i = 0; i < partial.content.length; i++) {
							const block = partial.content[i];
							if (block.type === "toolCall" && !toolEnded.has(i)) {
								yield {
									type: "toolcall_end",
									contentIndex: i,
									toolCall: block,
									partial,
								};
								toolEnded.add(i);
							} else if (block.type === "text" && !textEnded.has(i)) {
								yield {
									type: "text_end",
									contentIndex: i,
									content: block.text,
									partial,
								};
								textEnded.add(i);
							}
						}

						const usage = event.response?.usage;
						if (usage) {
							partial.usage.input = usage.input_tokens || 0;
							partial.usage.output =
								(usage.output_tokens || 0) +
								(usage.output_tokens_details?.reasoning_tokens || 0);
							updateCosts(partial.usage);
						}
						partial.stopReason = "stop";
						yield {
							type: "done",
							reason: partial.stopReason,
							message: partial,
						};
						break;
					}
					case "response.failed": {
						partial.stopReason = "error";
						partial.errorMessage = event.response?.error?.message;
						break;
					}
					case "response.done": {
						for (let i = 0; i < partial.content.length; i++) {
							const block = partial.content[i];
							if (block.type === "toolCall" && !toolEnded.has(i)) {
								yield {
									type: "toolcall_end",
									contentIndex: i,
									toolCall: block,
									partial,
								};
								toolEnded.add(i);
							} else if (block.type === "text" && !textEnded.has(i)) {
								yield {
									type: "text_end",
									contentIndex: i,
									content: block.text,
									partial,
								};
								textEnded.add(i);
							}
						}

						const usage = event.response?.usage;
						if (usage) {
							partial.usage.input = usage.input_tokens || 0;
							partial.usage.output =
								(usage.output_tokens || 0) +
								(usage.output_tokens_details?.reasoning_tokens || 0);
							updateCosts(partial.usage);
						}
						const status = event.response?.status;
						partial.stopReason =
							status === "completed"
								? "stop"
								: status === "failed"
									? "error"
									: status === "cancelled"
										? "aborted"
										: "error";
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
						break;
					}
					default:
						break;
				}
			}
		}
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			partial.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: partial };
		} else {
			throw error;
		}
	} finally {
		toolState.clear();
		toolArgBuffers.clear();
	}
}

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content:
		| string
		| Array<
				| { type: "text"; text: string }
				| {
						type: "image_url";
						image_url: { url: string; detail?: "auto" | "low" | "high" };
				  }
		  >;
	tool_call_id?: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
}

/**
 * OpenAI/OpenRouter provider with automatic prompt caching (no explicit cache_control needed).
 * Caching is automatic for prompts >= 1024 tokens.
 * Structure prompts with static content at the beginning for best cache hit rates.
 */
// Exported for tests
export function resolveOpenAIUrlForTest(
	baseUrl: string,
	api: "openai-responses" | "openai-completions",
): string {
	return normalizeLLMBaseUrl(baseUrl, "openai", api);
}

export async function* streamOpenAI(
	model: Model<"openai-responses" | "openai-completions">,
	context: Context,
	options: OpenAIOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const apiKey = options.apiKey;
	if (!apiKey) {
		throw new Error("API key is required for OpenAI");
	}

	const messages: OpenAIMessage[] = [];

	// System prompt
	if (context.systemPrompt) {
		messages.push({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(context.messages, model);

	// Convert messages
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? sanitizeSurrogates(msg.content)
					: msg.content.map((c) => {
							if (c.type === "text") {
								return {
									type: "text" as const,
									text: sanitizeSurrogates(c.text),
								};
							}
							// OpenAI expects image URLs
							const dataUrl = `data:${c.mimeType};base64,${c.data}`;
							return {
								type: "image_url" as const,
								image_url: { url: dataUrl },
							};
						});
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const textContent: Array<{ type: "text"; text: string }> = [];
			const toolCalls: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}> = [];

			for (const c of msg.content) {
				if (c.type === "text") {
					textContent.push({ type: "text", text: sanitizeSurrogates(c.text) });
				} else if (c.type === "toolCall") {
					toolCalls.push({
						id: c.id,
						type: "function",
						function: {
							name: c.name,
							arguments: JSON.stringify(c.arguments),
						},
					});
				}
			}

			const message: OpenAIMessage = {
				role: "assistant",
				content: textContent.length > 0 ? textContent : "",
			};

			if (toolCalls.length > 0) {
				message.tool_calls = toolCalls;
			}

			messages.push(message);
		} else if (msg.role === "toolResult") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.map((c) => (c.type === "text" ? c.text : "[Image]"))
							.join("\n");

			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content,
			});
		}
	}

	if (model.api === "openai-responses") {
		return yield* streamResponsesApi(
			model as Model<"openai-responses">,
			context,
			options,
			messages,
		);
	}

	const requestBody: OpenAICompletionsRequestBody = {
		model: model.id,
		messages,
		max_tokens: options.maxTokens ?? model.maxTokens,
		stream: true,
		stream_options: { include_usage: true },
	};

	if (context.tools && context.tools.length > 0) {
		requestBody.tools = context.tools.map((tool) => ({
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}

	if (options.temperature !== undefined) {
		requestBody.temperature = options.temperature;
	}

	// Add reasoning effort for reasoning-capable models
	// Note: Grok models don't support reasoning_effort parameter
	if (
		options.reasoningEffort &&
		model.reasoning &&
		!model.id.toLowerCase().includes("grok")
	) {
		requestBody.reasoning_effort = options.reasoningEffort;
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...options.headers,
	};

	const targetUrl = normalizeLLMBaseUrl(
		model.baseUrl,
		model.provider,
		model.api,
	);

	const response = await fetchWithRetry(
		targetUrl,
		{
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: options.signal,
		},
		model.provider,
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
	}

	if (!response.body) {
		throw new Error("Response body is null");
	}

	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
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

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const toolArgBuffers = new Map<number, string>();
	let cacheAdjusted = false;
	const textEnded = new Set<number>();
	const toolEnded = new Set<number>();
	const thinkingEnded = new Set<number>();

	// Use shared utilities for delta handling and cost calculation
	const updateCosts = createCostCalculator(model);

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
					const choice = event.choices?.[0];

					if (!choice) {
						// Check for usage data
						if (event.usage) {
							partial.usage.input = event.usage.prompt_tokens || 0;
							// Include reasoning tokens in output count
							partial.usage.output =
								(event.usage.completion_tokens || 0) +
								(event.usage.completion_tokens_details?.reasoning_tokens || 0);
							// OpenAI caching: cached_tokens in prompt_tokens_details
							if (
								event.usage.prompt_tokens_details?.cached_tokens &&
								!cacheAdjusted
							) {
								partial.usage.cacheRead =
									event.usage.prompt_tokens_details.cached_tokens;
								// Adjust input tokens to not double count (only once)
								partial.usage.input -= partial.usage.cacheRead;
								cacheAdjusted = true;
							}

							updateCosts(partial.usage);
						}
						continue;
					}

					const delta = choice.delta;

					if (delta.content) {
						const contentDelta = Array.isArray(delta.content)
							? delta.content
									.map((part: unknown) => {
										if (typeof part === "string")
											return sanitizeSurrogates(part);
										if (
											part &&
											typeof part === "object" &&
											"text" in part &&
											typeof (part as { text: unknown }).text === "string"
										) {
											return sanitizeSurrogates(
												(part as { text: string }).text,
											);
										}
										logger.warn("Unsupported OpenAI content part", {
											partType: typeof part,
											keys:
												part && typeof part === "object"
													? Object.keys(part)
													: undefined,
											type:
												part && typeof part === "object" && "type" in part
													? (part as { type: unknown }).type
													: undefined,
										});
										return "";
									})
									.filter((s: string) => s.length > 0)
									.join("")
							: sanitizeSurrogates(delta.content);

						if (contentDelta && contentDelta.length > 0) {
							// Find or create text content block
							let textBlock = partial.content.find((c) => c.type === "text");
							if (!textBlock) {
								const idx = partial.content.length;
								textBlock = { type: "text", text: "" };
								partial.content.push(textBlock);
								yield { type: "text_start", contentIndex: idx, partial };
							}
							const idx = partial.content.indexOf(textBlock);
							const previousLength = textBlock.text.length;
							const { next, skipped } = appendDelta(
								textBlock.text,
								contentDelta,
							);
							if (skipped) continue;
							textBlock.text = next;
							if (!textEnded.has(idx)) {
								// will mark ended on text_end
							}
							yield {
								type: "text_delta",
								contentIndex: idx,
								delta: next.slice(previousLength),
								partial,
							};
						}
					}

					// Handle reasoning/thinking content
					// Some endpoints return reasoning in "reasoning_content" (llama.cpp),
					// others use "reasoning" (other OpenAI-compatible endpoints)
					const reasoningDelta =
						delta.reasoning_content || delta.reasoning || "";
					if (reasoningDelta.length > 0) {
						// Find or create thinking block
						let thinkingBlock = partial.content.find(
							(c) => c.type === "thinking",
						);
						if (!thinkingBlock) {
							const idx = partial.content.length;
							thinkingBlock = { type: "thinking", thinking: "" };
							partial.content.push(thinkingBlock);
							yield { type: "thinking_start", contentIndex: idx, partial };
						}

						if (thinkingBlock.type === "thinking") {
							const idx = partial.content.indexOf(thinkingBlock);
							const previousLength = thinkingBlock.thinking.length;
							const { next, skipped } = appendDelta(
								thinkingBlock.thinking,
								reasoningDelta,
							);
							if (skipped) continue;
							thinkingBlock.thinking = next;
							yield {
								type: "thinking_delta",
								contentIndex: idx,
								delta: next.slice(previousLength),
								partial,
							};
						}
					}

					if (delta.tool_calls) {
						for (const toolCall of delta.tool_calls) {
							const idx = toolCall.index;

							// Ensure we have a slot
							while (partial.content.length <= idx) {
								partial.content.push({
									type: "toolCall",
									id: "",
									name: "",
									arguments: {},
								});
							}

							const block = partial.content[idx];
							if (block.type !== "toolCall") continue;

							if (toolCall.id) {
								block.id = toolCall.id;
								block.name = toolCall.function?.name || "";
								yield { type: "toolcall_start", contentIndex: idx, partial };
							}

							if (toolCall.function?.arguments) {
								const argsDelta = toolCall.function.arguments;
								const existing = toolArgBuffers.get(idx) ?? "";
								const combined = existing + argsDelta;
								toolArgBuffers.set(idx, combined);

								// Parse streaming JSON progressively
								// This allows UI to show partial arguments like file paths
								// before the complete JSON arrives
								block.arguments = parseStreamingJson(combined);

								yield {
									type: "toolcall_delta",
									contentIndex: idx,
									delta: argsDelta,
									partial,
								};
							}
						}
					}

					if (choice.finish_reason) {
						partial.stopReason =
							choice.finish_reason === "stop"
								? "stop"
								: choice.finish_reason === "length"
									? "length"
									: choice.finish_reason === "tool_calls"
										? "toolUse"
										: "stop";

						// Finalize all content blocks
						for (let i = 0; i < partial.content.length; i++) {
							const block = partial.content[i];
							if (block.type === "toolCall" && !toolEnded.has(i)) {
								// Final parse of accumulated JSON
								const partialArgs = toolArgBuffers.get(i) || "{}";
								try {
									block.arguments = JSON.parse(partialArgs);
								} catch {
									// Fall back to partial parse result
									block.arguments = parseStreamingJson(partialArgs);
								}
								toolArgBuffers.delete(i);

								yield {
									type: "toolcall_end",
									contentIndex: i,
									toolCall: block,
									partial,
								};
								toolEnded.add(i);
							} else if (block.type === "text" && !textEnded.has(i)) {
								yield {
									type: "text_end",
									contentIndex: i,
									content: block.text,
									partial,
								};
								textEnded.add(i);
							} else if (block.type === "thinking" && !thinkingEnded.has(i)) {
								yield {
									type: "thinking_end",
									contentIndex: i,
									content: block.thinking,
									partial,
								};
								thinkingEnded.add(i);
							}
						}

						// Calculate costs one last time (in case no usage block arrived)
						updateCosts(partial.usage);

						yield {
							type: "done",
							reason: partial.stopReason,
							message: partial,
						};
					}
				} catch (e) {
					logger.warn("Failed to parse OpenAI event", {
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
		} else {
			throw error;
		}
	}
}
