import { visibleWidth } from "@evalops/tui";
import { describe, expect, it } from "vitest";
import type { AgentState, AssistantMessage } from "../src/agent/types.js";
import type { FooterStats } from "../src/tui/utils/footer-utils.js";
import {
	FOOTER_MIN_PADDING,
	buildSoloStatsLine,
	calculateFooterStats,
	formatModelLabel,
	resolveFooterHint,
	truncateModelLabel,
} from "../src/tui/utils/footer-utils.js";

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

const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, "g");
const stripAnsi = (value: string): string => value.replace(ANSI_REGEX, "");

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

	it("handles zero context window", () => {
		const state = baseState([baseAssistant()]);
		state.model = { ...state.model, contextWindow: 0 } as any;
		const stats = calculateFooterStats(state);
		expect(stats.contextPercent).toBe(0);
	});
});

describe("formatModelLabel", () => {
	it("returns model id when reasoning is disabled", () => {
		const label = formatModelLabel(baseState([baseAssistant()]));
		expect(label).toBe("gpt-4o");
	});

	it("appends thinking level when reasoning is enabled", () => {
		const reasoningState = baseState([baseAssistant()]);
		reasoningState.model = { ...baseModel, reasoning: true };
		reasoningState.thinkingLevel = "medium";
		const label = formatModelLabel(reasoningState);
		expect(label).toBe("gpt-4o • medium");
	});

	it("falls back to no-model when id is missing", () => {
		const state = baseState([baseAssistant()]) as any;
		state.model = { ...state.model };
		state.model.id = undefined;
		const label = formatModelLabel(state);
		expect(label).toBe("no-model");
	});
});

describe("resolveFooterHint", () => {
	const stats = (percent: number): FooterStats => ({
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 100,
		contextPercent: percent,
	});

	it("returns auto context hint when threshold exceeded", () => {
		const hint = resolveFooterHint(stats(80));
		expect(hint).toContain("Context 80.0%");
	});

	it("falls back to explicit hints when context is low", () => {
		const hint = resolveFooterHint(stats(10), "custom");
		expect(hint).toBe("custom");
	});
});

describe("truncateModelLabel", () => {
	it("respects visible width for unicode glyphs", () => {
		const label = "🎼✨ModelBeta";
		const truncated = truncateModelLabel(label, 5);
		expect(visibleWidth(truncated)).toBeLessThanOrEqual(5);
		expect(truncated.length).toBeLessThan(label.length);
	});
});

describe("buildSoloStatsLine", () => {
	it("includes cumulative stats and model label", () => {
		const state = baseState([baseAssistant()]);
		const stats = calculateFooterStats(state);
		const line = buildSoloStatsLine(stats, 80, state);
		const plain = stripAnsi(line);
		expect(plain).toContain("↑10");
		expect(plain).toContain("↓5");
		expect(plain).toContain("gpt-4o");
	});

	it("colorizes context percentage based on thresholds", () => {
		const state = baseState([baseAssistant()]);
		const stats: FooterStats = {
			...calculateFooterStats(state),
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 100,
			contextPercent: 95,
		};
		const line = buildSoloStatsLine(stats, 40, state);
		expect(line).toMatch(/95\.0%/);
	});

	it("truncates model label using visible width awareness", () => {
		const state = baseState([baseAssistant()]);
		state.model = { ...state.model, id: "🎼✨ModelBeta" };
		const stats = calculateFooterStats(state);
		const fullLine = stripAnsi(buildSoloStatsLine(stats, 200, state));
		const modelLabel = formatModelLabel(state);
		const statsLeftPlain = fullLine
			.slice(0, fullLine.lastIndexOf(modelLabel))
			.trimEnd();
		const statsLeftWidth = visibleWidth(statsLeftPlain);
		const availableForRight = 4;
		const width = statsLeftWidth + FOOTER_MIN_PADDING + availableForRight;
		const truncated = truncateModelLabel(modelLabel, availableForRight);
		const result = stripAnsi(buildSoloStatsLine(stats, width, state));
		expect(result.endsWith(truncated)).toBe(true);
	});
});
