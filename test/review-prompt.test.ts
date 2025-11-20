import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../src/tui/utils/commands/review-prompt.js";

describe("buildReviewPrompt", () => {
	it("includes repository context and truncates long sections", () => {
		const longStatus = "x".repeat(15050);
		const prompt = buildReviewPrompt({
			status: longStatus,
			diffStat: "stat",
			stagedDiff: "staged",
			worktreeDiff: "worktree",
			cwd: "/repo/root",
		});

		expect(prompt).toContain("Repository root: /repo/root");
		expect(prompt).toContain("Git status:");
		expect(prompt).toContain("[truncated 50 additional chars]");
		expect(prompt).toContain("Diff summary");
		expect(prompt).toContain("Staged diff");
		expect(prompt).toContain("Unstaged diff");
	});
});
