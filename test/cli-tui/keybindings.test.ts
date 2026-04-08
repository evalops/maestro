import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CustomEditor } from "../../src/cli-tui/custom-editor.js";
import {
	getResolvedTuiKeybindings,
	getTuiKeybindingLabel,
	matchesTuiKeybinding,
	resetTuiKeybindingConfigCache,
} from "../../src/cli-tui/keybindings.js";

const tempDirs: string[] = [];

function createKeybindingsFile(bindings: Record<string, string>): string {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-keybindings-test-"));
	tempDirs.push(tempDir);
	const filePath = join(tempDir, "keybindings.json");
	writeFileSync(
		filePath,
		JSON.stringify({
			version: 1,
			bindings,
		}),
		"utf-8",
	);
	return filePath;
}

afterEach(() => {
	resetTuiKeybindingConfigCache();
	delete process.env.MAESTRO_KEYBINDINGS_FILE;
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("tui keybindings", () => {
	it("uses terminal-aware defaults for queued follow-up editing", () => {
		expect(
			getResolvedTuiKeybindings({
				TERM_PROGRAM: "vscode",
			} as NodeJS.ProcessEnv)["edit-last-follow-up"],
		).toBe("shift+left");
		expect(
			getResolvedTuiKeybindings({
				TERM_PROGRAM: "WezTerm",
			} as NodeJS.ProcessEnv)["edit-last-follow-up"],
		).toBe("alt+up");
	});

	it("applies valid override permutations from the user-local config file", () => {
		const filePath = createKeybindingsFile({
			"cycle-model": "ctrl+k",
			"command-palette": "ctrl+p",
			"external-editor": "shift+left",
		});
		const env = {
			MAESTRO_KEYBINDINGS_FILE: filePath,
			TERM_PROGRAM: "WezTerm",
		} as NodeJS.ProcessEnv;

		expect(getResolvedTuiKeybindings(env)).toMatchObject({
			"cycle-model": "ctrl+k",
			"command-palette": "ctrl+p",
			"external-editor": "shift+left",
			"edit-last-follow-up": "alt+up",
		});
		expect(getTuiKeybindingLabel("external-editor", env)).toBe("Shift+Left");
		expect(matchesTuiKeybinding("cycle-model", "\x0b", env)).toBe(true);
		expect(matchesTuiKeybinding("command-palette", "\x10", env)).toBe(true);
		expect(matchesTuiKeybinding("external-editor", "\x1b[1;2D", env)).toBe(
			true,
		);
	});

	it("ignores partial overrides that would conflict with an existing default", () => {
		const filePath = createKeybindingsFile({
			"command-palette": "ctrl+p",
		});
		const env = {
			MAESTRO_KEYBINDINGS_FILE: filePath,
			TERM_PROGRAM: "WezTerm",
		} as NodeJS.ProcessEnv;

		expect(getResolvedTuiKeybindings(env)).toMatchObject({
			"cycle-model": "ctrl+p",
			"command-palette": "ctrl+k",
		});
	});

	it("routes editor actions through the configured shortcuts", () => {
		const filePath = createKeybindingsFile({
			"cycle-model": "ctrl+k",
			"command-palette": "ctrl+p",
		});
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		resetTuiKeybindingConfigCache();

		const editor = new CustomEditor();
		const shortcuts: string[] = [];
		let cycleModelCalls = 0;

		editor.onCtrlP = () => {
			cycleModelCalls += 1;
		};
		editor.onShortcut = (shortcut) => {
			shortcuts.push(shortcut);
			return true;
		};

		editor.handleInput("\x0b");
		editor.handleInput("\x10");

		expect(cycleModelCalls).toBe(1);
		expect(shortcuts).toEqual(["command-palette"]);
	});
});
