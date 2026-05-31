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
	resolveSubagentDispatch,
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
			expect(MODE_CONFIGS.frontier).toBeDefined();
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
		it("returns OpenAI Codex model by default", () => {
			const model = getModelForTier("opus");
			expect(model).toBe("gpt-5.5");
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
		it("returns Codex opus-tier model for smart mode", () => {
			const model = getModelForMode("smart");
			expect(model).toBe("gpt-5.5");
		});

		it("returns Codex sonnet-tier model for rush mode", () => {
			const model = getModelForMode("rush");
			expect(model).toBe("gpt-5.4");
		});

		it("returns Codex haiku-tier model for free mode", () => {
			const model = getModelForMode("free");
			expect(model).toBe("gpt-5.4-mini");
		});
	});

	describe("resolveSubagentDispatch", () => {
		it("routes smart coder subagents to an explicit OpenAI Codex model", () => {
			const dispatch = resolveSubagentDispatch("smart", "coder", "anthropic");

			expect(dispatch).toMatchObject({
				mode: "smart",
				type: "coder",
				provider: "openai-codex",
				model: "gpt-5.5",
				reasoningEffort: "medium",
				source: "mode",
			});
		});

		it("falls back to the mode primary tier when a subagent type is undeclared", () => {
			const dispatch = resolveSubagentDispatch(
				"custom",
				"researcher",
				"google",
			);

			expect(dispatch).toMatchObject({
				mode: "custom",
				type: "researcher",
				provider: "google",
				model: MODEL_BY_TIER.sonnet.google,
				modelTier: "sonnet",
				reasoningEffort: "medium",
				source: "fallback",
			});
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
			expect(parseMode("Frontier")).toBe("frontier");
		});

		it("returns null for invalid modes", () => {
			expect(parseMode("invalid")).toBeNull();
			expect(parseMode("")).toBeNull();
			expect(parseMode("turbo")).toBeNull();
		});
	});

	describe("getModeFromEnv", () => {
		const originalEnv = process.env.MAESTRO_MODE;

		afterEach(() => {
			if (originalEnv === undefined) {
				Reflect.deleteProperty(process.env, "MAESTRO_MODE");
			} else {
				process.env.MAESTRO_MODE = originalEnv;
			}
		});

		it("returns smart by default", () => {
			Reflect.deleteProperty(process.env, "MAESTRO_MODE");
			expect(getModeFromEnv()).toBe("smart");
		});

		it("respects MAESTRO_MODE env var", () => {
			process.env.MAESTRO_MODE = "rush";
			expect(getModeFromEnv()).toBe("rush");

			process.env.MAESTRO_MODE = "FREE";
			expect(getModeFromEnv()).toBe("free");
		});

		it("ignores invalid env values", () => {
			process.env.MAESTRO_MODE = "invalid";
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
			expect(modes.map((m) => m.mode)).not.toContain("frontier");
		});

		it("returns hidden modes only when requested", () => {
			const modes = getAllModes({ includeHidden: true });
			expect(modes.map((m) => m.mode)).toEqual([
				"smart",
				"rush",
				"free",
				"custom",
				"frontier",
				"replay",
			]);
			expect(getAllModes().map((m) => m.mode)).not.toContain("frontier");
			expect(getAllModes().map((m) => m.mode)).not.toContain("replay");
			expect(MODE_CONFIGS.frontier.visible).toBe(false);
			expect(MODE_CONFIGS.replay.visible).toBe(false);
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
