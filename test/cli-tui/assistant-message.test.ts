import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../src/agent/types.js";
import { AssistantMessageComponent } from "../../src/cli-tui/assistant-message.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";
import type { RenderableAssistantMessage } from "../../src/conversation/render-model.js";

const baseAssistant: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-responses",
	provider: "openai",
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

describe("AssistantMessageComponent", () => {
	it("renders streaming thinking summaries", () => {
		const renderable: RenderableAssistantMessage = {
			kind: "assistant",
			textBlocks: [],
			thinkingBlocks: ["Reasoning summary"],
			toolCalls: [],
			stopReason: "stop",
			cleaned: false,
			raw: baseAssistant,
		};

		const component = new AssistantMessageComponent(renderable);
		component.updateContent(renderable, { streaming: true });

		const output = stripAnsiSequences(component.render(80).join("\n"));
		expect(output.toLowerCase()).toContain("thinking");
		expect(output).toContain("Reasoning summary");
	});
});
