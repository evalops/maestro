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

	it("dedupes repeated numbered lines across separate content blocks", () => {
		const message: AssistantMessage = {
			...baseAssistant,
			content: [
				{ type: "text", text: "1. One\n2. Two\n3. Three" },
				{ type: "text", text: "3. Three\n4. Four" },
			],
		};

		const renderable = toRenderableAssistantMessage(message, {
			cleanMode: "soft",
		});

		expect(renderable.textBlocks.join("\n")).toBe(
			["1. One", "2. Two", "3. Three", "4. Four"].join("\n"),
		);
		expect(renderable.cleaned).toBe(true);
	});

	it("dedupes cumulative re-sent blocks (emoji bullets)", () => {
		const message: AssistantMessage = {
			...baseAssistant,
			content: [
				{ type: "text", text: "✅ A\n✅ B" },
				{ type: "text", text: "✅ A\n✅ B\n✅ C" },
				{ type: "text", text: "✅ A\n✅ B\n✅ C\n✅ D" },
			],
		};

		const renderable = toRenderableAssistantMessage(message, {
			cleanMode: "soft",
		});

		expect(renderable.textBlocks.join("\n")).toBe(
			["✅ A", "✅ B", "✅ C", "✅ D"].join("\n"),
		);
		expect(renderable.cleaned).toBe(true);
	});
});
