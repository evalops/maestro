/**
 * OpenAI Responses API implementation using the official SDK
 *
 * This replaces the raw SSE parsing with proper typed events from the SDK.
 */

import OpenAI from "openai";
import type {
	ResponseFunctionToolCall,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import { normalizeLLMBaseUrl } from "../../models/url-normalize.js";
import { createLogger } from "../../utils/logger.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.js";
import { parseStreamingJson } from "./json-parse.js";
import type { OpenAIOptions } from "./openai.js";
import { filterResponsesApiTools } from "./openai.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";

const logger = createLogger("agent:providers:openai-responses");

/**
 * Stream responses from OpenAI Responses API using the official SDK
 */
export async function* streamResponsesApiSdk(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	if (!options.apiKey) {
		throw new Error("OpenAI API key is required");
	}

	const baseUrl = normalizeLLMBaseUrl(model.baseUrl, model.provider, model.api);

	const client = new OpenAI({
		apiKey: options.apiKey,
		baseURL: baseUrl.replace("/responses", ""), // SDK adds the endpoint
		dangerouslyAllowBrowser: true,
		defaultHeaders: options.headers,
	});

	// Build input messages
	const input = buildInput(context, model);

	// Filter and convert tools
	const validTools = context.tools
		? filterResponsesApiTools(context.tools)
		: [];

	if (context.tools && validTools.length < context.tools.length) {
		const filtered = context.tools.filter(
			(t) => !validTools.some((v) => v.name === t.name),
		);
		logger.warn(
			"Some tools filtered out due to Responses API schema limitations",
			{
				filteredTools: filtered.map((t) => t.name),
				reason:
					"Responses API does not support oneOf/anyOf/allOf/enum/not in tool schemas",
			},
		);
	}

	// Build request params
	const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
		model: model.id,
		input,
		stream: true,
	};

	if (validTools.length > 0) {
		params.tools = validTools.map((tool) => ({
			type: "function" as const,
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>,
			strict: null,
		}));
	}

	if (options.maxTokens) {
		params.max_output_tokens = options.maxTokens;
	}

	if (options.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (model.reasoning && options.reasoningEffort) {
		params.reasoning = {
			effort: options.reasoningEffort,
		};
	}

	// Initialize output
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
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

	yield { type: "start", partial: output };

	// Track current items and blocks
	let currentItem:
		| ResponseReasoningItem
		| ResponseOutputMessage
		| ResponseFunctionToolCall
		| null = null;
	let currentBlock:
		| ThinkingContent
		| TextContent
		| (ToolCall & { partialJson: string })
		| null = null;
	const blockIndex = () => output.content.length - 1;

	try {
		const stream = await client.responses.create(params, {
			signal: options.signal,
		});

		for await (const event of stream) {
			// Handle output item start
			if (event.type === "response.output_item.added") {
				const item = event.item;
				if (item.type === "reasoning") {
					currentItem = item;
					currentBlock = { type: "thinking", thinking: "" };
					output.content.push(currentBlock);
					yield {
						type: "thinking_start",
						contentIndex: blockIndex(),
						partial: output,
					};
				} else if (item.type === "message") {
					currentItem = item;
					currentBlock = { type: "text", text: "" };
					output.content.push(currentBlock);
					yield {
						type: "text_start",
						contentIndex: blockIndex(),
						partial: output,
					};
				} else if (item.type === "function_call") {
					currentItem = item;
					currentBlock = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: {},
						partialJson: item.arguments || "",
					};
					output.content.push(currentBlock);
					yield {
						type: "toolcall_start",
						contentIndex: blockIndex(),
						partial: output,
					};
				}
			}
			// Handle text deltas
			else if (event.type === "response.output_text.delta") {
				if (
					currentItem &&
					currentItem.type === "message" &&
					currentBlock &&
					currentBlock.type === "text"
				) {
					currentBlock.text += event.delta;
					yield {
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					};
				}
			}
			// Handle function call argument deltas
			else if (event.type === "response.function_call_arguments.delta") {
				if (
					currentItem &&
					currentItem.type === "function_call" &&
					currentBlock &&
					currentBlock.type === "toolCall"
				) {
					currentBlock.partialJson += event.delta;
					currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
					yield {
						type: "toolcall_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					};
				}
			}
			// Handle output item completion
			else if (event.type === "response.output_item.done") {
				const item = event.item;

				if (
					item.type === "reasoning" &&
					currentBlock &&
					currentBlock.type === "thinking"
				) {
					currentBlock.thinking =
						item.summary?.map((s) => s.text).join("\n\n") || "";
					// Store the full reasoning item so we can send it back verbatim
					// This is required for reasoning models like codex
					currentBlock.thinkingSignature = JSON.stringify(item);
					yield {
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					};
					currentBlock = null;
				} else if (
					item.type === "message" &&
					currentBlock &&
					currentBlock.type === "text"
				) {
					currentBlock.text = item.content
						.map((c) =>
							c.type === "output_text"
								? c.text
								: (c as { refusal?: string }).refusal || "",
						)
						.join("");
					yield {
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					};
					currentBlock = null;
				} else if (item.type === "function_call") {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: JSON.parse(item.arguments),
					};
					yield {
						type: "toolcall_end",
						contentIndex: blockIndex(),
						toolCall,
						partial: output,
					};
					currentBlock = null;
				}
				currentItem = null;
			}
			// Handle completion
			else if (event.type === "response.completed") {
				const response = event.response;
				if (response?.usage) {
					const cachedTokens =
						response.usage.input_tokens_details?.cached_tokens || 0;
					output.usage = {
						input: (response.usage.input_tokens || 0) - cachedTokens,
						output: response.usage.output_tokens || 0,
						cacheRead: cachedTokens,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					// Calculate costs
					if (model.cost) {
						output.usage.cost = {
							input: (output.usage.input / 1_000_000) * model.cost.input,
							output: (output.usage.output / 1_000_000) * model.cost.output,
							cacheRead:
								(output.usage.cacheRead / 1_000_000) * model.cost.cacheRead,
							cacheWrite: 0,
							total: 0,
						};
						output.usage.cost.total =
							output.usage.cost.input +
							output.usage.cost.output +
							output.usage.cost.cacheRead;
					}
				}
				// Map status to stop reason
				output.stopReason = mapStopReason(response?.status);
				if (
					output.content.some((b) => b.type === "toolCall") &&
					output.stopReason === "stop"
				) {
					output.stopReason = "toolUse";
				}
			}
			// Handle errors
			else if (event.type === "error") {
				throw new Error(`OpenAI Error ${event.code}: ${event.message}`);
			} else if (event.type === "response.failed") {
				throw new Error("OpenAI request failed");
			}
		}

		yield {
			type: "done",
			reason: output.stopReason as "stop" | "length" | "toolUse",
			message: output,
		};
	} catch (error) {
		output.stopReason = options.signal?.aborted ? "aborted" : "error";
		output.errorMessage =
			error instanceof Error ? error.message : String(error);
		yield {
			type: "error",
			reason: output.stopReason as "aborted" | "error",
			error: output,
		};
	}
}

function buildInput(
	context: Context,
	model: Model<"openai-responses">,
): OpenAI.Responses.ResponseInput {
	const input: OpenAI.Responses.ResponseInput = [];

	// System prompt
	if (context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		input.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	// Messages
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content: OpenAI.Responses.ResponseInputContent[] = [];
			// Handle string content
			if (typeof msg.content === "string") {
				content.push({
					type: "input_text",
					text: sanitizeSurrogates(msg.content),
				});
			} else {
				// Handle array content
				for (const block of msg.content) {
					if (block.type === "text") {
						content.push({
							type: "input_text",
							text: sanitizeSurrogates(block.text),
						});
					} else if (block.type === "image") {
						content.push({
							type: "input_image",
							image_url: `data:${block.mimeType};base64,${block.data}`,
							detail: "auto",
						});
					}
				}
			}
			if (content.length > 0) {
				input.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			// Check if there are any toolCall blocks that will be included
			// This is needed because reasoning items require their following function_call
			const hasValidToolCalls =
				msg.stopReason !== "error" &&
				msg.content.some((b) => b.type === "toolCall");

			for (const block of msg.content) {
				if (block.type === "text") {
					input.push({
						type: "message",
						role: "assistant",
						content: [
							{
								type: "output_text",
								text: sanitizeSurrogates(block.text),
								annotations: [],
							},
						],
						status: "completed",
						id: `msg_${Math.random().toString(36).substring(2, 15)}`,
					});
				} else if (block.type === "thinking" && hasValidToolCalls) {
					// For reasoning models, we need to include reasoning items
					// They're required before function_call items
					// Only include if there are valid toolCalls (reasoning requires its following item)
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature);
						input.push(reasoningItem);
					}
				} else if (block.type === "toolCall" && msg.stopReason !== "error") {
					const id = block.id.includes("|") ? block.id.split("|")[1] : block.id;
					const callId = block.id.includes("|")
						? block.id.split("|")[0]
						: block.id;
					input.push({
						type: "function_call",
						id,
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("\n");

			const callId = msg.toolCallId.includes("|")
				? msg.toolCallId.split("|")[0]
				: msg.toolCallId;

			input.push({
				type: "function_call_output",
				call_id: callId,
				output: sanitizeSurrogates(textResult || "(empty result)"),
			});
		}
	}

	return input;
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
): "stop" | "length" | "toolUse" | "error" {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default:
			return "stop";
	}
}
