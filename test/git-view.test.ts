import { describe, expect, it } from "vitest";
import { GitView } from "../src/tui/git-view.js";

type GitResult = { ok: boolean; stdout: string; stderr: string };

class StubGitView extends GitView {
	constructor(private readonly responses: Record<string, GitResult>) {
		super({
			chatContainer: { addChild: () => {}, clear: () => {} } as any,
			ui: { setFocus: () => {}, requestRender: () => {} } as any,
			showInfoMessage: () => {},
			showToast: () => {},
			editor: {} as any,
			editorContainer: { addChild: () => {}, clear: () => {} } as any,
		});
	}

	protected override runGitCommand(args: string[]): GitResult {
		const key = args.join(" ");
		const hit = this.responses[key];
		return (
			hit ?? {
				ok: false,
				stdout: "",
				stderr: "missing stub",
			}
		);
	}
}

describe("GitView.getReviewContext", () => {
	it("collects status and diffs when git commands succeed", () => {
		const view = new StubGitView({
			"status -sb": {
				ok: true,
				stdout: "## main\n M src/file.ts\n",
				stderr: "",
			},
			"diff --stat": {
				ok: true,
				stdout: " src/file.ts | 2 +-",
				stderr: "",
			},
			"diff --cached --unified=5": {
				ok: true,
				stdout: "cached diff output",
				stderr: "",
			},
			"diff --unified=5": {
				ok: true,
				stdout: "worktree diff output",
				stderr: "",
			},
		});

		const ctx = view.getReviewContext();
		expect(ctx.ok).toBe(true);
		expect(ctx.status).toContain("## main");
		expect(ctx.diffStat).toContain("src/file.ts");
		expect(ctx.stagedDiff).toBe("cached diff output");
		expect(ctx.worktreeDiff).toBe("worktree diff output");
	});

	it("reports failure when git status fails", () => {
		const view = new StubGitView({
			"status -sb": {
				ok: false,
				stdout: "",
				stderr: "fatal: not a git repository",
			},
		});
		const ctx = view.getReviewContext();
		expect(ctx.ok).toBe(false);
		expect(ctx.error).toContain("fatal");
	});

	it("surfaces diff stat failure output", () => {
		const view = new StubGitView({
			"status -sb": { ok: true, stdout: "## main", stderr: "" },
			"diff --stat": { ok: false, stdout: "", stderr: "stat failed" },
			"diff --cached --unified=5": { ok: true, stdout: "cached", stderr: "" },
			"diff --unified=5": { ok: true, stdout: "worktree", stderr: "" },
		});
		const ctx = view.getReviewContext();
		expect(ctx.ok).toBe(false);
		expect(ctx.diffStat).toBe("");
		expect(ctx.error).toContain("stat failed");
	});

	it("returns staged diff failure output", () => {
		const view = new StubGitView({
			"status -sb": { ok: true, stdout: "## main", stderr: "" },
			"diff --stat": { ok: true, stdout: "stat", stderr: "" },
			"diff --cached --unified=5": {
				ok: false,
				stdout: "",
				stderr: "cached failed",
			},
			"diff --unified=5": { ok: true, stdout: "worktree", stderr: "" },
		});
		const ctx = view.getReviewContext();
		expect(ctx.ok).toBe(false);
		expect(ctx.stagedDiff).toBe("");
		expect(ctx.error).toContain("cached failed");
	});

	it("returns worktree diff failure output", () => {
		const view = new StubGitView({
			"status -sb": { ok: true, stdout: "## main", stderr: "" },
			"diff --stat": { ok: true, stdout: "stat", stderr: "" },
			"diff --cached --unified=5": { ok: true, stdout: "cached", stderr: "" },
			"diff --unified=5": { ok: false, stdout: "", stderr: "wt failed" },
		});
		const ctx = view.getReviewContext();
		expect(ctx.ok).toBe(false);
		expect(ctx.worktreeDiff).toBe("");
		expect(ctx.error).toContain("wt failed");
	});
});
