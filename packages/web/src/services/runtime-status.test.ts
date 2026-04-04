import { describe, expect, it } from "vitest";
import { formatWebRuntimeStatus } from "./runtime-status.js";

describe("web runtime status", () => {
	it("formats compacting status events", () => {
		expect(
			formatWebRuntimeStatus({
				type: "status",
				status: "compacting",
				details: {},
			}),
		).toBe("Compacting conversation...");
	});

	it("trims status events before formatting", () => {
		expect(
			formatWebRuntimeStatus({
				type: "status",
				status: " compacting ",
				details: {},
			}),
		).toBe("Compacting conversation...");
	});

	it("formats generic status events", () => {
		expect(
			formatWebRuntimeStatus({
				type: "status",
				status: "planning",
				details: {},
			}),
		).toBe("Status: planning");
	});

	it("formats live tool summaries without the generic prefix", () => {
		expect(
			formatWebRuntimeStatus({
				type: "status",
				status: "Read app.ts",
				details: { kind: "tool_execution_summary" },
			}),
		).toBe("Read app.ts");
	});

	it("trims status values before formatting", () => {
		expect(
			formatWebRuntimeStatus({
				type: "status",
				status: " compacting ",
				details: {},
			}),
		).toBe("Compacting conversation...");
	});

	it("formats compaction events", () => {
		expect(
			formatWebRuntimeStatus({
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
