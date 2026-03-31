import { describe, expect, it } from "vitest";
import { buildHotkeysMarkdown } from "../../src/cli-tui/hotkeys-view.js";

describe("buildHotkeysMarkdown", () => {
	it("uses the terminal-aware queued follow-up edit binding label", () => {
		expect(
			buildHotkeysMarkdown({ TERM_PROGRAM: "vscode" } as NodeJS.ProcessEnv),
		).toContain("`Shift+Left` | Edit last queued follow-up");
		expect(
			buildHotkeysMarkdown({ TERM_PROGRAM: "WezTerm" } as NodeJS.ProcessEnv),
		).toContain("`Alt+Up` | Edit last queued follow-up");
	});

	it("describes Tab as the unified send-or-queue shortcut", () => {
		expect(buildHotkeysMarkdown()).toContain(
			"`Tab` | Send message / Queue follow-up (while running)",
		);
	});
});
