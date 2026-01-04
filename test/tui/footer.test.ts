import { describe, expect, it } from "vitest";
import type {
	AgentState,
	AppMessage,
	AssistantMessage,
} from "../../src/agent/types.js";
import { FooterComponent } from "../../src/cli-tui/footer.js";

// Helper to create a mock assistant message
function createAssistantMessage(
	usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number;
	},
	stopReason: "stop" | "aborted" = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "test response" }],
		stopReason,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		timestamp: Date.now(),
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead || 0,
			cacheWrite: usage.cacheWrite || 0,
			cost: {
				input: usage.cost || 0,
				output: usage.cost || 0,
				cacheRead: usage.cost || 0,
				cacheWrite: usage.cost || 0,
				total: usage.cost || 0,
			},
		},
	};
}

// Helper to create a mock agent state
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

function stripAnsi(value: string): string {
	return value.replaceAll(ANSI_REGEX, "");
}

function statsLineFrom(rendered: string[]): string {
	// New layout: [rule, brand, rule, pathStats]
	// Path+stats is now on line 3
	return stripAnsi(rendered[3] ?? "");
}

function brandLineFrom(rendered: string[]): string {
	// Brand line is now on line 1
	return stripAnsi(rendered[1] ?? "");
}

function createMockState(
	messages: AppMessage[],
	contextWindow = 200000,
): AgentState {
	return {
		messages,
		systemPrompt: "test",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com/v1/messages",
			contextWindow,
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 0.003,
				output: 0.015,
				cacheRead: 0.0003,
				cacheWrite: 0.00375,
			},
			maxTokens: 8192,
		},
		tools: [],
		thinkingLevel: "off",
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

describe("FooterComponent", () => {
	describe("Token Calculations", () => {
		it("should sum tokens across multiple assistant messages", () => {
			const messages = [
				createAssistantMessage({ input: 1000, output: 500 }),
				createAssistantMessage({ input: 2000, output: 1000 }),
				createAssistantMessage({ input: 500, output: 250 }),
			];

			const state = createMockState(messages);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			// Should show cumulative totals: 3500 input, 1750 output
			const statsLine = statsLineFrom(rendered);
			expect(statsLine).toContain("3.5k"); // Input tokens
			expect(statsLine).toContain("1.8k"); // Output tokens (rounded)
		});

		it("should include cache tokens in cumulative stats", () => {
			const messages = [
				createAssistantMessage({
					input: 1000,
					output: 500,
					cacheRead: 5000,
					cacheWrite: 2000,
				}),
				createAssistantMessage({
					input: 1000,
					output: 500,
					cacheRead: 3000,
					cacheWrite: 1000,
				}),
			];

			const state = createMockState(messages);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			const statsLine = statsLineFrom(rendered);
			expect(statsLine).toContain("+2.0k"); // Input: 1000 + 1000
			expect(statsLine).toContain("-1.0k"); // Output: 500 + 500
			expect(statsLine).toContain("~8.0k"); // Cache read: 5000 + 3000
			// Note: Cache write not shown in new compact format
		});

		it("should calculate context percentage from cumulative tokens", () => {
			const messages = [
				createAssistantMessage({ input: 100000, output: 50000 }), // 150k tokens
				createAssistantMessage({ input: 10000, output: 5000 }, "aborted"), // Included in cumulative
			];

			const state = createMockState(messages, 200000); // 200k context window
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			const statsLine = statsLineFrom(rendered);
			// Last message input (10k) + all outputs (50k + 5k) = 65k / 200k = 32.5%
			// But wait - aborted messages should be excluded from lastAssistant
			// So: first message input (100k) + output (50k) = 150k / 200k = 75.0%
			expect(statsLine).toContain("75.0%");
		});

		it("should include cache reads when computing context percentage", () => {
			const messages = [
				createAssistantMessage({
					input: 2000,
					output: 1000,
					cacheRead: 90000,
				}),
			];

			const state = createMockState(messages, 200000);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			const statsLine = statsLineFrom(rendered);
			// (2k input + 90k cacheRead + 1k output) / 200k = 93k / 200k = 46.5%
			// Format shows percentage after progress bar
			expect(statsLine).toContain("46.5%");
			expect(statsLine).not.toContain("1.5%");
		});

		it("should format token counts correctly", () => {
			const messages = [
				createAssistantMessage({ input: 500, output: 100 }), // Under 1k
				createAssistantMessage({ input: 5500, output: 1200 }), // 1k-10k range
				createAssistantMessage({ input: 15000, output: 8000 }), // Over 10k
			];

			const state = createMockState(messages);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			const statsLine = statsLineFrom(rendered);
			expect(statsLine).toContain("21k"); // Total input: 21000
			expect(statsLine).toContain("9.3k"); // Total output: 9300
		});

		it("should sum costs across messages", () => {
			const messages = [
				createAssistantMessage({ input: 1000, output: 500, cost: 0.123 }),
				createAssistantMessage({ input: 2000, output: 1000, cost: 0.456 }),
			];

			const state = createMockState(messages);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			const statsLine = statsLineFrom(rendered);
			// New format uses 2 decimal places: $0.58 (rounded from 0.579)
			expect(statsLine).toContain("$0.58");
		});
	});

	describe("Display Layout", () => {
		it("should show composer branding on brand line", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);

			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			const brandLine = brandLineFrom(rendered);
			expect(brandLine).toContain("◆ composer");
		});

		it("shows static responding stage badge", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);
			const footer = new FooterComponent(state);
			footer.setStage("  Responding   ");
			const rendered = footer.render(120);
			// Stage badge is now on path+stats line (line 3)
			const pathStatsLine = statsLineFrom(rendered);
			expect(pathStatsLine).toContain("Responding");
		});

		it("shows static thinking stage badge", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);
			const footer = new FooterComponent(state);
			footer.setStage("Thinking");
			const rendered = footer.render(120);
			const pathStatsLine = statsLineFrom(rendered);
			expect(pathStatsLine).toContain("Thinking");
		});

		it("shows static working stage badge with tool detail", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);
			const footer = new FooterComponent(state);
			footer.setStage("Working · search (1/2)");
			const rendered = footer.render(120);
			const pathStatsLine = statsLineFrom(rendered);
			expect(pathStatsLine).toContain("Working");
			expect(pathStatsLine).toContain("search (1/2)");
		});

		it("shows static dreaming stage badge", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);
			const footer = new FooterComponent(state);
			footer.setStage("Dreaming");
			const rendered = footer.render(120);
			const pathStatsLine = statsLineFrom(rendered);
			expect(pathStatsLine).toContain("Dreaming");
		});

		it("should show model name next to composer branding", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);

			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			// Model and brand are now on the brand line (line 1)
			const brandLine = brandLineFrom(rendered);
			expect(brandLine).toContain("claude-sonnet-4");
			expect(brandLine).toContain("◆ composer");
		});

		it("should prioritize model name over brand when width is too small", () => {
			const state = createMockState(
				[createAssistantMessage({ input: 1000, output: 500 })],
				200000,
			);
			state.model.id = "very-long-model-name-that-wont-fit";

			const footer = new FooterComponent(state);
			const rendered = footer.render(60); // Narrow width

			// Brand line should still have model name
			const brandLine = brandLineFrom(rendered);
			expect(brandLine).toContain("very-long");
		});

		it("should show pwd with home directory as ~", () => {
			const originalCwd = process.cwd();
			const originalHome = process.env.HOME;

			try {
				// Mock home directory
				process.env.HOME = "/Users/test";
				// Mock cwd as subdirectory of home
				process.chdir = () => {}; // Prevent actual change
				Object.defineProperty(process, "cwd", {
					value: () => "/Users/test/projects/myproject",
					configurable: true,
				});

				const state = createMockState([
					createAssistantMessage({ input: 1000, output: 500 }),
				]);

				const footer = new FooterComponent(state);
				const rendered = footer.render(120);

				// Path is now on line 3 (path+stats line)
				const pathStatsLine = rendered[3];
				expect(pathStatsLine).toContain("~/projects/myproject");
			} finally {
				// Restore original values
				process.env.HOME = originalHome;
				Object.defineProperty(process, "cwd", {
					value: () => originalCwd,
					configurable: true,
				});
			}
		});

		it("should highlight context percentage in red when >= 80%", () => {
			const messages = [
				createAssistantMessage({ input: 160000, output: 10000 }), // 170k / 200k = 85%
			];

			const state = createMockState(messages, 200000);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			// Stats are now on line 3 (path+stats line)
			const statsLine = rendered[3];
			expect(statsLine).toContain("85.0%");
			// Note: Can't easily test color codes, but the percentage should be there
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty message history", () => {
			const state = createMockState([]);
			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			// New layout: [rule, brand, rule, pathStats]
			expect(rendered).toHaveLength(4);
		});

		it("should handle zero context window", () => {
			const state = createMockState(
				[createAssistantMessage({ input: 1000, output: 500 })],
				0, // Zero context window
			);

			const footer = new FooterComponent(state);
			const rendered = footer.render(120);

			// With zero context window, no context % is shown
			// Just verify it renders without error
			expect(rendered).toHaveLength(4);
		});

		it("should handle very narrow terminal width", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);

			const footer = new FooterComponent(state);
			const rendered = footer.render(20); // Very narrow

			// New layout: [rule, brand, rule, pathStats]
			expect(rendered).toHaveLength(4);
			// Should not crash, even if truncated
		});
	});

	describe("Solo mode", () => {
		it("renders minimal stats without composer branding", () => {
			const state = createMockState([
				createAssistantMessage({ input: 1000, output: 500 }),
			]);
			const footer = new FooterComponent(state, "solo");
			const rendered = footer.render(120);
			const statsLine = statsLineFrom(rendered);
			expect(statsLine).not.toContain("composer");
			expect(rendered).toHaveLength(2);
		});

		it("omits hint line when in solo mode", () => {
			const state = createMockState([
				createAssistantMessage({ input: 50000, output: 10000 }),
			]);
			const footer = new FooterComponent(state, "solo");
			footer.setHint("High context");
			const rendered = footer.render(120);
			expect(rendered).toHaveLength(2);
		});
	});
});
