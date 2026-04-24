import type {
	ComposerPendingClientToolRequest,
	ComposerToolRetryRequest,
} from "@evalops/contracts";
import { describe, expect, it, vi } from "vitest";
import { ComposerChatClientRequests } from "./composer-chat-client-requests.js";

function createClientRequestHarness() {
	const state = {
		pendingToolRetryQueue: [] as ComposerToolRetryRequest[],
		toolRetrySubmitting: false,
		pendingMcpElicitationQueue: [] as ComposerPendingClientToolRequest[],
		mcpElicitationSubmitting: false,
		pendingUserInputQueue: [] as ComposerPendingClientToolRequest[],
		userInputSubmitting: false,
	};
	const apiClient = {
		sendClientToolResult: vi.fn(),
		submitToolRetryDecision: vi.fn(),
	};
	const showToast = vi.fn();

	const clientRequests = new ComposerChatClientRequests(
		() => apiClient,
		() => state,
		(nextState) => {
			Object.assign(state, nextState);
		},
		showToast,
	);

	return {
		apiClient,
		clientRequests,
		showToast,
		state,
	};
}

describe("ComposerChatClientRequests", () => {
	it("replaces duplicate user input requests by toolCallId", () => {
		const { clientRequests, state } = createClientRequestHarness();

		clientRequests.enqueueUserInputRequest({
			toolCallId: "call-1",
			toolName: "ask_user",
			args: { questions: [{ header: "Stack" }] },
			kind: "user_input",
		});
		clientRequests.enqueueUserInputRequest({
			toolCallId: "call-1",
			toolName: "ask_user",
			args: { questions: [{ header: "Mode" }] },
			kind: "user_input",
		});

		expect(state.pendingUserInputQueue).toEqual([
			{
				toolCallId: "call-1",
				toolName: "ask_user",
				args: { questions: [{ header: "Mode" }] },
				kind: "user_input",
			},
		]);
	});

	it("restores persisted queues and returns only replayable requests", () => {
		const { clientRequests, state } = createClientRequestHarness();

		const replayable = clientRequests.restorePendingRequests({
			pendingToolRetryRequests: [
				{
					id: "retry-1",
					toolCallId: "tool-call-1",
					toolName: "bash",
					args: { command: "ls" },
					errorMessage: "failed",
					attempt: 1,
				},
			],
			pendingClientToolRequests: [
				{
					toolCallId: "mcp-1",
					toolName: "mcp_elicitation",
					args: { prompt: "project" },
					kind: "mcp_elicitation",
				},
				{
					toolCallId: "user-1",
					toolName: "ask_user",
					args: { questions: [{ header: "Mode" }] },
					kind: "user_input",
				},
				{
					toolCallId: "artifact-1",
					toolName: "artifacts",
					args: { command: "list" },
				},
			],
		});

		expect(state.pendingToolRetryQueue).toHaveLength(1);
		expect(state.pendingMcpElicitationQueue).toEqual([
			{
				toolCallId: "mcp-1",
				toolName: "mcp_elicitation",
				args: { prompt: "project" },
				kind: "mcp_elicitation",
			},
		]);
		expect(state.pendingUserInputQueue).toEqual([
			{
				toolCallId: "user-1",
				toolName: "ask_user",
				args: { questions: [{ header: "Mode" }] },
				kind: "user_input",
			},
		]);
		expect(replayable).toEqual([
			{
				toolCallId: "artifact-1",
				toolName: "artifacts",
				args: { command: "list" },
			},
		]);
	});

	it("restores normalized pending requests when split queues are absent", () => {
		const { clientRequests, state } = createClientRequestHarness();

		const replayable = clientRequests.restorePendingRequests({
			pendingRequests: [
				{
					id: "retry-1",
					kind: "tool_retry",
					status: "pending",
					visibility: "user",
					sessionId: "session-1",
					toolCallId: "tool-call-1",
					toolName: "bash",
					args: {
						tool_call_id: "tool-call-1",
						args: { command: "npm test" },
						error_message: "exit 1",
						attempt: 2,
						max_attempts: 3,
						summary: "Tests failed",
					},
					reason: "Tests failed",
					createdAt: "2026-04-23T23:00:00.000Z",
					source: "local",
				},
				{
					id: "mcp-1",
					kind: "mcp_elicitation",
					status: "pending",
					visibility: "user",
					sessionId: "session-1",
					toolCallId: "mcp-call-1",
					toolName: "mcp_elicitation",
					args: { prompt: "project" },
					reason: "MCP server requested more input",
					createdAt: "2026-04-23T23:00:01.000Z",
					source: "platform",
					platform: {
						source: "tool_execution",
						toolExecutionId: "texec-1",
					},
				},
				{
					id: "user-1",
					kind: "user_input",
					status: "pending",
					visibility: "user",
					sessionId: "session-1",
					toolCallId: "user-call-1",
					toolName: "ask_user",
					args: { questions: [{ header: "Mode" }] },
					reason: "Agent requested structured user input",
					createdAt: "2026-04-23T23:00:02.000Z",
					source: "platform",
				},
				{
					id: "artifact-1",
					kind: "client_tool",
					status: "pending",
					visibility: "user",
					sessionId: "session-1",
					toolCallId: "artifact-call-1",
					toolName: "artifacts",
					args: { command: "list" },
					reason: "Client tool requires local execution",
					createdAt: "2026-04-23T23:00:03.000Z",
					source: "local",
				},
			],
		});

		expect(state.pendingToolRetryQueue).toEqual([
			{
				id: "retry-1",
				toolCallId: "tool-call-1",
				toolName: "bash",
				args: { command: "npm test" },
				errorMessage: "exit 1",
				attempt: 2,
				maxAttempts: 3,
				summary: "Tests failed",
			},
		]);
		expect(state.pendingMcpElicitationQueue).toEqual([
			{
				toolCallId: "mcp-call-1",
				toolName: "mcp_elicitation",
				args: { prompt: "project" },
				kind: "mcp_elicitation",
				reason: "MCP server requested more input",
			},
		]);
		expect(state.pendingUserInputQueue).toEqual([
			{
				toolCallId: "user-call-1",
				toolName: "ask_user",
				args: { questions: [{ header: "Mode" }] },
				kind: "user_input",
				reason: "Agent requested structured user input",
			},
		]);
		expect(replayable).toEqual([
			{
				toolCallId: "artifact-call-1",
				toolName: "artifacts",
				args: { command: "list" },
				kind: "client_tool",
				reason: "Client tool requires local execution",
			},
		]);
	});

	it("lets normalized pending requests refresh legacy queue entries", () => {
		const { clientRequests, state } = createClientRequestHarness();

		clientRequests.restorePendingRequests({
			pendingClientToolRequests: [
				{
					toolCallId: "user-call-1",
					toolName: "ask_user",
					args: { questions: [{ header: "Old" }] },
					kind: "user_input",
				},
			],
			pendingRequests: [
				{
					id: "user-1",
					kind: "user_input",
					status: "pending",
					visibility: "user",
					sessionId: "session-1",
					toolCallId: "user-call-1",
					toolName: "ask_user",
					args: { questions: [{ header: "Latest" }] },
					reason: "Latest Platform wait projection",
					createdAt: "2026-04-23T23:00:00.000Z",
					source: "platform",
				},
			],
		});

		expect(state.pendingUserInputQueue).toEqual([
			{
				toolCallId: "user-call-1",
				toolName: "ask_user",
				args: { questions: [{ header: "Latest" }] },
				kind: "user_input",
				reason: "Latest Platform wait projection",
			},
		]);
	});

	it("submits MCP elicitation responses and clears the queue", async () => {
		const { apiClient, clientRequests, showToast, state } =
			createClientRequestHarness();
		apiClient.sendClientToolResult.mockResolvedValue(undefined);
		state.pendingMcpElicitationQueue = [
			{
				toolCallId: "mcp-1",
				toolName: "mcp_elicitation",
				args: { requestId: "req-1" },
				kind: "mcp_elicitation",
			},
		];

		await clientRequests.submitMcpElicitationResponse("mcp-1", "accept", {
			project: "maestro",
		});

		expect(apiClient.sendClientToolResult).toHaveBeenCalledWith({
			toolCallId: "mcp-1",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						action: "accept",
						content: { project: "maestro" },
					}),
				},
			],
			isError: false,
		});
		expect(state.pendingMcpElicitationQueue).toEqual([]);
		expect(state.mcpElicitationSubmitting).toBe(false);
		expect(showToast).toHaveBeenCalledWith(
			"MCP input submitted",
			"success",
			1500,
		);
	});
});
