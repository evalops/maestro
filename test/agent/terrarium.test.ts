import { describe, expect, it } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type { AgentContextSource } from "../../src/agent/context-manager.js";
import type { AgentTransport } from "../../src/agent/types.js";
import { MockTransport } from "./mock-transport.js";

class MockContextSource implements AgentContextSource {
	constructor(
		public name: string,
		private content: string | null,
		public cacheScope: "none" | "session" = "none",
	) {}

	async getSystemPromptAdditions(): Promise<string | null> {
		return this.content;
	}
}

describe("Environmental Context Injection (Terrarium Physics)", () => {
	it("injects context from multiple sources into system prompt", async () => {
		const transport = new MockTransport();
		transport.addResponse("assistant", "I see the context.");

		const source1 = new MockContextSource(
			"law-of-gravity",
			"# Gravity: 9.8m/s",
		);
		const source2 = new MockContextSource(
			"law-of-thermodynamics",
			"# Entropy: Increasing",
		);

		const agent = new Agent({
			transport,
			initialState: {
				model: {
					id: "test-model",
					name: "Test Model",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: false,
					toolUse: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 1000,
				},
				systemPrompt: "You are a physics simulator.",
			},
			contextSources: [source1, source2],
		});

		await agent.prompt("What is the state of the universe?");

		const lastPrompt = transport.lastSystemPrompt;
		expect(lastPrompt).toContain("You are a physics simulator.");
		expect(lastPrompt).toContain("# Gravity: 9.8m/s");
		expect(lastPrompt).toContain("# Entropy: Increasing");
	});

	it("maintains correct whitespace spacing (2 newlines) between sections", async () => {
		const transport = new MockTransport();
		transport.addResponse("assistant", "Spacing check.");

		const source1 = new MockContextSource("source-a", "# Section A");
		const source2 = new MockContextSource("source-b", "# Section B");

		const agent = new Agent({
			transport,
			initialState: {
				model: {
					id: "test-model",
					name: "Test Model",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: false,
					toolUse: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 1000,
				},
				systemPrompt: "Base prompt.",
			},
			contextSources: [source1, source2],
		});

		await agent.prompt("Check spacing.");

		const lastPrompt = transport.lastSystemPrompt;
		// Expect: "Base prompt.\n\n# Section A\n\n# Section B"
		expect(lastPrompt).toContain("Base prompt.\n\n# Section A\n\n# Section B");
		// Verify we don't have excessive newlines (e.g. \n\n\n\n)
		expect(lastPrompt).not.toContain("\n\n\n");
	});

	it("handles failing context sources gracefully without crashing agent", async () => {
		const transport = new MockTransport();
		transport.addResponse("assistant", "I am resilient.");

		const failingSource: AgentContextSource = {
			name: "chaos-monkey",
			getSystemPromptAdditions: async () => {
				throw new Error("Chaos ensued");
			},
		};

		const workingSource = new MockContextSource(
			"reliable-law",
			"# Sun: Rising",
		);

		const agent = new Agent({
			transport,
			initialState: {
				model: {
					id: "test-model",
					name: "Test Model",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: false,
					toolUse: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 1000,
				},
				systemPrompt: "Base prompt.",
			},
			contextSources: [failingSource, workingSource],
		});

		await agent.prompt("Report status.");

		const lastPrompt = transport.lastSystemPrompt;
		expect(lastPrompt).toContain("Base prompt.");
		expect(lastPrompt).toContain("# Sun: Rising");
		// Should not fail the prompt
		expect(agent.state.messages.length).toBeGreaterThan(0);
	});

	it("reuses session-cached context across prompts", async () => {
		const transport = new MockTransport();
		transport.addResponse("assistant", "Cached context loaded.");

		let loads = 0;
		const cachedSource: AgentContextSource = {
			name: "cached-source",
			cacheScope: "session",
			getSystemPromptAdditions: async () => {
				loads += 1;
				return "# Cached: Once";
			},
		};

		const agent = new Agent({
			transport,
			initialState: {
				model: {
					id: "test-model",
					name: "Test Model",
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: false,
					toolUse: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 1000,
				},
				systemPrompt: "Base prompt.",
			},
			contextSources: [cachedSource],
		});

		await agent.prompt("First prompt");
		await agent.prompt("Second prompt");

		expect(loads).toBe(1);
		expect(transport.lastSystemPrompt).toContain("# Cached: Once");
	});
});
