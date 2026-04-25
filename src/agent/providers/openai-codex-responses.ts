import { arch, platform, release } from "node:os";
import { extractOpenAICodexAccountId } from "../../oauth/openai-codex.js";
import { fetchWithRetry } from "../../providers/network-config.js";
import {
	createTimeoutReader,
	isStreamIdleTimeoutError,
} from "../../providers/stream-idle-timeout.js";
import { createLogger } from "../../utils/logger.js";
import { mapThinkingLevelToOpenAIEffort } from "../thinking-level-mapper.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	ReasoningEffort,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types.js";
import type { OpenAIOptions } from "./openai-shared.js";
import { filterResponsesApiTools } from "./openai-shared.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { createToolArgumentNormalizer, isRecord } from "./tool-arguments.js";
import { transformMessages } from "./transform-messages.js";

const logger = createLogger("agent:providers:openai-codex");
const toolArgumentNormalizer = createToolArgumentNormalizer({
	logger,
	providerLabel: "OpenAI Codex",
});

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ORIGINATOR = "codex_cli_rs";

type ResponsesInputContent =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; detail: "auto" };

type ResponsesInputItem =
	| {
			role: "user" | "developer" | "system";
			content: string | ResponsesInputContent[];
	  }
	| {
			type: "message";
			role: "assistant";
			content: Array<{
				type: "output_text";
				text: string;
				annotations: unknown[];
			}>;
			status: "completed";
			id: string;
	  }
	| {
			type: "function_call";
			id: string;
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: "function_call_output";
			call_id: string;
			output: string;
	  }
	| Record<string, unknown>;

interface CodexRequestBody {
	model: string;
	store: false;
	stream: true;
	instructions?: string;
	input: ResponsesInputItem[];
	text: { verbosity: "low" | "medium" | "high" };
	include: string[];
	prompt_cache_key?: string;
	tool_choice?: "auto";
	parallel_tool_calls?: true;
	tools?: Array<{
		type: "function";
		name: string;
		description: string;
		parameters: unknown;
		strict: null;
	}>;
	max_output_tokens?: number;
	temperature?: number;
	reasoning?: {
		effort: "low" | "medium" | "high" | "xhigh";
		summary?: "auto" | "detailed" | "concise";
	};
}

type CodexResponseStatus =
	| "completed"
	| "incomplete"
	| "failed"
	| "cancelled"
	| "in_progress"
	| "queued";

interface CodexResponseEvent {
	type?: string;
	item?: Record<string, unknown>;
	delta?: string;
	part?: Record<string, unknown>;
	response?: {
		status?: CodexResponseStatus;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			input_tokens_details?: { cached_tokens?: number };
		};
		error?: { message?: string };
	};
	code?: string;
	message?: string;
}

type CurrentBlock =
	| ThinkingContent
	| TextContent
	| (ToolCall & { partialJson: string });

export async function* streamOpenAICodexResponses(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAIOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	if (!options.apiKey) {
		throw new Error("OpenAI Codex OAuth token is required");
	}

	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
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

	try {
		const token = options.apiKey;
		const accountId = resolveAccountId(token, options.headers);
		const body = buildRequestBody(model, context, options);
		const headers = buildHeaders(
			model.headers,
			options.headers,
			accountId,
			token,
			options.sessionId,
		);
		const response = await fetchWithRetry(
			resolveCodexUrl(model.baseUrl),
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options.signal,
			},
			model.provider,
			{ modelId: model.id },
		);

		if (!response.ok) {
			const info = await parseErrorResponse(response);
			throw new Error(info.friendlyMessage || info.message);
		}
		if (!response.body) {
			throw new Error("OpenAI Codex response body is null");
		}

		yield { type: "start", partial: output };
		yield* processEvents(parseSSE(response, model, options), output, model);
		yield {
			type: "done",
			reason: output.stopReason as "stop" | "length" | "toolUse",
			message: output,
		};
	} catch (error: unknown) {
		if (isStreamIdleTimeoutError(error)) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			output.stopReason = "aborted";
			yield { type: "error", reason: "aborted", error: output };
			return;
		}
		output.stopReason = "error";
		output.errorMessage =
			error instanceof Error ? error.message : String(error);
		yield { type: "error", reason: "error", error: output };
	}
}

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAIOptions,
): CodexRequestBody {
	const body: CodexRequestBody = {
		model: model.id,
		store: false,
		stream: true,
		input: buildInput(context, model),
		text: { verbosity: "medium" },
		include: ["reasoning.encrypted_content"],
	};

	if (context.systemPrompt) {
		body.instructions = sanitizeSurrogates(context.systemPrompt);
	}
	if (options.sessionId) {
		body.prompt_cache_key = options.sessionId;
	}
	if (options.maxTokens) {
		body.max_output_tokens = options.maxTokens;
	}
	if (options.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	const validTools = context.tools
		? filterResponsesApiTools(context.tools).filter(
				(tool) => !("deferApiDefinition" in tool && tool.deferApiDefinition),
			)
		: [];
	if (validTools.length > 0) {
		body.tool_choice = "auto";
		body.parallel_tool_calls = true;
		body.tools = validTools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: null,
		}));
	}

	const summary = options.reasoningSummary;
	const shouldIncludeSummary = summary !== undefined && summary !== null;
	if (model.reasoning && (options.reasoningEffort || shouldIncludeSummary)) {
		const effort = clampReasoningEffort(
			model.id,
			mapCodexReasoningEffort(options.reasoningEffort) ?? "medium",
		);
		body.reasoning = shouldIncludeSummary ? { effort, summary } : { effort };
	}

	if (options.requestBody) {
		Object.assign(body, options.requestBody);
	}
	return body;
}

function buildInput(
	context: Context,
	model: Model<"openai-codex-responses">,
): ResponsesInputItem[] {
	const input: ResponsesInputItem[] = [];
	const transformedMessages = transformMessages(context.messages, model);
	let msgIndex = 0;

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const content: ResponsesInputContent[] = [];
			if (typeof msg.content === "string") {
				content.push({
					type: "input_text",
					text: sanitizeSurrogates(msg.content),
				});
			} else {
				for (const block of msg.content) {
					if (block.type === "text") {
						content.push({
							type: "input_text",
							text: sanitizeSurrogates(block.text),
						});
					} else if (block.type === "image" && model.input.includes("image")) {
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
			const isIncomplete =
				msg.stopReason === "error" || msg.stopReason === "aborted";
			const hasToolCalls = msg.content.some(
				(block) => block.type === "toolCall",
			);
			const canIncludeReasoning = hasToolCalls && !isIncomplete;

			for (const block of msg.content) {
				if (block.type === "text") {
					let msgId = block.textSignature;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
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
						id: msgId,
					});
				} else if (
					block.type === "thinking" &&
					canIncludeReasoning &&
					block.thinkingSignature
				) {
					const parsed = safeJsonRecord(block.thinkingSignature);
					if (parsed) {
						input.push(parsed);
					}
				} else if (block.type === "toolCall" && !isIncomplete) {
					const { callId, itemId } = splitToolCallId(block.id);
					input.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");
			const hasImages = msg.content.some((content) => content.type === "image");
			const outputText =
				textResult || (hasImages ? "(see attached image)" : "(empty result)");
			input.push({
				type: "function_call_output",
				call_id: splitToolCallId(msg.toolCallId).callId,
				output: sanitizeSurrogates(outputText),
			});

			if (hasImages && model.input.includes("image")) {
				const imageContent: ResponsesInputContent[] = [
					{
						type: "input_text",
						text: "Attached image(s) from tool result:",
					},
				];
				for (const block of msg.content) {
					if (block.type === "image") {
						imageContent.push({
							type: "input_image",
							image_url: `data:${block.mimeType};base64,${block.data}`,
							detail: "auto",
						});
					}
				}
				input.push({ role: "user", content: imageContent });
			}
		}
		msgIndex++;
	}

	return input;
}

async function* processEvents(
	events: AsyncIterable<CodexResponseEvent>,
	output: AssistantMessage,
	model: Model<"openai-codex-responses">,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	let currentItem: Record<string, unknown> | null = null;
	let currentBlock: CurrentBlock | null = null;
	const blockIndex = () => output.content.length - 1;

	for await (const rawEvent of events) {
		const event = normalizeCodexEvent(rawEvent);
		if (!event.type) continue;

		if (event.type === "error") {
			throw new Error(
				`OpenAI Codex error: ${event.message || event.code || "unknown error"}`,
			);
		}
		if (event.type === "response.failed") {
			throw new Error(
				event.response?.error?.message || "OpenAI Codex response failed",
			);
		}

		if (event.type === "response.output_item.added" && event.item) {
			const itemType = stringValue(event.item.type);
			currentItem = event.item;
			if (itemType === "reasoning") {
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				yield {
					type: "thinking_start",
					contentIndex: blockIndex(),
					partial: output,
				};
			} else if (itemType === "message") {
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				yield {
					type: "text_start",
					contentIndex: blockIndex(),
					partial: output,
				};
			} else if (itemType === "function_call") {
				const callId =
					stringValue(event.item.call_id) ||
					stringValue(event.item.id) ||
					createLocalId();
				const itemId = stringValue(event.item.id) || callId;
				const name = stringValue(event.item.name) || "tool";
				const rawArguments = stringValue(event.item.arguments) ?? "";
				const normalized = toolArgumentNormalizer.normalizeWithPartialJson(
					rawArguments,
					{ callId, name, stage: "start" },
					{ expectString: true },
				);
				currentBlock = {
					type: "toolCall",
					id: `${callId}|${itemId}`,
					name,
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
			continue;
		}

		if (event.type === "response.reasoning_summary_text.delta") {
			if (currentBlock?.type === "thinking" && event.delta) {
				currentBlock.thinking += event.delta;
				yield {
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				};
			}
			continue;
		}

		if (event.type === "response.output_text.delta") {
			if (currentBlock?.type === "text" && event.delta) {
				currentBlock.text += sanitizeSurrogates(event.delta);
				yield {
					type: "text_delta",
					contentIndex: blockIndex(),
					delta: sanitizeSurrogates(event.delta),
					partial: output,
				};
			}
			continue;
		}

		if (event.type === "response.function_call_arguments.delta") {
			if (currentItem && currentBlock?.type === "toolCall" && event.delta) {
				currentBlock.partialJson += event.delta;
				currentBlock.arguments = toolArgumentNormalizer.parseFromString(
					currentBlock.partialJson,
					{
						callId: stringValue(currentItem.call_id) || currentBlock.id,
						name: currentBlock.name,
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
			continue;
		}

		if (event.type === "response.output_item.done" && event.item) {
			const itemType = stringValue(event.item.type);
			if (itemType === "reasoning" && currentBlock?.type === "thinking") {
				const summaryText = getReasoningSummaryText(event.item);
				if (!currentBlock.thinking && summaryText) {
					currentBlock.thinking = summaryText;
				}
				currentBlock.thinkingSignature = JSON.stringify(event.item);
				yield {
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				};
			} else if (itemType === "message" && currentBlock?.type === "text") {
				currentBlock.text = getMessageText(event.item) || currentBlock.text;
				yield {
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				};
			} else if (itemType === "function_call") {
				const callId = stringValue(event.item.call_id) || createLocalId();
				const itemId = stringValue(event.item.id) || callId;
				const name =
					stringValue(event.item.name) ||
					(currentBlock?.type === "toolCall" ? currentBlock.name : undefined) ||
					"tool";
				const rawArguments = stringValue(event.item.arguments) ?? "{}";
				const toolCall: ToolCall = {
					type: "toolCall",
					id: `${callId}|${itemId}`,
					name,
					arguments: toolArgumentNormalizer.parseFromString(
						rawArguments,
						{ callId, name, stage: "done" },
						{ logInvalid: true },
					),
				};
				if (currentBlock?.type === "toolCall") {
					currentBlock.arguments = toolCall.arguments;
				}
				yield {
					type: "toolcall_end",
					contentIndex: blockIndex(),
					toolCall,
					partial: output,
				};
			}
			currentItem = null;
			currentBlock = null;
			continue;
		}

		if (event.type === "response.completed") {
			if (event.response?.usage) {
				applyUsage(output.usage, event.response.usage, model);
			}
			const stopReason = mapStopReason(event.response?.status);
			if (stopReason === "error") {
				throw new Error(
					event.response?.error?.message || "OpenAI Codex response failed",
				);
			}
			output.stopReason = stopReason;
			if (
				output.content.some((block) => block.type === "toolCall") &&
				output.stopReason === "stop"
			) {
				output.stopReason = "toolUse";
			}
		}
	}
}

async function* parseSSE(
	response: Response,
	model: Model<"openai-codex-responses">,
	options: OpenAIOptions,
): AsyncGenerator<CodexResponseEvent, void, unknown> {
	const rawReader = response.body?.getReader();
	if (!rawReader) return;
	const reader = createTimeoutReader(rawReader, {
		provider: model.provider,
		signal: options.signal,
	});
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			yield* drainSseBuffer(buffer, (nextBuffer) => {
				buffer = nextBuffer;
			});
		}
		if (buffer.trim()) {
			yield* parseSseChunk(buffer);
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Ignore cleanup errors.
		}
		reader.releaseLock();
	}
}

async function* drainSseBuffer(
	buffer: string,
	setBuffer: (buffer: string) => void,
): AsyncGenerator<CodexResponseEvent, void, unknown> {
	let nextBuffer = buffer;
	let index = nextBuffer.indexOf("\n\n");
	while (index !== -1) {
		const chunk = nextBuffer.slice(0, index);
		nextBuffer = nextBuffer.slice(index + 2);
		yield* parseSseChunk(chunk);
		index = nextBuffer.indexOf("\n\n");
	}
	setBuffer(nextBuffer);
}

async function* parseSseChunk(
	chunk: string,
): AsyncGenerator<CodexResponseEvent, void, unknown> {
	const dataLines = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	if (dataLines.length === 0) return;
	const data = dataLines.join("\n").trim();
	if (!data || data === "[DONE]") return;
	try {
		yield JSON.parse(data) as CodexResponseEvent;
	} catch {
		logger.debug("Ignoring unparsable OpenAI Codex SSE event");
	}
}

function normalizeCodexEvent(event: CodexResponseEvent): CodexResponseEvent {
	if (
		event.type === "response.done" ||
		event.type === "response.incomplete" ||
		event.type === "response.completed"
	) {
		return {
			...event,
			type: "response.completed",
			response: {
				...event.response,
				status: normalizeStatus(event.response?.status),
			},
		};
	}
	return event;
}

function normalizeStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	if (
		status === "completed" ||
		status === "incomplete" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "in_progress" ||
		status === "queued"
	) {
		return status;
	}
	return undefined;
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw =
		baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/u, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function buildHeaders(
	modelHeaders: Record<string, string> | undefined,
	optionHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = new Headers(modelHeaders);
	for (const [key, value] of Object.entries(optionHeaders ?? {})) {
		headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", ORIGINATOR);
	headers.set("User-Agent", `maestro (${platform()} ${release()}; ${arch()})`);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}

function resolveAccountId(
	token: string,
	headers: Record<string, string> | undefined,
): string {
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (key.toLowerCase() === "chatgpt-account-id" && value.trim()) {
			return value.trim();
		}
	}
	const accountId =
		process.env.OPENAI_CODEX_ACCOUNT_ID?.trim() ??
		process.env.CHATGPT_ACCOUNT_ID?.trim() ??
		extractOpenAICodexAccountId(token);
	if (!accountId) {
		throw new Error(
			"OpenAI Codex account id is required. Log in with /login openai-codex or set OPENAI_CODEX_ACCOUNT_ID.",
		);
	}
	return accountId;
}

function mapCodexReasoningEffort(
	effort: ReasoningEffort | undefined,
): "low" | "medium" | "high" | "xhigh" | undefined {
	if (!effort) return undefined;
	if (effort === "ultra") return "xhigh";
	return mapThinkingLevelToOpenAIEffort(effort);
}

function clampReasoningEffort(
	modelId: string,
	effort: "low" | "medium" | "high" | "xhigh",
): "low" | "medium" | "high" | "xhigh" {
	const id = modelId.includes("/")
		? (modelId.split("/").pop() ?? modelId)
		: modelId;
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") {
		return effort === "high" || effort === "xhigh" ? "high" : "medium";
	}
	return effort;
}

function applyUsage(
	usage: Usage,
	responseUsage: NonNullable<CodexResponseEvent["response"]>["usage"],
	model: Model<"openai-codex-responses">,
): void {
	const cachedTokens = responseUsage?.input_tokens_details?.cached_tokens ?? 0;
	usage.input = Math.max(0, (responseUsage?.input_tokens ?? 0) - cachedTokens);
	usage.output = responseUsage?.output_tokens ?? 0;
	usage.cacheRead = cachedTokens;
	usage.cacheWrite = 0;
	usage.cost = {
		input: (usage.input * model.cost.input) / 1_000_000,
		output: (usage.output * model.cost.output) / 1_000_000,
		cacheRead: (usage.cacheRead * model.cost.cacheRead) / 1_000_000,
		cacheWrite: 0,
		total: 0,
	};
	usage.cost.total =
		usage.cost.input + usage.cost.output + usage.cost.cacheRead;
}

async function parseErrorResponse(
	response: Response,
): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: {
				code?: string;
				type?: string;
				message?: string;
				plan_type?: string;
				resets_at?: number;
			};
		};
		const error = parsed.error;
		if (error) {
			const code = error.code || error.type || "";
			if (
				/usage_limit_reached|usage_not_included|rate_limit_exceeded/iu.test(
					code,
				) ||
				response.status === 429
			) {
				const plan = error.plan_type
					? ` (${error.plan_type.toLowerCase()} plan)`
					: "";
				const minutes = error.resets_at
					? Math.max(
							0,
							Math.round((error.resets_at * 1000 - Date.now()) / 60_000),
						)
					: undefined;
				const retryText =
					minutes !== undefined ? ` Try again in about ${minutes} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${retryText}`;
			}
			message = error.message || friendlyMessage || message;
		}
	} catch {
		// Keep raw message.
	}

	return { message, friendlyMessage };
}

function mapStopReason(
	status: CodexResponseStatus | undefined,
): "stop" | "length" | "toolUse" | "error" {
	switch (status) {
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "completed":
		case "in_progress":
		case "queued":
		case undefined:
			return "stop";
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function getMessageText(item: Record<string, unknown>): string {
	const content = Array.isArray(item.content) ? item.content : [];
	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (part.type === "output_text" && typeof part.text === "string") {
				return sanitizeSurrogates(part.text);
			}
			if (typeof part.refusal === "string") {
				return sanitizeSurrogates(part.refusal);
			}
			return "";
		})
		.join("");
}

function getReasoningSummaryText(item: Record<string, unknown>): string {
	const summary = Array.isArray(item.summary) ? item.summary : [];
	return summary
		.map((part) =>
			isRecord(part) && typeof part.text === "string" ? part.text : "",
		)
		.filter(Boolean)
		.join("\n\n");
}

function safeJsonRecord(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function splitToolCallId(id: string): { callId: string; itemId: string } {
	if (id.includes("|")) {
		const [callId, itemId] = id.split("|", 2);
		return { callId: callId || id, itemId: itemId || callId || id };
	}
	return { callId: id, itemId: id };
}

function createLocalId(): string {
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 =
		Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
		Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 =
		Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
		Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
