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
	pendingMcpElicitationQueue: Array<Record<string, unknown>>;
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
	it("restores pending approval, tool-retry, MCP elicitation, and user-input queues without auto-failing pending prompts", async () => {
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
						toolCallId: "mcp-call-1",
						toolName: "mcp_elicitation",
						args: {
							serverName: "context7",
							requestId: "request-1",
							mode: "form",
							message: "Provide the project name",
							requestedSchema: {
								type: "object",
								properties: {
									project: { type: "string" },
								},
								required: ["project"],
							},
						},
						kind: "mcp_elicitation",
					},
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
		expect(element.pendingMcpElicitationQueue).toEqual([
			{
				toolCallId: "mcp-call-1",
				toolName: "mcp_elicitation",
				args: {
					serverName: "context7",
					requestId: "request-1",
					mode: "form",
					message: "Provide the project name",
					requestedSchema: {
						type: "object",
						properties: {
							project: { type: "string" },
						},
						required: ["project"],
					},
				},
				kind: "mcp_elicitation",
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

	it("rehydrates pending queues from normalized pendingRequests after attach", async () => {
		const element = createChat();
		const sendClientToolResult = vi.fn().mockResolvedValue({ success: true });
		element.apiClient = {
			createSession: vi.fn(),
			getSession: vi.fn().mockResolvedValue({
				id: "session-platform",
				messages: [],
				pendingRequests: [
					{
						id: "approval-platform",
						kind: "approval",
						status: "pending",
						visibility: "user",
						sessionId: "session-platform",
						toolCallId: "approval-platform",
						toolName: "bash",
						displayName: "Run shell command",
						summaryLabel: "Needs command approval",
						actionDescription: "npm test",
						args: { command: "npm test" },
						reason: "Platform approval wait",
						createdAt: "2026-04-23T23:00:00.000Z",
						source: "platform",
						platform: {
							source: "tool_execution",
							toolExecutionId: "texec-1",
							approvalRequestId: "approval-platform",
						},
					},
					{
						id: "retry-platform",
						kind: "tool_retry",
						status: "pending",
						visibility: "user",
						sessionId: "session-platform",
						toolCallId: "tool-call-platform",
						toolName: "read",
						args: {
							tool_call_id: "tool-call-platform",
							args: { file: "README.md" },
							error_message: "timed out",
							attempt: 2,
						},
						reason: "timed out",
						createdAt: "2026-04-23T23:00:01.000Z",
						source: "local",
					},
					{
						id: "user-platform",
						kind: "user_input",
						status: "pending",
						visibility: "user",
						sessionId: "session-platform",
						toolCallId: "client-call-platform",
						toolName: "ask_user",
						args: {
							questions: [
								{
									header: "Mode",
									question: "How should we proceed?",
									options: [
										{
											label: "Continue",
											description: "Keep going",
										},
									],
								},
							],
						},
						reason: "Agent requested structured user input",
						createdAt: "2026-04-23T23:00:02.000Z",
						source: "platform",
					},
				],
			}),
			sendClientToolResult,
		};

		await element.selectSession("session-platform");
		await flushAsyncWork();

		expect(element.pendingApprovalQueue).toEqual([
			{
				id: "approval-platform",
				toolName: "bash",
				displayName: "Run shell command",
				summaryLabel: "Needs command approval",
				actionDescription: "npm test",
				args: { command: "npm test" },
				reason: "Platform approval wait",
				platform: {
					source: "tool_execution",
					toolExecutionId: "texec-1",
					approvalRequestId: "approval-platform",
				},
			},
		]);
		expect(element.pendingToolRetryQueue).toEqual([
			{
				id: "retry-platform",
				toolCallId: "tool-call-platform",
				toolName: "read",
				args: { file: "README.md" },
				errorMessage: "timed out",
				attempt: 2,
				maxAttempts: undefined,
				summary: undefined,
			},
		]);
		expect(element.pendingUserInputQueue).toEqual([
			{
				toolCallId: "client-call-platform",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Mode",
							question: "How should we proceed?",
							options: [
								{
									label: "Continue",
									description: "Keep going",
								},
							],
						},
					],
				},
				kind: "user_input",
				reason: "Agent requested structured user input",
			},
		]);
		expect(sendClientToolResult).not.toHaveBeenCalled();
	});

	it("restores pending queues after the current-session update cycle runs", async () => {
		const element = createChat();
		let flushedSessionUpdate = false;
		Object.defineProperty(element, "updateComplete", {
			configurable: true,
			get: () =>
				Promise.resolve().then(() => {
					if (!flushedSessionUpdate) {
						flushedSessionUpdate = true;
						(
							element as SessionPendingInternals & {
								updated: (changed: Map<string, unknown>) => void;
							}
						).updated(new Map([["currentSessionId", null]]));
					}
				}),
		});
		element.apiClient = {
			createSession: vi.fn(),
			getSession: vi.fn().mockResolvedValue({
				id: "session-2",
				messages: [],
				pendingApprovalRequests: [
					{
						id: "approval-restored",
						toolName: "bash",
						args: { command: "echo hi" },
						reason: "Needs approval",
					},
				],
				pendingToolRetryRequests: [],
				pendingClientToolRequests: [
					{
						toolCallId: "client-call-restored",
						toolName: "ask_user",
						args: {
							questions: [
								{
									header: "Mode",
									question: "Continue?",
									options: [
										{
											label: "Yes",
											description: "Keep going",
										},
									],
								},
							],
						},
						kind: "user_input",
					},
				],
			}),
			sendClientToolResult: vi.fn(),
		};

		await element.selectSession("session-2");

		expect(element.pendingApprovalQueue).toEqual([
			{
				id: "approval-restored",
				toolName: "bash",
				args: { command: "echo hi" },
				reason: "Needs approval",
			},
		]);
		expect(element.pendingUserInputQueue).toEqual([
			{
				toolCallId: "client-call-restored",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Mode",
							question: "Continue?",
							options: [
								{
									label: "Yes",
									description: "Keep going",
								},
							],
						},
					],
				},
				kind: "user_input",
			},
		]);
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
			createSession: vi.fn().mockResolvedValue({
				id: "session-live",
				messages: [],
			}),
			getSession: vi.fn().mockResolvedValue(recoveredSession),
			getSessions: vi.fn().mockResolvedValue([]),
			sendClientToolResult: vi.fn().mockResolvedValue({ success: true }),
		};
		element.clientOnline = true;
		element.currentSessionId = null;
		element.messages = [];
		element.pendingApprovalQueue = [];
		element.pendingMcpElicitationQueue = [];
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

	it("precreates a new session so websocket failures before session_update can still recover pending queues", async () => {
		const element = createChat();
		const recoveredSession = {
			id: "session-precreated",
			messages: [],
			pendingApprovalRequests: [
				{
					id: "approval-precreated",
					toolName: "bash",
					args: { command: "git push --force" },
					reason: "Needs approval",
				},
			],
			pendingToolRetryRequests: [],
			pendingClientToolRequests: [
				{
					toolCallId: "client-call-precreated",
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
					yield { type: "status", status: "connecting" };
					throw new Error("WebSocket closed before completion");
				})(),
			),
			createSession: vi.fn().mockResolvedValue({
				id: "session-precreated",
				messages: [],
			}),
			getSession: vi.fn().mockResolvedValue(recoveredSession),
			getSessions: vi.fn().mockResolvedValue([]),
			sendClientToolResult: vi.fn().mockResolvedValue({ success: true }),
		};
		element.clientOnline = true;
		element.currentSessionId = null;
		element.messages = [];
		element.pendingApprovalQueue = [];
		element.pendingMcpElicitationQueue = [];
		element.pendingToolRetryQueue = [];
		element.pendingUserInputQueue = [];

		await element.handleSubmit?.(
			new CustomEvent("submit", { detail: { text: "run the command" } }),
		);
		await flushAsyncWork();

		expect(element.apiClient.getSessions).toHaveBeenCalledTimes(1);
		expect(element.apiClient.createSession).toHaveBeenCalledWith("New Chat");
		expect(element.apiClient.chatWithEvents).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-precreated" }),
		);
		expect(element.apiClient.getSession).toHaveBeenCalledWith(
			"session-precreated",
		);
		expect(element.currentSessionId).toBe("session-precreated");
		expect(element.pendingApprovalQueue).toEqual(
			recoveredSession.pendingApprovalRequests,
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
		element.pendingMcpElicitationQueue = [];
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
			createSession: vi.fn().mockResolvedValue({
				id: "session-refresh-failure",
				messages: [],
			}),
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
