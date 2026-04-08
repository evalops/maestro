import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resetTuiKeybindingConfigCache } from "../src/cli-tui/keybindings.js";
import {
	getQueuedFollowUpEditBinding,
	getQueuedFollowUpEditBindingLabel,
	getQueuedFollowUpEditBindingSequence,
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

	it("uses the configured keybinding override when present", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-queued-binding-test-"));
		const filePath = join(tempDir, "keybindings.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				version: 1,
				bindings: {
					"external-editor": "shift+left",
					"edit-last-follow-up": "ctrl+g",
				},
			}),
			"utf-8",
		);
		const env = {
			MAESTRO_KEYBINDINGS_FILE: filePath,
			TERM_PROGRAM: "WezTerm",
		} as NodeJS.ProcessEnv;

		try {
			resetTuiKeybindingConfigCache();
			expect(getQueuedFollowUpEditBinding(env)).toBe("ctrl+g");
			expect(getQueuedFollowUpEditBindingLabel(env)).toBe("Ctrl+G");
			expect(matchesQueuedFollowUpEditBinding("\x07", env)).toBe(true);
			expect(getQueuedFollowUpEditBindingSequence(env)).toBe("\x07");
		} finally {
			resetTuiKeybindingConfigCache();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
