import { describe, expect, it } from "vitest";
import {
	getQueuedFollowUpEditBinding,
	getQueuedFollowUpEditBindingLabel,
	matchesQueuedFollowUpEditBinding,
} from "../src/cli-tui/queue/queued-follow-up-edit-binding.js";

describe("queued follow-up edit binding", () => {
	it("uses Shift+Left for tmux and terminals that swallow Alt+Up", () => {
		expect(getQueuedFollowUpEditBinding({ TMUX: "1" })).toBe("shift+left");
		expect(
			getQueuedFollowUpEditBinding({ TERM_PROGRAM: "Apple_Terminal" }),
		).toBe("shift+left");
		expect(getQueuedFollowUpEditBinding({ TERM_PROGRAM: "WarpTerminal" })).toBe(
			"shift+left",
		);
		expect(getQueuedFollowUpEditBinding({ TERM_PROGRAM: "vscode" })).toBe(
			"shift+left",
		);
		expect(getQueuedFollowUpEditBindingLabel({ TERM_PROGRAM: "vscode" })).toBe(
			"Shift+Left",
		);
	});

	it("keeps Alt+Up everywhere else", () => {
		expect(getQueuedFollowUpEditBinding({ TERM_PROGRAM: "WezTerm" })).toBe(
			"alt+up",
		);
		expect(getQueuedFollowUpEditBindingLabel({ TERM_PROGRAM: "WezTerm" })).toBe(
			"Alt+Up",
		);
		expect(
			matchesQueuedFollowUpEditBinding("\x1b[1;3A", {
				TERM_PROGRAM: "WezTerm",
			}),
		).toBe(true);
		expect(
			matchesQueuedFollowUpEditBinding("\x1b[1;2D", {
				TERM_PROGRAM: "WezTerm",
			}),
		).toBe(false);
	});
});
