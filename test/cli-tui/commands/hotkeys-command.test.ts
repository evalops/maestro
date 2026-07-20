import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotkeysCommandHandler } from "../../../src/cli-tui/commands/hotkeys-command.js";
import type { CommandExecutionContext } from "../../../src/cli-tui/commands/types.js";
import { resetTuiKeybindingConfigCache } from "../../../src/cli-tui/keybindings.js";

const tempDirs: string[] = [];

function createTempKeybindingsPath(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-hotkeys-command-"));
	tempDirs.push(tempDir);
	return join(tempDir, "keybindings.json");
}

function createContext(
	rawInput: string,
	argumentText = "",
): CommandExecutionContext {
	return {
		command: { name: "hotkeys", description: "hotkeys" },
		rawInput,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
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

describe("hotkeys command", () => {
	it("shows the hotkeys view by default", async () => {
		const showHotkeys = vi.fn();
		const handler = createHotkeysCommandHandler({ showHotkeys });

		await handler(createContext("/hotkeys"));

		expect(showHotkeys).toHaveBeenCalledTimes(1);
	});

	it("creates a starter config file on init", async () => {
		const filePath = createTempKeybindingsPath();
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		const handler = createHotkeysCommandHandler({ showHotkeys: vi.fn() });
		const ctx = createContext("/hotkeys init", "init");

		await handler(ctx);

		expect(readFileSync(filePath, "utf-8")).toContain('"version": 1');
		expect(ctx.showInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				`Created keyboard shortcuts config at ${filePath}`,
			),
		);
	});

	it("reports validation issues for the current config", async () => {
		const filePath = createTempKeybindingsPath();
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		writeFileSync(
			filePath,
			JSON.stringify({
				version: 1,
				bindings: {
					"command-palette": "ctrl+p",
				},
			}),
			"utf-8",
		);
		const handler = createHotkeysCommandHandler({ showHotkeys: vi.fn() });
		const ctx = createContext("/hotkeys validate", "validate");

		await handler(ctx);

		expect(ctx.showInfo).toHaveBeenCalledWith(
			expect.stringContaining("Keyboard Shortcuts Config:"),
		);
		expect(ctx.showInfo).toHaveBeenCalledWith(
			expect.stringContaining(
				'TUI override "command-palette: ctrl+p" conflicts',
			),
		);
	});

	it("refuses to overwrite an existing config without --force", async () => {
		const filePath = createTempKeybindingsPath();
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		writeFileSync(filePath, '{"version":1,"bindings":{}}', "utf-8");
		const handler = createHotkeysCommandHandler({ showHotkeys: vi.fn() });
		const ctx = createContext("/hotkeys init", "init");

		await handler(ctx);

		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining(
				"Re-run with /hotkeys init --force to overwrite it.",
			),
		);
	});
});
