/**
 * AWS Bedrock Provider - Converse API Integration
 *
 * This module implements streaming communication with AWS Bedrock's Converse API.
 * It supports all models available through Bedrock including Claude, Llama, Mistral,
 * and third-party models like Writer Palmyra.
 *
 * ## API Endpoint
 *
 * Bedrock uses region-specific endpoints:
 * `https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream`
 *
 * ## Authentication
 *
 * Requests are signed using AWS Signature Version 4 (SigV4). Credentials can be
 * provided via:
 * - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * - AWS profiles
 * - Bearer tokens (AWS_BEARER_TOKEN_BEDROCK)
 *
 * ## Streaming Architecture
 *
 * Bedrock uses a binary event stream format with typed events:
 *
 * ```
 * messageStart -> contentBlockStart -> contentBlockDelta* -> contentBlockStop -> messageStop -> metadata
 * ```
 *
 * Events are encoded as length-prefixed binary frames with JSON payloads.
 *
 * ## Tool Calling
 *
 * Tools are specified in the `toolConfig` field:
 *
 * ```json
 * {
 *   "toolConfig": {
 *     "tools": [{
 *       "toolSpec": {
 *         "name": "read_file",
 *         "description": "Reads a file",
 *         "inputSchema": { "json": {...} }
 *       }
 *     }]
 *   }
 * }
 * ```
 *
 * @module agent/providers/bedrock
 */

import {
	type AwsCredentials,
	buildBedrockUrl,
	getAwsRegion,
	resolveAwsCredentials,
	signAwsRequest,
} from "../../providers/aws-auth.js";
import { createLogger } from "../../utils/logger.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types.js";
import { parseStreamingJson } from "./json-parse.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";

const logger = createLogger("agent:providers:bedrock");

export interface BedrockOptions extends StreamOptions {
	region?: string;
	credentials?: AwsCredentials;
}

// Bedrock Converse API Types

interface BedrockTextContent {
	text: string;
}

interface BedrockImageContent {
	image: {
		format: "png" | "jpeg" | "gif" | "webp";
		source: {
			bytes: string; // base64
		};
	};
}

interface BedrockToolUseContent {
	toolUse: {
		toolUseId: string;
		name: string;
		input: Record<string, unknown>;
	};
}

interface BedrockToolResultContent {
	toolResult: {
		toolUseId: string;
		content: Array<{ text?: string; json?: unknown }>;
		status?: "success" | "error";
	};
}

type BedrockContentBlock =
	| BedrockTextContent
	| BedrockImageContent
	| BedrockToolUseContent
	| BedrockToolResultContent;

interface BedrockMessage {
	role: "user" | "assistant";
	content: BedrockContentBlock[];
}

interface BedrockToolSpec {
	toolSpec: {
		name: string;
		description: string;
		inputSchema: {
			json: unknown;
		};
	};
}

interface BedrockRequestBody {
	messages: BedrockMessage[];
	system?: Array<{ text: string }>;
	inferenceConfig?: {
		maxTokens?: number;
		temperature?: number;
		topP?: number;
		stopSequences?: string[];
	};
	toolConfig?: {
		tools: BedrockToolSpec[];
		toolChoice?:
			| { auto: object }
			| { any: object }
			| { tool: { name: string } };
	};
}

// Bedrock Streaming Event Types

interface BedrockMessageStartEvent {
	messageStart: {
		role: string;
	};
}

interface BedrockContentBlockStartEvent {
	contentBlockStart: {
		contentBlockIndex: number;
		start?: {
			toolUse?: {
				toolUseId: string;
				name: string;
			};
		};
	};
}

interface BedrockContentBlockDeltaEvent {
	contentBlockDelta: {
		contentBlockIndex: number;
		delta: {
			text?: string;
			toolUse?: {
				input: string; // JSON string chunk
			};
			reasoningContent?: {
				text: string;
			};
		};
	};
}

interface BedrockContentBlockStopEvent {
	contentBlockStop: {
		contentBlockIndex: number;
	};
}

interface BedrockMessageStopEvent {
	messageStop: {
		stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
		additionalModelResponseFields?: unknown;
	};
}

interface BedrockMetadataEvent {
	metadata: {
		usage: {
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			cacheReadInputTokens?: number;
			cacheWriteInputTokens?: number;
		};
		metrics?: {
			latencyMs: number;
		};
	};
}

type BedrockStreamEvent =
	| BedrockMessageStartEvent
	| BedrockContentBlockStartEvent
	| BedrockContentBlockDeltaEvent
	| BedrockContentBlockStopEvent
	| BedrockMessageStopEvent
	| BedrockMetadataEvent;

/**
 * Parse Bedrock's binary event stream format
 *
 * Bedrock uses AWS's event stream encoding:
 * - 4 bytes: total message length
 * - 4 bytes: headers length
 * - headers (variable)
 * - payload (JSON)
 * - 4 bytes: message CRC
 */
async function* parseBedrockEventStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<BedrockStreamEvent, void, unknown> {
	let buffer = new Uint8Array(0);

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		// Append new data to buffer
		const newBuffer = new Uint8Array(buffer.length + value.length);
		newBuffer.set(buffer);
		newBuffer.set(value, buffer.length);
		buffer = newBuffer;

		// Try to parse complete messages
		while (buffer.length >= 16) {
			// Minimum message size
			const view = new DataView(
				buffer.buffer,
				buffer.byteOffset,
				buffer.length,
			);

			// Read prelude (8 bytes)
			const totalLength = view.getUint32(0, false); // big-endian
			const headersLength = view.getUint32(4, false);

			if (buffer.length < totalLength) {
				// Need more data
				break;
			}

			// Extract headers and payload
			const headersEnd = 12 + headersLength; // 8 prelude + 4 prelude CRC
			const payloadEnd = totalLength - 4; // Exclude message CRC

			if (payloadEnd > headersEnd) {
				const payloadBytes = buffer.slice(headersEnd, payloadEnd);
				const payloadText = new TextDecoder().decode(payloadBytes);

				try {
					const event = JSON.parse(payloadText) as BedrockStreamEvent;
					yield event;
				} catch (e) {
					logger.warn("Failed to parse Bedrock event", {
						error: e instanceof Error ? e.message : String(e),
						payload: payloadText.slice(0, 200),
					});
				}
			}

			// Remove processed message from buffer
			buffer = buffer.slice(totalLength);
		}
	}
}

/**
 * Stream responses from AWS Bedrock using the Converse API
 */
export async function* streamBedrock(
	model: Model<"bedrock-converse">,
	context: Context,
	options: BedrockOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const region = options.region ?? getAwsRegion();
	const credentials = options.credentials ?? resolveAwsCredentials();
	const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;

	if (!credentials && !bearerToken) {
		throw new Error(
			"AWS credentials not found for Bedrock. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, " +
				"or use AWS_BEARER_TOKEN_BEDROCK for bearer token authentication.",
		);
	}

	// Build messages
	const messages: BedrockMessage[] = [];

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content: BedrockContentBlock[] = [];
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
								source: { bytes: c.data },
							},
						});
					}
				}
			}
			if (content.length > 0) {
				messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const content: BedrockContentBlock[] = [];
			for (const c of msg.content) {
				if (c.type === "text") {
					content.push({ text: sanitizeSurrogates(c.text) });
				} else if (c.type === "toolCall") {
					content.push({
						toolUse: {
							toolUseId: c.id,
							name: c.name,
							input: c.arguments,
						},
					});
				}
			}
			if (content.length > 0) {
				messages.push({ role: "assistant", content });
			}
		} else if (msg.role === "toolResult") {
			// Tool results are sent as user messages in Bedrock
			const resultContent: Array<{ text?: string; json?: unknown }> = [];
			if (typeof msg.content === "string") {
				resultContent.push({ text: msg.content });
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						resultContent.push({ text: c.text });
					}
				}
			}

			// Check if the last message is already a user message with tool results
			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === "user") {
				lastMsg.content.push({
					toolResult: {
						toolUseId: msg.toolCallId,
						content: resultContent,
						status: msg.isError ? "error" : "success",
					},
				});
			} else {
				messages.push({
					role: "user",
					content: [
						{
							toolResult: {
								toolUseId: msg.toolCallId,
								content: resultContent,
								status: msg.isError ? "error" : "success",
							},
						},
					],
				});
			}
		}
	}

	// Build request body
	const requestBody: BedrockRequestBody = {
		messages,
	};

	// Add system prompt
	if (context.systemPrompt) {
		requestBody.system = [{ text: sanitizeSurrogates(context.systemPrompt) }];
	}

	// Add inference config
	requestBody.inferenceConfig = {
		maxTokens: options.maxTokens ?? model.maxTokens,
	};
	if (options.temperature !== undefined) {
		requestBody.inferenceConfig.temperature = options.temperature;
	}

	// Add tools
	if (context.tools && context.tools.length > 0) {
		requestBody.toolConfig = {
			tools: context.tools.map((tool) => ({
				toolSpec: {
					name: tool.name,
					description: tool.description,
					inputSchema: {
						json: tool.parameters,
					},
				},
			})),
		};
	}

	const url = buildBedrockUrl(region, model.id, true);

	// Sign the request
	const baseHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/vnd.amazon.eventstream",
	};

	const body = JSON.stringify(requestBody);

	const signedHeaders = await signAwsRequest(
		{
			method: "POST",
			url,
			headers: baseHeaders,
			body,
		},
		{
			region,
			service: "bedrock",
			credentials: credentials ?? undefined,
			bearerToken,
		},
	);

	const response = await fetch(url, {
		method: "POST",
		headers: signedHeaders,
		body,
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Bedrock API error (${response.status}): ${errorText}`);
	}

	if (!response.body) {
		throw new Error("Response body is null");
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

	const reader = response.body.getReader();
	const toolArgBuffers = new Map<number, string>();
	const contentBlockTypes = new Map<number, "text" | "toolCall" | "thinking">();

	try {
		for await (const event of parseBedrockEventStream(reader)) {
			if ("messageStart" in event) {
				// Message started
				continue;
			}

			if ("contentBlockStart" in event) {
				const { contentBlockIndex, start } = event.contentBlockStart;

				if (start?.toolUse) {
					// Tool use block
					const toolCall: ToolCall = {
						type: "toolCall",
						id: start.toolUse.toolUseId,
						name: start.toolUse.name,
						arguments: {},
					};
					partial.content[contentBlockIndex] = toolCall;
					contentBlockTypes.set(contentBlockIndex, "toolCall");
					yield {
						type: "toolcall_start",
						contentIndex: contentBlockIndex,
						partial,
					};
				} else {
					// Text block (default)
					partial.content[contentBlockIndex] = { type: "text", text: "" };
					contentBlockTypes.set(contentBlockIndex, "text");
					yield {
						type: "text_start",
						contentIndex: contentBlockIndex,
						partial,
					};
				}
				continue;
			}

			if ("contentBlockDelta" in event) {
				const { contentBlockIndex, delta } = event.contentBlockDelta;
				const blockType = contentBlockTypes.get(contentBlockIndex);
				const block = partial.content[contentBlockIndex];

				if (delta.text && blockType === "text" && block?.type === "text") {
					const chunk = sanitizeSurrogates(delta.text);
					block.text += chunk;
					yield {
						type: "text_delta",
						contentIndex: contentBlockIndex,
						delta: chunk,
						partial,
					};
				} else if (delta.toolUse?.input && block?.type === "toolCall") {
					const existing = toolArgBuffers.get(contentBlockIndex) ?? "";
					const combined = existing + delta.toolUse.input;
					toolArgBuffers.set(contentBlockIndex, combined);
					block.arguments = parseStreamingJson(combined);
					yield {
						type: "toolcall_delta",
						contentIndex: contentBlockIndex,
						delta: delta.toolUse.input,
						partial,
					};
				} else if (delta.reasoningContent?.text) {
					// Reasoning/thinking content
					let thinkingBlock = partial.content.find(
						(c): c is ThinkingContent => c.type === "thinking",
					);
					if (!thinkingBlock) {
						thinkingBlock = { type: "thinking", thinking: "" };
						partial.content.push(thinkingBlock);
						const idx = partial.content.indexOf(thinkingBlock);
						contentBlockTypes.set(idx, "thinking");
						yield { type: "thinking_start", contentIndex: idx, partial };
					}
					const chunk = sanitizeSurrogates(delta.reasoningContent.text);
					thinkingBlock.thinking += chunk;
					yield {
						type: "thinking_delta",
						contentIndex: partial.content.indexOf(thinkingBlock),
						delta: chunk,
						partial,
					};
				}
				continue;
			}

			if ("contentBlockStop" in event) {
				const { contentBlockIndex } = event.contentBlockStop;
				const blockType = contentBlockTypes.get(contentBlockIndex);
				const block = partial.content[contentBlockIndex];

				if (blockType === "text" && block?.type === "text") {
					yield {
						type: "text_end",
						contentIndex: contentBlockIndex,
						content: block.text,
						partial,
					};
				} else if (blockType === "toolCall" && block?.type === "toolCall") {
					// Final parse of tool arguments
					const buf = toolArgBuffers.get(contentBlockIndex) ?? "{}";
					try {
						block.arguments = JSON.parse(buf);
					} catch {
						block.arguments = parseStreamingJson(buf);
					}
					toolArgBuffers.delete(contentBlockIndex);
					yield {
						type: "toolcall_end",
						contentIndex: contentBlockIndex,
						toolCall: block,
						partial,
					};
				} else if (blockType === "thinking" && block?.type === "thinking") {
					yield {
						type: "thinking_end",
						contentIndex: contentBlockIndex,
						content: block.thinking,
						partial,
					};
				}
				continue;
			}

			if ("messageStop" in event) {
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

			if ("metadata" in event) {
				const { usage } = event.metadata;
				partial.usage.input = usage.inputTokens;
				partial.usage.output = usage.outputTokens;
				partial.usage.cacheRead = usage.cacheReadInputTokens ?? 0;
				partial.usage.cacheWrite = usage.cacheWriteInputTokens ?? 0;

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
		} else {
			throw error;
		}
	}
}
