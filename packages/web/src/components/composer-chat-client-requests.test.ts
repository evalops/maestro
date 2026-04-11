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
