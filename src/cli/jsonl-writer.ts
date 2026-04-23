import type { Writable } from "node:stream";
import type {
	AgentEvent,
	AppMessage,
	AssistantMessage,
	TextContent,
} from "../agent/types.js";

export type JsonlEvent =
	| {
			type: "thread";
			phase: "start" | "end";
			threadId: string;
			sessionId?: string;
			timestamp: string;
			sandbox?: string;
			cwd?: string;
			status?: "ok" | "error";
	  }
	| {
			type: "turn";
			phase: "start" | "end";
			turnId: string;
			role: "user" | "assistant" | "tool";
			timestamp: string;
			text?: string;
	  }
	| {
			type: "item";
			subtype:
				| "message_delta"
				| "message_complete"
				| "tool_call"
				| "tool_result"
				| "tool_update"
				| "approval"
				| "tool_retry";
			turnId?: string;
			timestamp: string;
			data?: unknown;
	  }
	| {
			type: "done";
			status: "ok" | "error";
			timestamp: string;
			sessionId?: string;
	  }
	| {
			type: "error";
			message: string;
			timestamp: string;
			stack?: string;
	  };

export class JsonlEventWriter {
	constructor(
		private readonly enabled: boolean,
		private readonly stream: Writable = process.stdout,
	) {}

	emit(event: JsonlEvent): void {
		if (!this.enabled) {
			return;
		}
		this.stream.write(`${JSON.stringify(event)}\n`);
	}
}

const now = (): string => new Date().toISOString();

const isTextChunk = (chunk: unknown): chunk is TextContent =>
	typeof chunk === "object" &&
	chunk !== null &&
	"type" in chunk &&
	(chunk as { type?: unknown }).type === "text" &&
	"text" in chunk &&
	typeof (chunk as { text?: unknown }).text === "string";

const extractText = (message: AppMessage | undefined): string => {
	if (!message) return "";
	const content = (message as { content?: unknown }).content;
	if (Array.isArray(content)) {
		return content
			.filter(isTextChunk)
			.map((chunk) => chunk.text)
			.join("");
	}
	if (typeof content === "string") {
		return content;
	}
	return "";
};

const isAssistantMessage = (message: AppMessage): message is AssistantMessage =>
	(message as { role?: unknown }).role === "assistant";

export interface AgentJsonlAdapter {
	handle(event: AgentEvent): void;
	getLastAssistantText(): string;
}

export function createAgentJsonlAdapter(
	writer: JsonlEventWriter,
	nextTurnId: () => string,
): AgentJsonlAdapter {
	let currentAssistantTurn: string | null = null;
	let lastAssistantText = "";

	return {
		handle(event: AgentEvent) {
			switch (event.type) {
				case "message_start": {
					if (!isAssistantMessage(event.message)) {
						break;
					}
					currentAssistantTurn = nextTurnId();
					writer.emit({
						type: "turn",
						phase: "start",
						role: "assistant",
						turnId: currentAssistantTurn,
						timestamp: now(),
					});
					break;
				}
				case "message_update": {
					if (!isAssistantMessage(event.message)) {
						break;
					}
					if (!currentAssistantTurn) {
						currentAssistantTurn = nextTurnId();
						writer.emit({
							type: "turn",
							phase: "start",
							role: "assistant",
							turnId: currentAssistantTurn,
							timestamp: now(),
						});
					}
					writer.emit({
						type: "item",
						subtype: "message_delta",
						turnId: currentAssistantTurn,
						timestamp: now(),
						data: { text: extractText(event.message) },
					});
					break;
				}
				case "message_end": {
					if (!isAssistantMessage(event.message)) {
						break;
					}
					lastAssistantText = extractText(event.message);
					const turnId = currentAssistantTurn ?? nextTurnId();
					const data: Record<string, unknown> = {
						text: extractText(event.message),
					};
					data.usage = event.message.usage;
					data.stopReason = event.message.stopReason;
					data.model = event.message.model;
					data.provider = event.message.provider;
					data.api = event.message.api;
					writer.emit({
						type: "item",
						subtype: "message_complete",
						turnId,
						timestamp: now(),
						data,
					});
					writer.emit({
						type: "turn",
						phase: "end",
						turnId,
						role: "assistant",
						timestamp: now(),
					});
					currentAssistantTurn = null;
					break;
				}
				case "tool_execution_start": {
					writer.emit({
						type: "item",
						subtype: "tool_call",
						timestamp: now(),
						data: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
						},
					});
					break;
				}
				case "tool_execution_end": {
					const data: Record<string, unknown> = {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					};
					if (event.errorCode) {
						data.errorCode = event.errorCode;
					}
					if (event.approvalRequestId) {
						data.approvalRequestId = event.approvalRequestId;
					}
					if (event.governedOutcome) {
						data.governedOutcome = event.governedOutcome;
					}
					if (event.skillMetadata) {
						data.skillMetadata = event.skillMetadata;
					}
					writer.emit({
						type: "item",
						subtype: "tool_result",
						timestamp: now(),
						data,
					});
					break;
				}
				case "tool_execution_update": {
					writer.emit({
						type: "item",
						subtype: "tool_update",
						timestamp: now(),
						data: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							partialResult: event.partialResult,
						},
					});
					break;
				}
				case "action_approval_required": {
					writer.emit({
						type: "item",
						subtype: "approval",
						timestamp: now(),
						data: { request: event.request },
					});
					break;
				}
				case "action_approval_resolved": {
					writer.emit({
						type: "item",
						subtype: "approval",
						timestamp: now(),
						data: { request: event.request, decision: event.decision },
					});
					break;
				}
				case "tool_retry_required": {
					writer.emit({
						type: "item",
						subtype: "tool_retry",
						timestamp: now(),
						data: { request: event.request },
					});
					break;
				}
				case "tool_retry_resolved": {
					writer.emit({
						type: "item",
						subtype: "tool_retry",
						timestamp: now(),
						data: { request: event.request, decision: event.decision },
					});
					break;
				}
				default:
					break;
			}
		},
		getLastAssistantText() {
			return lastAssistantText;
		},
	};
}

export function emitUserTurn(
	writer: JsonlEventWriter,
	nextTurnId: () => string,
	text: string,
): string {
	const turnId = nextTurnId();
	const stamp = now();
	writer.emit({
		type: "turn",
		phase: "start",
		turnId,
		role: "user",
		timestamp: stamp,
		text,
	});
	writer.emit({
		type: "item",
		subtype: "message_complete",
		turnId,
		timestamp: now(),
		data: { text },
	});
	writer.emit({
		type: "turn",
		phase: "end",
		turnId,
		role: "user",
		timestamp: now(),
	});
	return turnId;
}

export function emitThreadStart(
	writer: JsonlEventWriter,
	threadId: string,
	options: { sandboxMode?: string; cwd?: string; sessionId?: string } = {},
): void {
	writer.emit({
		type: "thread",
		phase: "start",
		threadId,
		sessionId: options.sessionId,
		sandbox: options.sandboxMode,
		cwd: options.cwd,
		timestamp: now(),
	});
}

export function emitThreadEnd(
	writer: JsonlEventWriter,
	threadId: string,
	status: "ok" | "error",
	sessionId?: string,
): void {
	writer.emit({
		type: "thread",
		phase: "end",
		threadId,
		sessionId,
		status,
		timestamp: now(),
	});
}
