import { describe, expect, it } from "vitest";
import { formatDesktopRuntimeStatus } from "../../packages/desktop/src/renderer/lib/runtime-status";

describe("desktop runtime status", () => {
	it("formats compacting status events", () => {
		expect(
			formatDesktopRuntimeStatus({
				type: "status",
				status: "compacting",
				details: {},
			}),
		).toBe("Compacting conversation...");
	});

	it("formats generic status events", () => {
		expect(
			formatDesktopRuntimeStatus({
				type: "status",
				status: "planning",
				details: {},
			}),
		).toBe("Status: planning");
	});

	it("formats live tool summaries without the generic prefix", () => {
		expect(
			formatDesktopRuntimeStatus({
				type: "status",
				status: "Read app.ts",
				details: { kind: "tool_execution_summary" },
			}),
		).toBe("Read app.ts");
	});

	it("formats compaction events", () => {
		expect(
			formatDesktopRuntimeStatus({
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
