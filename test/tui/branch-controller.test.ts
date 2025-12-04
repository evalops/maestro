import { describe, expect, it, vi } from "vitest";
import type { AppMessage } from "../../src/agent/types.js";
import {
	BranchController,
	type BranchControllerCallbacks,
	type BranchControllerOptions,
} from "../../src/tui/session/branch-controller.js";

function createMockAgent(
	messages: AppMessage[] = [],
): BranchControllerOptions["agent"] {
	return {
		state: {
			messages,
		},
	} as BranchControllerOptions["agent"];
}

function createMockSessionManager(): BranchControllerOptions["sessionManager"] {
	return {
		createBranchedSession: vi.fn().mockReturnValue("/tmp/session.jsonl"),
		setSessionFile: vi.fn(),
	} as unknown as BranchControllerOptions["sessionManager"];
}

function createMockChatContainer(): BranchControllerOptions["chatContainer"] {
	return {
		addChild: vi.fn(),
	} as unknown as BranchControllerOptions["chatContainer"];
}

function createMockUI(): BranchControllerOptions["ui"] {
	return {} as BranchControllerOptions["ui"];
}

function createMockNotificationView(): BranchControllerOptions["notificationView"] {
	return {
		showError: vi.fn(),
		showInfo: vi.fn(),
	} as unknown as BranchControllerOptions["notificationView"];
}

function createMockSessionContext(): BranchControllerOptions["sessionContext"] {
	return {} as BranchControllerOptions["sessionContext"];
}

function createMockCallbacks(
	overrides: Partial<BranchControllerCallbacks> = {},
): BranchControllerCallbacks {
	return {
		isAgentRunning: vi.fn().mockReturnValue(false),
		resetConversation: vi.fn(),
		requestRender: vi.fn(),
		showUserMessageSelector: vi.fn(),
		...overrides,
	};
}

function createUserMessage(content: string): AppMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function createUserMessageWithArrayContent(text: string): AppMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(content: string): AppMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

describe("BranchController", () => {
	describe("handleBranchCommand", () => {
		it("shows error when agent is running", () => {
			const callbacks = createMockCallbacks({
				isAgentRunning: vi.fn().mockReturnValue(true),
			});
			const showError = vi.fn();
			const showInfo = vi.fn();

			const controller = new BranchController({
				agent: createMockAgent(),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.handleBranchCommand("", showError, showInfo);

			expect(showError).toHaveBeenCalledWith(
				expect.stringContaining("Wait for the current run"),
			);
		});

		it("shows info when no user messages available", () => {
			const showError = vi.fn();
			const showInfo = vi.fn();

			const controller = new BranchController({
				agent: createMockAgent([]),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks: createMockCallbacks(),
			});

			controller.handleBranchCommand("", showError, showInfo);

			expect(showInfo).toHaveBeenCalledWith(
				"No user messages available to branch from yet.",
			);
		});

		it("shows interactive selector when no argument provided", () => {
			const callbacks = createMockCallbacks();
			const messages: AppMessage[] = [createUserMessage("Hello")];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.handleBranchCommand("", vi.fn(), vi.fn());

			expect(callbacks.showUserMessageSelector).toHaveBeenCalled();
		});

		it("renders branch list when argument is 'list'", () => {
			const chatContainer = createMockChatContainer();
			const callbacks = createMockCallbacks();
			const messages: AppMessage[] = [
				createUserMessage("First message"),
				createAssistantMessage("Response"),
				createUserMessage("Second message"),
			];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: chatContainer,
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.handleBranchCommand("list", vi.fn(), vi.fn());

			expect(chatContainer.addChild).toHaveBeenCalled();
			expect(callbacks.requestRender).toHaveBeenCalled();
		});

		it("shows error for invalid branch number", () => {
			const showError = vi.fn();
			const messages: AppMessage[] = [createUserMessage("Hello")];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks: createMockCallbacks(),
			});

			controller.handleBranchCommand("abc", showError, vi.fn());

			expect(showError).toHaveBeenCalledWith(
				"Provide a valid user message number to branch from.",
			);
		});

		it("shows error for zero or negative number", () => {
			const showError = vi.fn();
			const messages: AppMessage[] = [createUserMessage("Hello")];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks: createMockCallbacks(),
			});

			controller.handleBranchCommand("0", showError, vi.fn());
			expect(showError).toHaveBeenCalledWith(
				"Provide a valid user message number to branch from.",
			);

			showError.mockClear();
			controller.handleBranchCommand("-1", showError, vi.fn());
			expect(showError).toHaveBeenCalledWith(
				"Provide a valid user message number to branch from.",
			);
		});

		it("shows error when branch number exceeds available messages", () => {
			const showError = vi.fn();
			const messages: AppMessage[] = [createUserMessage("Hello")];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks: createMockCallbacks(),
			});

			controller.handleBranchCommand("5", showError, vi.fn());

			expect(showError).toHaveBeenCalledWith("Only 1 user message available.");
		});

		it("resets conversation at correct message index", () => {
			const callbacks = createMockCallbacks();
			const messages: AppMessage[] = [
				createUserMessage("First user message"),
				createAssistantMessage("Response 1"),
				createUserMessage("Second user message"),
				createAssistantMessage("Response 2"),
			];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			// Branch from message 2 (second user message at index 2)
			controller.handleBranchCommand("2", vi.fn(), vi.fn());

			expect(callbacks.resetConversation).toHaveBeenCalledWith(
				[messages[0], messages[1]], // Messages before second user message
				"Second user message", // Editor seed
				"Branched to new session before user message #2.",
				expect.objectContaining({ preserveSession: true }),
			);
		});
	});

	describe("branchToIndex", () => {
		it("shows error when message index not found", () => {
			const notificationView = createMockNotificationView();
			const messages: AppMessage[] = [createUserMessage("Hello")];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: notificationView,
				sessionContext: createMockSessionContext(),
				callbacks: createMockCallbacks(),
			});

			controller.branchToIndex(5);

			expect(notificationView.showError).toHaveBeenCalledWith(
				"User message #5 not found",
			);
		});

		it("resets conversation for valid index", () => {
			const callbacks = createMockCallbacks();
			const messages: AppMessage[] = [
				createUserMessage("First message"),
				createAssistantMessage("Response"),
			];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.branchToIndex(1);

			expect(callbacks.resetConversation).toHaveBeenCalledWith(
				[], // No messages before first user message
				"First message",
				"Branched to new session before user message #1.",
				expect.objectContaining({ preserveSession: true }),
			);
		});
	});

	describe("content extraction", () => {
		it("extracts text from string content", () => {
			const callbacks = createMockCallbacks();
			const messages: AppMessage[] = [
				createUserMessage("Simple string content"),
			];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.branchToIndex(1);

			expect(callbacks.resetConversation).toHaveBeenCalledWith(
				[],
				"Simple string content",
				"Branched to new session before user message #1.",
				expect.objectContaining({ preserveSession: true }),
			);
		});

		it("extracts text from array content", () => {
			const callbacks = createMockCallbacks();
			const messages: AppMessage[] = [
				createUserMessageWithArrayContent("Array text content"),
			];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.branchToIndex(1);

			expect(callbacks.resetConversation).toHaveBeenCalledWith(
				[],
				"Array text content",
				"Branched to new session before user message #1.",
				expect.objectContaining({ preserveSession: true }),
			);
		});

		it("returns empty string for missing content", () => {
			const callbacks = createMockCallbacks();
			// Using empty string content to test edge case
			const messages: AppMessage[] = [createUserMessage("")];

			const controller = new BranchController({
				agent: createMockAgent(messages),
				sessionManager: createMockSessionManager(),
				chatContainer: createMockChatContainer(),
				ui: createMockUI(),
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				callbacks,
			});

			controller.branchToIndex(1);

			expect(callbacks.resetConversation).toHaveBeenCalledWith(
				[],
				"",
				"Branched to new session before user message #1.",
				expect.objectContaining({ preserveSession: true }),
			);
		});
	});
});
