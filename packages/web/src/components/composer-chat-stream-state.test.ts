import { describe, expect, it, vi } from "vitest";
import {
	ComposerChatStreamState,
	type UiMessage,
} from "./composer-chat-stream-state.js";

function createStreamState(assistantMessage?: UiMessage) {
	const commitMessages = vi.fn();
	const setRuntimeStatus = vi.fn();
	const onSessionUpdate = vi.fn();
	const enqueueApprovalRequest = vi.fn();
	const clearApprovalRequest = vi.fn();
	const enqueueToolRetryRequest = vi.fn();
	const clearToolRetryRequest = vi.fn();
	const handleClientToolRequest = vi.fn().mockResolvedValue(undefined);
	const message: UiMessage = assistantMessage ?? {
		role: "assistant",
		content: "",
		timestamp: "",
		tools: [],
		thinking: "",
	};
	const streamState = new ComposerChatStreamState(message, {
		commitMessages,
		setRuntimeStatus,
		onSessionUpdate,
		enqueueApprovalRequest,
		clearApprovalRequest,
		enqueueToolRetryRequest,
		clearToolRetryRequest,
		handleClientToolRequest,
	});

	return {
		clearApprovalRequest,
		commitMessages,
		enqueueApprovalRequest,
		enqueueToolRetryRequest,
		clearToolRetryRequest,
		handleClientToolRequest,
		message,
		onSessionUpdate,
		setRuntimeStatus,
		streamState,
	};
}

describe("ComposerChatStreamState", () => {
	it("reconstructs tool call args from deltas and tracks execution state", async () => {
		const { message, streamState } = createStreamState();

		await streamState.handleEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				toolCallId: "call_1",
				toolCallName: "read_file",
			},
		} as never);
		await streamState.handleEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				toolCallId: "call_1",
				toolCallName: "read_file",
				delta: '{"path":"/tmp',
			},
		} as never);
		await streamState.handleEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				toolCallId: "call_1",
				toolCallName: "read_file",
				delta: '/test.txt","mode":"r"}',
			},
		} as never);
		await streamState.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
		} as never);
		await streamState.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call_1",
			isError: false,
			result: { ok: true },
		} as never);

		expect(message.tools).toHaveLength(1);
		expect(message.tools?.[0]).toMatchObject({
			toolCallId: "call_1",
			name: "read_file",
			args: { path: "/tmp/test.txt", mode: "r" },
			status: "completed",
			result: { ok: true },
		});
	});

	it("tracks session updates, thinking deltas, and terminal outcomes", async () => {
		const { message, onSessionUpdate, streamState } = createStreamState();

		await streamState.handleEvent({
			type: "session_update",
			sessionId: "session-2",
		} as never);
		await streamState.handleEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_start",
				contentIndex: 0,
			},
		} as never);
		await streamState.handleEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Reasoning summary",
			},
		} as never);
		await streamState.handleEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
			},
		} as never);
		await streamState.handleEvent({
			type: "error",
			message: "Stream failed",
		} as never);

		expect(onSessionUpdate).toHaveBeenCalledWith("session-2");
		expect(message.thinking).toContain("Reasoning summary");
		expect(streamState.getOutcome()).toEqual({
			message: "Stream failed",
			type: "error",
		});
	});
});
