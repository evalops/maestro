import { describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../src/agent/types.js";
import { ContextView } from "../../src/tui/context-view.js";

describe("ContextView", () => {
	it("renders correctly with mixed messages", () => {
		const state: AgentState = {
			systemPrompt: "System prompt with some length",
			messages: [
				{ role: "user", content: "Hello world" },
				{
					role: "assistant",
					content: "Hi there",
					usage: {
						output: 10,
						input: 20,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							total: 0,
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
						},
					},
				},
				{ role: "user", content: "Another user message" },
			],
			model: { id: "gpt-4", contextWindow: 8000, reasoning: false },
			status: "ready",
			history: [],
			tools: [],
			config: {},
		} as unknown as AgentState;

		const view = new ContextView({
			state,
			onClose: vi.fn(),
		});

		const lines = view.render(80);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((l) => l.includes("CONTEXT USAGE"))).toBe(true);
		expect(lines.some((l) => l.includes("System Prompt"))).toBe(true);
		expect(lines.some((l) => l.includes("Assistant Response"))).toBe(true);
		// Check for user message content
		expect(lines.some((l) => l.includes("Hello world"))).toBe(true);
	});

	it("handles scrolling", () => {
		// Create many messages
		const messages = Array.from({ length: 20 }, (_, i) => ({
			role: "user",
			content: `Message ${i}`,
		}));

		const state = {
			messages,
			model: { id: "gpt-4", contextWindow: 8000 },
		} as unknown as AgentState;

		const view = new ContextView({
			state,
			onClose: vi.fn(),
		});

		// Initial render
		let lines = view.render(80);
		expect(lines.some((l) => l.includes("Message 0"))).toBe(true);

		// Scroll down
		view.handleInput("\x1b[B"); // Down arrow

		lines = view.render(80);
		// Message 0 might scroll out if we scrolled far enough, but here just checking it updates state.
		// Since we scroll 1 item, Message 1 should be visible.
		expect(lines.some((l) => l.includes("Message 1"))).toBe(true);
	});

	it("assistant items show full token contribution (input + output + cacheRead)", () => {
		const state: AgentState = {
			messages: [
				{
					role: "assistant",
					content: "Hi",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 25,
						cacheWrite: 0,
						cost: {
							total: 0,
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
						},
					},
				},
			],
			model: { id: "gpt-4", contextWindow: 1000, reasoning: false },
			status: "ready",
		} as unknown as AgentState;

		const view = new ContextView({ state, onClose: vi.fn() });
		const lines = view.render(80);
		// 100 + 50 + 25 = 175
		expect(lines.some((l) => l.includes("175"))).toBe(true);
	});
});
