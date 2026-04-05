import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLAN_FILE_COMPACTION_CUSTOM_TYPE,
	PLAN_MODE_COMPACTION_CUSTOM_TYPE,
	collectPlanMessagesForCompaction,
} from "../../src/agent/compaction-restoration.js";
import {
	getCurrentPlanFilePath,
	isPlanModeActive,
	readPlanFile,
} from "../../src/agent/plan-mode.js";

vi.mock("../../src/agent/plan-mode.js", () => ({
	getCurrentPlanFilePath: vi.fn(),
	isPlanModeActive: vi.fn(),
	readPlanFile: vi.fn(),
}));

describe("collectPlanMessagesForCompaction", () => {
	beforeEach(() => {
		vi.mocked(isPlanModeActive).mockReset().mockReturnValue(false);
		vi.mocked(getCurrentPlanFilePath).mockReset().mockReturnValue(null);
		vi.mocked(readPlanFile).mockReset().mockReturnValue(null);
	});

	it("returns no messages when plan mode is inactive", () => {
		expect(collectPlanMessagesForCompaction([])).toEqual([]);
	});

	it("returns hidden plan file and plan-mode restoration messages when plan mode is active", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getCurrentPlanFilePath).mockReturnValue("/tmp/plan.md");
		vi.mocked(readPlanFile).mockReturnValue("# Current plan\n- [ ] Ship it");

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Current plan contents:"),
				details: { filePath: "/tmp/plan.md" },
			}),
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				display: false,
				content: expect.stringContaining("Plan file: /tmp/plan.md"),
				details: { filePath: "/tmp/plan.md" },
			}),
		]);
	});

	it("still restores plan mode when the active plan file cannot be read", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getCurrentPlanFilePath).mockReturnValue("/tmp/plan.md");
		vi.mocked(readPlanFile).mockReturnValue(null);

		expect(collectPlanMessagesForCompaction([])).toEqual([
			expect.objectContaining({
				role: "hookMessage",
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
			}),
		]);
	});

	it("deduplicates already-present plan restoration messages", () => {
		vi.mocked(isPlanModeActive).mockReturnValue(true);
		vi.mocked(getCurrentPlanFilePath).mockReturnValue("/tmp/plan.md");
		vi.mocked(readPlanFile).mockReturnValue("# Current plan\n- [ ] Ship it");

		const existingPlanContent = [
			"# Active plan file restored after compaction",
			"",
			"Plan file: /tmp/plan.md",
			"",
			"Current plan contents:",
			"# Current plan\n- [ ] Ship it",
		].join("\n");
		const existingMessages = [
			{
				role: "hookMessage" as const,
				customType: PLAN_FILE_COMPACTION_CUSTOM_TYPE,
				content: existingPlanContent,
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
			{
				role: "hookMessage" as const,
				customType: PLAN_MODE_COMPACTION_CUSTOM_TYPE,
				content: "Plan file: /tmp/plan.md",
				display: false,
				details: { filePath: "/tmp/plan.md" },
				timestamp: Date.now(),
			},
		];

		expect(collectPlanMessagesForCompaction(existingMessages)).toEqual([]);
	});
});
