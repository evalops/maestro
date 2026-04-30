import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getFleetPlatformEventBusStatus,
	inferFleetModelTier,
} from "../../src/server/headless-runtime-service.js";

describe("inferFleetModelTier", () => {
	it("classifies mini variants as fast before GPT-5 frontier matching", () => {
		expect(inferFleetModelTier("openai", "gpt-5.4-mini")).toBe("fast");
		expect(inferFleetModelTier("openai", "gpt-5.1-codex-mini")).toBe("fast");
	});

	it("classifies non-mini frontier models as frontier", () => {
		expect(inferFleetModelTier("openai", "gpt-5.4")).toBe("frontier");
		expect(inferFleetModelTier("anthropic", "claude-opus-4-1")).toBe(
			"frontier",
		);
	});

	it("does not classify gemini model names as mini variants", () => {
		expect(inferFleetModelTier("google", "gemini-2.5-pro")).toBeUndefined();
		expect(
			inferFleetModelTier("google", "gemini-3-pro-preview"),
		).toBeUndefined();
	});
});

describe("getFleetPlatformEventBusStatus", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("recognizes NATS_URL like the Rust event bus config", () => {
		vi.stubEnv("NATS_URL", "nats://bus.example:4222");
		vi.stubEnv("MAESTRO_EVENT_BUS_URL", "");
		vi.stubEnv("EVALOPS_NATS_URL", "");

		expect(getFleetPlatformEventBusStatus()).toEqual({
			enabled: true,
			reason: "nats",
			subject: "maestro.ambient_agent.routing.selected",
		});
	});
});
