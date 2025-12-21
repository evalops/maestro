import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
	type PasteEditorInterface,
	PasteHandler,
	type PasteHandlerOptions,
} from "../../src/cli-tui/paste/paste-handler.js";

interface MockAgent {
	generateSummary: Mock;
}

function createMockAgent(): MockAgent {
	return {
		generateSummary: vi.fn().mockResolvedValue({
			content: "Summary of the pasted content",
		}),
	};
}

function createMockNotificationView(): PasteHandlerOptions["notificationView"] {
	return {
		showInfo: vi.fn(),
		showToast: vi.fn(),
		showError: vi.fn(),
	} as unknown as PasteHandlerOptions["notificationView"];
}

function createMockSessionContext(): PasteHandlerOptions["sessionContext"] {
	return {
		recordPasteSummaryArtifact: vi.fn(),
	} as unknown as PasteHandlerOptions["sessionContext"];
}

function createMockEditor(): PasteEditorInterface {
	return {
		replacePasteMarker: vi.fn().mockReturnValue(true),
	};
}

describe("PasteHandler", () => {
	describe("hasPending / pendingCount", () => {
		it("returns false/0 initially", () => {
			const handler = new PasteHandler({
				agent: createMockAgent() as unknown as PasteHandlerOptions["agent"],
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			expect(handler.hasPending()).toBe(false);
			expect(handler.pendingCount()).toBe(0);
		});
	});

	describe("handleLargePaste", () => {
		it("ignores empty content", async () => {
			const notificationView = createMockNotificationView();
			const handler = new PasteHandler({
				agent: createMockAgent() as unknown as PasteHandlerOptions["agent"],
				notificationView: notificationView,
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "   ",
				lineCount: 0,
				charCount: 3,
				marker: "[PASTE:1]",
			});

			expect(notificationView.showInfo).not.toHaveBeenCalled();
		});

		it("ignores duplicate paste events", async () => {
			const agent = createMockAgent();
			let resolveSummary!: (value: { content: string }) => void;
			const summaryPromise = new Promise<{ content: string }>((resolve) => {
				resolveSummary = resolve;
			});
			// Keep the first summary pending to test duplicate detection.
			agent.generateSummary.mockImplementation(() => summaryPromise);

			const handler = new PasteHandler({
				agent: agent as unknown as PasteHandlerOptions["agent"],
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			const event = {
				pasteId: 1,
				content: "Some content",
				lineCount: 1,
				charCount: 12,
				marker: "[PASTE:1]",
			};

			// Start first paste
			const first = handler.handleLargePaste(event);

			// Try duplicate - should be ignored
			await handler.handleLargePaste(event);

			// Only one call to generateSummary
			expect(agent.generateSummary).toHaveBeenCalledTimes(1);

			resolveSummary({ content: "Summary of the pasted content" });
			await first;
		});

		it("shows info notification on start", async () => {
			const notificationView = createMockNotificationView();
			const handler = new PasteHandler({
				agent: createMockAgent() as unknown as PasteHandlerOptions["agent"],
				notificationView: notificationView,
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 100,
				charCount: 5000,
				marker: "[PASTE:1]",
			});

			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Summarizing pasted block (~100 lines)…",
			);
		});

		it("calls refreshFooterHint at start and end", async () => {
			const refreshFooterHint = vi.fn();
			const handler = new PasteHandler({
				agent: createMockAgent() as unknown as PasteHandlerOptions["agent"],
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint,
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 10,
				charCount: 100,
				marker: "[PASTE:1]",
			});

			expect(refreshFooterHint).toHaveBeenCalledTimes(2);
		});

		it("replaces paste marker on success", async () => {
			const editor = createMockEditor();
			const notificationView = createMockNotificationView();
			const sessionContext = createMockSessionContext();
			const handler = new PasteHandler({
				agent: createMockAgent() as unknown as PasteHandlerOptions["agent"],
				notificationView: notificationView,
				sessionContext: sessionContext,
				editor,
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 50,
				charCount: 2500,
				marker: "[PASTE:1]",
			});

			expect(editor.replacePasteMarker).toHaveBeenCalledWith(
				1,
				expect.stringContaining(
					"[[Pasted 50 lines (~2,500 chars) summarized]]",
				),
			);
			expect(notificationView.showToast).toHaveBeenCalledWith(
				"Summarized pasted block (~50 lines)",
				"success",
			);
			expect(sessionContext.recordPasteSummaryArtifact).toHaveBeenCalled();
		});

		it("shows info when marker not found", async () => {
			const editor = createMockEditor();
			(editor.replacePasteMarker as Mock).mockReturnValue(false);
			const notificationView = createMockNotificationView();
			const sessionContext = createMockSessionContext();

			const handler = new PasteHandler({
				agent: createMockAgent() as unknown as PasteHandlerOptions["agent"],
				notificationView: notificationView,
				sessionContext: sessionContext,
				editor,
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 10,
				charCount: 100,
				marker: "[PASTE:1]",
			});

			expect(notificationView.showInfo).toHaveBeenCalledWith(
				"Generated paste summary but it was no longer needed.",
			);
			expect(sessionContext.recordPasteSummaryArtifact).not.toHaveBeenCalled();
		});

		it("shows error on summary failure", async () => {
			const agent = createMockAgent();
			agent.generateSummary.mockRejectedValue(new Error("API error"));
			const notificationView = createMockNotificationView();

			const handler = new PasteHandler({
				agent: agent as unknown as PasteHandlerOptions["agent"],
				notificationView: notificationView,
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 10,
				charCount: 100,
				marker: "[PASTE:1]",
			});

			expect(notificationView.showError).toHaveBeenCalledWith(
				"Couldn't summarize pasted content. The original text will be sent.",
			);
		});

		it("shows error on empty summary", async () => {
			const agent = createMockAgent();
			agent.generateSummary.mockResolvedValue({ content: "" });
			const notificationView = createMockNotificationView();

			const handler = new PasteHandler({
				agent: agent as unknown as PasteHandlerOptions["agent"],
				notificationView: notificationView,
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 10,
				charCount: 100,
				marker: "[PASTE:1]",
			});

			expect(notificationView.showError).toHaveBeenCalled();
		});

		it("clears pending status even on error", async () => {
			const agent = createMockAgent();
			agent.generateSummary.mockRejectedValue(new Error("API error"));

			const handler = new PasteHandler({
				agent: agent as unknown as PasteHandlerOptions["agent"],
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 10,
				charCount: 100,
				marker: "[PASTE:1]",
			});

			expect(handler.hasPending()).toBe(false);
		});

		it("handles array content in message", async () => {
			const agent = createMockAgent();
			agent.generateSummary.mockResolvedValue({
				content: [{ type: "text", text: "Array summary" }],
			});
			const editor = createMockEditor();

			const handler = new PasteHandler({
				agent: agent as unknown as PasteHandlerOptions["agent"],
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				editor,
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: "Some content",
				lineCount: 10,
				charCount: 100,
				marker: "[PASTE:1]",
			});

			expect(editor.replacePasteMarker).toHaveBeenCalledWith(
				1,
				expect.stringContaining("Array summary"),
			);
		});

		it("truncates very long content", async () => {
			const agent = createMockAgent();
			const longContent = "x".repeat(15000);

			const handler = new PasteHandler({
				agent: agent as unknown as PasteHandlerOptions["agent"],
				notificationView: createMockNotificationView(),
				sessionContext: createMockSessionContext(),
				editor: createMockEditor(),
				refreshFooterHint: vi.fn(),
			});

			await handler.handleLargePaste({
				pasteId: 1,
				content: longContent,
				lineCount: 500,
				charCount: 15000,
				marker: "[PASTE:1]",
			});

			const call = agent.generateSummary.mock.calls[0];
			const messageContent = call[0][0].content[0].text;
			expect(messageContent).toContain("[truncated");
			expect(messageContent.length).toBeLessThan(15000);
		});
	});
});
