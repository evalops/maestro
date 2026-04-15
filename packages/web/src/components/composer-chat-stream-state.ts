import type {
	ComposerActionApprovalRequest,
	ComposerToolRetryRequest,
} from "@evalops/contracts";
import { parse as parsePartialJson } from "partial-json";
import type {
	AgentEvent,
	AssistantMessageEvent,
	ComposerToolCall,
	Message,
} from "../services/api-client.js";
import { formatWebRuntimeStatus } from "../services/runtime-status.js";

const parseToolCallArgs = (
	raw: string,
): Record<string, unknown> | undefined => {
	if (!raw || raw.trim() === "") return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		try {
			const parsed = parsePartialJson(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Ignore partial parse failures while args are still streaming.
		}
		return undefined;
	}
};

export interface ExtendedToolCall extends ComposerToolCall {
	startTime?: number;
	endTime?: number;
	argsTruncated?: boolean;
	displayName?: string;
	summaryLabel?: string;
}

interface ActiveToolInfo {
	name: string;
	args: unknown;
	index: number;
	argsTruncated?: boolean;
}

export interface MessageWithThinking extends Message {
	thinking?: string;
}

export type UiMessage = Omit<Message, "tools"> & {
	tools?: ExtendedToolCall[];
	localOnly?: boolean;
};

type AssistantMessageSnapshot = Pick<Message, "content"> & {
	tools?: unknown[];
	thinking?: string;
};

type StreamOutcome = { message: string; type: "error" | "info" } | null;

type StreamCallbacks = {
	commitMessages: () => void;
	setRuntimeStatus: (status: string | null) => void;
	onSessionUpdate: (sessionId: string) => void;
	enqueueApprovalRequest: (request: ComposerActionApprovalRequest) => void;
	clearApprovalRequest: (requestId: string) => void;
	enqueueToolRetryRequest: (request: ComposerToolRetryRequest) => void;
	clearToolRetryRequest: (requestId: string) => void;
	handleClientToolRequest: (
		toolCallId: string,
		toolName: string,
		args: unknown,
	) => Promise<void>;
};

function getMessageTextContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (item?.type === "text" ? item.text : ""))
		.join("");
}

export function hasAssistantMessageProgress(
	message: AssistantMessageSnapshot,
): boolean {
	if (getMessageTextContent(message.content).trim().length > 0) {
		return true;
	}
	if (
		typeof message.thinking === "string" &&
		message.thinking.trim().length > 0
	) {
		return true;
	}
	return Array.isArray(message.tools) && message.tools.length > 0;
}

export function getTerminalStreamOutcome(event: AgentEvent): StreamOutcome {
	switch (event.type) {
		case "error":
			return {
				message: event.message?.trim() || "Failed to complete request",
				type: "error",
			};
		case "aborted":
			return { message: "Request aborted", type: "info" };
		case "agent_end":
			return event.aborted
				? { message: "Request aborted", type: "info" }
				: null;
		default:
			return null;
	}
}

export class ComposerChatStreamState {
	private readonly activeTools = new Map<string, ActiveToolInfo>();
	private readonly thinkingBlocks = new Map<number, string>();
	private readonly toolCallArgsById = new Map<
		string,
		Record<string, unknown>
	>();
	private readonly toolCallJsonById = new Map<string, string>();
	private currentThinkingIndex: number | null = null;
	private terminalStreamOutcome: StreamOutcome = null;

	constructor(
		private readonly assistantMessage: UiMessage,
		private readonly callbacks: StreamCallbacks,
	) {}

	getOutcome(): StreamOutcome {
		return this.terminalStreamOutcome;
	}

	async handleEvent(agentEvent: AgentEvent): Promise<void> {
		switch (agentEvent.type) {
			case "session_update":
				if (agentEvent.sessionId) {
					this.callbacks.onSessionUpdate(agentEvent.sessionId);
				}
				break;

			case "message_update":
				if (agentEvent.assistantMessageEvent) {
					this.handleAssistantMessageEvent(agentEvent.assistantMessageEvent);
				}
				break;

			case "tool_execution_start":
				this.handleToolExecutionStart(agentEvent.toolCallId, {
					displayName: agentEvent.displayName,
					summaryLabel: agentEvent.summaryLabel,
				});
				break;

			case "tool_execution_update":
				this.handleToolExecutionUpdate(agentEvent.toolCallId, {
					displayName: agentEvent.displayName,
					partialResult: agentEvent.partialResult,
					summaryLabel: agentEvent.summaryLabel,
				});
				break;

			case "tool_execution_end":
				this.handleToolExecutionEnd(agentEvent.toolCallId, {
					displayName: agentEvent.displayName,
					isError: agentEvent.isError,
					result: agentEvent.result,
					summaryLabel: agentEvent.summaryLabel,
				});
				break;

			case "status":
			case "compaction":
			case "tool_batch_summary": {
				const nextRuntimeStatus = formatWebRuntimeStatus(agentEvent);
				if (nextRuntimeStatus) {
					this.callbacks.setRuntimeStatus(nextRuntimeStatus);
				}
				break;
			}

			case "action_approval_required":
				this.callbacks.enqueueApprovalRequest(agentEvent.request);
				break;

			case "action_approval_resolved":
				this.callbacks.clearApprovalRequest(agentEvent.request.id);
				break;

			case "tool_retry_required":
				this.callbacks.enqueueToolRetryRequest(agentEvent.request);
				break;

			case "tool_retry_resolved":
				this.callbacks.clearToolRetryRequest(agentEvent.request.id);
				break;

			case "client_tool_request":
				await this.callbacks.handleClientToolRequest(
					agentEvent.toolCallId,
					agentEvent.toolName,
					agentEvent.args,
				);
				break;

			case "message_end":
				if (agentEvent.message.role === "assistant") {
					this.assistantMessage.timestamp = new Date().toISOString();
					this.callbacks.commitMessages();
				}
				break;

			case "error":
			case "aborted":
				this.terminalStreamOutcome = getTerminalStreamOutcome(agentEvent);
				break;

			case "agent_end":
				this.terminalStreamOutcome ??= getTerminalStreamOutcome(agentEvent);
				break;
		}
	}

	private handleAssistantMessageEvent(msgEvent: AssistantMessageEvent): void {
		if (msgEvent.type === "text_delta") {
			if (typeof this.assistantMessage.content !== "string") {
				this.assistantMessage.content = this.coerceMessageContent(
					this.assistantMessage.content,
				);
			}
			this.assistantMessage.content += msgEvent.delta;
			this.callbacks.commitMessages();
			return;
		}

		if (msgEvent.type === "thinking_start") {
			this.currentThinkingIndex = msgEvent.contentIndex;
			this.thinkingBlocks.set(msgEvent.contentIndex, "");
			return;
		}

		if (
			msgEvent.type === "thinking_delta" &&
			this.currentThinkingIndex !== null
		) {
			const current = this.thinkingBlocks.get(this.currentThinkingIndex) || "";
			this.thinkingBlocks.set(
				this.currentThinkingIndex,
				current + msgEvent.delta,
			);
			this.assistantMessage.thinking = Array.from(
				this.thinkingBlocks.values(),
			).join("\n\n");
			this.callbacks.commitMessages();
			return;
		}

		if (msgEvent.type === "thinking_end") {
			this.currentThinkingIndex = null;
			return;
		}

		if (msgEvent.type === "toolcall_start") {
			this.handleToolCallStart(msgEvent);
			return;
		}

		if (msgEvent.type === "toolcall_delta") {
			this.handleToolCallDelta(msgEvent);
			return;
		}

		if (msgEvent.type === "toolcall_end") {
			this.handleToolCallEnd(msgEvent);
		}
	}

	private handleToolCallStart(
		msgEvent: Extract<AssistantMessageEvent, { type: "toolcall_start" }>,
	): void {
		const partial = Array.isArray(msgEvent.partial?.content)
			? msgEvent.partial.content[msgEvent.contentIndex]
			: undefined;
		const slimArgs =
			msgEvent.toolCallArgs &&
			typeof msgEvent.toolCallArgs === "object" &&
			!Array.isArray(msgEvent.toolCallArgs)
				? (msgEvent.toolCallArgs as Record<string, unknown>)
				: undefined;
		const argsTruncated = Boolean(msgEvent.toolCallArgsTruncated);
		const toolCallId =
			partial?.type === "toolCall" ? partial.id : msgEvent.toolCallId;
		if (!toolCallId) {
			return;
		}
		if (slimArgs) {
			this.toolCallArgsById.set(toolCallId, slimArgs);
		}
		const args =
			partial?.type === "toolCall"
				? (partial.arguments ?? {})
				: (slimArgs ?? this.toolCallArgsById.get(toolCallId) ?? {});
		const name =
			partial?.type === "toolCall"
				? partial.name || "tool"
				: msgEvent.toolCallName || "tool";
		if (!this.assistantMessage.tools) {
			this.assistantMessage.tools = [];
		}
		const existingIndex = this.assistantMessage.tools.findIndex(
			(tool) => tool.toolCallId === toolCallId,
		);
		const entry: ExtendedToolCall = {
			toolCallId,
			name,
			status: "pending",
			args,
			argsTruncated,
			startTime: Date.now(),
		};
		if (existingIndex >= 0) {
			this.assistantMessage.tools[existingIndex] = {
				...this.assistantMessage.tools[existingIndex],
				...entry,
			};
		} else {
			this.assistantMessage.tools.push(entry);
		}
		this.activeTools.set(toolCallId, {
			name,
			args,
			index:
				existingIndex >= 0
					? existingIndex
					: this.assistantMessage.tools.length - 1,
			argsTruncated,
		});
		this.callbacks.commitMessages();
	}

	private handleToolCallDelta(
		msgEvent: Extract<AssistantMessageEvent, { type: "toolcall_delta" }>,
	): void {
		const partial = Array.isArray(msgEvent.partial?.content)
			? msgEvent.partial.content[msgEvent.contentIndex]
			: undefined;
		const slimArgs =
			msgEvent.toolCallArgs &&
			typeof msgEvent.toolCallArgs === "object" &&
			!Array.isArray(msgEvent.toolCallArgs)
				? (msgEvent.toolCallArgs as Record<string, unknown>)
				: undefined;
		const argsTruncated = Boolean(msgEvent.toolCallArgsTruncated);
		const toolCallId =
			partial?.type === "toolCall" ? partial.id : msgEvent.toolCallId;
		if (!toolCallId) {
			return;
		}
		let args: Record<string, unknown>;
		if (partial?.type === "toolCall") {
			args = partial.arguments ?? {};
		} else if (slimArgs) {
			this.toolCallArgsById.set(toolCallId, slimArgs);
			args = slimArgs;
		} else if (argsTruncated) {
			args = this.toolCallArgsById.get(toolCallId) ?? {};
		} else {
			const current = this.toolCallJsonById.get(toolCallId) ?? "";
			const next = current + msgEvent.delta;
			this.toolCallJsonById.set(toolCallId, next);
			const parsed = parseToolCallArgs(next);
			if (parsed) {
				this.toolCallArgsById.set(toolCallId, parsed);
				args = parsed;
			} else {
				args = this.toolCallArgsById.get(toolCallId) ?? {};
			}
		}

		if (!this.assistantMessage.tools) {
			this.assistantMessage.tools = [];
		}
		const existingIndex = this.assistantMessage.tools.findIndex(
			(tool) => tool.toolCallId === toolCallId,
		);
		if (existingIndex >= 0) {
			const existingTool = this.assistantMessage.tools[existingIndex]!;
			this.assistantMessage.tools[existingIndex] = {
				...existingTool,
				args,
				status: "pending",
				argsTruncated: existingTool.argsTruncated || argsTruncated,
			};
		} else {
			this.assistantMessage.tools.push({
				toolCallId,
				name:
					partial?.type === "toolCall"
						? partial.name || "tool"
						: msgEvent.toolCallName || "tool",
				status: "pending",
				args,
				argsTruncated,
			});
		}
		this.activeTools.set(toolCallId, {
			name:
				partial?.type === "toolCall"
					? partial.name || "tool"
					: msgEvent.toolCallName || "tool",
			args,
			index:
				existingIndex >= 0
					? existingIndex
					: this.assistantMessage.tools.length - 1,
			argsTruncated,
		});
		this.callbacks.commitMessages();
	}

	private handleToolCallEnd(
		msgEvent: Extract<AssistantMessageEvent, { type: "toolcall_end" }>,
	): void {
		const toolCall = msgEvent.toolCall;
		this.toolCallJsonById.delete(toolCall.id);
		this.toolCallArgsById.delete(toolCall.id);
		if (!this.assistantMessage.tools) {
			this.assistantMessage.tools = [];
		}
		const existingIndex = this.assistantMessage.tools.findIndex(
			(tool) => tool.toolCallId === toolCall.id,
		);
		const extendedTool: ExtendedToolCall = {
			toolCallId: toolCall.id,
			name: toolCall.name,
			status: "pending",
			args: toolCall.arguments,
			argsTruncated: false,
		};
		if (existingIndex >= 0) {
			this.assistantMessage.tools[existingIndex] = {
				...this.assistantMessage.tools[existingIndex],
				...extendedTool,
			};
		} else {
			this.assistantMessage.tools.push(extendedTool);
		}
		this.activeTools.set(toolCall.id, {
			name: toolCall.name,
			args: toolCall.arguments,
			index:
				existingIndex >= 0
					? existingIndex
					: this.assistantMessage.tools.length - 1,
		});
		this.callbacks.commitMessages();
	}

	private handleToolExecutionStart(
		toolCallId: string,
		metadata: { displayName?: string; summaryLabel?: string },
	): void {
		const toolInfo = this.activeTools.get(toolCallId);
		if (!toolInfo || !this.assistantMessage.tools) {
			return;
		}
		const tool = this.assistantMessage.tools[
			toolInfo.index
		] as ExtendedToolCall;
		tool.status = "running";
		tool.startTime = Date.now();
		tool.displayName = metadata.displayName ?? tool.displayName;
		tool.summaryLabel = metadata.summaryLabel ?? tool.summaryLabel;
		this.callbacks.commitMessages();
	}

	private handleToolExecutionUpdate(
		toolCallId: string,
		metadata: {
			displayName?: string;
			partialResult: unknown;
			summaryLabel?: string;
		},
	): void {
		const toolInfo = this.activeTools.get(toolCallId);
		if (!toolInfo || !this.assistantMessage.tools) {
			return;
		}
		const tool = this.assistantMessage.tools[
			toolInfo.index
		] as ExtendedToolCall;
		tool.result = metadata.partialResult;
		tool.displayName = metadata.displayName ?? tool.displayName;
		tool.summaryLabel = metadata.summaryLabel ?? tool.summaryLabel;
		this.callbacks.commitMessages();
	}

	private handleToolExecutionEnd(
		toolCallId: string,
		metadata: {
			displayName?: string;
			isError: boolean;
			result: unknown;
			summaryLabel?: string;
		},
	): void {
		const toolInfo = this.activeTools.get(toolCallId);
		if (toolInfo && this.assistantMessage.tools) {
			const tool = this.assistantMessage.tools[
				toolInfo.index
			] as ExtendedToolCall;
			tool.status = metadata.isError ? "error" : "completed";
			tool.result = metadata.result;
			tool.endTime = Date.now();
			tool.displayName = metadata.displayName ?? tool.displayName;
			tool.summaryLabel = metadata.summaryLabel ?? tool.summaryLabel;
			this.callbacks.commitMessages();
		}
		this.activeTools.delete(toolCallId);
	}

	private coerceMessageContent(content: Message["content"]): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((item) => (item?.type === "text" ? item.text : ""))
			.join("");
	}
}
