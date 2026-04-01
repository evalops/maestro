import type {
	ComposerMessage,
	ComposerToolCall,
	ComposerToolCallContent,
} from "@evalops/contracts";
import type { AgentEvent, Message, ToolCall } from "./types";

export interface AssistantStreamingState {
	currentThinkingIndex: number | null;
	thinkingBlocks: Map<number, string>;
	toolCallJsonById: Map<string, string>;
	toolCallArgsById: Map<string, Record<string, unknown>>;
	activeToolIndexes: Map<string, number>;
}

function isDesktopRole(role: string): role is Message["role"] {
	return role === "user" || role === "assistant";
}

function extractMessageText(
	content: ComposerMessage["content"] | Message["content"],
): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				block.type === "text" &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

function normalizeToolStatus(
	status: ComposerToolCall["status"] | ToolCall["status"] | undefined,
): ToolCall["status"] {
	switch (status) {
		case "pending":
		case "running":
		case "error":
		case "success":
			return status;
		case "completed":
			return "success";
		default:
			return "success";
	}
}

function formatToolResult(result: unknown): string | undefined {
	if (result === undefined || result === null) {
		return undefined;
	}
	if (typeof result === "string") {
		return result;
	}
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}

function normalizeToolCall(tool: ComposerToolCall | ToolCall): ToolCall {
	return {
		id: "toolCallId" in tool ? tool.toolCallId : tool.id,
		name: tool.name,
		args: tool.args,
		status: normalizeToolStatus(tool.status),
		result: formatToolResult(tool.result),
	};
}

function getPartialToolCall(
	messageEvent: NonNullable<AgentEvent["assistantMessageEvent"]>,
): ComposerToolCallContent | undefined {
	if (
		typeof messageEvent.contentIndex !== "number" ||
		!messageEvent.partial ||
		typeof messageEvent.partial.content === "string" ||
		!Array.isArray(messageEvent.partial.content)
	) {
		return undefined;
	}
	const part = messageEvent.partial.content[messageEvent.contentIndex];
	if (
		part &&
		typeof part === "object" &&
		part.type === "toolCall" &&
		typeof part.id === "string" &&
		typeof part.name === "string" &&
		part.arguments &&
		typeof part.arguments === "object" &&
		!Array.isArray(part.arguments)
	) {
		return part as ComposerToolCallContent;
	}
	return undefined;
}

function parseToolCallArgs(raw: string): Record<string, unknown> | undefined {
	if (!raw || raw.trim().length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function ensureToolCalls(message: Message): ToolCall[] {
	if (!message.toolCalls) {
		message.toolCalls = [];
	}
	return message.toolCalls;
}

function upsertToolCall(
	message: Message,
	toolCallId: string,
	patch: Partial<ToolCall> & Pick<ToolCall, "name">,
): number {
	const toolCalls = ensureToolCalls(message);
	const existingIndex = toolCalls.findIndex(
		(toolCall) => toolCall.id === toolCallId,
	);
	if (existingIndex >= 0) {
		toolCalls[existingIndex] = {
			...toolCalls[existingIndex],
			...patch,
			id: toolCallId,
		};
		return existingIndex;
	}
	toolCalls.push({
		id: toolCallId,
		name: patch.name,
		args: patch.args,
		status: patch.status,
		result: patch.result,
	});
	return toolCalls.length - 1;
}

function syncActiveToolIndexes(
	state: AssistantStreamingState,
	toolCalls: ToolCall[] | undefined,
): void {
	state.activeToolIndexes.clear();
	if (!toolCalls) {
		return;
	}
	for (const [index, toolCall] of toolCalls.entries()) {
		if (toolCall.id) {
			state.activeToolIndexes.set(toolCall.id, index);
		}
	}
}

export function normalizeServerMessage(
	message: Message | ComposerMessage,
): Message | null {
	if (!isDesktopRole(message.role)) {
		return null;
	}
	const normalized: Message = {
		id: "id" in message ? message.id : undefined,
		role: message.role,
		content: extractMessageText(message.content),
		timestamp: message.timestamp,
		thinking:
			typeof message.thinking === "string" ? message.thinking : undefined,
	};
	if ("toolCalls" in message && Array.isArray(message.toolCalls)) {
		normalized.toolCalls = message.toolCalls.map((toolCall) =>
			normalizeToolCall(toolCall),
		);
	} else if ("tools" in message && Array.isArray(message.tools)) {
		normalized.toolCalls = message.tools.map((toolCall) =>
			normalizeToolCall(toolCall),
		);
	}
	return normalized;
}

export function createAssistantStreamingState(): AssistantStreamingState {
	return {
		currentThinkingIndex: null,
		thinkingBlocks: new Map<number, string>(),
		toolCallJsonById: new Map<string, string>(),
		toolCallArgsById: new Map<string, Record<string, unknown>>(),
		activeToolIndexes: new Map<string, number>(),
	};
}

export function applyAgentEventToMessage(
	message: Message,
	event: AgentEvent,
	state: AssistantStreamingState,
): void {
	if (event.type === "message_end" && event.message) {
		const normalized = normalizeServerMessage(event.message);
		if (normalized) {
			message.content = normalized.content;
			message.thinking = normalized.thinking;
			message.toolCalls = normalized.toolCalls;
			syncActiveToolIndexes(state, normalized.toolCalls);
		}
		return;
	}

	if (event.type === "tool_execution_start" && event.toolCallId) {
		const index = upsertToolCall(message, event.toolCallId, {
			name: event.toolName ?? "tool",
			args: event.args,
			status: "running",
		});
		state.activeToolIndexes.set(event.toolCallId, index);
		return;
	}

	if (event.type === "tool_execution_update" && event.toolCallId) {
		const index = upsertToolCall(message, event.toolCallId, {
			name: event.toolName ?? "tool",
			args: event.args,
			status: "running",
			result: formatToolResult(event.partialResult),
		});
		state.activeToolIndexes.set(event.toolCallId, index);
		return;
	}

	if (event.type === "tool_execution_end" && event.toolCallId) {
		const index = upsertToolCall(message, event.toolCallId, {
			name: event.toolName ?? "tool",
			status: event.isError ? "error" : "success",
			result: formatToolResult(event.result),
		});
		state.activeToolIndexes.set(event.toolCallId, index);
		return;
	}

	const messageEvent = event.assistantMessageEvent;
	if (!messageEvent || event.type !== "message_update") {
		return;
	}

	if (messageEvent.type === "text_delta" && messageEvent.delta) {
		message.content += messageEvent.delta;
		return;
	}

	if (messageEvent.type === "text_end" && message.content.length === 0) {
		message.content = messageEvent.content ?? message.content;
		return;
	}

	if (messageEvent.type === "thinking_start") {
		state.currentThinkingIndex =
			typeof messageEvent.contentIndex === "number"
				? messageEvent.contentIndex
				: null;
		if (state.currentThinkingIndex !== null) {
			state.thinkingBlocks.set(state.currentThinkingIndex, "");
		}
		return;
	}

	if (
		messageEvent.type === "thinking_delta" &&
		typeof messageEvent.contentIndex === "number"
	) {
		const activeIndex = state.currentThinkingIndex ?? messageEvent.contentIndex;
		const current = state.thinkingBlocks.get(activeIndex) ?? "";
		state.thinkingBlocks.set(activeIndex, current + (messageEvent.delta ?? ""));
		message.thinking = Array.from(state.thinkingBlocks.values()).join("\n\n");
		return;
	}

	if (messageEvent.type === "thinking_end") {
		if (
			typeof messageEvent.contentIndex === "number" &&
			typeof messageEvent.content === "string"
		) {
			state.thinkingBlocks.set(messageEvent.contentIndex, messageEvent.content);
			message.thinking = Array.from(state.thinkingBlocks.values()).join("\n\n");
		}
		state.currentThinkingIndex = null;
		return;
	}

	if (
		messageEvent.type !== "toolcall_start" &&
		messageEvent.type !== "toolcall_delta" &&
		messageEvent.type !== "toolcall_end"
	) {
		return;
	}

	if (messageEvent.type === "toolcall_end") {
		const toolCall = messageEvent.toolCall;
		state.toolCallJsonById.delete(toolCall.id);
		state.toolCallArgsById.delete(toolCall.id);
		const index = upsertToolCall(message, toolCall.id, {
			name: toolCall.name,
			args: toolCall.arguments,
			status: "pending",
		});
		state.activeToolIndexes.set(toolCall.id, index);
		return;
	}

	const partialToolCall = getPartialToolCall(messageEvent);
	const slimArgs =
		messageEvent.toolCallArgs &&
		typeof messageEvent.toolCallArgs === "object" &&
		!Array.isArray(messageEvent.toolCallArgs)
			? messageEvent.toolCallArgs
			: undefined;
	const argsTruncated = Boolean(messageEvent.toolCallArgsTruncated);
	const toolCallId =
		partialToolCall?.id ?? messageEvent.toolCallId ?? undefined;

	if (!toolCallId) {
		return;
	}

	let args: Record<string, unknown> = partialToolCall?.arguments ?? {};
	if (!partialToolCall) {
		if (slimArgs) {
			state.toolCallArgsById.set(toolCallId, slimArgs);
			args = slimArgs;
		} else if (argsTruncated) {
			args = state.toolCallArgsById.get(toolCallId) ?? {};
		} else if (messageEvent.type === "toolcall_delta") {
			const current = state.toolCallJsonById.get(toolCallId) ?? "";
			const next = current + (messageEvent.delta ?? "");
			state.toolCallJsonById.set(toolCallId, next);
			args =
				parseToolCallArgs(next) ?? state.toolCallArgsById.get(toolCallId) ?? {};
			if (Object.keys(args).length > 0) {
				state.toolCallArgsById.set(toolCallId, args);
			}
		} else {
			args = state.toolCallArgsById.get(toolCallId) ?? {};
		}
	} else {
		state.toolCallArgsById.set(toolCallId, args);
	}

	const index = upsertToolCall(message, toolCallId, {
		name: partialToolCall?.name ?? messageEvent.toolCallName ?? "tool",
		args,
		status: "pending",
	});
	state.activeToolIndexes.set(toolCallId, index);
}
