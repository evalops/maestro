import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetTuiKeybindingConfigCache } from "../src/cli-tui/keybindings.js";
import {
	getQueuedFollowUpEditBinding,
	getQueuedFollowUpEditBindingLabel,
	getQueuedFollowUpEditBindingSequence,
	matchesQueuedFollowUpEditBinding,
} from "../src/cli-tui/queue/queued-follow-up-edit-binding.js";

const tempDirs: string[] = [];

function createIsolatedEnv(
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const tempDir = mkdtempSync(
		join(tmpdir(), "maestro-queued-binding-defaults-"),
	);
	tempDirs.push(tempDir);
	return {
		MAESTRO_KEYBINDINGS_FILE: join(tempDir, "missing-keybindings.json"),
		...overrides,
	} as NodeJS.ProcessEnv;
}

afterEach(() => {
	resetTuiKeybindingConfigCache();
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("queued follow-up edit binding", () => {
	it("uses Shift+Left for tmux and terminals that swallow Alt+Up", () => {
		expect(getQueuedFollowUpEditBinding(createIsolatedEnv({ TMUX: "1" }))).toBe(
			"shift+left",
		);
		expect(
			getQueuedFollowUpEditBinding(
				createIsolatedEnv({ TERM_PROGRAM: "Apple_Terminal" }),
			),
		).toBe("shift+left");
		expect(
			getQueuedFollowUpEditBinding(
				createIsolatedEnv({ TERM_PROGRAM: "WarpTerminal" }),
			),
		).toBe("shift+left");
		expect(
			getQueuedFollowUpEditBinding(
				createIsolatedEnv({ TERM_PROGRAM: "vscode" }),
			),
		).toBe("shift+left");
		expect(
			getQueuedFollowUpEditBindingLabel(
				createIsolatedEnv({ TERM_PROGRAM: "vscode" }),
			),
		).toBe("Shift+Left");
	});

	it("keeps Alt+Up everywhere else", () => {
		const env = createIsolatedEnv({ TERM_PROGRAM: "WezTerm" });
		expect(getQueuedFollowUpEditBinding(env)).toBe("alt+up");
		expect(getQueuedFollowUpEditBindingLabel(env)).toBe("Alt+Up");
		expect(matchesQueuedFollowUpEditBinding("\x1b[1;3A", env)).toBe(true);
		expect(matchesQueuedFollowUpEditBinding("\x1b[1;2D", env)).toBe(false);
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
