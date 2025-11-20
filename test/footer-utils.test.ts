import { describe, expect, it } from "vitest";
import type { AgentState, AssistantMessage } from "../src/agent/types.js";
import { calculateFooterStats } from "../src/tui/utils/footer-utils.js";

const baseModel = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses" as const,
	provider: "openai" as const,
	baseUrl: "https://api.openai.com/v1/chat/completions",
	reasoning: false,
	input: ["text" as const],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 1000,
	maxTokens: 4096,
};

const baseAssistant = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "summary" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-4o",
	usage: {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

const baseState = (messages: AssistantMessage[]): AgentState => ({
	systemPrompt: "",
	model: baseModel,
	thinkingLevel: "off",
	tools: [],
	messages,
	isStreaming: false,
	streamMessage: null,
	pendingToolCalls: new Map(),
});

describe("calculateFooterStats", () => {
	it("handles assistant messages missing usage", () => {
		const assistant = { ...baseAssistant() } as any;
		assistant.usage = undefined;
		const stats = calculateFooterStats(baseState([assistant]));
		expect(stats.totalInput).toBe(0);
		expect(stats.totalOutput).toBe(0);
		expect(stats.totalCost).toBe(0);
		expect(stats.contextTokens).toBe(0);
		expect(stats.contextWindow).toBe(1000);
		expect(stats.contextPercent).toBe(0);
	});

	it("sums usage when present", () => {
		const stats = calculateFooterStats(baseState([baseAssistant()]));
		expect(stats.totalInput).toBe(10);
		expect(stats.totalOutput).toBe(5);
		expect(stats.contextTokens).toBe(15);
		expect(stats.contextPercent).toBeCloseTo(1.5);
	});
});
