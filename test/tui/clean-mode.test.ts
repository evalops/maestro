import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseCleanMode,
	readCleanModeFromEnv,
} from "../../src/tui/clean-mode.js";

describe("clean-mode", () => {
	describe("parseCleanMode", () => {
		it("returns 'off' for off variants", () => {
			expect(parseCleanMode("off")).toBe("off");
			expect(parseCleanMode("OFF")).toBe("off");
			expect(parseCleanMode("disable")).toBe("off");
			expect(parseCleanMode("DISABLE")).toBe("off");
			expect(parseCleanMode("0")).toBe("off");
		});

		it("returns 'soft' for soft variants", () => {
			expect(parseCleanMode("soft")).toBe("soft");
			expect(parseCleanMode("SOFT")).toBe("soft");
			expect(parseCleanMode("on")).toBe("soft");
			expect(parseCleanMode("ON")).toBe("soft");
			expect(parseCleanMode("true")).toBe("soft");
			expect(parseCleanMode("TRUE")).toBe("soft");
			expect(parseCleanMode("1")).toBe("soft");
		});

		it("returns 'aggressive' for aggressive", () => {
			expect(parseCleanMode("aggressive")).toBe("aggressive");
			expect(parseCleanMode("AGGRESSIVE")).toBe("aggressive");
		});

		it("returns null for invalid values", () => {
			expect(parseCleanMode("invalid")).toBeNull();
			expect(parseCleanMode("")).toBeNull();
			expect(parseCleanMode("2")).toBeNull();
			expect(parseCleanMode("maybe")).toBeNull();
		});
	});

	describe("readCleanModeFromEnv", () => {
		const originalEnv = process.env.COMPOSER_TUI_CLEAN;

		afterEach(() => {
			if (originalEnv === undefined) {
				// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
				delete process.env.COMPOSER_TUI_CLEAN;
			} else {
				process.env.COMPOSER_TUI_CLEAN = originalEnv;
			}
		});

		it("returns null when env var is not set", () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_TUI_CLEAN;
			expect(readCleanModeFromEnv()).toBeNull();
		});

		it("returns parsed value from env var", () => {
			process.env.COMPOSER_TUI_CLEAN = "aggressive";
			expect(readCleanModeFromEnv()).toBe("aggressive");

			process.env.COMPOSER_TUI_CLEAN = "soft";
			expect(readCleanModeFromEnv()).toBe("soft");

			process.env.COMPOSER_TUI_CLEAN = "off";
			expect(readCleanModeFromEnv()).toBe("off");
		});

		it("returns null for invalid env value", () => {
			process.env.COMPOSER_TUI_CLEAN = "invalid";
			expect(readCleanModeFromEnv()).toBeNull();
		});
	});
});
