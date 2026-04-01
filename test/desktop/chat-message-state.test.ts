import type { ComposerAgentEvent, ComposerMessage } from "@evalops/contracts";
import { describe, expect, it } from "vitest";
import {
	applyAgentEventToMessage,
	createAssistantStreamingState,
	normalizeServerMessage,
} from "../../packages/desktop/src/renderer/lib/chat-message-state";
import type { Message } from "../../packages/desktop/src/renderer/lib/types";

describe("desktop chat message state", () => {
	it("normalizes server assistant messages with tool calls", () => {
		const message: ComposerMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Investigating" }],
			thinking: "Reasoning",
			tools: [
				{
					toolCallId: "call-1",
					name: "read",
					status: "completed",
					args: { path: "src/app.ts" },
					result: { ok: true },
				},
			],
		};

		expect(normalizeServerMessage(message)).toEqual({
			role: "assistant",
			content: "Investigating",
			thinking: "Reasoning",
			timestamp: undefined,
			id: undefined,
			toolCalls: [
				{
					id: "call-1",
					name: "read",
					status: "success",
					args: { path: "src/app.ts" },
					result: JSON.stringify({ ok: true }, null, 2),
				},
			],
		});
	});

	it("ignores unsupported server roles", () => {
		const message: ComposerMessage = {
			role: "tool",
			content: "read result",
		};

		expect(normalizeServerMessage(message)).toBeNull();
	});

	it("tracks tool call lifecycle during streaming", () => {
		const message: Message = {
			role: "assistant",
			content: "",
		};
		const state = createAssistantStreamingState();

		const startEvent: ComposerAgentEvent = {
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				toolCallId: "call-1",
				toolCallName: "read",
				toolCallArgs: { path: "src/app.ts" },
			},
		};
		const runEvent: ComposerAgentEvent = {
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/app.ts" },
		};
		const updateEvent: ComposerAgentEvent = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "read",
			args: { path: "src/app.ts" },
			partialResult: { lines: 42 },
		};
		const endEvent: ComposerAgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: "done",
			isError: false,
		};

		applyAgentEventToMessage(message, startEvent, state);
		applyAgentEventToMessage(message, runEvent, state);
		applyAgentEventToMessage(message, updateEvent, state);
		applyAgentEventToMessage(message, endEvent, state);

		expect(message.toolCalls).toEqual([
			{
				id: "call-1",
				name: "read",
				args: { path: "src/app.ts" },
				status: "success",
				result: "done",
			},
		]);
	});

	it("hydrates final assistant content and tools from message_end", () => {
		const message: Message = {
			role: "assistant",
			content: "",
		};
		const state = createAssistantStreamingState();
		const event: ComposerAgentEvent = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Finished" }],
				thinking: "Done reasoning",
				tools: [
					{
						toolCallId: "call-9",
						name: "search",
						status: "completed",
						args: { pattern: "TODO" },
						result: "match",
					},
				],
			},
		};

		applyAgentEventToMessage(message, event, state);

		expect(message).toEqual({
			role: "assistant",
			content: "Finished",
			thinking: "Done reasoning",
			toolCalls: [
				{
					id: "call-9",
					name: "search",
					status: "success",
					args: { pattern: "TODO" },
					result: "match",
				},
			],
		});
	});
});
