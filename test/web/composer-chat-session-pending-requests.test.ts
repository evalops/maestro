// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index++) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

type SessionPendingInternals = {
	apiClient: {
		createSession: ReturnType<typeof vi.fn>;
		getSession: ReturnType<typeof vi.fn>;
		sendClientToolResult: ReturnType<typeof vi.fn>;
	};
	refreshUiState: ReturnType<typeof vi.fn>;
	requestUpdate: ReturnType<typeof vi.fn>;
	scrollToBottom: ReturnType<typeof vi.fn>;
	updateComplete: Promise<void>;
	pendingApprovalQueue: Array<Record<string, unknown>>;
	pendingToolRetryQueue: Array<Record<string, unknown>>;
	pendingUserInputQueue: Array<Record<string, unknown>>;
	selectSession: (sessionId: string) => Promise<void>;
};

function createChat() {
	const element = new ComposerChat() as unknown as SessionPendingInternals;
	element.refreshUiState = vi.fn().mockResolvedValue(undefined);
	element.requestUpdate = vi.fn();
	element.scrollToBottom = vi.fn();
	Object.defineProperty(element, "updateComplete", {
		configurable: true,
		value: Promise.resolve(),
	});
	return element;
}

describe("composer-chat session pending request restore", () => {
	it("restores pending approval, tool-retry, and user-input queues without auto-failing ask_user", async () => {
		const element = createChat();
		const sendClientToolResult = vi.fn().mockResolvedValue({ success: true });
		element.apiClient = {
			createSession: vi.fn(),
			getSession: vi.fn().mockResolvedValue({
				id: "session-2",
				messages: [],
				pendingApprovalRequests: [
					{
						id: "approval-1",
						toolName: "bash",
						args: { command: "echo hi" },
						reason: "Needs approval",
					},
				],
				pendingToolRetryRequests: [
					{
						id: "retry-1",
						toolCallId: "tool-call-1",
						toolName: "read",
						args: { file: "README.md" },
						errorMessage: "timed out",
						attempt: 2,
					},
				],
				pendingClientToolRequests: [
					{
						toolCallId: "client-call-1",
						toolName: "ask_user",
						args: {
							questions: [
								{
									header: "Stack",
									question: "Which schema library should we use?",
									options: [
										{
											label: "Zod",
											description: "Use Zod schemas",
										},
										{
											label: "Valibot",
											description: "Use Valibot schemas",
										},
									],
								},
							],
						},
						kind: "user_input",
					},
				],
			}),
			sendClientToolResult,
		};

		await element.selectSession("session-2");
		await flushAsyncWork();

		expect(element.pendingApprovalQueue).toEqual([
			{
				id: "approval-1",
				toolName: "bash",
				args: { command: "echo hi" },
				reason: "Needs approval",
			},
		]);
		expect(element.pendingToolRetryQueue).toEqual([
			{
				id: "retry-1",
				toolCallId: "tool-call-1",
				toolName: "read",
				args: { file: "README.md" },
				errorMessage: "timed out",
				attempt: 2,
			},
		]);
		expect(element.pendingUserInputQueue).toEqual([
			{
				toolCallId: "client-call-1",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
								{
									label: "Valibot",
									description: "Use Valibot schemas",
								},
							],
						},
					],
				},
				kind: "user_input",
			},
		]);
		expect(sendClientToolResult).not.toHaveBeenCalled();
	});
});
