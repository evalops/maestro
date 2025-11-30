import { normalizeLLMBaseUrl } from "../../models/url-normalize.js";
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
		content: Array<{ type: "input_text"; text: string }>;
	}>;
	stream: boolean;
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			description: string;
			parameters: unknown;
		};
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

	// Responses API accepts "input" with content parts; we only send text parts to stay compatible.
	const input = messages.map((msg) => {
		const parts: Array<{ type: "input_text"; text: string }> = [];
		if (typeof msg.content === "string") {
			parts.push({ type: "input_text", text: msg.content });
		} else {
			for (const c of msg.content) {
				if (c.type === "text") {
					parts.push({ type: "input_text", text: c.text });
				}
			}
		}
		return { role: msg.role, content: parts };
	});

	const requestBody: OpenAIResponsesRequestBody = {
		model: model.id,
		input,
		stream: true,
		tools:
			context.tools?.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				},
			})) ?? [],
	};

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

	const response = await fetch(targetUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal: options.signal,
	});

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

	const updateCosts = () => {
		partial.usage.cost = {
			input: (partial.usage.input * model.cost.input) / 1_000_000,
			output: (partial.usage.output * model.cost.output) / 1_000_000,
			cacheRead: (partial.usage.cacheRead * model.cost.cacheRead) / 1_000_000,
			cacheWrite: 0,
			total: 0,
		};
		partial.usage.cost.total =
			partial.usage.cost.input +
			partial.usage.cost.output +
			partial.usage.cost.cacheRead;
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
						const usage = event.response?.usage;
						if (usage) {
							partial.usage.input = usage.input_tokens || 0;
							partial.usage.output =
								(usage.output_tokens || 0) +
								(usage.output_tokens_details?.reasoning_tokens || 0);
							updateCosts();
						}
						partial.stopReason = "stop";
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
							updateCosts();
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

	const response = await fetch(targetUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal: options.signal,
	});

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
	const lastTextDelta = new Map<number, string>();
	const lastThinkingDelta = new Map<number, string>();

	const updateCosts = () => {
		partial.usage.cost = {
			input: (partial.usage.input * model.cost.input) / 1_000_000,
			output: (partial.usage.output * model.cost.output) / 1_000_000,
			cacheRead: (partial.usage.cacheRead * model.cost.cacheRead) / 1_000_000,
			cacheWrite: 0, // OpenAI doesn't charge for cache writes
			total: 0,
		};
		partial.usage.cost.total =
			partial.usage.cost.input +
			partial.usage.cost.output +
			partial.usage.cost.cacheRead;
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

							updateCosts();
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
							const lastDelta = lastTextDelta.get(idx) ?? "";
							if (contentDelta === lastDelta) {
								continue;
							}
							lastTextDelta.set(idx, contentDelta);
							textBlock.text += contentDelta;
							if (!textEnded.has(idx)) {
								// will mark ended on text_end
							}
							yield {
								type: "text_delta",
								contentIndex: idx,
								delta: contentDelta,
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
							const lastDelta = lastThinkingDelta.get(idx) ?? "";
							if (reasoningDelta === lastDelta) {
								continue;
							}
							lastThinkingDelta.set(idx, reasoningDelta);
							thinkingBlock.thinking += reasoningDelta;
							yield {
								type: "thinking_delta",
								contentIndex: idx,
								delta: reasoningDelta,
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
						updateCosts();

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
