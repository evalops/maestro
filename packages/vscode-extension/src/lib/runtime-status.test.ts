import { describe, expect, it } from "vitest";
import { formatVscodeRuntimeStatus } from "./runtime-status.js";

describe("vscode runtime status", () => {
	it("formats compacting status events", () => {
		expect(
			formatVscodeRuntimeStatus({
				type: "status",
				status: "compacting",
				details: {},
			}),
		).toBe("Compacting conversation...");
	});

	it("formats generic status events", () => {
		expect(
			formatVscodeRuntimeStatus({
				type: "status",
				status: "planning",
				details: {},
			}),
		).toBe("Status: planning");
	});

	it("formats compaction events", () => {
		expect(
			formatVscodeRuntimeStatus({
				type: "compaction",
				summary: "Summary",
				firstKeptEntryIndex: 3,
				tokensBefore: 1000,
				auto: true,
				timestamp: new Date(0).toISOString(),
			}),
		).toBe("Compacted conversation automatically");
	});
});
