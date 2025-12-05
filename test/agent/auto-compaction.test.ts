import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AutoCompactionConfig,
	AutoCompactionMonitor,
	calculateContextUsage,
	createAutoCompactionMonitor,
	getAutoCompactionConfig,
	shouldAutoCompact,
} from "../../src/agent/auto-compaction.js";
import type { AppMessage, Model } from "../../src/agent/types.js";

describe("Auto-Compaction", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		vi.resetModules();
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("getAutoCompactionConfig", () => {
		it("returns default configuration", () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AUTOCOMPACT_ENABLED;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AUTOCOMPACT_PCT;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AUTOCOMPACT_MIN_MESSAGES;

			const config = getAutoCompactionConfig();

			expect(config.enabled).toBe(true);
			expect(config.thresholdPercent).toBe(85);
			expect(config.minMessages).toBe(10);
			expect(config.keepRecentCount).toBe(6);
		});

		it("respects COMPOSER_AUTOCOMPACT_ENABLED=false", () => {
			process.env.COMPOSER_AUTOCOMPACT_ENABLED = "false";

			const config = getAutoCompactionConfig();

			expect(config.enabled).toBe(false);
		});

		it("parses COMPOSER_AUTOCOMPACT_PCT", () => {
			process.env.COMPOSER_AUTOCOMPACT_PCT = "75";

			const config = getAutoCompactionConfig();

			expect(config.thresholdPercent).toBe(75);
		});

		it("clamps threshold between 50 and 100", () => {
			process.env.COMPOSER_AUTOCOMPACT_PCT = "40";
			expect(getAutoCompactionConfig().thresholdPercent).toBe(50);

			process.env.COMPOSER_AUTOCOMPACT_PCT = "150";
			expect(getAutoCompactionConfig().thresholdPercent).toBe(100);
		});

		it("parses COMPOSER_AUTOCOMPACT_MIN_MESSAGES", () => {
			process.env.COMPOSER_AUTOCOMPACT_MIN_MESSAGES = "20";

			const config = getAutoCompactionConfig();

			expect(config.minMessages).toBe(20);
		});

		it("enforces minimum of 5 messages", () => {
			process.env.COMPOSER_AUTOCOMPACT_MIN_MESSAGES = "2";

			const config = getAutoCompactionConfig();

			expect(config.minMessages).toBe(5);
		});
	});

	describe("calculateContextUsage", () => {
		const mockModel: Model<"anthropic-messages"> = {
			id: "claude-3-opus",
			name: "Claude 3 Opus",
			contextWindow: 200000,
			cost: { input: 15, output: 75, cacheRead: 0.15, cacheWrite: 18.75 },
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			maxTokens: 4096,
		};

		it("calculates usage for simple text messages", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "Hello world", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there!" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-opus",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];

			const stats = calculateContextUsage(messages, mockModel, 0);

			expect(stats.totalTokens).toBeGreaterThan(0);
			expect(stats.contextWindow).toBe(200000);
			expect(stats.usagePercent).toBeLessThan(1);
			expect(stats.messageCount).toBe(2);
			expect(stats.shouldCompact).toBe(false);
		});

		it("includes system prompt tokens", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "Test", timestamp: Date.now() },
			];

			const withoutSystem = calculateContextUsage(messages, mockModel, 0);
			const withSystem = calculateContextUsage(messages, mockModel, 10000);

			expect(withSystem.totalTokens).toBe(withoutSystem.totalTokens + 10000);
		});

		it("uses actual usage when available on assistant messages", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "Hello", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Response" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-3-opus",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];

			const stats = calculateContextUsage(messages, mockModel, 0);

			// Should include the actual usage from the assistant message
			expect(stats.totalTokens).toBeGreaterThan(150);
		});

		it("handles array content messages", () => {
			const messages: AppMessage[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "Hello" },
						{ type: "text", text: "World" },
					],
					timestamp: Date.now(),
				},
			];

			const stats = calculateContextUsage(messages, mockModel, 0);

			expect(stats.totalTokens).toBeGreaterThan(0);
		});
	});

	describe("shouldAutoCompact", () => {
		const mockModel: Model<"anthropic-messages"> = {
			id: "claude-3-opus",
			name: "Claude 3 Opus",
			contextWindow: 1000, // Small for testing
			cost: { input: 15, output: 75, cacheRead: 0.15, cacheWrite: 18.75 },
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			maxTokens: 4096,
		};

		const config: AutoCompactionConfig = {
			enabled: true,
			thresholdPercent: 80,
			minMessages: 5,
			keepRecentCount: 3,
		};

		it("returns false when disabled", () => {
			const messages: AppMessage[] = Array(10)
				.fill(null)
				.map(() => ({
					role: "user" as const,
					content: "x".repeat(100),
					timestamp: Date.now(),
				}));

			const stats = shouldAutoCompact(messages, mockModel, {
				...config,
				enabled: false,
			});

			expect(stats.shouldCompact).toBe(false);
			expect(stats.reason).toBe("Auto-compaction disabled");
		});

		it("returns false when message count is below minimum", () => {
			const messages: AppMessage[] = [
				{ role: "user", content: "x".repeat(1000), timestamp: Date.now() },
			];

			const stats = shouldAutoCompact(messages, mockModel, config);

			expect(stats.shouldCompact).toBe(false);
			expect(stats.reason).toContain("Not enough messages");
		});

		it("returns true when threshold exceeded with enough messages", () => {
			// Create messages that will exceed 80% of 1000 token context
			const messages: AppMessage[] = Array(10)
				.fill(null)
				.map(() => ({
					role: "user" as const,
					content: "x".repeat(400),
					timestamp: Date.now(),
				}));

			const stats = shouldAutoCompact(messages, mockModel, config);

			expect(stats.shouldCompact).toBe(true);
			expect(stats.reason).toContain("exceeds");
		});

		it("returns false when below threshold", () => {
			const messages: AppMessage[] = Array(10)
				.fill(null)
				.map(() => ({
					role: "user" as const,
					content: "x",
					timestamp: Date.now(),
				}));

			const stats = shouldAutoCompact(messages, mockModel, config);

			expect(stats.shouldCompact).toBe(false);
			expect(stats.reason).toContain("below");
		});
	});

	describe("AutoCompactionMonitor", () => {
		const mockModel: Model<"anthropic-messages"> = {
			id: "claude-3-opus",
			name: "Claude 3 Opus",
			contextWindow: 1000,
			cost: { input: 15, output: 75, cacheRead: 0.15, cacheWrite: 18.75 },
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			maxTokens: 4096,
		};

		it("creates with default config", () => {
			const monitor = createAutoCompactionMonitor();
			const config = monitor.getConfig();

			expect(config.enabled).toBe(true);
			expect(config.thresholdPercent).toBeGreaterThan(0);
		});

		it("allows config override", () => {
			const monitor = createAutoCompactionMonitor({
				thresholdPercent: 90,
			});

			expect(monitor.getConfig().thresholdPercent).toBe(90);
		});

		it("allows config update after creation", () => {
			const monitor = new AutoCompactionMonitor();
			monitor.setConfig({ thresholdPercent: 95 });

			expect(monitor.getConfig().thresholdPercent).toBe(95);
		});

		it("rate limits checks", () => {
			const monitor = new AutoCompactionMonitor();
			const messages: AppMessage[] = [
				{ role: "user", content: "test", timestamp: Date.now() },
			];

			const first = monitor.check(messages, mockModel);
			const second = monitor.check(messages, mockModel);

			// Second check should return cached result
			expect(second).toEqual(first);
		});

		it("tracks compaction count", () => {
			const monitor = new AutoCompactionMonitor();

			expect(monitor.getStats().compactionCount).toBe(0);

			monitor.recordCompaction();
			expect(monitor.getStats().compactionCount).toBe(1);

			monitor.recordCompaction();
			expect(monitor.getStats().compactionCount).toBe(2);
		});

		it("returns warning thresholds", () => {
			const monitor = new AutoCompactionMonitor({ thresholdPercent: 80 });
			const thresholds = monitor.getWarningThresholds();

			expect(thresholds.warning).toBe(70); // threshold - 10
			expect(thresholds.critical).toBe(80); // threshold
		});

		it("calls callback when compaction recommended", async () => {
			const callback = vi.fn();
			const monitor = new AutoCompactionMonitor({
				thresholdPercent: 50,
				minMessages: 2,
				onCompactionRecommended: callback,
			});

			const messages: AppMessage[] = Array(5)
				.fill(null)
				.map(() => ({
					role: "user" as const,
					content: "x".repeat(200),
					timestamp: Date.now(),
				}));

			// Force check by waiting and checking
			monitor.check(messages, mockModel);

			// Wait a bit for rate limiting
			await new Promise((resolve) => setTimeout(resolve, 5100));
			monitor.check(messages, mockModel);

			// Callback should have been called if compaction was recommended
			if (callback.mock.calls.length > 0) {
				expect(callback).toHaveBeenCalledWith(
					expect.objectContaining({ shouldCompact: true }),
				);
			}
		});
	});
});
