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

import crypto from "node:crypto";
import { normalizeLLMBaseUrl } from "../../models/url-normalize.js";
import { fetchWithRetry } from "../../providers/network-config.js";
import {
	createTimeoutReader,
	isStreamIdleTimeoutError,
} from "../../providers/stream-idle-timeout.js";
import { createLogger } from "../../utils/logger.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ReasoningEffort,
	StreamOptions,
} from "../types.js";

const logger = createLogger("agent:providers:openai");
import { streamResponsesApiSdk } from "./openai-responses-sdk.js";
export {
	filterResponsesApiTools,
	OpenAIOptions,
	OpenAIResponseFormat,
	OpenAIToolChoice,
	ResponsesContentPart,
	ResponsesInputMessage,
	ResponsesInputTextPart,
	ResponsesOutputTextPart,
} from "./openai-shared.js";
import type {
	OpenAIOptions,
	OpenAIResponseFormat,
	OpenAIToolChoice,
} from "./openai-shared.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import {
	createToolArgumentNormalizer,
	describeValueType,
	isRecord,
} from "./tool-arguments.js";
import { transformMessages } from "./transform-messages.js";

const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "OpenAI",
});

interface OpenAICompat {
	supportsStore: boolean;
	supportsDeveloperRole: boolean;
	supportsReasoningEffort: boolean;
	maxTokensField: "max_tokens" | "max_completion_tokens";
	requiresToolResultName: boolean;
	requiresAssistantAfterToolResult: boolean;
	requiresThinkingAsText: boolean;
	requiresMistralToolIds: boolean;
}

function resolveOpenAICompat(
	model: Pick<Model<Api>, "baseUrl" | "provider" | "compat">,
): Required<OpenAICompat> {
	const rawBaseUrl = model.baseUrl ?? "";
	let baseUrl = rawBaseUrl.toLowerCase();
	try {
		const parsed = new URL(rawBaseUrl);
		const upstream = parsed.searchParams.get("url");
		if (upstream) {
			baseUrl = upstream.toLowerCase();
		}
	} catch {
		// ignore malformed URLs for compat detection
	}
	const provider = (model.provider ?? "").toLowerCase();
	const isMistral = baseUrl.includes("mistral.ai") || provider === "mistral";
	const isGrok = baseUrl.includes("api.x.ai") || provider === "xai";
	const isOpenAIBase = baseUrl.includes("api.openai.com");
	const isOpenAIProvider = provider === "openai";
	const nonOpenAIHosts = [
		"mistral.ai",
		"api.x.ai",
		"cerebras.ai",
		"chutes.ai",
		"openrouter.ai",
		"api.groq.com",
		"openai.azure.com",
	];
	const isNonOpenAIBase = nonOpenAIHosts.some((host) => baseUrl.includes(host));
	const isOpenAI =
		(isOpenAIBase || isOpenAIProvider) &&
		!isNonOpenAIBase &&
		!isMistral &&
		!isGrok;

	const detected: Required<OpenAICompat> = {
		supportsStore: isOpenAI,
		supportsDeveloperRole: isOpenAI,
		supportsReasoningEffort: isOpenAI && !isGrok,
		maxTokensField: isOpenAI ? "max_completion_tokens" : "max_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
	};

	const overrides = model.compat;
	if (!overrides) {
		return detected;
	}

	return {
		supportsStore: overrides.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole:
			overrides.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort:
			overrides.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		maxTokensField: overrides.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName:
			overrides.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			overrides.requiresAssistantAfterToolResult ??
			detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText:
			overrides.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresMistralToolIds:
			overrides.requiresMistralToolIds ?? detected.requiresMistralToolIds,
	};
}

/**
 * Normalize tool call IDs for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 * Use a per-request mapping to avoid collisions across multiple tool calls.
 */
function createMistralToolIdNormalizer(isMistral: boolean) {
	if (!isMistral) {
		return (id: string) => id;
	}

	const byOriginal = new Map<string, string>();
	const used = new Set<string>();

	const hashToBase36 = (value: string) => {
		const hex = crypto.createHash("sha1").update(value).digest("hex");
		const base36 = BigInt(`0x${hex}`).toString(36);
		return base36.padStart(9, "0");
	};

	const makeCandidate = (id: string, attempt: number) => {
		const cleaned = id.replace(/[^a-zA-Z0-9]/g, "");
		if (attempt === 0 && cleaned.length >= 9) {
			return cleaned.slice(0, 9);
		}
		const hashed = hashToBase36(`${id}:${attempt}`);
		return hashed.slice(0, 9);
	};

	return (id: string) => {
		const existing = byOriginal.get(id);
		if (existing) return existing;

		let attempt = 0;
		let candidate = makeCandidate(id, attempt);
		while (used.has(candidate)) {
			attempt += 1;
			candidate = makeCandidate(id, attempt);
		}
		used.add(candidate);
		byOriginal.set(id, candidate);
		return candidate;
	};
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * Some OpenAI-compatible proxies require the tools param when tool history exists.
 */
function hasToolHistory(messages: Context["messages"]): boolean {
	for (const msg of messages ?? []) {
		if (!msg) continue;
		if (msg.role === "toolResult") return true;
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
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
	tool_choice?: OpenAIToolChoice;
	max_output_tokens?: number;
	reasoning?: { effort: string };
}

interface OpenAICompletionsRequestBody {
	model: string;
	messages: OpenAIMessage[];
	max_tokens?: number;
	max_completion_tokens?: number;
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
	tool_choice?: OpenAIToolChoice;
	temperature?: number;
	reasoning_effort?: string;
	response_format?: OpenAIResponseFormat;
	store?: boolean;
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
			arguments?: string | Record<string, unknown> | null;
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

interface OpenAIMessage {
	role: "system" | "developer" | "user" | "assistant" | "tool";
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

	const compat = resolveOpenAICompat(model);
	const normalizeToolId = createMistralToolIdNormalizer(
		compat.requiresMistralToolIds,
	);
	const messages: OpenAIMessage[] = [];
	const pushMessage = (message: OpenAIMessage) => {
		messages.push(message);
		lastSentRole = message.role;
	};

	// System prompt
	if (context.systemPrompt) {
		const role =
			model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(context.messages, model);
	let lastOriginalRole: Message["role"] | null = null;
	let lastSentRole: OpenAIMessage["role"] | null = null;

	// Convert messages
	for (const msg of transformedMessages) {
		let didSend = false;

		if (
			compat.requiresAssistantAfterToolResult &&
			lastOriginalRole === "toolResult" &&
			msg.role === "user"
		) {
			pushMessage({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

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

			if (Array.isArray(content)) {
				const filteredContent = model.input.includes("image")
					? content
					: content.filter((c) => c.type !== "image_url");
				if (filteredContent.length === 0) {
					continue;
				}
				pushMessage({ role: "user", content: filteredContent });
				didSend = true;
			} else {
				pushMessage({ role: "user", content });
				didSend = true;
			}
		} else if (msg.role === "assistant") {
			const textContent: Array<{ type: "text"; text: string }> = [];
			const toolCalls: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}> = [];

			for (const c of msg.content) {
				if (c.type === "text") {
					const text = sanitizeSurrogates(c.text);
					if (text.length === 0) {
						continue;
					}
					textContent.push({ type: "text", text });
				} else if (c.type === "toolCall") {
					toolCalls.push({
						id: normalizeToolId(c.id),
						type: "function",
						function: {
							name: c.name,
							arguments: JSON.stringify(c.arguments),
						},
					});
				}
			}

			const message: OpenAIMessage & Record<string, unknown> = {
				role: "assistant",
				content: textContent.length > 0 ? textContent : "",
			};

			let hasReasoningSignature = false;
			const thinkingBlocks = msg.content.filter(
				(block) => block.type === "thinking",
			);
			if (thinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					const thinkingText = thinkingBlocks
						.map((block) =>
							sanitizeSurrogates(
								(block.type === "thinking" ? block.thinking : "") ?? "",
							),
						)
						.join("\n");
					const textBlock = `<thinking>\n${thinkingText}\n</thinking>`;
					if (Array.isArray(message.content)) {
						message.content.unshift({ type: "text", text: textBlock });
					} else {
						message.content = [{ type: "text", text: textBlock }];
					}
				} else if (thinkingBlocks[0]?.type === "thinking") {
					const signature = thinkingBlocks[0].thinkingSignature;
					if (signature && signature.length > 0) {
						message[signature] = thinkingBlocks
							.map((block) =>
								sanitizeSurrogates(
									(block.type === "thinking" ? block.thinking : "") ?? "",
								),
							)
							.join("\n");
						hasReasoningSignature = true;
					}
				}
			}

			if (toolCalls.length > 0) {
				message.tool_calls = toolCalls;
			}

			const content = message.content;
			const hasContent = Array.isArray(content)
				? content.length > 0
				: content.length > 0;
			if (!hasContent && toolCalls.length === 0 && !hasReasoningSignature) {
				continue;
			}

			pushMessage(message);
			didSend = true;
		} else if (msg.role === "toolResult") {
			const textResult =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => sanitizeSurrogates(c.text))
							.join("\n");
			const hasImages =
				typeof msg.content !== "string" &&
				msg.content.some((c) => c.type === "image");
			const hasText = textResult.length > 0;

			const toolMessage: OpenAIMessage & { name?: string } = {
				role: "tool",
				tool_call_id: normalizeToolId(msg.toolCallId),
				content: sanitizeSurrogates(
					hasText
						? textResult
						: hasImages
							? "(see attached image)"
							: "(empty result)",
				),
			};

			// Some providers (e.g., Mistral) require the 'name' field in tool results
			if (compat.requiresToolResultName && msg.toolName) {
				toolMessage.name = msg.toolName;
			}

			pushMessage(toolMessage);
			didSend = true;

			if (hasImages && model.input.includes("image")) {
				const contentBlocks: Array<
					| { type: "text"; text: string }
					| { type: "image_url"; image_url: { url: string } }
				> = [];

				contentBlocks.push({
					type: "text",
					text: "Attached image(s) from tool result:",
				});

				if (typeof msg.content !== "string") {
					for (const block of msg.content) {
						if (block.type === "image") {
							contentBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}

				pushMessage({
					role: "user",
					content: contentBlocks,
				});
			}
		}

		if (didSend) {
			lastOriginalRole = msg.role;
		}
	}

	if (model.api === "openai-responses") {
		return yield* streamResponsesApiSdk(
			model as Model<"openai-responses">,
			context,
			options,
		);
	}

	const requestBody: OpenAICompletionsRequestBody = {
		model: model.id,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};

	if (compat.supportsStore) {
		requestBody.store = false;
	}

	const maxTokens = options.maxTokens ?? model.maxTokens;
	if (compat.maxTokensField === "max_tokens") {
		requestBody.max_tokens = maxTokens;
	} else {
		requestBody.max_completion_tokens = maxTokens;
	}

	if (context.tools && context.tools.length > 0) {
		requestBody.tools = context.tools.map((tool) => ({
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	} else if (hasToolHistory(context.messages)) {
		requestBody.tools = [];
	}

	// Set tool_choice if specified
	if (options.toolChoice && requestBody.tools && requestBody.tools.length > 0) {
		requestBody.tool_choice = options.toolChoice;
	}

	if (options.temperature !== undefined) {
		requestBody.temperature = options.temperature;
	}

	// Add response format for structured outputs
	if (options.responseFormat) {
		requestBody.response_format = options.responseFormat;
	}

	// Add reasoning effort for reasoning-capable models
	// Note: OpenAI API only supports up to "high", so map "ultra" to "high"
	if (
		options.reasoningEffort &&
		model.reasoning &&
		compat.supportsReasoningEffort
	) {
		const effort =
			options.reasoningEffort === "ultra" ? "high" : options.reasoningEffort;
		requestBody.reasoning_effort = effort;
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...options.headers,
	};
	if (model.provider === "github-copilot") {
		const isAgentCall = lastSentRole ? lastSentRole !== "user" : false;
		headers["X-Initiator"] = isAgentCall ? "agent" : "user";
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
					if (delta?.content) {
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
					const reasoningDelta = delta
						? delta.reasoning_content || delta.reasoning || ""
						: "";
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

					if (delta?.tool_calls) {
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
							if (!block || block.type !== "toolCall") continue;

							if (toolCall.id) {
								block.id = toolCall.id;
								block.name = toolCall.function?.name || "";
								yield { type: "toolcall_start", contentIndex: idx, partial };
							}

							if (toolCall.function && "arguments" in toolCall.function) {
								const argsDelta = toolCall.function.arguments;
								if (typeof argsDelta === "string") {
									toolArgOverrides.delete(idx);
									const existing = toolArgBuffers.get(idx) ?? "";
									const combined = existing + argsDelta;
									toolArgBuffers.set(idx, combined);

									// Parse streaming JSON progressively
									// This allows UI to show partial arguments like file paths
									// before the complete JSON arrives
									block.arguments = toolArgumentNormalizer.parseFromString(
										combined,
										{ callId: block.id, name: block.name, stage: "delta" },
										{ logInvalid: false },
									);

									yield {
										type: "toolcall_delta",
										contentIndex: idx,
										delta: argsDelta,
										partial,
									};
								} else if (isRecord(argsDelta)) {
									toolArgumentNormalizer.warnOnce(
										"delta:object",
										"OpenAI tool call arguments delta was object",
										{
											callId: block.id,
											name: block.name,
										},
									);
									toolArgOverrides.set(idx, argsDelta);
									toolArgBuffers.delete(idx);
									block.arguments = argsDelta;
									yield {
										type: "toolcall_delta",
										contentIndex: idx,
										delta: JSON.stringify(argsDelta),
										partial,
									};
								} else if (argsDelta !== null && argsDelta !== undefined) {
									const rawType = describeValueType(argsDelta);
									toolArgumentNormalizer.warnOnce(
										`delta:${rawType}`,
										"OpenAI tool call arguments delta was non-string",
										{
											callId: block.id,
											name: block.name,
											rawType,
										},
									);
								}
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
							if (!block) continue;
							if (block.type === "toolCall" && !toolEnded.has(i)) {
								const overrideArgs = toolArgOverrides.get(i);
								if (overrideArgs) {
									block.arguments = overrideArgs;
								} else {
									// Final parse of accumulated JSON
									const partialArgs = toolArgBuffers.get(i);
									if (partialArgs !== undefined) {
										block.arguments = toolArgumentNormalizer.parseFromString(
											partialArgs,
											{ callId: block.id, name: block.name, stage: "done" },
											{ logInvalid: true },
										);
									} else {
										block.arguments = isRecord(block.arguments)
											? block.arguments
											: {};
									}
								}
								toolArgBuffers.delete(i);
								toolArgOverrides.delete(i);

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
		} else if (isStreamIdleTimeoutError(error)) {
			// Re-throw idle timeout errors so caller can retry
			throw error;
		} else {
			throw error;
		}
	}
}
