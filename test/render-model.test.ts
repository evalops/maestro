import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/agent/types.js";
import {
	collapseRepeatedLines,
	toRenderableAssistantMessage,
} from "../src/conversation/render-model.js";

const baseAssistant: AssistantMessage = {
	role: "assistant",
	content: [],
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
	timestamp: Date.now(),
};

describe("render-model helpers", () => {
	it("collapses consecutive duplicate lines", () => {
		const input = ["Line A", "Line A", "Line B", "Line B", "", "Line C"].join(
			"\n",
		);
		const { text, changed } = collapseRepeatedLines(input);
		expect(text).toBe(["Line A", "Line B", "", "Line C"].join("\n"));
		expect(changed).toBe(true);
	});

	it("dedupes assistant text blocks when rendering", () => {
		const message: AssistantMessage = {
			...baseAssistant,
			content: [
				{ type: "text", text: "Repeat me\nRepeat me\nOnce" },
				{ type: "thinking", thinking: "Thought\nThought\nDone" },
			],
		};

		const renderable = toRenderableAssistantMessage(message, {
			cleanMode: "soft",
		});

		expect(renderable.textBlocks[0]).toBe("Repeat me\nOnce");
		expect(renderable.thinkingBlocks[0]).toBe("Thought\nDone");
		expect(renderable.cleaned).toBe(true);
	});

	it("does not collapse non-consecutive duplicate lines", () => {
		const input = "A\nB\nA";
		const { text, changed } = collapseRepeatedLines(input);
		expect(text).toBe(input);
		expect(changed).toBe(false);
	});

	it("collapses duplicate blocks separated by blank lines", () => {
		const input = ["Header", "", "Body", "", "Body", "Tail"].join("\n");
		const { text, changed } = collapseRepeatedLines(input);
		expect(text).toBe(["Header", "", "Body", "Tail"].join("\n"));
		expect(changed).toBe(true);
	});
});
