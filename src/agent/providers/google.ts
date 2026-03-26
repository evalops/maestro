import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type FunctionDeclaration,
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type Part,
} from "@google/genai";
import {
	isStreamIdleTimeoutError,
	withAbortableIdleTimeout,
} from "../../providers/stream-idle-timeout.js";
import { createLogger } from "../../utils/logger.js";
import { mapThinkingLevelToGoogleBudget } from "../thinking-level-mapper.js";
import type {
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	ReasoningEffort,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { createToolArgumentNormalizer } from "./tool-arguments.js";
import { transformMessages } from "./transform-messages.js";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: ReasoningEffort;
}

const logger = createLogger("agent:providers:google");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "Google",
});

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

/**
 * Google Gemini provider with thinking support and caching.
 * Supports Gemini 2.5 Pro/Flash models with extended context.
 */
export async function* streamGoogle(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const apiKey = options.apiKey;
	if (!apiKey) {
		throw new Error("API key is required for Google");
	}

	const client = new GoogleGenAI({ apiKey });
	const params = buildParams(model, context, options);

	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "google-generative-ai",
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

	try {
		const googleStream = await client.models.generateContentStream(params);

		// Wrap stream with idle timeout detection
		const timedStream = withAbortableIdleTimeout(googleStream, {
			provider: model.provider,
			signal: options.signal,
		});

		let currentBlock: TextContent | ThinkingContent | null = null;
		const blockIndex = () => partial.content.length - 1;

		for await (const chunk of timedStream) {
			const candidate = chunk.candidates?.[0];

			if (candidate?.content?.parts) {
				for (const part of candidate.content.parts) {
					if (part.text !== undefined) {
						const isThinking = part.thought === true;
						const thoughtSignature =
							"thoughtSignature" in part &&
							typeof (part as { thoughtSignature?: unknown })
								.thoughtSignature === "string"
								? (part as { thoughtSignature: string }).thoughtSignature
								: undefined;

						if (
							!currentBlock ||
							(isThinking && currentBlock.type !== "thinking") ||
							(!isThinking && currentBlock.type !== "text")
						) {
							// Finish previous block
							if (currentBlock) {
								if (currentBlock.type === "text") {
									yield {
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial,
									};
								} else {
									yield {
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial,
									};
								}
							}

							// Start new block
							if (isThinking) {
								currentBlock = {
									type: "thinking",
									thinking: "",
									...(thoughtSignature
										? { thinkingSignature: thoughtSignature }
										: {}),
								};
								partial.content.push(currentBlock);
								yield {
									type: "thinking_start",
									contentIndex: blockIndex(),
									partial,
								};
							} else {
								currentBlock = { type: "text", text: "" };
								partial.content.push(currentBlock);
								yield {
									type: "text_start",
									contentIndex: blockIndex(),
									partial,
								};
							}
						}

						// Accumulate delta
						if (currentBlock.type === "thinking") {
							if (thoughtSignature && !currentBlock.thinkingSignature) {
								currentBlock.thinkingSignature = thoughtSignature;
							}
							currentBlock.thinking += part.text;
							yield {
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial,
							};
						} else {
							currentBlock.text += part.text;
							yield {
								type: "text_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial,
							};
						}
					}

					if (part.functionCall) {
						// Finish current block if any
						if (currentBlock) {
							if (currentBlock.type === "text") {
								yield {
									type: "text_end",
									contentIndex: blockIndex(),
									content: currentBlock.text,
									partial,
								};
							} else {
								yield {
									type: "thinking_end",
									contentIndex: blockIndex(),
									content: currentBlock.thinking,
									partial,
								};
							}
							currentBlock = null;
						}

						// Generate unique ID if not provided or if it's a duplicate
						const providedId = part.functionCall.id;
						const needsNewId =
							!providedId ||
							partial.content.some(
								(b) => b.type === "toolCall" && b.id === providedId,
							);
						const toolCallId = needsNewId
							? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
							: providedId;

						const toolName = part.functionCall.name || "";
						const toolCall: ToolCall = {
							type: "toolCall",
							id: toolCallId,
							name: toolName,
							arguments: toolArgumentNormalizer.normalize(
								part.functionCall.args,
								{
									toolId: toolCallId,
									name: toolName,
								},
							),
							...("thoughtSignature" in part &&
							typeof (part as { thoughtSignature?: unknown })
								.thoughtSignature === "string"
								? {
										thoughtSignature: (part as { thoughtSignature: string })
											.thoughtSignature,
									}
								: {}),
						};

						// Note: Validation happens in the agent executor, not during streaming

						partial.content.push(toolCall);
						yield {
							type: "toolcall_start",
							contentIndex: blockIndex(),
							partial,
						};
						yield {
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta: JSON.stringify(toolCall.arguments),
							partial,
						};
						yield {
							type: "toolcall_end",
							contentIndex: blockIndex(),
							toolCall,
							partial,
						};
					}
				}
			}

			if (candidate?.finishReason) {
				partial.stopReason = mapStopReason(candidate.finishReason);
				if (
					partial.stopReason === "stop" &&
					partial.content.some((b) => b.type === "toolCall")
				) {
					partial.stopReason = "toolUse";
				}
			}

			if (chunk.usageMetadata) {
				partial.usage = {
					input: chunk.usageMetadata.promptTokenCount || 0,
					output:
						(chunk.usageMetadata.candidatesTokenCount || 0) +
						(chunk.usageMetadata.thoughtsTokenCount || 0),
					cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
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
				partial.usage.cost = {
					input: (partial.usage.input * model.cost.input) / 1_000_000,
					output: (partial.usage.output * model.cost.output) / 1_000_000,
					cacheRead:
						(partial.usage.cacheRead * model.cost.cacheRead) / 1_000_000,
					cacheWrite: 0,
					total: 0,
				};
				partial.usage.cost.total =
					partial.usage.cost.input +
					partial.usage.cost.output +
					partial.usage.cost.cacheRead;
			}
		}

		// Finish any remaining block
		if (currentBlock) {
			if (currentBlock.type === "text") {
				yield {
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial,
				};
			} else {
				yield {
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial,
				};
			}
		}

		const stopReason = partial.stopReason;
		if (stopReason === "error" || stopReason === "aborted") {
			yield { type: "error", reason: stopReason, error: partial };
		} else {
			yield {
				type: "done",
				reason:
					stopReason === "length"
						? "length"
						: stopReason === "toolUse"
							? "toolUse"
							: "stop",
				message: partial,
			};
		}
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			partial.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: partial };
		} else if (isStreamIdleTimeoutError(error)) {
			// Re-throw idle timeout errors so caller can retry
			throw error;
		} else {
			partial.stopReason = "error";
			partial.errorMessage =
				error instanceof Error ? error.message : JSON.stringify(error);
			yield { type: "error", reason: "error", error: partial };
		}
	}
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions,
): GenerateContentParameters {
	const contents = convertMessagesForGoogle(model, context);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && {
			systemInstruction: sanitizeSurrogates(context.systemPrompt),
		}),
		...(context.tools &&
			context.tools.length > 0 && {
				tools: convertTools(context.tools) as GenerateContentConfig["tools"],
			}),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	}

	// Add thinking config based on reasoning level
	if (options.thinking && model.reasoning) {
		// Use unified thinking level mapper for budget
		const thinkingBudget = mapThinkingLevelToGoogleBudget(options.thinking);
		if (thinkingBudget) {
			config.thinkingConfig = {
				includeThoughts: true,
				thinkingBudget,
			};
		}
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	if (options.headers && Object.keys(options.headers).length > 0) {
		const existingHeaders = config.httpOptions?.headers ?? {};
		config.httpOptions = {
			...(config.httpOptions ?? {}),
			headers: { ...existingHeaders, ...options.headers },
		};
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

export function convertMessagesForGoogle(
	model: Model<"google-generative-ai">,
	context: Context,
): Content[] {
	const contents: Content[] = [];
	const transformedMessages = transformMessages(context.messages, model);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					}
					return {
						inlineData: {
							mimeType: item.mimeType,
							data: item.data,
						},
					};
				});
				const filteredParts = !model.input.includes("image")
					? parts.filter((p) => p.text !== undefined)
					: parts;
				if (filteredParts.length === 0) continue;
				contents.push({
					role: "user",
					parts: filteredParts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			type PartWithThoughtSignature = Part & { thoughtSignature?: string };

			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					const thinkingPart: PartWithThoughtSignature = {
						thought: true,
						text: sanitizeSurrogates(block.thinking),
					} as PartWithThoughtSignature;
					if (block.thinkingSignature) {
						thinkingPart.thoughtSignature = block.thinkingSignature;
					}
					parts.push(thinkingPart);
				} else if (block.type === "toolCall") {
					const toolPart: PartWithThoughtSignature = {
						functionCall: {
							id: block.id,
							name: block.name,
							args: block.arguments,
						},
					} as PartWithThoughtSignature;
					if (block.thoughtSignature) {
						toolPart.thoughtSignature = block.thoughtSignature;
					}
					parts.push(toolPart);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			const parts: Part[] = [];

			// Extract text and image content
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => ("text" in c ? c.text : ""))
				.join("\n");
			const imageBlocks = model.input.includes("image")
				? msg.content.filter((c) => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageBlocks.length > 0;

			// Always add functionResponse
			parts.push({
				functionResponse: {
					id: msg.toolCallId,
					name: msg.toolName,
					response: {
						result: hasText
							? sanitizeSurrogates(textResult)
							: hasImages
								? "(see attached image)"
								: "",
						isError: msg.isError,
					},
				},
			});

			// Add any images as inlineData parts
			for (const imageBlock of imageBlocks) {
				const mimeType =
					"type" in imageBlock &&
					imageBlock.type === "image" &&
					imageBlock.mimeType
						? imageBlock.mimeType
						: "application/octet-stream";
				const data =
					"type" in imageBlock && imageBlock.type === "image" && imageBlock.data
						? imageBlock.data
						: "";
				parts.push({
					inlineData: {
						mimeType,
						data,
					},
				});
			}

			contents.push({
				role: "user",
				parts,
			});
		}
	}

	return contents;
}

function convertTools(
	tools: Tool[],
): Array<{ functionDeclarations: FunctionDeclaration[] }> | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as FunctionDeclaration["parameters"],
			})),
		},
	];
}

function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default:
			// Map any future/unknown reasons conservatively to an error so we don't throw at runtime
			return "error";
	}
}
