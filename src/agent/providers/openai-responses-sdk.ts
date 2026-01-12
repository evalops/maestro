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
import {
	isStreamIdleTimeoutError,
	withAbortableIdleTimeout,
} from "../../providers/stream-idle-timeout.js";
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
import type { OpenAIOptions } from "./openai-shared.js";
import { filterResponsesApiTools } from "./openai-shared.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { createToolArgumentNormalizer, isRecord } from "./tool-arguments.js";
import { transformMessages } from "./transform-messages.js";

const logger = createLogger("agent:providers:openai-responses");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "OpenAI Responses",
});

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
		// OpenAI SDK only supports up to "high", map "ultra" to "high"
		const effort =
			options.reasoningEffort === "ultra" ? "high" : options.reasoningEffort;
		params.reasoning = {
			effort,
		};
	}

	// Add structured outputs via text.format (Responses API format)
	if (options.responseFormat) {
		if (options.responseFormat.type === "json_schema") {
			params.text = {
				format: {
					type: "json_schema",
					name: options.responseFormat.json_schema.name,
					schema: options.responseFormat.json_schema.schema as Record<
						string,
						unknown
					>,
					strict: options.responseFormat.json_schema.strict ?? true,
					description: options.responseFormat.json_schema.description,
				},
			};
		} else if (options.responseFormat.type === "json_object") {
			params.text = {
				format: { type: "json_object" },
			};
		}
		// type: "text" is the default, no need to set
	}

	// For reasoning models, include encrypted_content to enable multi-turn conversations
	// This is required for stateless usage of the Responses API with reasoning items
	if (model.reasoning) {
		params.include = ["reasoning.encrypted_content"];
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

		// Wrap stream with idle timeout detection
		const timedStream = withAbortableIdleTimeout(stream, {
			provider: model.provider,
			signal: options.signal,
		});

		for await (const event of timedStream) {
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
					const normalized = toolArgumentNormalizer.normalizeWithPartialJson(
						item.arguments,
						{
							callId: item.call_id,
							name: item.name,
							stage: "start",
						},
						{ expectString: true },
					);
					currentBlock = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: normalized.arguments,
						partialJson: normalized.partialJson,
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
					currentBlock.arguments = toolArgumentNormalizer.parseFromString(
						currentBlock.partialJson,
						{
							callId: currentItem.call_id,
							name: currentItem.name,
							stage: "delta",
						},
						{ logInvalid: false },
					);
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
					const finalArguments =
						typeof item.arguments === "string"
							? toolArgumentNormalizer.parseFromString(
									item.arguments,
									{
										callId: item.call_id,
										name: item.name,
										stage: "done",
									},
									{ logInvalid: true },
								)
							: isRecord(item.arguments)
								? item.arguments
								: {};
					const toolCall: ToolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: item.name,
						arguments: finalArguments,
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
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			output.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: output };
		} else if (isStreamIdleTimeoutError(error)) {
			// Re-throw idle timeout errors so caller can retry
			throw error;
		} else {
			output.stopReason = "error";
			output.errorMessage =
				error instanceof Error ? error.message : String(error);
			yield { type: "error", reason: "error", error: output };
		}
	}
}

function buildInput(
	context: Context,
	model: Model<"openai-responses">,
): OpenAI.Responses.ResponseInput {
	const input: OpenAI.Responses.ResponseInput = [];
	const transformedMessages = transformMessages(context.messages, model);

	// System prompt
	if (context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		input.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	// Messages
	for (const msg of transformedMessages) {
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
			const filteredContent = model.input.includes("image")
				? content
				: content.filter((block) => block.type !== "input_image");
			if (filteredContent.length === 0) {
				continue;
			}
			input.push({ role: "user", content: filteredContent });
		} else if (msg.role === "assistant") {
			// Don't include thinking/toolCall if the message was aborted or errored
			// Reasoning items require their following function_call, so skip both
			const isIncomplete =
				msg.stopReason === "error" || msg.stopReason === "aborted";

			// Reasoning items can ONLY be followed by function_call, not by message
			// So only include reasoning if there are valid tool calls in this message
			const hasToolCalls = msg.content.some((b) => b.type === "toolCall");
			const canIncludeReasoning = hasToolCalls && !isIncomplete;

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
				} else if (block.type === "thinking" && canIncludeReasoning) {
					// For reasoning models, include reasoning items ONLY when followed by function_call
					// The API rejects reasoning items that aren't followed by their function_call
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature);
						input.push(reasoningItem);
					}
				} else if (block.type === "toolCall" && !isIncomplete) {
					const id = block.id.includes("|")
						? block.id.split("|")[1]!
						: block.id;
					const callId = block.id.includes("|")
						? block.id.split("|")[0]!
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
				? msg.toolCallId.split("|")[0]!
				: msg.toolCallId;

			const hasImages = msg.content.some((c) => c.type === "image");
			const outputText =
				textResult || (hasImages ? "(see attached image)" : "(empty result)");

			input.push({
				type: "function_call_output",
				call_id: callId,
				output: sanitizeSurrogates(outputText),
			});

			if (hasImages && model.input.includes("image")) {
				const contentParts: OpenAI.Responses.ResponseInputContent[] = [
					{
						type: "input_text",
						text: "Attached image(s) from tool result:",
					},
				];
				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							image_url: `data:${block.mimeType};base64,${block.data}`,
							detail: "auto",
						});
					}
				}
				input.push({ role: "user", content: contentParts });
			}
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
