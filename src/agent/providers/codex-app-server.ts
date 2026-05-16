import {
	type CodexAccountReadResult,
	type CodexAppServerClientLike,
	type CodexAppServerNotification,
	type CodexAppServerRequest,
	type CodexAppServerRequestHandlerResult,
	createCodexAppServerClient,
} from "../../codex/app-server-client.js";
import {
	type CodexDynamicToolCompilation,
	compileCodexDynamicToolSpecs,
	createCodexDynamicToolNameMap,
} from "../../codex/compatibility.js";
import type {
	AgentToolResult,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	Model,
	ReasoningEffort,
	StreamOptions,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";

export interface CodexAppServerProviderOptions extends StreamOptions {
	cwd?: string;
	reasoningEffort?: ReasoningEffort;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	codexAppServerClient?: CodexAppServerClientLike;
	codexAppServerClientFactory?: () =>
		| CodexAppServerClientLike
		| Promise<CodexAppServerClientLike>;
	turnTimeoutMs?: number;
}

type ThreadStartResult = {
	thread: { id: string };
};

type TurnStartResult = {
	turn: { id: string };
};

type DynamicToolCallParams = {
	threadId: string;
	turnId: string;
	callId: string;
	namespace?: string | null;
	tool: string;
	arguments: unknown;
};

type DynamicToolCallResponse = {
	contentItems: DynamicToolCallOutputContentItem[];
	success: boolean;
};

type DynamicToolCallOutputContentItem =
	| { type: "inputText"; text: string }
	| { type: "inputImage"; imageUrl: string };

type CodexUserInput =
	| { type: "text"; text: string; text_elements: [] }
	| { type: "image"; url: string };

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_THREAD_CHILD_RUN_PREFIX = "codex-thread:";
const CODEX_COLLAB_TOOLS = new Set([
	"spawnAgent",
	"sendInput",
	"resumeAgent",
	"wait",
	"closeAgent",
]);

type CodexCollabAgentToolCallItem = {
	type: "collabAgentToolCall";
	id: string;
	tool: string;
	status: string;
	senderThreadId: string;
	receiverThreadIds: string[];
	childRunIds?: string[];
	prompt: string | null;
	model: string | null;
	reasoningEffort: string | null;
	agentsStates: Record<string, unknown>;
};

export async function* streamCodexAppServer(
	model: Model<"openai-codex-app-server">,
	context: Context,
	options: CodexAppServerProviderOptions,
): AsyncGenerator<AssistantMessageEvent, void, unknown> {
	const output = createAssistantMessage(model);
	let client = options.codexAppServerClient;
	let ownsClient = false;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeRequest: (() => void) | undefined;
	const dynamicToolCompilation = buildDynamicToolSpecs(
		context,
		options.executeDynamicTool,
	);
	const dynamicTools = dynamicToolCompilation.specs;
	const dynamicToolNameMap = createCodexDynamicToolNameMap(
		dynamicToolCompilation.bindings,
	);

	try {
		if (!client) {
			client = options.codexAppServerClientFactory
				? await options.codexAppServerClientFactory()
				: createCodexAppServerClient();
			ownsClient = true;
		}

		await client.initialize(
			dynamicTools.length > 0 ? { experimentalApi: true } : undefined,
		);

		const account = await client.readAccount(false);
		assertCodexAccount(account);

		const notifications: CodexAppServerNotification[] = [];
		const providerToolEvents: AssistantMessageEvent[] = [];
		let wake: (() => void) | undefined;
		const wakeStream = () => {
			wake?.();
		};
		unsubscribe = client.onNotification((notification) => {
			notifications.push(notification);
			wakeStream();
		});

		const cwd = options.cwd ?? process.cwd();
		const threadStartParams: Record<string, unknown> = {
			model: model.id,
			cwd,
			ephemeral: true,
			serviceName: "maestro",
			baseInstructions: context.systemPrompt || undefined,
		};
		if (dynamicTools.length > 0) {
			threadStartParams.dynamicTools = dynamicTools;
		}
		const threadStart = await client.request<ThreadStartResult>(
			"thread/start",
			threadStartParams,
		);
		const threadId = readNestedId(threadStart, "thread", "thread/start");
		let turnId: string | undefined;
		if (dynamicTools.length > 0) {
			unsubscribeRequest = client.onRequest((request) =>
				handleDynamicToolRequest(request, {
					threadId,
					turnId,
					executeDynamicTool: options.executeDynamicTool,
					dynamicToolNameMap,
					partial: output,
					emitToolEvent: (event) => {
						providerToolEvents.push(event);
						wakeStream();
					},
				}),
			);
		}
		const turnStart = await client.request<TurnStartResult>("turn/start", {
			threadId,
			input: buildCodexUserInput(context),
			cwd,
			model: model.id,
			effort: mapCodexReasoningEffort(options.reasoningEffort),
			summary: mapCodexReasoningSummary(options.reasoningSummary),
		});
		turnId = readNestedId(turnStart, "turn", "turn/start");

		yield { type: "start", partial: output };

		let textIndex: number | null = null;
		let completed = false;
		const startedProviderToolCalls = new Set<string>();
		while (!completed) {
			const streamItem = await nextCodexStreamItem(
				notifications,
				providerToolEvents,
				() => wake,
				(nextWake) => {
					wake = nextWake;
				},
				options.signal,
				options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
			);
			if (streamItem.type === "providerToolEvent") {
				yield streamItem.event;
				continue;
			}
			const notification = streamItem.notification;

			if (notification.method === "item/agentMessage/delta") {
				const params = notification.params;
				if (
					isRecord(params) &&
					params.threadId === threadId &&
					params.turnId === turnId &&
					typeof params.delta === "string"
				) {
					textIndex = ensureTextBlock(output, textIndex);
					if (output.content[textIndex]?.type === "text") {
						const block = output.content[textIndex] as TextContent;
						const wasEmpty = block.text.length === 0;
						block.text += params.delta;
						if (wasEmpty) {
							yield {
								type: "text_start",
								contentIndex: textIndex,
								partial: output,
							};
						}
						yield {
							type: "text_delta",
							contentIndex: textIndex,
							delta: params.delta,
							partial: output,
						};
					}
				}
				continue;
			}

			if (notification.method === "item/started") {
				const params = notification.params;
				if (
					isRecord(params) &&
					params.threadId === threadId &&
					params.turnId === turnId &&
					isCodexCollabAgentToolCallItem(params.item)
				) {
					startedProviderToolCalls.add(params.item.id);
					yield codexCollabToolStartEvent(params.item, output, {
						threadId,
						turnId,
					});
				}
				continue;
			}

			if (notification.method === "item/completed") {
				const params = notification.params;
				if (
					isRecord(params) &&
					params.threadId === threadId &&
					params.turnId === turnId &&
					isRecord(params.item) &&
					params.item.type === "agentMessage" &&
					typeof params.item.text === "string"
				) {
					textIndex = ensureTextBlock(output, textIndex);
					const block = output.content[textIndex] as TextContent;
					if (params.item.text.length > block.text.length) {
						const delta = params.item.text.slice(block.text.length);
						const wasEmpty = block.text.length === 0;
						block.text = params.item.text;
						if (wasEmpty) {
							yield {
								type: "text_start",
								contentIndex: textIndex,
								partial: output,
							};
						}
						yield {
							type: "text_delta",
							contentIndex: textIndex,
							delta,
							partial: output,
						};
					}
				}
				if (
					isRecord(params) &&
					params.threadId === threadId &&
					params.turnId === turnId &&
					isCodexCollabAgentToolCallItem(params.item)
				) {
					if (!startedProviderToolCalls.has(params.item.id)) {
						startedProviderToolCalls.add(params.item.id);
						yield codexCollabToolStartEvent(params.item, output, {
							threadId,
							turnId,
						});
					}
					yield codexCollabToolEndEvent(params.item, output, {
						threadId,
						turnId,
					});
				}
				continue;
			}

			if (notification.method === "thread/tokenUsage/updated") {
				const params = notification.params;
				if (
					isRecord(params) &&
					params.threadId === threadId &&
					params.turnId === turnId
				) {
					applyCodexTokenUsage(output.usage, params.tokenUsage, model);
				}
				continue;
			}

			if (notification.method === "turn/completed") {
				const params = notification.params;
				if (!isRecord(params) || params.threadId !== threadId) {
					continue;
				}
				const turn = params.turn;
				if (!isRecord(turn) || turn.id !== turnId) {
					continue;
				}
				if (turn.status === "failed") {
					throw new Error(readTurnErrorMessage(turn));
				}
				if (turn.status === "interrupted") {
					throw createAbortError("Codex app-server turn was interrupted");
				}
				completed = true;
			}
		}

		while (providerToolEvents.length > 0) {
			const providerToolEvent = providerToolEvents.shift();
			if (providerToolEvent) {
				yield providerToolEvent;
			}
		}

		if (textIndex !== null && output.content[textIndex]?.type === "text") {
			yield {
				type: "text_end",
				contentIndex: textIndex,
				content: (output.content[textIndex] as TextContent).text,
				partial: output,
			};
		}
		output.stopReason = "stop";
		yield { type: "done", reason: "stop", message: output };
	} catch (error: unknown) {
		if (isAbortError(error)) {
			output.stopReason = "aborted";
			output.errorMessage = error instanceof Error ? error.message : "Aborted";
			yield { type: "error", reason: "aborted", error: output };
			return;
		}
		output.stopReason = "error";
		output.errorMessage =
			error instanceof Error ? error.message : String(error);
		yield { type: "error", reason: "error", error: output };
	} finally {
		unsubscribe?.();
		unsubscribeRequest?.();
		if (ownsClient) {
			client?.close();
		}
	}
}

function createAssistantMessage(
	model: Model<"openai-codex-app-server">,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-app-server",
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function applyCodexTokenUsage(
	usage: Usage,
	tokenUsage: unknown,
	model: Model<"openai-codex-app-server">,
): void {
	if (!isRecord(tokenUsage) || !isRecord(tokenUsage.last)) {
		return;
	}
	const cacheRead = readNumber(tokenUsage.last.cachedInputTokens);
	const input = Math.max(
		0,
		readNumber(tokenUsage.last.inputTokens) - cacheRead,
	);
	const output = readNumber(tokenUsage.last.outputTokens);
	const cacheWrite = 0;
	usage.input = input;
	usage.output = output;
	usage.cacheRead = cacheRead;
	usage.cacheWrite = cacheWrite;
	const inputCost = (input * model.cost.input) / 1_000_000;
	const outputCost = (output * model.cost.output) / 1_000_000;
	const cacheReadCost = (cacheRead * model.cost.cacheRead) / 1_000_000;
	const cacheWriteCost = (cacheWrite * model.cost.cacheWrite) / 1_000_000;
	usage.cost = {
		input: inputCost,
		output: outputCost,
		cacheRead: cacheReadCost,
		cacheWrite: cacheWriteCost,
		total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
	};
}

function isCodexCollabAgentToolCallItem(
	value: unknown,
): value is CodexCollabAgentToolCallItem {
	if (!isRecord(value) || value.type !== "collabAgentToolCall") {
		return false;
	}
	if (
		typeof value.id !== "string" ||
		typeof value.tool !== "string" ||
		!CODEX_COLLAB_TOOLS.has(value.tool) ||
		typeof value.status !== "string" ||
		typeof value.senderThreadId !== "string" ||
		!Array.isArray(value.receiverThreadIds) ||
		!value.receiverThreadIds.every((id) => typeof id === "string") ||
		(value.childRunIds !== undefined &&
			(!Array.isArray(value.childRunIds) ||
				!value.childRunIds.every((id) => typeof id === "string")))
	) {
		return false;
	}
	return (
		(value.prompt === null || typeof value.prompt === "string") &&
		(value.model === null || typeof value.model === "string") &&
		(value.reasoningEffort === null ||
			typeof value.reasoningEffort === "string") &&
		isRecord(value.agentsStates)
	);
}

function codexCollabToolStartEvent(
	item: CodexCollabAgentToolCallItem,
	output: AssistantMessage,
	scope: { threadId: string; turnId: string },
): AssistantMessageEvent {
	const toolName = codexCollabToolName(item.tool);
	return {
		type: "provider_tool_execution_start",
		toolCallId: item.id,
		toolName,
		displayName: codexCollabDisplayName(item.tool),
		summaryLabel: codexCollabSummaryLabel(item),
		args: codexCollabArgs(item, scope),
		partial: output,
	};
}

function codexCollabToolEndEvent(
	item: CodexCollabAgentToolCallItem,
	output: AssistantMessage,
	scope: { threadId: string; turnId: string },
): AssistantMessageEvent {
	const toolName = codexCollabToolName(item.tool);
	const isError = item.status === "failed";
	const details = codexCollabArgs(item, scope);
	return {
		type: "provider_tool_execution_end",
		toolCallId: item.id,
		toolName,
		displayName: codexCollabDisplayName(item.tool),
		summaryLabel: codexCollabSummaryLabel(item),
		result: {
			role: "toolResult",
			toolCallId: item.id,
			toolName,
			content: [
				{
					type: "text",
					text: `${codexCollabDisplayName(item.tool)} ${isError ? "failed" : "completed"}.`,
				},
			],
			details,
			isError,
			timestamp: Date.now(),
		},
		isError,
		partial: output,
	};
}

function codexCollabArgs(
	item: CodexCollabAgentToolCallItem,
	scope: { threadId: string; turnId: string },
): Record<string, unknown> {
	return {
		codexTool: item.tool,
		status: item.status,
		threadId: scope.threadId,
		turnId: scope.turnId,
		senderThreadId: item.senderThreadId,
		receiverThreadIds: item.receiverThreadIds,
		childRunIds: codexCollabChildRunIds(item),
		prompt: item.prompt,
		model: item.model,
		reasoningEffort: item.reasoningEffort,
		agentsStates: item.agentsStates,
	};
}

function codexCollabChildRunIds(item: CodexCollabAgentToolCallItem): string[] {
	if (item.childRunIds && item.childRunIds.length > 0) {
		return item.childRunIds;
	}
	return item.receiverThreadIds.map(
		(threadId) => `${CODEX_THREAD_CHILD_RUN_PREFIX}${threadId}`,
	);
}

function codexCollabToolName(tool: string): string {
	return `codex.subagent.${tool}`;
}

function codexCollabDisplayName(tool: string): string {
	return `Codex subagent: ${codexCollabHumanTool(tool)}`;
}

function codexCollabSummaryLabel(item: CodexCollabAgentToolCallItem): string {
	const targetCount = item.receiverThreadIds.length;
	if (targetCount === 0) {
		return codexCollabHumanTool(item.tool);
	}
	const targetLabel = targetCount === 1 ? "1 agent" : `${targetCount} agents`;
	return `${codexCollabHumanTool(item.tool)} ${targetLabel}`;
}

function codexCollabHumanTool(tool: string): string {
	switch (tool) {
		case "spawnAgent":
			return "spawn agent";
		case "sendInput":
			return "send input";
		case "resumeAgent":
			return "resume agent";
		case "wait":
			return "wait";
		case "closeAgent":
			return "close agent";
		default:
			return tool;
	}
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildDynamicToolSpecs(
	context: Context,
	executeDynamicTool: StreamOptions["executeDynamicTool"],
): CodexDynamicToolCompilation {
	if (!executeDynamicTool) {
		return { specs: [], bindings: [], diagnostics: [] };
	}
	return compileCodexDynamicToolSpecs(context.tools ?? []);
}

async function handleDynamicToolRequest(
	request: CodexAppServerRequest,
	options: {
		threadId: string;
		turnId?: string;
		executeDynamicTool?: StreamOptions["executeDynamicTool"];
		dynamicToolNameMap?: ReadonlyMap<string, string>;
		partial: AssistantMessage;
		emitToolEvent?: (event: AssistantMessageEvent) => void;
	},
): Promise<CodexAppServerRequestHandlerResult> {
	if (request.method !== "item/tool/call") {
		return { handled: false };
	}

	const params = parseDynamicToolCallParams(request.params);
	if (!params) {
		return {
			handled: true,
			error: {
				code: -32602,
				message: "Invalid Codex app-server dynamic tool call params",
			},
		};
	}
	if (
		params.threadId !== options.threadId ||
		(options.turnId && params.turnId !== options.turnId)
	) {
		return { handled: false };
	}

	const originalToolName =
		options.dynamicToolNameMap?.get(params.tool) ?? params.tool;
	options.emitToolEvent?.(
		codexDynamicToolStartEvent(params, originalToolName, options.partial),
	);

	if (!options.executeDynamicTool) {
		const result = dynamicToolFailureResult(
			"Maestro dynamic tool execution is unavailable",
		);
		options.emitToolEvent?.(
			codexDynamicToolEndEvent(
				params,
				originalToolName,
				result,
				options.partial,
			),
		);
		return {
			handled: true,
			result: agentToolResultToDynamicToolResponse(result),
		};
	}

	try {
		const result = await options.executeDynamicTool({
			type: "toolCall",
			id: params.callId,
			name: originalToolName,
			arguments: isRecord(params.arguments) ? params.arguments : {},
		});
		options.emitToolEvent?.(
			codexDynamicToolEndEvent(
				params,
				originalToolName,
				result,
				options.partial,
			),
		);
		return {
			handled: true,
			result: agentToolResultToDynamicToolResponse(result),
		};
	} catch (error: unknown) {
		const result = dynamicToolFailureResult(formatErrorMessage(error));
		options.emitToolEvent?.(
			codexDynamicToolEndEvent(
				params,
				originalToolName,
				result,
				options.partial,
			),
		);
		return {
			handled: true,
			result: agentToolResultToDynamicToolResponse(result),
		};
	}
}

function codexDynamicToolStartEvent(
	params: DynamicToolCallParams,
	toolName: string,
	partial: AssistantMessage,
): AssistantMessageEvent {
	return {
		type: "provider_tool_execution_start",
		toolCallId: params.callId,
		toolName,
		displayName: codexDynamicToolDisplayName(toolName),
		summaryLabel: toolName,
		args: codexDynamicToolArgs(params, toolName),
		partial,
	};
}

function codexDynamicToolEndEvent(
	params: DynamicToolCallParams,
	toolName: string,
	result: AgentToolResult,
	partial: AssistantMessage,
): AssistantMessageEvent {
	const isError = result.isError === true;
	return {
		type: "provider_tool_execution_end",
		toolCallId: params.callId,
		toolName,
		displayName: codexDynamicToolDisplayName(toolName),
		summaryLabel: toolName,
		result: {
			role: "toolResult",
			toolCallId: params.callId,
			toolName,
			content: result.content,
			details: result.details,
			isError,
			timestamp: Date.now(),
		},
		isError,
		partial,
	};
}

function codexDynamicToolDisplayName(toolName: string): string {
	return `Codex dynamic tool: ${toolName}`;
}

function codexDynamicToolArgs(
	params: DynamicToolCallParams,
	toolName: string,
): Record<string, unknown> {
	return {
		codexTool: params.tool,
		toolName,
		namespace: params.namespace ?? null,
		threadId: params.threadId,
		turnId: params.turnId,
		callId: params.callId,
		arguments: isRecord(params.arguments) ? params.arguments : {},
	};
}

function dynamicToolFailureResult(message: string): AgentToolResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
	};
}

function parseDynamicToolCallParams(
	value: unknown,
): DynamicToolCallParams | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		typeof value.threadId !== "string" ||
		typeof value.turnId !== "string" ||
		typeof value.callId !== "string" ||
		typeof value.tool !== "string"
	) {
		return null;
	}
	return {
		threadId: value.threadId,
		turnId: value.turnId,
		callId: value.callId,
		namespace:
			typeof value.namespace === "string" || value.namespace === null
				? value.namespace
				: undefined,
		tool: value.tool,
		arguments: value.arguments,
	};
}

function agentToolResultToDynamicToolResponse(
	result: AgentToolResult,
): DynamicToolCallResponse {
	const contentItems: DynamicToolCallOutputContentItem[] = [];
	for (const item of result.content) {
		if (item.type === "text") {
			contentItems.push({ type: "inputText", text: item.text });
			continue;
		}
		if (item.type === "image") {
			contentItems.push({
				type: "inputImage",
				imageUrl: `data:${item.mimeType};base64,${item.data}`,
			});
		}
	}
	return {
		contentItems:
			contentItems.length > 0
				? contentItems
				: [{ type: "inputText", text: "" }],
		success: !result.isError,
	};
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertCodexAccount(account: CodexAccountReadResult): void {
	if (account.account) {
		return;
	}
	throw new Error(
		'OpenAI Codex is not signed in. Run "maestro codex login" to sign in with ChatGPT.',
	);
}

function readNestedId(
	result: unknown,
	property: "thread" | "turn",
	method: string,
): string {
	if (!isRecord(result) || !isRecord(result[property])) {
		throw new Error(`Codex app-server ${method} returned an invalid response`);
	}
	const id = result[property].id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`Codex app-server ${method} did not return an id`);
	}
	return id;
}

function ensureTextBlock(
	output: AssistantMessage,
	currentIndex: number | null,
): number {
	if (
		currentIndex !== null &&
		output.content[currentIndex] &&
		output.content[currentIndex].type === "text"
	) {
		return currentIndex;
	}
	const nextIndex = output.content.length;
	output.content.push({ type: "text", text: "" });
	return nextIndex;
}

function formatContextForCodex(context: Context): string {
	const lines: string[] = [];
	for (const message of context.messages) {
		const text = messageToText(message);
		if (!text.trim()) {
			continue;
		}
		lines.push(`${message.role}:\n${text}`);
	}
	return sanitizeSurrogates(lines.join("\n\n"));
}

function buildCodexUserInput(context: Context): CodexUserInput[] {
	const prompt = formatContextForCodex(context);
	const input: CodexUserInput[] = [];
	if (prompt.trim()) {
		input.push({ type: "text", text: prompt, text_elements: [] });
	}
	for (const image of extractUserImages(context)) {
		input.push({ type: "image", url: imageToDataUrl(image) });
	}
	if (input.length === 0) {
		input.push({ type: "text", text: "", text_elements: [] });
	}
	return input;
}

function extractUserImages(context: Context): ImageContent[] {
	const images: ImageContent[] = [];
	for (const message of context.messages) {
		if (message.role !== "user" || typeof message.content === "string") {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "image") {
				images.push(block);
			}
		}
	}
	return images;
}

function imageToDataUrl(image: ImageContent): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

function messageToText(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content.map(contentBlockToText).join("\n");
	}
	if (message.role === "toolResult") {
		return formatToolResult(message);
	}
	return message.content.map(assistantBlockToText).filter(Boolean).join("\n");
}

function contentBlockToText(block: { type: string }): string {
	if (
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	) {
		return block.text;
	}
	if (block.type === "image" && "mimeType" in block) {
		return `[image: ${String(block.mimeType)}]`;
	}
	return `[${block.type}]`;
}

function assistantBlockToText(
	block: TextContent | ToolCall | { type: string },
): string {
	if (
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	) {
		return block.text;
	}
	if (
		block.type === "thinking" &&
		"thinking" in block &&
		typeof block.thinking === "string"
	) {
		return `<thinking>\n${block.thinking}\n</thinking>`;
	}
	if (block.type === "toolCall" && "name" in block && "arguments" in block) {
		return `[tool call: ${String(block.name)} ${JSON.stringify(block.arguments)}]`;
	}
	return "";
}

function formatToolResult(message: ToolResultMessage): string {
	const content = message.content.map(contentBlockToText).join("\n");
	return `[tool result: ${message.toolName}${message.isError ? " error" : ""}]\n${content}`;
}

function mapCodexReasoningEffort(
	effort: ReasoningEffort | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
	if (!effort) {
		return undefined;
	}
	if (effort === "ultra") {
		return "xhigh";
	}
	return effort;
}

function mapCodexReasoningSummary(
	summary: "auto" | "detailed" | "concise" | null | undefined,
): "auto" | "detailed" | "concise" | "none" | undefined {
	if (summary === null) {
		return "none";
	}
	return summary;
}

type CodexStreamItem =
	| { type: "notification"; notification: CodexAppServerNotification }
	| { type: "providerToolEvent"; event: AssistantMessageEvent };

async function nextCodexStreamItem(
	notificationQueue: CodexAppServerNotification[],
	providerToolEventQueue: AssistantMessageEvent[],
	getWake: () => (() => void) | undefined,
	setWake: (wake: (() => void) | undefined) => void,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<CodexStreamItem> {
	const queuedProviderToolEvent = providerToolEventQueue.shift();
	if (queuedProviderToolEvent) {
		return { type: "providerToolEvent", event: queuedProviderToolEvent };
	}
	const queuedNotification = notificationQueue.shift();
	if (queuedNotification) {
		return { type: "notification", notification: queuedNotification };
	}
	if (signal?.aborted) {
		throw createAbortError("Codex app-server turn aborted");
	}
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for Codex app-server turn events"));
		}, timeoutMs);
		const abort = (): void => {
			cleanup();
			reject(createAbortError("Codex app-server turn aborted"));
		};
		const wake = (): void => {
			const providerToolEvent = providerToolEventQueue.shift();
			if (providerToolEvent) {
				cleanup();
				resolve({ type: "providerToolEvent", event: providerToolEvent });
				return;
			}
			const notification = notificationQueue.shift();
			if (notification) {
				cleanup();
				resolve({ type: "notification", notification });
				return;
			}
		};
		const cleanup = (): void => {
			clearTimeout(timeout);
			if (getWake() === wake) {
				setWake(undefined);
			}
			signal?.removeEventListener("abort", abort);
		};
		setWake(wake);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function readTurnErrorMessage(turn: Record<string, unknown>): string {
	const error = turn.error;
	if (isRecord(error) && typeof error.message === "string") {
		return error.message;
	}
	return "Codex app-server turn failed";
}

function createAbortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
