import { describe, expect, it } from "vitest";
import { mergeUserSettings } from "../../src/api/user-settings-merge.js";
import type { UserSettings } from "../../src/db/schema.js";

describe("mergeUserSettings", () => {
	it("deep-merges the maestro namespace against the catalog", () => {
		const previous: UserSettings = {
			maestro: { compaction: { thresholdPercent: 80, enabled: true } },
		};
		const incoming: UserSettings = {
			maestro: { compaction: { thresholdPercent: 95 }, model: "gpt-5" },
		};

		const merged = mergeUserSettings(previous, incoming);

		expect(merged.maestro).toEqual({
			compaction: { thresholdPercent: 95, enabled: true },
			model: "gpt-5",
		});
	});

	it("normalizes invalid maestro values so only typed data is stored", () => {
		// @ts-expect-error -- simulating untyped JSONB input
		const incoming: UserSettings = {
			maestro: { compaction: { thresholdPercent: "nope" } },
		};

		const merged = mergeUserSettings(undefined, incoming);

		expect(merged).not.toHaveProperty("maestro");
	});

	it("preserves the previous twoFactor state and ignores a patch attempt", () => {
		const previous: UserSettings = {
			twoFactor: { enabled: true, enabledAt: "2026-01-01" },
		};
		// @ts-expect-error -- malicious/incorrect patch tries to disable 2FA
		const incoming: UserSettings = { twoFactor: { enabled: false } };

		const merged = mergeUserSettings(previous, incoming);

		expect(merged.twoFactor).toEqual({
			enabled: true,
			enabledAt: "2026-01-01",
		});
	});

	it("drops twoFactor entirely when the user never enrolled", () => {
		const merged = mergeUserSettings(undefined, {
			// @ts-expect-error -- patch attempts to inject 2FA state
			twoFactor: { enabled: true },
		});

		expect(merged).not.toHaveProperty("twoFactor");
	});

	it("replaces scalar/array fields rather than merging them", () => {
		const previous: UserSettings = {
			preferredModels: ["anthropic/claude", "openai/gpt"],
			notificationEmail: "old@example.com",
		};
		const incoming: UserSettings = { preferredModels: ["anthropic/claude"] };

		const merged = mergeUserSettings(previous, incoming);

		expect(merged.preferredModels).toEqual(["anthropic/claude"]);
		expect(merged.notificationEmail).toBe("old@example.com");
	});
});
