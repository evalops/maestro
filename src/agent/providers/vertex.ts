/**
 * Google Vertex AI Provider
 *
 * This module implements streaming communication with Google's Vertex AI
 * platform for Gemini models. Unlike the direct Google AI SDK, Vertex AI
 * uses service account authentication and different endpoints.
 *
 * ## Authentication
 *
 * Uses Google Application Default Credentials (ADC):
 * - Service account JSON key file (GOOGLE_APPLICATION_CREDENTIALS)
 * - gcloud CLI credentials (gcloud auth application-default login)
 * - Compute Engine/Cloud Run default service account
 *
 * ## Configuration
 *
 * Required environment variables:
 * - GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID: GCP project ID
 * - GOOGLE_CLOUD_REGION or VERTEX_LOCATION: Region (e.g., us-central1)
 *
 * Optional:
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account JSON
 *
 * @module agent/providers/vertex
 */

import { GoogleAuth } from "google-auth-library";
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
	ReasoningEffort,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.js";
import { mapThinkingLevelToGoogleBudget } from "../thinking-level-mapper.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { createToolArgumentNormalizer } from "./tool-arguments.js";
import { transformMessages } from "./transform-messages.js";

const logger = createLogger("agent:providers:vertex");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "Vertex",
});

export interface VertexOptions extends StreamOptions {
	/** GCP project ID override */
	projectId?: string;
	/** GCP region override (e.g., us-central1) */
	location?: string;
	/** Tool choice mode */
	toolChoice?: "auto" | "none" | "any";
	/** Reasoning/thinking level for supported models */
	thinking?: ReasoningEffort;
}

/**
 * Get Vertex AI configuration from environment.
 */
function getVertexConfig(options: VertexOptions): {
	projectId: string;
	location: string;
} {
	const projectId =
		options.projectId ||
		process.env.GOOGLE_CLOUD_PROJECT ||
		process.env.VERTEX_PROJECT_ID ||
		process.env.GCLOUD_PROJECT;

	const location =
		options.location ||
		process.env.GOOGLE_CLOUD_REGION ||
		process.env.VERTEX_LOCATION ||
		"us-central1";

	if (!projectId) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT or VERTEX_PROJECT_ID environment variable.",
		);
	}

	return { projectId, location };
}

// Cache auth client
let authClient: GoogleAuth | null = null;

async function getAuthClient(): Promise<GoogleAuth> {
	if (!authClient) {
		authClient = new GoogleAuth({
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
	}
	return authClient;
}

/**
 * Build the Vertex AI endpoint URL.
 */
function getVertexEndpoint(
	projectId: string,
	location: string,
	modelId: string,
): string {
	// Extract just the model name if it includes provider prefix
	const modelName = modelId.includes("/") ? modelId.split("/").pop() : modelId;
	return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelName}:streamGenerateContent`;
}

/**
 * Convert internal message format to Vertex AI format.
 */
function convertToVertexFormat(
	model: Model<"vertex-ai">,
	context: Context,
): { contents: VertexContent[]; systemInstruction?: { parts: VertexPart[] } } {
	const contents: VertexContent[] = [];
	const transformedMessages = transformMessages(context.messages, model);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: VertexPart[] = msg.content.map((item) => {
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
				contents.push({ role: "user", parts });
			}
		} else if (msg.role === "assistant") {
			const parts: VertexPart[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					parts.push({ text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					parts.push({
						thought: true,
						text: sanitizeSurrogates(block.thinking),
					});
				} else if (block.type === "toolCall") {
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments,
						},
					});
				}
			}
			if (parts.length > 0) {
				contents.push({ role: "model", parts });
			}
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c) => c.type === "text")
				.map((c) => ("text" in c ? c.text : ""))
				.join("\n");

			contents.push({
				role: "user",
				parts: [
					{
						functionResponse: {
							name: msg.toolName,
							response: {
								result: sanitizeSurrogates(textResult),
								isError: msg.isError,
							},
						},
					},
				],
			});
		}
	}

	const result: {
		contents: VertexContent[];
		systemInstruction?: { parts: VertexPart[] };
	} = { contents };

	if (context.systemPrompt) {
		result.systemInstruction = {
			parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
		};
	}

	return result;
}

interface VertexPart {
	text?: string;
	thought?: boolean;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args: Record<string, unknown> };
	functionResponse?: {
		name: string;
		response: { result: string; isError?: boolean };
	};
}

interface VertexContent {
	role: "user" | "model";
	parts: VertexPart[];
}

interface VertexTool {
	functionDeclarations: Array<{
		name: string;
		description: string;
		parameters: unknown;
	}>;
}

/**
 * Stream responses from Google Vertex AI.
 */
export async function* streamVertex(
	model: Model<"vertex-ai">,
	context: Context,
	options: VertexOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const { projectId, location } = getVertexConfig(options);
	const endpoint = getVertexEndpoint(projectId, location, model.id);

	logger.debug("Vertex AI request", {
		projectId,
		location,
		model: model.id,
		endpoint,
	});

	// Get auth token
	const auth = await getAuthClient();
	const accessToken = await auth.getAccessToken();

	if (!accessToken) {
		throw new Error("Failed to get Vertex AI access token");
	}

	// Build request body
	const { contents, systemInstruction } = convertToVertexFormat(model, context);

	const requestBody: Record<string, unknown> = {
		contents,
	};

	if (systemInstruction) {
		requestBody.systemInstruction = systemInstruction;
	}

	// Add generation config
	const generationConfig: Record<string, unknown> = {};
	if (options.maxTokens) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (Object.keys(generationConfig).length > 0) {
		requestBody.generationConfig = generationConfig;
	}

	// Add tools
	if (context.tools && context.tools.length > 0) {
		const tools: VertexTool[] = [
			{
				functionDeclarations: context.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		];
		requestBody.tools = tools;

		if (options.toolChoice) {
			requestBody.toolConfig = {
				functionCallingConfig: {
					mode:
						options.toolChoice === "auto"
							? "AUTO"
							: options.toolChoice === "none"
								? "NONE"
								: "ANY",
				},
			};
		}
	}

	// Add thinking config
	if (options.thinking && model.reasoning) {
		// Use unified thinking level mapper for budget
		const thinkingBudget = mapThinkingLevelToGoogleBudget(options.thinking);
		if (thinkingBudget) {
			requestBody.generationConfig = {
				...(requestBody.generationConfig as Record<string, unknown>),
				thinkingConfig: {
					includeThoughts: true,
					thinkingBudget,
				},
			};
		}
	}

	// Initialize partial message
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "vertex-ai",
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

	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Vertex AI error (${response.status}): ${errorText}`);
		}

		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Parse streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentBlock: TextContent | ThinkingContent | null = null;
		let toolCallCounter = 0;

		const blockIndex = () => partial.content.length - 1;
		function* handleChunk(chunk: {
			candidates?: Array<{
				content?: { parts?: Array<Record<string, unknown>> };
				finishReason?: string;
			}>;
			usageMetadata?: {
				promptTokenCount?: number;
				candidatesTokenCount?: number;
				thoughtsTokenCount?: number;
				cachedContentTokenCount?: number;
			};
		}): Generator<AssistantMessageEvent, void, unknown> {
			const candidate = chunk.candidates?.[0];

			if (candidate?.content?.parts) {
				for (const part of candidate.content.parts) {
					if (typeof part.text === "string") {
						const isThinking = part.thought === true;

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
								currentBlock = { type: "thinking", thinking: "" };
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

					const functionCall =
						typeof part.functionCall === "object" && part.functionCall !== null
							? (part.functionCall as { name?: unknown; args?: unknown })
							: null;
					if (functionCall) {
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

						const toolName =
							typeof functionCall.name === "string" ? functionCall.name : "";
						const toolCallId = `${toolName}_${Date.now()}_${++toolCallCounter}`;
						const toolCall: ToolCall = {
							type: "toolCall",
							id: toolCallId,
							name: toolName,
							arguments: toolArgumentNormalizer.normalize(functionCall.args, {
								toolId: toolCallId,
								name: toolName,
							}),
						};

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

		function* parseChunkString(
			jsonStr: string,
		): Generator<AssistantMessageEvent, void, unknown> {
			try {
				yield* handleChunk(JSON.parse(jsonStr));
			} catch {
				// Incomplete JSON, continue buffering
			}
		}

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Parse JSON objects from the buffer (Vertex returns array of objects)
			// Remove leading [ and trailing ] for easier parsing
			const cleanBuffer = buffer.replace(/^\[/, "").replace(/\]$/, "");
			const lines = cleanBuffer.split(/\}\s*,\s*\{/);

			for (let i = 0; i < lines.length - 1; i++) {
				let jsonStr = lines[i]!;
				if (!jsonStr.startsWith("{")) jsonStr = `{${jsonStr}`;
				if (!jsonStr.endsWith("}")) jsonStr = `${jsonStr}}`;

				yield* parseChunkString(jsonStr);
			}

			// Keep last incomplete chunk in buffer
			if (lines.length > 0) {
				buffer = lines[lines.length - 1]!;
			}
		}

		const remaining = buffer.replace(/^\[/, "").replace(/\]$/, "");
		if (remaining.trim()) {
			const trailingLines = remaining.split(/\}\s*,\s*\{/);
			for (const line of trailingLines) {
				let jsonStr = line;
				if (!jsonStr.startsWith("{")) jsonStr = `{${jsonStr}`;
				if (!jsonStr.endsWith("}")) jsonStr = `${jsonStr}}`;
				yield* parseChunkString(jsonStr);
			}
		}

		// Finish any remaining block
		const finalBlock = currentBlock as TextContent | ThinkingContent | null;
		if (finalBlock) {
			if (finalBlock.type === "text") {
				yield {
					type: "text_end",
					contentIndex: blockIndex(),
					content: finalBlock.text,
					partial,
				};
			} else {
				yield {
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: finalBlock.thinking,
					partial,
				};
			}
		}

		// Check if we have tool calls
		if (
			partial.stopReason === "stop" &&
			partial.content.some((b) => b.type === "toolCall")
		) {
			partial.stopReason = "toolUse";
		}

		yield {
			type: "done",
			reason: partial.stopReason as "stop" | "length" | "toolUse",
			message: partial,
		};
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "AbortError") {
			partial.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: partial };
		} else if (isStreamIdleTimeoutError(error)) {
			throw error;
		} else {
			partial.stopReason = "error";
			partial.errorMessage =
				error instanceof Error ? error.message : String(error);
			yield { type: "error", reason: "error", error: partial };
		}
	}
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "SAFETY":
		case "RECITATION":
		case "OTHER":
			return "error";
		default:
			return "stop";
	}
}

/**
 * Check if Vertex AI is available (has credentials configured).
 */
export async function isVertexAvailable(): Promise<boolean> {
	try {
		const projectId =
			process.env.GOOGLE_CLOUD_PROJECT ||
			process.env.VERTEX_PROJECT_ID ||
			process.env.GCLOUD_PROJECT;

		if (!projectId) {
			return false;
		}

		const auth = await getAuthClient();
		const token = await auth.getAccessToken();
		return !!token;
	} catch {
		return false;
	}
}
