import { Container } from "@evalops/tui";
import { describe, expect, it } from "vitest";
import {
	COMPACTION_RESUME_PROMPT,
	decorateSummaryText,
} from "../../src/agent/compaction.js";
import type {
	AgentState,
	AppMessage,
	AssistantMessage,
} from "../../src/agent/types.js";
import { MessageView } from "../../src/cli-tui/message-view.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";

function createAssistantMessage(
	text: string,
	timestamp = Date.now(),
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function renderMessages(messages: AppMessage[]): string {
	const chatContainer = new Container();
	const messageView = new MessageView({
		chatContainer,
		ui: {} as never,
		toolComponents: new Set(),
		pendingTools: new Map(),
		registerToolComponent: () => {},
	});
	messageView.renderInitialMessages({ messages } as AgentState);
	return stripAnsiSequences(chatContainer.render(120).join("\n"));
}

describe("MessageView", () => {
	it("renders a compaction boundary instead of synthetic summary and resume messages", () => {
		const output = renderMessages([
			createAssistantMessage(
				decorateSummaryText("Summary text", 8, true),
				1711894200000,
			),
			{
				role: "user",
				content: COMPACTION_RESUME_PROMPT,
				timestamp: 1711894201000,
			},
			{
				role: "user",
				content: "Continue with the refactor",
				timestamp: 1711894202000,
			},
		]);

		expect(output).toContain("Conversation compacted");
		expect(output).not.toContain("Summary text");
		expect(output).not.toContain(COMPACTION_RESUME_PROMPT);
		expect(output).toContain("Continue with the refactor");
	});

	it("renders persisted compaction summaries as a boundary marker", () => {
		const output = renderMessages([
			{
				role: "compactionSummary",
				summary: "Older work summary",
				tokensBefore: 32000,
				timestamp: 1711894200000,
			},
			{
				role: "user",
				content: "Show me the next step",
				timestamp: 1711894202000,
			},
		]);

		expect(output).toContain("Conversation compacted");
		expect(output).not.toContain("Older work summary");
		expect(output).toContain("Show me the next step");
	});
});
