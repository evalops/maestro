/**
 * Google Gemini CLI / Cloud Code Assist provider.
 * Uses the Cloud Code Assist API endpoint to access Gemini models via OAuth.
 */

import {
	type Content,
	FunctionCallingConfigMode,
	type FunctionDeclaration,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import { createLogger } from "../../utils/logger.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
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

export type GoogleThinkingLevel =
	| "THINKING_LEVEL_UNSPECIFIED"
	| "MINIMAL"
	| "LOW"
	| "MEDIUM"
	| "HIGH";

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: ReasoningEffort;
}

const logger = createLogger("agent:providers:google-gemini-cli");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "Google Gemini CLI",
});

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const GEMINI_CLI_HEADERS = {
	"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function extractRetryDelay(errorText: string): number | undefined {
	const durationMatch = errorText.match(
		/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i,
	);
	if (durationMatch) {
		const hours = durationMatch[1] ? Number.parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2]
			? Number.parseInt(durationMatch[2], 10)
			: 0;
		const seconds = Number.parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			if (totalMs > 0) {
				return Math.ceil(totalMs + 1000);
			}
		}
	}

	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = Number.parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = Number.parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms =
				retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return Math.ceil(ms + 1000);
		}
	}

	return undefined;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503) {
		return true;
	}
	if (status === 504) {
		return true;
	}
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable/i.test(
		errorText,
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		systemInstruction?: { parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: {
			functionCallingConfig: {
				mode: ReturnType<typeof mapToolChoice>;
			};
		};
	};
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: {
						name: string;
						args: Record<string, unknown>;
						id?: string;
					};
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	traceId?: string;
}

export async function* streamGoogleGeminiCli(
	model: Model<"google-gemini-cli">,
	context: Context,
	options: GoogleGeminiCliOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "google-gemini-cli",
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
		const apiKeyRaw = options.apiKey;
		if (!apiKeyRaw) {
			throw new Error(
				"Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.",
			);
		}

		let accessToken: string;
		let projectId: string;

		try {
			const parsed = JSON.parse(apiKeyRaw) as {
				token: string;
				projectId: string;
			};
			accessToken = parsed.token;
			projectId = parsed.projectId;
		} catch {
			throw new Error(
				"Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.",
			);
		}

		if (!accessToken || !projectId) {
			throw new Error(
				"Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.",
			);
		}

		const requestBody = buildRequest(model, context, projectId, options);
		const endpoint = model.baseUrl || DEFAULT_ENDPOINT;
		const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

		let response: Response | undefined;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			try {
				response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						...GEMINI_CLI_HEADERS,
						...(options.headers ?? {}),
					},
					body: JSON.stringify(requestBody),
					signal: options.signal,
				});

				if (response.ok) {
					break;
				}

				const errorText = await response.text();
				if (
					attempt < MAX_RETRIES &&
					isRetryableError(response.status, errorText)
				) {
					const serverDelay = extractRetryDelay(errorText);
					const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;
					await sleep(delayMs, options.signal);
					continue;
				}

				throw new Error(
					`Cloud Code Assist API error (${response.status}): ${errorText}`,
				);
			} catch (error) {
				if (error instanceof Error && error.message === "Request was aborted") {
					throw error;
				}
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < MAX_RETRIES) {
					const delayMs = BASE_DELAY_MS * 2 ** attempt;
					await sleep(delayMs, options.signal);
					continue;
				}
				throw lastError;
			}
		}

		if (!response || !response.ok) {
			throw lastError ?? new Error("Failed to get response after retries");
		}
		if (!response.body) {
			throw new Error("No response body");
		}

		let currentBlock: TextContent | ThinkingContent | null = null;
		const blockIndex = () => partial.content.length - 1;

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;

				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;

				let chunk: CloudCodeAssistResponseChunk;
				try {
					chunk = JSON.parse(jsonStr);
				} catch {
					continue;
				}

				const responseData = chunk.response;
				if (!responseData) continue;

				const candidate = responseData.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = part.thought === true;
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
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

								if (isThinking) {
									currentBlock = {
										type: "thinking",
										thinking: "",
										thinkingSignature: undefined,
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

							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = part.thoughtSignature;
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
										stage: "done",
									},
								),
								...(part.thoughtSignature
									? { thoughtSignature: part.thoughtSignature }
									: {}),
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
					partial.stopReason = mapStopReasonString(candidate.finishReason);
					if (
						partial.stopReason === "stop" &&
						partial.content.some((b) => b.type === "toolCall")
					) {
						partial.stopReason = "toolUse";
					}
				}

				if (responseData.usageMetadata) {
					partial.usage = {
						input: responseData.usageMetadata.promptTokenCount || 0,
						output:
							(responseData.usageMetadata.candidatesTokenCount || 0) +
							(responseData.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: responseData.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};

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
		}

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

		if (options.signal?.aborted) {
			throw new Error("Request was aborted");
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
		partial.stopReason = options.signal?.aborted ? "aborted" : "error";
		partial.errorMessage =
			error instanceof Error ? error.message : JSON.stringify(error);
		yield { type: "error", reason: partial.stopReason, error: partial };
	}
}

function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions,
): CloudCodeAssistRequest {
	const contents = convertMessages(model, context);

	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] =
		{};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const thinkingConfig = buildThinkingConfig(model, options.thinking);
	if (thinkingConfig) {
		generationConfig.thinkingConfig = thinkingConfig;
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	if (context.systemPrompt) {
		request.systemInstruction = {
			parts: [{ text: sanitizeSurrogates(context.systemPrompt) }],
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	if (context.tools && context.tools.length > 0) {
		request.tools = convertTools(context.tools);
		if (options.toolChoice) {
			request.toolConfig = {
				functionCallingConfig: {
					mode: mapToolChoice(options.toolChoice),
				},
			};
		}
	}

	return {
		project: projectId,
		model: model.id,
		request,
		userAgent: "composer",
		requestId: `composer-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

function buildThinkingConfig(
	model: Model<"google-gemini-cli">,
	thinking?: ReasoningEffort,
): ThinkingConfig | undefined {
	if (!thinking || !model.reasoning) return undefined;

	const config: ThinkingConfig = {
		includeThoughts: true,
	};

	if (model.id.includes("gemini-3")) {
		const level = mapReasoningToLevel(thinking);
		config.thinkingLevel = level as unknown as ThinkingConfig["thinkingLevel"];
		return config;
	}

	const budgets: Record<ReasoningEffort, number> = {
		minimal: 128,
		low: 2048,
		medium: 8192,
		high: 32768,
		ultra: 65536,
	};
	config.thinkingBudget = budgets[thinking];
	return config;
}

function mapReasoningToLevel(reasoning: ReasoningEffort): GoogleThinkingLevel {
	switch (reasoning) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
		case "ultra":
			return "HIGH";
		default:
			return "THINKING_LEVEL_UNSPECIFIED";
	}
}

function convertMessages(
	model: Model<"google-gemini-cli">,
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
				const parts = msg.content.map((item) => {
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

			for (const block of msg.content) {
				if (block.type === "text") {
					if (!block.text || block.text.trim() === "") continue;
					parts.push({ text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					if (block.thinkingSignature) {
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							thoughtSignature: block.thinkingSignature,
						});
					} else {
						parts.push({
							text: `<thinking>\n${sanitizeSurrogates(block.thinking)}\n</thinking>`,
						});
					}
				} else if (block.type === "toolCall") {
					const part = {
						functionCall: {
							id: block.id,
							name: block.name,
							args: block.arguments,
						},
						...(block.thoughtSignature
							? { thoughtSignature: block.thoughtSignature }
							: {}),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			const textContent = msg.content.filter(
				(c): c is TextContent => c.type === "text",
			);
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;
			const supportsMultimodalFunctionResponse = model.id.includes("gemini-3");
			const responseValue = hasText
				? sanitizeSurrogates(textResult)
				: hasImages
					? "(see attached image)"
					: "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const functionResponsePart: Part = {
				functionResponse: {
					id: msg.toolCallId,
					name: msg.toolName,
					response: msg.isError
						? { error: responseValue }
						: { output: responseValue },
					...(hasImages && supportsMultimodalFunctionResponse
						? { parts: imageParts }
						: {}),
				},
			};

			const lastContent = contents[contents.length - 1];
			if (
				lastContent?.role === "user" &&
				lastContent.parts?.some((p) => p.functionResponse)
			) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			if (hasImages && !supportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
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

function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}
