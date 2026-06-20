import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAESTRO_COMPACTION_SETTINGS,
	MaestroSettingsSchema,
	mergeMaestroSettings,
	normalizeMaestroSettings,
} from "../../packages/contracts/src/maestro-settings.js";

describe("MaestroSettings catalog", () => {
	describe("schema", () => {
		it("is a TypeBox object covering the runtime knob namespaces", () => {
			expect(MaestroSettingsSchema[Symbol.for("TypeBox.Kind")]).toBe("Object");
			const properties = MaestroSettingsSchema.properties as Record<
				string,
				unknown
			>;
			expect(Object.keys(properties).sort()).toEqual([
				"compaction",
				"model",
				"tools",
			]);
		});

		it("defaults match the auto-compaction built-in defaults", () => {
			expect(DEFAULT_MAESTRO_COMPACTION_SETTINGS.thresholdPercent).toBe(85);
			expect(DEFAULT_MAESTRO_COMPACTION_SETTINGS.enabled).toBe(true);
			expect(DEFAULT_MAESTRO_COMPACTION_SETTINGS.minMessages).toBe(10);
			expect(DEFAULT_MAESTRO_COMPACTION_SETTINGS.keepRecentMessages).toBe(6);
		});
	});

	describe("normalizeMaestroSettings", () => {
		it("returns an empty object for non-object input", () => {
			expect(normalizeMaestroSettings(null)).toEqual({});
			expect(normalizeMaestroSettings("oops")).toEqual({});
			expect(normalizeMaestroSettings(undefined)).toEqual({});
		});

		it("coerces valid compaction fields and clamps threshold to 50-100", () => {
			const normalized = normalizeMaestroSettings({
				compaction: {
					thresholdPercent: 40,
					enabled: "true",
					minMessages: "7",
					keepRecentMessages: 3,
				},
			});
			expect(normalized.compaction).toEqual({
				thresholdPercent: 50,
				enabled: true,
				minMessages: 7,
				keepRecentMessages: 3,
			});
		});

		it("drops invalid compaction fields but keeps valid ones", () => {
			const normalized = normalizeMaestroSettings({
				compaction: {
					thresholdPercent: "not-a-number",
					enabled: "maybe",
					minMessages: 20,
				},
			});
			expect(normalized.compaction).toEqual({ minMessages: 20 });
		});

		it("normalizes model selection as a string or per-mode map", () => {
			expect(normalizeMaestroSettings({ model: "gpt-5" }).model).toBe("gpt-5");
			expect(
				normalizeMaestroSettings({
					model: { reasoning: "gpt-5", default: "gpt-4o" },
				}).model,
			).toEqual({ reasoning: "gpt-5", default: "gpt-4o" });
			expect(normalizeMaestroSettings({ model: 42 }).model).toBeUndefined();
		});

		it("dedupes and trims tool gating lists", () => {
			expect(
				normalizeMaestroSettings({
					tools: { disable: ["bash", " bash ", "rm"], enable: [] },
				}).tools,
			).toEqual({ disable: ["bash", "rm"] });
		});

		it("ignores unknown keys so stored rows survive catalog growth", () => {
			expect(
				normalizeMaestroSettings({
					futureKnob: 1,
					compaction: { enabled: false },
				}),
			).toEqual({ compaction: { enabled: false } });
		});
	});

	describe("mergeMaestroSettings", () => {
		it("user leaves win over organization leaves within a namespace", () => {
			const merged = mergeMaestroSettings(
				{ compaction: { thresholdPercent: 70, enabled: true } },
				{ compaction: { thresholdPercent: 90 } },
			);
			expect(merged.compaction).toEqual({
				thresholdPercent: 90,
				enabled: true,
			});
		});

		it("falls through to organization when user omits a namespace", () => {
			const merged = mergeMaestroSettings(
				{ model: "org-model", tools: { disable: ["bash"] } },
				{ compaction: { enabled: false } },
			);
			expect(merged.model).toBe("org-model");
			expect(merged.tools).toEqual({ disable: ["bash"] });
			expect(merged.compaction).toEqual({ enabled: false });
		});

		it("returns an empty object when neither layer provides settings", () => {
			expect(mergeMaestroSettings(null, undefined)).toEqual({});
		});
	});
});
