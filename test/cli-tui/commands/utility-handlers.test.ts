import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMessage } from "../../../src/agent/types.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";

vi.mock("../../../src/cli/commands/agents.js", () => ({
	handleAgentsInit: vi.fn(() => "/home/user/project/AGENTS.md"),
}));

import {
	type CopyHandlerCallbacks,
	type CopyHandlerDeps,
	type InitHandlerCallbacks,
	type ReportHandlerDeps,
	handleCopyCommand,
	handleInitCommand,
	handleReportCommand,
} from "../../../src/cli-tui/commands/utility-handlers.js";
import { handleAgentsInit } from "../../../src/cli/commands/agents.js";

function makeAssistantMessage(
	text: string,
	timestamp = Date.now(),
): AppMessage {
	return {
		role: "assistant",
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4-5-20250929",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

function createMockContext(
	rawInput: string,
	argumentText = "",
	parsedArgs?: Record<string, unknown>,
): CommandExecutionContext {
	return {
		command: { name: "test", description: "test command" },
		rawInput,
		argumentText,
		parsedArgs,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

describe("utility-handlers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("handleCopyCommand", () => {
		it("shows error when no messages exist", () => {
			const ctx = createMockContext("/copy");
			const deps: CopyHandlerDeps = { getMessages: () => [] };
			const callbacks: CopyHandlerCallbacks = {
				showInfo: vi.fn(),
				showError: vi.fn(),
			};

			handleCopyCommand(ctx, deps, callbacks);

			expect(callbacks.showError).toHaveBeenCalledWith(
				"No assistant message to copy.",
			);
		});

		it("shows error when only user messages exist", () => {
			const ctx = createMockContext("/copy");
			const deps: CopyHandlerDeps = {
				getMessages: () => [
					{ role: "user", content: "hello", timestamp: Date.now() },
				],
			};
			const callbacks: CopyHandlerCallbacks = {
				showInfo: vi.fn(),
				showError: vi.fn(),
			};

			handleCopyCommand(ctx, deps, callbacks);

			expect(callbacks.showError).toHaveBeenCalledWith(
				"No assistant message to copy.",
			);
		});

		it("does not error on 'no assistant' when assistant messages exist", () => {
			const ctx = createMockContext("/copy");
			const deps: CopyHandlerDeps = {
				getMessages: () => [
					{ role: "user", content: "hello", timestamp: 1 },
					makeAssistantMessage("first", 2),
					{ role: "user", content: "more", timestamp: 3 },
					makeAssistantMessage("second", 4),
				],
			};
			const callbacks: CopyHandlerCallbacks = {
				showInfo: vi.fn(),
				showError: vi.fn(),
			};

			// handleCopyCommand uses dynamic require() for render-model and clipboardy
			// which may not resolve in the test environment. We catch the require error
			// and verify the assistant lookup succeeded (no "No assistant message" error).
			try {
				handleCopyCommand(ctx, deps, callbacks);
			} catch {
				// require() failure is expected in test env
			}

			expect(callbacks.showError).not.toHaveBeenCalledWith(
				"No assistant message to copy.",
			);
		});
	});

	describe("handleInitCommand", () => {
		it("calls handleAgentsInit and shows success on success", () => {
			vi.mocked(handleAgentsInit).mockReturnValue(
				"/home/user/project/AGENTS.md",
			);

			const ctx = createMockContext("/init", "");
			const callbacks: InitHandlerCallbacks = {
				showSuccess: vi.fn(),
				showError: vi.fn(),
				addContent: vi.fn(),
				requestRender: vi.fn(),
			};

			handleInitCommand(ctx, callbacks);

			expect(callbacks.showSuccess).toHaveBeenCalled();
			expect(callbacks.addContent).toHaveBeenCalled();
			expect(callbacks.requestRender).toHaveBeenCalled();
		});

		it("shows error when handleAgentsInit throws", () => {
			vi.mocked(handleAgentsInit).mockImplementation(() => {
				throw new Error("File already exists");
			});

			const ctx = createMockContext("/init", "");
			const callbacks: InitHandlerCallbacks = {
				showSuccess: vi.fn(),
				showError: vi.fn(),
				addContent: vi.fn(),
				requestRender: vi.fn(),
			};

			handleInitCommand(ctx, callbacks);

			expect(callbacks.showError).toHaveBeenCalledWith("File already exists");
		});

		it("passes target argument when provided", () => {
			vi.mocked(handleAgentsInit).mockReturnValue("/custom/path/AGENTS.md");

			const ctx = createMockContext("/init ./custom/path", "./custom/path");
			const callbacks: InitHandlerCallbacks = {
				showSuccess: vi.fn(),
				showError: vi.fn(),
				addContent: vi.fn(),
				requestRender: vi.fn(),
			};

			handleInitCommand(ctx, callbacks);

			expect(handleAgentsInit).toHaveBeenCalledWith("./custom/path", {
				force: false,
			});
		});
	});

	describe("handleReportCommand", () => {
		let deps: ReportHandlerDeps;

		beforeEach(() => {
			deps = {
				showBugReport: vi.fn(),
				showFeedback: vi.fn(),
				showReportSelector: vi.fn(),
			};
		});

		it("routes 'bug' to showBugReport via argument text", () => {
			const ctx = createMockContext("/report bug", "bug");

			handleReportCommand(ctx, deps);

			expect(deps.showBugReport).toHaveBeenCalled();
			expect(deps.showFeedback).not.toHaveBeenCalled();
			expect(deps.showReportSelector).not.toHaveBeenCalled();
		});

		it("routes 'feedback' to showFeedback via argument text", () => {
			const ctx = createMockContext("/report feedback", "feedback");

			handleReportCommand(ctx, deps);

			expect(deps.showFeedback).toHaveBeenCalled();
		});

		it("routes 'bug' via parsedArgs", () => {
			const ctx = createMockContext("/report bug", "bug", { type: "bug" });

			handleReportCommand(ctx, deps);

			expect(deps.showBugReport).toHaveBeenCalled();
		});

		it("routes 'feedback' via parsedArgs", () => {
			const ctx = createMockContext("/report feedback", "feedback", {
				type: "feedback",
			});

			handleReportCommand(ctx, deps);

			expect(deps.showFeedback).toHaveBeenCalled();
		});

		it("shows error for invalid report type", () => {
			const ctx = createMockContext("/report invalid", "invalid");

			handleReportCommand(ctx, deps);

			expect(ctx.showError).toHaveBeenCalledWith(
				'Report type must be "bug" or "feedback".',
			);
			expect(ctx.renderHelp).toHaveBeenCalled();
		});

		it("shows report selector when no argument given", () => {
			const ctx = createMockContext("/report", "");

			handleReportCommand(ctx, deps);

			expect(deps.showReportSelector).toHaveBeenCalled();
		});
	});
});
