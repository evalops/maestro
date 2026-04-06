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
		chatWithEvents?: ReturnType<typeof vi.fn>;
		createSession: ReturnType<typeof vi.fn>;
		getSession: ReturnType<typeof vi.fn>;
		getSessions?: ReturnType<typeof vi.fn>;
		sendClientToolResult: ReturnType<typeof vi.fn>;
	};
	clientOnline?: boolean;
	currentSessionId?: string | null;
	refreshUiState: ReturnType<typeof vi.fn>;
	requestUpdate: ReturnType<typeof vi.fn>;
	scrollToBottom: ReturnType<typeof vi.fn>;
	updateComplete: Promise<void>;
	messages?: Array<Record<string, unknown>>;
	pendingApprovalQueue: Array<Record<string, unknown>>;
	pendingToolRetryQueue: Array<Record<string, unknown>>;
	pendingUserInputQueue: Array<Record<string, unknown>>;
	handleSubmit?: (event: CustomEvent<{ text: string }>) => Promise<void>;
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

	it("recovers pending queues from a websocket-born session after a stream error", async () => {
		const element = createChat();
		const recoveredSession = {
			id: "session-live",
			messages: [],
			pendingApprovalRequests: [
				{
					id: "approval-live",
					toolName: "bash",
					args: { command: "git push --force" },
					reason: "Needs approval",
				},
			],
			pendingToolRetryRequests: [
				{
					id: "retry-live",
					toolCallId: "tool-call-live",
					toolName: "read",
					args: { file: "README.md" },
					errorMessage: "timed out",
					attempt: 1,
				},
			],
			pendingClientToolRequests: [
				{
					toolCallId: "client-call-live",
					toolName: "ask_user",
					args: {
						questions: [
							{
								header: "Mode",
								question: "How should we proceed?",
								options: [
									{
										label: "Retry",
										description: "Try again",
									},
								],
							},
						],
					},
					kind: "user_input",
				},
			],
		};

		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "session_update", sessionId: "session-live" };
					throw new Error("WebSocket connection failed");
				})(),
			),
			createSession: vi.fn(),
			getSession: vi.fn().mockResolvedValue(recoveredSession),
			getSessions: vi.fn().mockResolvedValue([]),
			sendClientToolResult: vi.fn().mockResolvedValue({ success: true }),
		};
		element.clientOnline = true;
		element.currentSessionId = null;
		element.messages = [];
		element.pendingApprovalQueue = [];
		element.pendingToolRetryQueue = [];
		element.pendingUserInputQueue = [];

		await element.handleSubmit?.(
			new CustomEvent("submit", { detail: { text: "run the command" } }),
		);
		await flushAsyncWork();

		expect(element.apiClient.getSession).toHaveBeenCalledWith("session-live");
		expect(element.currentSessionId).toBe("session-live");
		expect(element.pendingApprovalQueue).toEqual(
			recoveredSession.pendingApprovalRequests,
		);
		expect(element.pendingToolRetryQueue).toEqual(
			recoveredSession.pendingToolRetryRequests,
		);
		expect(element.pendingUserInputQueue).toEqual(
			recoveredSession.pendingClientToolRequests,
		);
	});

	it("recovers pending queues for an existing session after a stream error", async () => {
		const element = createChat();
		const recoveredSession = {
			id: "session-existing",
			messages: [],
			pendingApprovalRequests: [
				{
					id: "approval-existing",
					toolName: "write",
					args: { path: "/tmp/demo.txt" },
					reason: "Writes a file",
				},
			],
			pendingToolRetryRequests: [],
			pendingClientToolRequests: [],
		};

		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(
				(async function* () {
					yield { type: "status", status: "connecting" };
					throw new Error("WebSocket connection failed");
				})(),
			),
			createSession: vi.fn(),
			getSession: vi.fn().mockResolvedValue(recoveredSession),
			getSessions: vi.fn().mockResolvedValue([]),
			sendClientToolResult: vi.fn().mockResolvedValue({ success: true }),
		};
		element.clientOnline = true;
		element.currentSessionId = "session-existing";
		element.messages = [];
		element.pendingApprovalQueue = [];
		element.pendingToolRetryQueue = [];
		element.pendingUserInputQueue = [];

		await element.handleSubmit?.(
			new CustomEvent("submit", { detail: { text: "write the file" } }),
		);
		await flushAsyncWork();

		expect(element.apiClient.getSession).toHaveBeenCalledWith(
			"session-existing",
		);
		expect(element.pendingApprovalQueue).toEqual(
			recoveredSession.pendingApprovalRequests,
		);
	});

	it("only recovers pending queues once when session refresh fails after a stream error", async () => {
		const element = createChat();
		const recoveredSession = {
			id: "session-refresh-failure",
			messages: [],
			pendingApprovalRequests: [
				{
					id: "approval-refresh-failure",
					toolName: "bash",
					args: { command: "git push --force" },
					reason: "Needs approval",
				},
			],
			pendingToolRetryRequests: [],
			pendingClientToolRequests: [],
		};

		element.apiClient = {
			chatWithEvents: vi.fn().mockReturnValue(
				(async function* () {
					yield {
						type: "session_update",
						sessionId: "session-refresh-failure",
					};
					yield { type: "error", message: "Stream failed" };
				})(),
			),
			createSession: vi.fn(),
			getSession: vi.fn().mockResolvedValue(recoveredSession),
			getSessions: vi
				.fn()
				.mockRejectedValue(new Error("Failed to refresh sessions")),
			sendClientToolResult: vi.fn().mockResolvedValue({ success: true }),
		};
		element.clientOnline = true;
		element.currentSessionId = null;
		element.messages = [];
		element.pendingApprovalQueue = [];
		element.pendingToolRetryQueue = [];
		element.pendingUserInputQueue = [];

		await element.handleSubmit?.(
			new CustomEvent("submit", { detail: { text: "run the command" } }),
		);
		await flushAsyncWork();

		expect(element.apiClient.getSession).toHaveBeenCalledTimes(1);
		expect(element.pendingApprovalQueue).toEqual(
			recoveredSession.pendingApprovalRequests,
		);
	});
});
