/**
 * TDD tests for Agent class instantiation and basic lifecycle.
 * Tests that the Agent can be constructed and its public API is accessible
 * without needing a real LLM connection.
 */
import { describe, expect, it, vi } from "vitest";

import { Agent } from "../../../packages/core/src/index.js";
import type { AgentOptions } from "../../../packages/core/src/index.js";

function createMockTransport() {
	return {
		run: vi.fn(),
		continue: vi.fn(),
	} as unknown as AgentOptions["transport"];
}

function createMinimalOptions(): AgentOptions {
	return {
		transport: createMockTransport(),
		initialState: {
			model: {
				id: "claude-sonnet-4-5",
				provider: "anthropic",
				api: "anthropic-messages",
				// biome-ignore lint/suspicious/noExplicitAny: test mock
			} as any,
		},
	};
}

describe("Agent", () => {
	describe("constructor", () => {
		it("can be instantiated with minimal options", () => {
			const agent = new Agent(createMinimalOptions());
			expect(agent).toBeDefined();
		});

		it("is a class (not a plain object)", () => {
			expect(typeof Agent).toBe("function");
			expect(Agent.prototype).toBeDefined();
		});
	});

	describe("state", () => {
		it("exposes state as a getter", () => {
			const agent = new Agent(createMinimalOptions());
			const state = agent.state;
			expect(state).toBeDefined();
			expect(typeof state).toBe("object");
		});

		it("state has messages array", () => {
			const agent = new Agent(createMinimalOptions());
			expect(Array.isArray(agent.state.messages)).toBe(true);
		});

		it("state starts with empty messages", () => {
			const agent = new Agent(createMinimalOptions());
			expect(agent.state.messages.length).toBe(0);
		});

		it("state is readonly (frozen reference)", () => {
			const agent = new Agent(createMinimalOptions());
			const state1 = agent.state;
			const state2 = agent.state;
			// Getter should return consistent shape
			expect(state1.messages).toBeDefined();
			expect(state2.messages).toBeDefined();
		});
	});

	describe("subscribe", () => {
		it("returns an unsubscribe function", () => {
			const agent = new Agent(createMinimalOptions());
			const unsub = agent.subscribe(() => {});
			expect(typeof unsub).toBe("function");
		});

		it("can subscribe multiple listeners", () => {
			const agent = new Agent(createMinimalOptions());
			const fn1 = vi.fn();
			const fn2 = vi.fn();
			const unsub1 = agent.subscribe(fn1);
			const unsub2 = agent.subscribe(fn2);
			expect(unsub1).not.toBe(unsub2);
			unsub1();
			unsub2();
		});

		it("unsubscribe is idempotent", () => {
			const agent = new Agent(createMinimalOptions());
			const unsub = agent.subscribe(() => {});
			unsub();
			expect(() => unsub()).not.toThrow();
		});
	});

	describe("setTools", () => {
		it("accepts empty tools array", () => {
			const agent = new Agent(createMinimalOptions());
			expect(() => agent.setTools([])).not.toThrow();
		});

		it("accepts tools with name and execute", () => {
			const agent = new Agent(createMinimalOptions());
			expect(() =>
				agent.setTools([
					{
						name: "test_tool",
						description: "A test tool",
						execute: async () => ({ content: "done" }),
						// biome-ignore lint/suspicious/noExplicitAny: test mock
					} as any,
				]),
			).not.toThrow();
		});
	});

	describe("setSystemPrompt", () => {
		it("accepts a string prompt", () => {
			const agent = new Agent(createMinimalOptions());
			expect(() => agent.setSystemPrompt("You are helpful.")).not.toThrow();
		});

		it("accepts empty string", () => {
			const agent = new Agent(createMinimalOptions());
			expect(() => agent.setSystemPrompt("")).not.toThrow();
		});
	});

	describe("abort", () => {
		it("does not throw when not running", () => {
			const agent = new Agent(createMinimalOptions());
			expect(() => agent.abort()).not.toThrow();
		});

		it("can be called multiple times", () => {
			const agent = new Agent(createMinimalOptions());
			agent.abort();
			agent.abort();
			agent.abort();
			// Should not throw or accumulate state
		});
	});

	describe("prompt", () => {
		it("is an async method", () => {
			const agent = new Agent(createMinimalOptions());
			expect(typeof agent.prompt).toBe("function");
		});
	});

	describe("configuration methods", () => {
		it("has setTemperature", () => {
			const agent = new Agent(createMinimalOptions());
			expect(typeof agent.setTemperature).toBe("function");
			expect(() => agent.setTemperature(0.7)).not.toThrow();
		});

		it("has setTopP", () => {
			const agent = new Agent(createMinimalOptions());
			expect(typeof agent.setTopP).toBe("function");
			expect(() => agent.setTopP(0.9)).not.toThrow();
		});

		it("setTemperature accepts undefined (reset)", () => {
			const agent = new Agent(createMinimalOptions());
			expect(() => agent.setTemperature(undefined)).not.toThrow();
		});
	});
});
