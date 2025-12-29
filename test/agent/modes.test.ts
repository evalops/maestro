import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentMode,
	MODEL_BY_TIER,
	MODE_CONFIGS,
	formatModeDisplay,
	getAllModes,
	getCurrentMode,
	getModeConfig,
	getModeFromEnv,
	getModelForMode,
	getModelForTier,
	parseMode,
	setCurrentMode,
	suggestMode,
} from "../../src/agent/modes.js";

describe("agent/modes", () => {
	describe("MODE_CONFIGS", () => {
		it("defines all expected modes", () => {
			expect(MODE_CONFIGS.smart).toBeDefined();
			expect(MODE_CONFIGS.rush).toBeDefined();
			expect(MODE_CONFIGS.free).toBeDefined();
			expect(MODE_CONFIGS.custom).toBeDefined();
		});

		it("smart mode uses opus tier", () => {
			expect(MODE_CONFIGS.smart.primaryTier).toBe("opus");
			expect(MODE_CONFIGS.smart.enableThinking).toBe(true);
		});

		it("rush mode uses sonnet tier", () => {
			expect(MODE_CONFIGS.rush.primaryTier).toBe("sonnet");
			expect(MODE_CONFIGS.rush.enableThinking).toBe(false);
		});

		it("free mode uses haiku tier", () => {
			expect(MODE_CONFIGS.free.primaryTier).toBe("haiku");
			expect(MODE_CONFIGS.free.enableThinking).toBe(false);
		});
	});

	describe("MODEL_BY_TIER", () => {
		it("defines models for all tiers", () => {
			expect(MODEL_BY_TIER.opus.anthropic).toBeDefined();
			expect(MODEL_BY_TIER.sonnet.anthropic).toBeDefined();
			expect(MODEL_BY_TIER.haiku.anthropic).toBeDefined();
		});

		it("includes OpenAI models", () => {
			expect(MODEL_BY_TIER.opus.openai).toBeDefined();
			expect(MODEL_BY_TIER.sonnet.openai).toBe("gpt-4o");
		});
	});

	describe("getModelForTier", () => {
		it("returns anthropic model by default", () => {
			const model = getModelForTier("opus");
			expect(model).toBe("claude-opus-4-5-20251101");
		});

		it("returns openai model when specified", () => {
			const model = getModelForTier("sonnet", "openai");
			expect(model).toBe("gpt-4o");
		});

		it("falls back to anthropic for unknown provider models", () => {
			const model = getModelForTier("opus", "google");
			expect(model).toBeDefined();
		});
	});

	describe("getModeConfig", () => {
		it("returns config for valid mode", () => {
			const config = getModeConfig("smart");
			expect(config.displayName).toBe("Smart");
			expect(config.primaryTier).toBe("opus");
		});
	});

	describe("getModelForMode", () => {
		it("returns opus model for smart mode", () => {
			const model = getModelForMode("smart");
			expect(model).toContain("opus");
		});

		it("returns sonnet model for rush mode", () => {
			const model = getModelForMode("rush");
			expect(model).toContain("sonnet");
		});

		it("returns haiku model for free mode", () => {
			const model = getModelForMode("free");
			expect(model).toContain("haiku");
		});
	});

	describe("getCurrentMode/setCurrentMode", () => {
		it("defaults to smart mode", () => {
			setCurrentMode("smart");
			expect(getCurrentMode()).toBe("smart");
		});

		it("can change mode", () => {
			setCurrentMode("rush");
			expect(getCurrentMode()).toBe("rush");

			setCurrentMode("free");
			expect(getCurrentMode()).toBe("free");

			// Reset
			setCurrentMode("smart");
		});
	});

	describe("parseMode", () => {
		it("parses valid modes (case-insensitive)", () => {
			expect(parseMode("smart")).toBe("smart");
			expect(parseMode("SMART")).toBe("smart");
			expect(parseMode("Rush")).toBe("rush");
			expect(parseMode("FREE")).toBe("free");
		});

		it("returns null for invalid modes", () => {
			expect(parseMode("invalid")).toBeNull();
			expect(parseMode("")).toBeNull();
			expect(parseMode("turbo")).toBeNull();
		});
	});

	describe("getModeFromEnv", () => {
		const originalEnv = process.env.COMPOSER_MODE;

		afterEach(() => {
			if (originalEnv === undefined) {
				Reflect.deleteProperty(process.env, "COMPOSER_MODE");
			} else {
				process.env.COMPOSER_MODE = originalEnv;
			}
		});

		it("returns smart by default", () => {
			Reflect.deleteProperty(process.env, "COMPOSER_MODE");
			expect(getModeFromEnv()).toBe("smart");
		});

		it("respects COMPOSER_MODE env var", () => {
			process.env.COMPOSER_MODE = "rush";
			expect(getModeFromEnv()).toBe("rush");

			process.env.COMPOSER_MODE = "FREE";
			expect(getModeFromEnv()).toBe("free");
		});

		it("ignores invalid env values", () => {
			process.env.COMPOSER_MODE = "invalid";
			expect(getModeFromEnv()).toBe("smart");
		});
	});

	describe("formatModeDisplay", () => {
		it("formats mode with name and description", () => {
			const display = formatModeDisplay("smart");
			expect(display).toContain("Smart");
			expect(display).toContain("-");
		});
	});

	describe("getAllModes", () => {
		it("returns all modes with configs", () => {
			const modes = getAllModes();
			expect(modes.length).toBe(4);
			expect(modes.map((m) => m.mode)).toContain("smart");
			expect(modes.map((m) => m.mode)).toContain("rush");
			expect(modes.map((m) => m.mode)).toContain("free");
			expect(modes.map((m) => m.mode)).toContain("custom");
		});
	});

	describe("suggestMode", () => {
		it("suggests smart for complex tasks", () => {
			expect(suggestMode("refactor the authentication system")).toBe("smart");
			expect(suggestMode("design a new API architecture")).toBe("smart");
			expect(suggestMode("implement comprehensive test suite")).toBe("smart");
		});

		it("suggests rush for simple tasks", () => {
			expect(suggestMode("fix this typo")).toBe("rush");
			expect(suggestMode("make a simple change")).toBe("rush");
			expect(suggestMode("rename this variable")).toBe("rush");
		});

		it("suggests free for information tasks", () => {
			expect(suggestMode("what does this function do")).toBe("free");
			expect(suggestMode("explain this code")).toBe("free");
			expect(suggestMode("list all files")).toBe("free");
		});

		it("defaults to smart for ambiguous tasks", () => {
			expect(suggestMode("do something")).toBe("smart");
			expect(suggestMode("")).toBe("smart");
		});
	});

	describe("mode cost/speed hints", () => {
		it("smart has highest cost multiplier", () => {
			expect(MODE_CONFIGS.smart.costMultiplier).toBeGreaterThan(
				MODE_CONFIGS.rush.costMultiplier,
			);
			expect(MODE_CONFIGS.rush.costMultiplier).toBeGreaterThan(
				MODE_CONFIGS.free.costMultiplier,
			);
		});

		it("free has highest speed hint", () => {
			expect(MODE_CONFIGS.free.speedHint).toBeGreaterThan(
				MODE_CONFIGS.rush.speedHint,
			);
			expect(MODE_CONFIGS.rush.speedHint).toBeGreaterThan(
				MODE_CONFIGS.smart.speedHint,
			);
		});
	});
});
