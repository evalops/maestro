/**
 * AWS Bedrock Provider - Converse API Integration
 *
 * This module implements streaming communication with AWS Bedrock's Converse API
 * using the official AWS SDK (@aws-sdk/client-bedrock-runtime).
 *
 * It supports all models available through Bedrock including Claude, Llama, Mistral,
 * and third-party models like Writer Palmyra.
 *
 * ## Authentication
 *
 * The SDK automatically handles credential resolution via the standard AWS
 * credential provider chain:
 * - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * - Shared credentials file (~/.aws/credentials)
 * - IAM roles for EC2/ECS/Lambda
 * - Web identity tokens (EKS)
 *
 * ## Streaming Architecture
 *
 * Uses ConverseStreamCommand which returns an async iterator of events:
 * - messageStart: Start of assistant message
 * - contentBlockStart: Start of text or tool use block
 * - contentBlockDelta: Incremental content updates
 * - contentBlockStop: End of content block
 * - messageStop: End of message with stop reason
 * - metadata: Token usage and metrics
 *
 * @module agent/providers/bedrock
 */

import {
	BedrockRuntimeClient,
	type CachePointBlock,
	type ContentBlock,
	type ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamCommandInput,
	type GuardrailStreamConfiguration,
	type Message,
	type SystemContentBlock,
	type Tool,
	type ToolResultBlock,
	type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import { getAwsRegion, parseBedrockArn } from "../../providers/aws-auth.js";
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
	StreamOptions,
	ThinkingContent,
	ToolCall,
} from "../types.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import {
	createToolArgumentNormalizer,
	describeValueType,
	isRecord,
} from "./tool-arguments.js";

const logger = createLogger("agent:providers:bedrock");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "Bedrock",
});

/**
 * Guardrail configuration for Bedrock requests
 */
export interface BedrockGuardrailConfig {
	/** Guardrail identifier (ID or ARN) */
	guardrailIdentifier: string;
	/** Guardrail version */
	guardrailVersion: string;
	/** Enable trace for debugging guardrail decisions */
	trace?: "enabled" | "disabled" | "enabled_full";
	/** Stream processing mode - sync waits for guardrail before streaming */
	streamProcessingMode?: "sync" | "async";
}

export interface BedrockOptions extends StreamOptions {
	/** AWS region override (auto-detected from ARN if not specified) */
	region?: string;
	/** Enable prompt caching for system prompt and tools (Claude/Nova models) */
	enableCaching?: boolean;
	/** Guardrail configuration */
	guardrailConfig?: BedrockGuardrailConfig;
	/** Use inference profile ID instead of model ID (for cross-region inference) */
	inferenceProfileId?: string;
}

// Cache client instances by region
const clientCache = new Map<string, BedrockRuntimeClient>();

function getClient(region: string): BedrockRuntimeClient {
	let client = clientCache.get(region);
	if (!client) {
		client = new BedrockRuntimeClient({ region });
		clientCache.set(region, client);
	}
	return client;
}

/**
 * Stream responses from AWS Bedrock using the Converse API
 */
export async function* streamBedrock(
	model: Model<"bedrock-converse">,
	context: Context,
	options: BedrockOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	// Determine model ID - use inference profile if specified
	const modelId = options.inferenceProfileId ?? model.id;

	// Auto-detect region from ARN/inference profile, fallback to option or env
	const arnInfo = parseBedrockArn(modelId);
	const region = options.region ?? arnInfo?.region ?? getAwsRegion();
	const client = getClient(region);

	logger.debug("Bedrock request", {
		modelId,
		region,
		enableCaching: options.enableCaching,
		hasGuardrail: !!options.guardrailConfig,
	});

	// Build messages
	const messages: Message[] = [];

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content: ContentBlock[] = [];
			if (typeof msg.content === "string") {
				content.push({ text: sanitizeSurrogates(msg.content) });
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						content.push({ text: sanitizeSurrogates(c.text) });
					} else if (c.type === "image") {
						// Determine format from mimeType
						const formatMatch = c.mimeType.match(/image\/(png|jpeg|gif|webp)/);
						const format = (formatMatch?.[1] ?? "png") as
							| "png"
							| "jpeg"
							| "gif"
							| "webp";
						content.push({
							image: {
								format,
								source: { bytes: Buffer.from(c.data, "base64") },
							},
						});
					}
				}
			}
			if (content.length > 0) {
				messages.push({ role: "user" as ConversationRole, content });
			}
		} else if (msg.role === "assistant") {
			const content: ContentBlock[] = [];
			for (const c of msg.content) {
				if (c.type === "text") {
					content.push({ text: sanitizeSurrogates(c.text) });
				} else if (c.type === "toolCall") {
					content.push({
						toolUse: {
							toolUseId: c.id,
							name: c.name,
							input: c.arguments as DocumentType,
						},
					});
				}
			}
			if (content.length > 0) {
				messages.push({ role: "assistant" as ConversationRole, content });
			}
		} else if (msg.role === "toolResult") {
			// Tool results are sent as user messages in Bedrock
			const resultContent: ToolResultContentBlock[] = [];
			if (typeof msg.content === "string") {
				resultContent.push({ text: msg.content });
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						resultContent.push({ text: c.text });
					} else if (c.type === "image") {
						// Extract format from mimeType (e.g., "image/png" -> "png")
						const formatMatch = c.mimeType.match(/image\/(png|jpeg|gif|webp)/);
						const format = (formatMatch?.[1] ?? "png") as
							| "png"
							| "jpeg"
							| "gif"
							| "webp";
						resultContent.push({
							image: {
								format,
								source: { bytes: Buffer.from(c.data, "base64") },
							},
						});
					}
				}
			}

			const toolResult: ToolResultBlock = {
				toolUseId: msg.toolCallId,
				content: resultContent,
				status: msg.isError ? "error" : "success",
			};

			// Check if the last message is already a user message with tool results
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "user" && lastMsg.content) {
				lastMsg.content.push({ toolResult });
			} else {
				messages.push({
					role: "user" as ConversationRole,
					content: [{ toolResult }],
				});
			}
		}
	}

	// Build request input
	const input: ConverseStreamCommandInput = {
		modelId,
		messages,
	};

	// Add system prompt with optional cache point
	if (context.systemPrompt) {
		const systemContent: SystemContentBlock[] = [
			{ text: sanitizeSurrogates(context.systemPrompt) },
		];
		// Add cache point after system prompt if caching is enabled
		if (options.enableCaching) {
			const cachePoint: CachePointBlock = { type: "default" };
			systemContent.push({ cachePoint });
		}
		input.system = systemContent;
	}

	// Add inference config
	input.inferenceConfig = {
		maxTokens: options.maxTokens ?? model.maxTokens,
	};
	if (options.temperature !== undefined) {
		input.inferenceConfig.temperature = options.temperature;
	}

	// Add guardrail config if specified
	if (options.guardrailConfig) {
		const guardrailConfig: GuardrailStreamConfiguration = {
			guardrailIdentifier: options.guardrailConfig.guardrailIdentifier,
			guardrailVersion: options.guardrailConfig.guardrailVersion,
		};
		if (options.guardrailConfig.trace) {
			guardrailConfig.trace = options.guardrailConfig.trace;
		}
		if (options.guardrailConfig.streamProcessingMode) {
			guardrailConfig.streamProcessingMode =
				options.guardrailConfig.streamProcessingMode;
		}
		input.guardrailConfig = guardrailConfig;
	}

	// Add tools with optional cache point
	if (context.tools && context.tools.length > 0) {
		const tools: Tool[] = context.tools.map((tool) => ({
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: {
					json: tool.parameters,
				},
			},
		}));
		// Add cache point after tools if caching is enabled
		if (options.enableCaching) {
			const cachePoint: CachePointBlock = { type: "default" };
			tools.push({ cachePoint });
		}
		input.toolConfig = { tools };
	}

	// Initialize partial message
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "bedrock-converse",
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

	const toolArgBuffers = new Map<number, string>();
	const toolArgOverrides = new Map<number, Record<string, unknown>>();
	const contentBlockTypes = new Map<number, "text" | "toolCall" | "thinking">();

	try {
		const command = new ConverseStreamCommand(input);
		const response = await client.send(command, {
			abortSignal: options.signal,
		});

		if (!response.stream) {
			throw new Error("Response stream is undefined");
		}

		// Wrap stream with idle timeout detection
		const timedStream = withAbortableIdleTimeout(response.stream, {
			provider: model.provider,
			signal: options.signal,
		});

		for await (const event of timedStream) {
			if (event.messageStart) {
				// Message started - role is always assistant for responses
				continue;
			}

			if (event.contentBlockStart) {
				const { contentBlockIndex, start } = event.contentBlockStart;
				const idx = contentBlockIndex ?? 0;

				if (start?.toolUse) {
					// Tool use block
					const toolCall: ToolCall = {
						type: "toolCall",
						id: start.toolUse.toolUseId ?? `tool-${idx}`,
						name: start.toolUse.name ?? "unknown",
						arguments: {},
					};
					partial.content[idx] = toolCall;
					contentBlockTypes.set(idx, "toolCall");
					yield {
						type: "toolcall_start",
						contentIndex: idx,
						partial,
					};
				} else {
					// Text block (default)
					partial.content[idx] = { type: "text", text: "" };
					contentBlockTypes.set(idx, "text");
					yield {
						type: "text_start",
						contentIndex: idx,
						partial,
					};
				}
				continue;
			}

			if (event.contentBlockDelta) {
				const { contentBlockIndex, delta } = event.contentBlockDelta;
				const idx = contentBlockIndex ?? 0;
				const blockType = contentBlockTypes.get(idx);
				const block = partial.content[idx];

				if (delta?.text && blockType === "text" && block?.type === "text") {
					const chunk = sanitizeSurrogates(delta.text);
					block.text += chunk;
					yield {
						type: "text_delta",
						contentIndex: idx,
						delta: chunk,
						partial,
					};
				} else if (delta?.toolUse?.input && block?.type === "toolCall") {
					const input = delta.toolUse.input;
					if (typeof input === "string") {
						toolArgOverrides.delete(idx);
						const existing = toolArgBuffers.get(idx) ?? "";
						const combined = existing + input;
						toolArgBuffers.set(idx, combined);
						block.arguments = toolArgumentNormalizer.parseFromString(
							combined,
							{ toolId: block.id, name: block.name, stage: "delta" },
							{ logInvalid: false },
						);
						yield {
							type: "toolcall_delta",
							contentIndex: idx,
							delta: input,
							partial,
						};
					} else if (isRecord(input)) {
						toolArgumentNormalizer.warnOnce(
							"delta:object",
							"Bedrock tool_use input delta was object",
							{ toolId: block.id, name: block.name },
						);
						toolArgOverrides.set(idx, input);
						toolArgBuffers.delete(idx);
						block.arguments = input;
						yield {
							type: "toolcall_delta",
							contentIndex: idx,
							delta: JSON.stringify(input),
							partial,
						};
					} else if (input !== null && input !== undefined) {
						const rawType = describeValueType(input);
						toolArgumentNormalizer.warnOnce(
							`delta:${rawType}`,
							"Bedrock tool_use input delta was non-string",
							{ toolId: block.id, name: block.name, rawType },
						);
					}
				} else if (delta?.reasoningContent?.text) {
					// Reasoning/thinking content (for models that support it)
					// Use Bedrock's contentBlockIndex to maintain consistency with contentBlockStop
					let thinkingBlock = partial.content[idx] as
						| ThinkingContent
						| undefined;
					if (!thinkingBlock || thinkingBlock.type !== "thinking") {
						thinkingBlock = { type: "thinking", thinking: "" };
						partial.content[idx] = thinkingBlock;
						contentBlockTypes.set(idx, "thinking");
						yield {
							type: "thinking_start",
							contentIndex: idx,
							partial,
						};
					}
					const chunk = sanitizeSurrogates(delta.reasoningContent.text);
					thinkingBlock.thinking += chunk;
					yield {
						type: "thinking_delta",
						contentIndex: idx,
						delta: chunk,
						partial,
					};
				}
				continue;
			}

			if (event.contentBlockStop) {
				const { contentBlockIndex } = event.contentBlockStop;
				const idx = contentBlockIndex ?? 0;
				const blockType = contentBlockTypes.get(idx);
				const block = partial.content[idx];

				if (blockType === "text" && block?.type === "text") {
					yield {
						type: "text_end",
						contentIndex: idx,
						content: block.text,
						partial,
					};
				} else if (blockType === "toolCall" && block?.type === "toolCall") {
					// Final parse of tool arguments
					const overrideArgs = toolArgOverrides.get(idx);
					if (overrideArgs) {
						block.arguments = overrideArgs;
					} else {
						const buf = toolArgBuffers.get(idx);
						if (buf !== undefined) {
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
				} else if (blockType === "thinking" && block?.type === "thinking") {
					yield {
						type: "thinking_end",
						contentIndex: idx,
						content: block.thinking,
						partial,
					};
				}
				continue;
			}

			if (event.messageStop) {
				const { stopReason } = event.messageStop;
				partial.stopReason =
					stopReason === "end_turn"
						? "stop"
						: stopReason === "max_tokens"
							? "length"
							: stopReason === "tool_use"
								? "toolUse"
								: "stop";
				continue;
			}

			if (event.metadata) {
				const { usage } = event.metadata;
				if (usage) {
					partial.usage.input = usage.inputTokens ?? 0;
					partial.usage.output = usage.outputTokens ?? 0;
					partial.usage.cacheRead = usage.cacheReadInputTokens ?? 0;
					partial.usage.cacheWrite = usage.cacheWriteInputTokens ?? 0;
				}

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

				// Emit done event after metadata
				const finalReason =
					partial.stopReason === "stop" ||
					partial.stopReason === "length" ||
					partial.stopReason === "toolUse"
						? partial.stopReason
						: "stop";
				yield {
					type: "done",
					reason: finalReason,
					message: partial,
				};
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
