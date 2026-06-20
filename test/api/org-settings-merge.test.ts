import { describe, expect, it } from "vitest";
import { mergeOrganizationSettings } from "../../src/api/org-settings-merge.js";
import type { OrganizationSettings } from "../../src/db/schema.js";

describe("mergeOrganizationSettings", () => {
	it("deep-merges the maestro namespace with incoming leaves winning", () => {
		const previous: OrganizationSettings = {
			maestro: {
				compaction: { thresholdPercent: 70, enabled: true },
				model: "prev-model",
			},
		};
		const incoming: OrganizationSettings = {
			maestro: {
				compaction: { thresholdPercent: 90 },
				tools: { disable: ["bash"] },
			},
		};

		const merged = mergeOrganizationSettings(previous, incoming);

		expect(merged.maestro).toEqual({
			compaction: { thresholdPercent: 90, enabled: true },
			model: "prev-model",
			tools: { disable: ["bash"] },
		});
	});

	it("normalizes invalid maestro values so only typed data is stored", () => {
		const incoming: OrganizationSettings = {
			// @ts-expect-error -- simulating untyped JSONB input
			maestro: {
				compaction: { thresholdPercent: "not-a-number", enabled: "maybe" },
				model: 42,
				bogusNamespace: { keep: "me" },
			},
		};

		const merged = mergeOrganizationSettings(undefined, incoming);

		// All maestro values were invalid, so the namespace is dropped entirely
		// (no empty object, no unknown keys persisted to the jsonb column).
		expect(merged).not.toHaveProperty("maestro");
	});

	it("preserves a previously stored maestro namespace when the patch omits it", () => {
		const previous: OrganizationSettings = {
			maestro: { compaction: { thresholdPercent: 80 } },
		};

		const merged = mergeOrganizationSettings(previous, {
			piiRedactionEnabled: true,
		});

		expect(merged.maestro).toEqual({ compaction: { thresholdPercent: 80 } });
		expect(merged.piiRedactionEnabled).toBe(true);
	});

	it("drops an empty maestro namespace instead of storing an empty object", () => {
		const merged = mergeOrganizationSettings(undefined, {
			piiRedactionEnabled: true,
		});
		expect(merged).not.toHaveProperty("maestro");
	});

	it("still deep-merges the internal namespace (telemetry controls)", () => {
		const previous: OrganizationSettings = {
			internal: { telemetryDisabled: true },
		};
		const incoming: OrganizationSettings = {
			internal: { telemetryDisabled: false },
		};

		const merged = mergeOrganizationSettings(previous, incoming);

		expect(merged.internal).toEqual({ telemetryDisabled: false });
	});

	it("replaces scalar/array fields rather than merging them", () => {
		const previous: OrganizationSettings = {
			allowedDirectories: ["a/*", "b/*"],
			alertWebhooks: ["https://old.example.com"],
		};
		const incoming: OrganizationSettings = {
			allowedDirectories: ["c/*"],
		};

		const merged = mergeOrganizationSettings(previous, incoming);

		expect(merged.allowedDirectories).toEqual(["c/*"]);
		expect(merged.alertWebhooks).toEqual(["https://old.example.com"]);
	});
});
