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

	it("formats token-budget continuation statuses without the generic prefix", () => {
		expect(
			formatWebRuntimeStatus({
				type: "status",
				status: "Target: 200 / 1,000 (20%)",
				details: { kind: "token_budget_continuation" },
			}),
		).toBe("Target: 200 / 1,000 (20%)");
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

	it("formats tool batch summaries without a status prefix", () => {
		expect(
			formatWebRuntimeStatus({
				type: "tool_batch_summary",
				summary: "Read README.md +1 more",
				summaryLabels: ["Read README.md", "Wrote notes.txt"],
				toolCallIds: ["tool_0", "tool_1"],
				toolNames: ["read", "write"],
				callsSucceeded: 2,
				callsFailed: 0,
			}),
		).toBe("Read README.md +1 more");
	});
});
