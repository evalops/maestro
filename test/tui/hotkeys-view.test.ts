import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHotkeysMarkdown } from "../../src/cli-tui/hotkeys-view.js";
import { resetTuiKeybindingConfigCache } from "../../src/cli-tui/keybindings.js";

const tempDirs: string[] = [];

function createIsolatedEnv(
	overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-hotkeys-defaults-"));
	tempDirs.push(tempDir);
	return {
		MAESTRO_KEYBINDINGS_FILE: join(tempDir, "missing-keybindings.json"),
		...overrides,
	} as NodeJS.ProcessEnv;
}

function createKeybindingsFile(bindings: Record<string, string>): string {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-hotkeys-test-"));
	tempDirs.push(tempDir);
	const filePath = join(tempDir, "keybindings.json");
	writeFileSync(filePath, JSON.stringify({ version: 1, bindings }), "utf-8");
	return filePath;
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

describe("buildHotkeysMarkdown", () => {
	it("uses the terminal-aware queued follow-up edit binding label", () => {
		expect(
			buildHotkeysMarkdown(createIsolatedEnv({ TERM_PROGRAM: "vscode" })),
		).toContain("`Shift+Left` | Edit last queued follow-up");
		expect(
			buildHotkeysMarkdown(createIsolatedEnv({ TERM_PROGRAM: "WezTerm" })),
		).toContain("`Alt+Up` | Edit last queued follow-up");
	});

	it("describes Tab as the unified send-or-queue shortcut", () => {
		expect(buildHotkeysMarkdown()).toContain(
			"`Tab` | Send message / Queue follow-up (while running)",
		);
	});

	it("renders configured shortcut labels from the user-local keybinding file", () => {
		const filePath = createKeybindingsFile({
			"cycle-model": "ctrl+k",
			"command-palette": "ctrl+p",
			"external-editor": "shift+left",
		});

		const markdown = buildHotkeysMarkdown({
			MAESTRO_KEYBINDINGS_FILE: filePath,
			TERM_PROGRAM: "WezTerm",
		} as NodeJS.ProcessEnv);

		expect(markdown).toContain("`Ctrl+P` | Command palette");
		expect(markdown).toContain(
			"`Shift+Left` | Edit message in external editor",
		);
		expect(markdown).toContain("`Ctrl+K` | Cycle models");
		expect(markdown).toContain("`Ctrl+K` | Delete to end of line");
	});

	it("includes keybinding management commands and config status", () => {
		const markdown = buildHotkeysMarkdown();

		expect(markdown).toContain(
			"`/hotkeys path` | Show the config file location",
		);
		expect(markdown).toContain(
			"`/hotkeys validate` | Validate current overrides",
		);
		expect(markdown).toContain("Current config:");
	});
});
