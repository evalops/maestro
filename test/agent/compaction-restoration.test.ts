import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLAN_MODE_COMPACTION_CUSTOM_TYPE,
	collectPlanModeMessagesForCompaction,
} from "../../src/agent/compaction-restoration.js";
import {
	getCurrentPlanFilePath,
	isPlanModeActive,
} from "../../src/agent/plan-mode.js";

vi.mock("../../src/agent/plan-mode.js", () => ({
	getCurrentPlanFilePath: vi.fn(),
	isPlanModeActive: vi.fn(),
}));

describe("collectPlanModeMessagesForCompaction", () => {
	beforeEach(() => {
		vi.mocked(isPlanModeActive).mockReset().mockReturnValue(false);
		vi.mocked(getCurrentPlanFilePath).mockReset().mockReturnValue(null);
	});

	it("returns no messages when plan mode is inactive", () => {
		expect(collectPlanModeMessagesForCompaction([])).toEqual([]);
	});

	it("returns a hidden plan-mode restoration message when plan mode is active", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getCurrentPlanFilePath).mockReturnValue("/tmp/plan.md");

		expect(collectPlanModeMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Plan file: /tmp/plan.md"),
				details: { filePath: "/tmp/plan.md" },
			}),
		]);
	});

	it("deduplicates an already-present plan-mode restoration message", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getCurrentPlanFilePath).mockReturnValue("/tmp/plan.md");

		const existingMessages = [
			{
				role: "hookMessage" as const,
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				content: "Plan file: /tmp/plan.md",
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
		];

		expect(collectPlanModeMessagesForCompaction(existingMessages)).toEqual([]);
	});
});
