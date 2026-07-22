/**
 * Pure adapter that maps headless protocol `HeadlessFromAgentMessage` values
 * into web/runtime `AgentEvent` frames.
 *
 * Used by the native-headless chat bridge so chat-ws can forward events to the
 * browser without an in-process TypeScript Agent. Prefer `raw_agent_event`
 * passthrough when the native runtime already emits full AgentEvent payloads.
 */

import type {
	AgentEvent,
	AgentToolResult,
	Api,
	AppMessage,
	AssistantMessage,
	StopReason,
	ToolResultMessage,
	Usage,
} from "../agent/types.js";
import type {
	HeadlessFromAgentMessage,
	HeadlessResponseEndMessage,
	HeadlessToolCallMessage,
	HeadlessToolEndMessage,
} from "../cli/headless-protocol.js";
import { isRecord } from "../utils/json.js";

const DEFAULT_API: Api = "openai-responses";
const DEFAULT_MODEL_ID = "unknown";
const DEFAULT_PROVIDER = "unknown";

export type NativeHeadlessAdapterOptions = {
	modelId?: string;
	provider?: string;
	/** Optional API format for assembled assistant messages. */
	api?: Api;
};

export type NativeHeadlessAdapterState = {
	/** Active response_id from response_start, if any. */
	responseId: string | null;
	/** Accumulated assistant text across response_chunk messages. */
	text: string;
	/** Accumulated thinking across is_thinking response_chunk messages. */
	thinking: string;
	/** Content-block index for the text block, once opened. */
	textContentIndex: number | null;
	/** Content-block index for the thinking block, once opened. */
	thinkingContentIndex: number | null;
	/** Next free content-block index. */
	nextContentIndex: number;
	/** Timestamp used for the current assistant message. */
	messageTimestamp: number;
	/** Whether agent_start has been emitted for the current agentic turn. */
	agentStarted: boolean;
	/** Whether turn_start has been emitted for the current agentic turn. */
	turnStarted: boolean;
	/** Last completed assistant message (for turn_end on sentinel done). */
	lastAssistantMessage: AssistantMessage | null;
	/** Whether a ready status has already been emitted. */
	readyEmitted: boolean;
	/** Model id from options, ready, or latest response_end usage. */
	modelId: string;
	/** Provider from options, ready, or latest response_end usage. */
	provider: string;
	/** API format for assembled messages. */
	api: Api;
	/** Active tools keyed by call_id. */
	tools: Map<string, ActiveToolState>;
	/** Completed tool results for the current turn (for turn_end). */
	toolResults: AppMessage[];
};

type ActiveToolState = {
	toolName: string;
	args: Record<string, unknown>;
	output: string;
	toolExecutionId?: string;
	displayName?: string;
	summaryLabel?: string;
};

export type NativeHeadlessEventAdapter = {
	/** Convert one headless message to 0+ agent events; mutates internal state. */
	handle(message: HeadlessFromAgentMessage): AgentEvent[];
	/** Clear streaming assembly state (does not clear model/provider defaults). */
	reset(): void;
	/** Current partial assistant text (excludes thinking). */
	getPartialAssistantText(): string;
};

/**
 * Create a stateful headless → AgentEvent adapter.
 *
 * Pure: no I/O. State is only for assembling text across chunks and tracking
 * tool call metadata between headless tool_* messages.
 */
export function createNativeHeadlessEventAdapter(
	options: NativeHeadlessAdapterOptions = {},
): NativeHeadlessEventAdapter {
	const state = createInitialState(options);

	return {
		handle(message: HeadlessFromAgentMessage): AgentEvent[] {
			return handleMessage(state, message);
		},
		reset(): void {
			resetStreamingState(state);
		},
		getPartialAssistantText(): string {
			return state.text;
		},
	};
}

function createInitialState(
	options: NativeHeadlessAdapterOptions,
): NativeHeadlessAdapterState {
	return {
		responseId: null,
		text: "",
		thinking: "",
		textContentIndex: null,
		thinkingContentIndex: null,
		nextContentIndex: 0,
		messageTimestamp: Date.now(),
		agentStarted: false,
		turnStarted: false,
		lastAssistantMessage: null,
		readyEmitted: false,
		modelId: options.modelId ?? DEFAULT_MODEL_ID,
		provider: options.provider ?? DEFAULT_PROVIDER,
		api: options.api ?? DEFAULT_API,
		tools: new Map(),
		toolResults: [],
	};
}

function resetStreamingState(state: NativeHeadlessAdapterState): void {
	state.responseId = null;
	state.text = "";
	state.thinking = "";
	state.textContentIndex = null;
	state.thinkingContentIndex = null;
	state.nextContentIndex = 0;
	state.messageTimestamp = Date.now();
	state.agentStarted = false;
	state.turnStarted = false;
	state.lastAssistantMessage = null;
	state.tools.clear();
	state.toolResults = [];
	// readyEmitted / model / provider intentionally preserved across reset
}

function clearMessageAssembly(state: NativeHeadlessAdapterState): void {
	state.responseId = null;
	state.text = "";
	state.thinking = "";
	state.textContentIndex = null;
	state.thinkingContentIndex = null;
	state.nextContentIndex = 0;
	state.messageTimestamp = Date.now();
}

function isTurnTerminalResponseId(responseId: string): boolean {
	return responseId === "done" || responseId === "blocked";
}

function handleMessage(
	state: NativeHeadlessAdapterState,
	message: HeadlessFromAgentMessage,
): AgentEvent[] {
	switch (message.type) {
		case "raw_agent_event":
			return handleRawAgentEvent(message.event);
		case "ready":
			return handleReady(state, message);
		case "hello_ok":
			return [
				{
					type: "status",
					status: "hello_ok",
					details: {
						protocol_version: message.protocol_version,
						connection_id: message.connection_id,
						role: message.role,
						server_capabilities: message.server_capabilities,
					},
				},
			];
		case "response_start":
			return handleResponseStart(state, message.response_id);
		case "response_chunk":
			return handleResponseChunk(
				state,
				message.response_id,
				message.content,
				message.is_thinking,
			);
		case "response_end":
			return handleResponseEnd(state, message);
		case "tool_call":
			return handleToolCall(state, message);
		case "tool_start":
			// Optional: headless tool_start has no payload beyond call_id.
			// tool_execution_start already covers UI start from tool_call.
			return [];
		case "tool_output":
			return handleToolOutput(state, message.call_id, message.content);
		case "tool_end":
			return handleToolEnd(state, message);
		case "client_tool_request":
			return [
				{
					type: "client_tool_request",
					toolCallId: message.call_id,
					toolName: message.tool,
					args: message.args,
				},
			];
		case "server_request":
			return handleServerRequest(message);
		case "server_request_resolved":
			return [
				{
					type: "status",
					status: "server_request_resolved",
					details: {
						request_id: message.request_id,
						request_type: message.request_type,
						call_id: message.call_id,
						resolution: message.resolution,
						reason: message.reason,
						resolved_by: message.resolved_by,
					},
				},
			];
		case "error":
			return handleError(state, message.message, message.fatal);
		case "status":
			return [
				{
					type: "status",
					status: message.message,
					details: {},
				},
			];
		case "session_info":
			return [
				{
					type: "status",
					status: "session_info",
					details: {
						session_id: message.session_id,
						cwd: message.cwd,
						git_branch: message.git_branch,
					},
				},
			];
		case "compaction":
			return [
				{
					type: "compaction",
					summary: message.summary,
					firstKeptEntryIndex: message.first_kept_entry_index,
					tokensBefore: message.tokens_before,
					auto: message.auto,
					customInstructions: message.custom_instructions,
					timestamp: message.timestamp,
				},
			];
		case "connection_info":
			return [
				{
					type: "status",
					status: "connection_info",
					details: {
						connection_id: message.connection_id,
						role: message.role,
						connection_count: message.connection_count,
						controller_connection_id: message.controller_connection_id,
					},
				},
			];
		// Utility / file-watch protocol is out of scope for chat bridge MVP.
		case "utility_command_started":
		case "utility_command_resized":
		case "utility_command_output":
		case "utility_command_exited":
		case "utility_file_search_results":
		case "utility_file_read_result":
		case "utility_file_watch_started":
		case "utility_file_watch_event":
		case "utility_file_watch_stopped":
			return [];
		default: {
			// Exhaustiveness: unknown headless types produce no events.
			const _exhaustive: never = message;
			void _exhaustive;
			return [];
		}
	}
}

function handleRawAgentEvent(event: unknown): AgentEvent[] {
	if (looksLikeAgentEvent(event)) {
		return [event];
	}
	return [];
}

function looksLikeAgentEvent(value: unknown): value is AgentEvent {
	return isRecord(value) && typeof value.type === "string";
}

function handleReady(
	state: NativeHeadlessAdapterState,
	message: Extract<HeadlessFromAgentMessage, { type: "ready" }>,
): AgentEvent[] {
	state.modelId = message.model || state.modelId;
	state.provider = message.provider || state.provider;

	// Emit once — avoid spamming when ready is followed by hello_ok / retries.
	if (state.readyEmitted) {
		return [];
	}
	state.readyEmitted = true;
	return [
		{
			type: "status",
			status: "ready",
			details: {
				model: message.model,
				provider: message.provider,
				session_id: message.session_id,
				protocol_version: message.protocol_version,
				executor_type: message.executor_type,
			},
		},
	];
}

function handleResponseStart(
	state: NativeHeadlessAdapterState,
	responseId: string,
): AgentEvent[] {
	// New LLM round: reset message assembly only. Keep toolResults across
	// multi-step agentic turns (response_end intermediate → tools → next start).
	clearMessageAssembly(state);
	state.responseId = responseId;

	const events: AgentEvent[] = [];
	if (!state.agentStarted) {
		events.push({ type: "agent_start" });
		state.agentStarted = true;
	}
	if (!state.turnStarted) {
		events.push({ type: "turn_start" });
		state.turnStarted = true;
	}
	events.push({
		type: "message_start",
		message: buildAssistantMessage(state),
	});
	return events;
}

function handleResponseChunk(
	state: NativeHeadlessAdapterState,
	responseId: string,
	content: string,
	isThinking: boolean,
): AgentEvent[] {
	if (!state.responseId) {
		state.responseId = responseId;
		state.messageTimestamp = Date.now();
	}

	if (isThinking) {
		if (state.thinkingContentIndex === null) {
			state.thinkingContentIndex = state.nextContentIndex++;
		}
		state.thinking += content;
		const partial = buildAssistantMessage(state);
		return [
			{
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: state.thinkingContentIndex,
					delta: content,
					partial,
				},
			},
		];
	}

	if (state.textContentIndex === null) {
		state.textContentIndex = state.nextContentIndex++;
	}
	state.text += content;
	const partial = buildAssistantMessage(state);
	return [
		{
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: state.textContentIndex,
				delta: content,
				partial,
			},
		},
	];
}

function handleResponseEnd(
	state: NativeHeadlessAdapterState,
	message: HeadlessResponseEndMessage,
): AgentEvent[] {
	if (message.usage?.model_id) {
		state.modelId = message.usage.model_id;
	}
	if (message.usage?.provider) {
		state.provider = message.usage.provider;
	}

	// Sentinel: native agent finished the full agentic loop (or blocked hooks).
	// Intermediate response_end (real response ids) only close the current
	// assistant message so tools can run before the next response_start.
	if (isTurnTerminalResponseId(message.response_id)) {
		return handleTerminalResponseEnd(state, message);
	}

	const stopReason = resolveStopReason(message);
	const finalMessage = buildAssistantMessage(state, {
		usage: mapHeadlessUsage(message.usage),
		stopReason,
	});
	state.lastAssistantMessage = finalMessage;

	const events: AgentEvent[] = [{ type: "message_end", message: finalMessage }];

	// Clear message assembly only; keep agent/turn open for tools + next rounds.
	clearMessageAssembly(state);
	state.tools.clear();

	return events;
}

function handleTerminalResponseEnd(
	state: NativeHeadlessAdapterState,
	message: HeadlessResponseEndMessage,
): AgentEvent[] {
	const events: AgentEvent[] = [];
	const stopReason =
		message.response_id === "blocked"
			? ("error" as const)
			: resolveStopReason(message);

	// Flush any in-flight assistant message (unusual for "done", possible for "blocked").
	if (state.responseId || state.text || state.thinking) {
		const finalMessage = buildAssistantMessage(state, {
			usage: mapHeadlessUsage(message.usage),
			stopReason,
		});
		state.lastAssistantMessage = finalMessage;
		events.push({ type: "message_end", message: finalMessage });
	}

	const finalMessage =
		state.lastAssistantMessage ??
		buildAssistantMessage(state, {
			usage: mapHeadlessUsage(message.usage),
			stopReason,
		});
	const toolResults = [...state.toolResults];

	if (state.turnStarted) {
		events.push({
			type: "turn_end",
			message: finalMessage,
			toolResults,
		});
	}
	if (
		state.agentStarted ||
		events.length > 0 ||
		message.response_id === "done"
	) {
		events.push({
			type: "agent_end",
			messages: state.lastAssistantMessage
				? [finalMessage, ...toolResults]
				: [...toolResults],
			stopReason,
		});
	}

	state.agentStarted = false;
	state.turnStarted = false;
	state.lastAssistantMessage = null;
	state.toolResults = [];
	state.tools.clear();
	clearMessageAssembly(state);

	return events;
}

function handleToolCall(
	state: NativeHeadlessAdapterState,
	message: HeadlessToolCallMessage,
): AgentEvent[] {
	const args = normalizeArgs(message.args);
	const existing = state.tools.get(message.call_id);
	const tool: ActiveToolState = {
		toolName: message.tool,
		args,
		output: existing?.output ?? "",
		...(message.tool_execution_id
			? { toolExecutionId: message.tool_execution_id }
			: {}),
	};
	state.tools.set(message.call_id, tool);

	return [
		{
			type: "tool_execution_start",
			toolCallId: message.call_id,
			...(tool.toolExecutionId
				? { toolExecutionId: tool.toolExecutionId }
				: {}),
			toolName: tool.toolName,
			args: tool.args,
		},
	];
}

function handleToolOutput(
	state: NativeHeadlessAdapterState,
	callId: string,
	content: string,
): AgentEvent[] {
	const tool = state.tools.get(callId) ?? {
		toolName: "unknown",
		args: {},
		output: "",
	};
	tool.output = appendToolOutput(tool.output, content);
	state.tools.set(callId, tool);

	const partialResult: AgentToolResult = {
		content: [{ type: "text", text: tool.output }],
		...(tool.toolExecutionId ? { toolExecutionId: tool.toolExecutionId } : {}),
	};

	return [
		{
			type: "tool_execution_update",
			toolCallId: callId,
			...(tool.toolExecutionId
				? { toolExecutionId: tool.toolExecutionId }
				: {}),
			toolName: tool.toolName,
			args: tool.args,
			partialResult,
		},
	];
}

function handleToolEnd(
	state: NativeHeadlessAdapterState,
	message: HeadlessToolEndMessage,
): AgentEvent[] {
	const tool = state.tools.get(message.call_id) ?? {
		toolName: message.tool ?? "unknown",
		args: {},
		output: "",
	};
	if (message.tool) {
		tool.toolName = message.tool;
	}
	if (message.tool_execution_id) {
		tool.toolExecutionId = message.tool_execution_id;
	}

	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: message.call_id,
		toolName: tool.toolName,
		content: tool.output ? [{ type: "text", text: tool.output }] : [],
		...(message.details !== undefined ? { details: message.details } : {}),
		isError: !message.success,
		timestamp: Date.now(),
	};

	state.toolResults.push(result);
	state.tools.delete(message.call_id);

	const event: Extract<AgentEvent, { type: "tool_execution_end" }> = {
		type: "tool_execution_end",
		toolCallId: message.call_id,
		...(tool.toolExecutionId ? { toolExecutionId: tool.toolExecutionId } : {}),
		...(message.approval_request_id
			? { approvalRequestId: message.approval_request_id }
			: {}),
		...(message.error_code ? { errorCode: message.error_code } : {}),
		...(isGovernedOutcome(message.governed_outcome)
			? { governedOutcome: message.governed_outcome }
			: {}),
		toolName: tool.toolName,
		result,
		isError: !message.success,
	};

	return [event];
}

function handleServerRequest(
	message: Extract<HeadlessFromAgentMessage, { type: "server_request" }>,
): AgentEvent[] {
	if (message.request_type === "approval") {
		return [
			{
				type: "action_approval_required",
				request: {
					id: message.request_id,
					toolName: message.tool,
					...(message.display_name
						? { displayName: message.display_name }
						: {}),
					...(message.summary_label
						? { summaryLabel: message.summary_label }
						: {}),
					...(message.action_description
						? { actionDescription: message.action_description }
						: {}),
					args: message.args,
					reason: message.reason,
					...(message.started_at_ms !== undefined
						? { startedAtMs: message.started_at_ms }
						: {}),
					...(message.tool_execution_id
						? {
								platform: {
									source: "tool_execution" as const,
									toolExecutionId: message.tool_execution_id,
								},
							}
						: {}),
				},
			},
		];
	}

	if (
		message.request_type === "client_tool" ||
		message.request_type === "user_input"
	) {
		return [
			{
				type: "client_tool_request",
				toolCallId: message.call_id,
				toolName: message.tool,
				args: message.args,
			},
		];
	}

	return [
		{
			type: "status",
			status: "server_request",
			details: {
				request_id: message.request_id,
				request_type: message.request_type,
				call_id: message.call_id,
				tool: message.tool,
				reason: message.reason,
			},
		},
	];
}

function handleError(
	state: NativeHeadlessAdapterState,
	message: string,
	fatal: boolean,
): AgentEvent[] {
	const events: AgentEvent[] = [{ type: "error", message }];
	if (fatal) {
		const partial =
			state.text || state.thinking
				? buildAssistantMessage(state, { stopReason: "error" })
				: undefined;
		events.push({
			type: "agent_end",
			messages: partial ? [partial] : [],
			aborted: true,
			...(partial ? { partialAccepted: partial } : {}),
			stopReason: "error",
		});
		state.agentStarted = false;
		state.turnStarted = false;
		state.lastAssistantMessage = null;
		state.tools.clear();
		state.toolResults = [];
		clearMessageAssembly(state);
	}
	return events;
}

function buildAssistantMessage(
	state: NativeHeadlessAdapterState,
	overrides?: {
		usage?: Usage;
		stopReason?: StopReason;
	},
): AssistantMessage {
	const content: AssistantMessage["content"] = [];

	// Prefer thinking-before-text when both exist and thinking opened first.
	const thinkingFirst =
		state.thinkingContentIndex !== null &&
		(state.textContentIndex === null ||
			state.thinkingContentIndex < state.textContentIndex);

	const pushThinking = () => {
		if (state.thinking.length > 0 || state.thinkingContentIndex !== null) {
			content.push({ type: "thinking", thinking: state.thinking });
		}
	};
	const pushText = () => {
		if (state.text.length > 0 || state.textContentIndex !== null) {
			content.push({ type: "text", text: state.text });
		}
	};

	if (thinkingFirst) {
		pushThinking();
		pushText();
	} else {
		pushText();
		pushThinking();
	}

	return {
		role: "assistant",
		content,
		api: state.api,
		provider: state.provider,
		model: state.modelId,
		usage: overrides?.usage ?? emptyUsage(),
		stopReason: overrides?.stopReason ?? "stop",
		timestamp: state.messageTimestamp,
	};
}

function resolveStopReason(message: HeadlessResponseEndMessage): StopReason {
	const toolsUsed = message.tools_summary?.tools_used?.length ?? 0;
	const calls =
		(message.tools_summary?.calls_succeeded ?? 0) +
		(message.tools_summary?.calls_failed ?? 0);
	if (toolsUsed > 0 || calls > 0) {
		return "toolUse";
	}
	return "stop";
}

function mapHeadlessUsage(
	usage: HeadlessResponseEndMessage["usage"] | undefined,
): Usage {
	if (!usage) {
		return emptyUsage();
	}
	return {
		input: usage.input_tokens ?? 0,
		output: usage.output_tokens ?? 0,
		cacheRead: usage.cache_read_tokens ?? 0,
		cacheWrite: usage.cache_write_tokens ?? 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.total_cost_usd ?? 0,
		},
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

function normalizeArgs(args: unknown): Record<string, unknown> {
	if (isRecord(args)) {
		return args;
	}
	if (args === undefined) {
		return {};
	}
	return { value: args };
}

function appendToolOutput(existing: string, chunk: string): string {
	if (!existing) return chunk;
	if (!chunk) return existing;
	return existing + chunk;
}

type GovernedOutcome = NonNullable<
	Extract<AgentEvent, { type: "tool_execution_end" }>["governedOutcome"]
>;

const GOVERNED_OUTCOMES: ReadonlySet<string> = new Set([
	"approval_required",
	"approval_pending",
	"authentication_required",
	"denied",
	"rate_limited",
]);

function isGovernedOutcome(
	value: string | undefined,
): value is GovernedOutcome {
	return typeof value === "string" && GOVERNED_OUTCOMES.has(value);
}
