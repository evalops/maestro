import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatKeybindingConfigReport,
	generateKeybindingsTemplate,
	initializeKeybindingsFile,
	inspectKeybindingConfig,
} from "../../src/cli-tui/keybindings-config.js";

const tempDirs: string[] = [];

function createTempKeybindingsPath(): string {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-keybindings-config-"));
	tempDirs.push(tempDir);
	return join(tempDir, "keybindings.json");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

describe("keybindings config helpers", () => {
	it("reports a missing config file with an init hint", () => {
		const filePath = createTempKeybindingsPath();
		const report = inspectKeybindingConfig({
			MAESTRO_KEYBINDINGS_FILE: filePath,
		} as NodeJS.ProcessEnv);

		expect(report.exists).toBe(false);
		expect(formatKeybindingConfigReport(report)).toContain(
			"Hint: run /hotkeys init to create a starter file.",
		);
	});

	it("generates a terminal-aware starter template for TS and Rust bindings", () => {
		const template = generateKeybindingsTemplate({
			TERM_PROGRAM: "vscode",
		} as NodeJS.ProcessEnv);

		expect(template).toContain('"version": 1');
		expect(template).toContain('"bindings"');
		expect(template).toContain('"rustBindings"');
		expect(template).toContain('"edit-last-follow-up": "shift+left"');
	});

	it("validates unknown actions, invalid shortcuts, and conflicting overrides", () => {
		const filePath = createTempKeybindingsPath();
		writeFileSync(
			filePath,
			JSON.stringify(
				{
					version: 1,
					bindings: {
						unknown: "ctrl+k",
						"command-palette": "ctrl+p",
						"external-editor": "CTRL + G",
					},
					rustBindings: {
						"file-search": "ctrl+k",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		const report = inspectKeybindingConfig({
			MAESTRO_KEYBINDINGS_FILE: filePath,
			TERM_PROGRAM: "wezterm",
		} as NodeJS.ProcessEnv);

		expect(report.exists).toBe(true);
		expect(report.tuiRequestedOverrides).toBe(2);
		expect(report.tuiActiveOverrides).toBe(1);
		expect(report.rustRequestedOverrides).toBe(0);
		expect(report.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					severity: "error",
					message: expect.stringContaining(
						'Unknown TUI keybinding action "unknown"',
					),
				}),
				expect.objectContaining({
					severity: "error",
					message: expect.stringContaining(
						'Unsupported Rust TUI shortcut "ctrl+k"',
					),
				}),
				expect.objectContaining({
					severity: "warning",
					message: expect.stringContaining(
						'TUI override "command-palette: ctrl+p" conflicts with cycle-model',
					),
				}),
			]),
		);
	});

	it("creates a starter file and only overwrites when forced", () => {
		const filePath = createTempKeybindingsPath();

		expect(
			initializeKeybindingsFile({
				env: { MAESTRO_KEYBINDINGS_FILE: filePath } as NodeJS.ProcessEnv,
			}),
		).toEqual({ path: filePath, created: true });

		writeFileSync(
			filePath,
			'{"version":1,"bindings":{"command-palette":"ctrl+p"}}',
		);

		expect(
			initializeKeybindingsFile({
				env: { MAESTRO_KEYBINDINGS_FILE: filePath } as NodeJS.ProcessEnv,
			}),
		).toEqual({ path: filePath, created: false });

		expect(
			initializeKeybindingsFile({
				env: { MAESTRO_KEYBINDINGS_FILE: filePath } as NodeJS.ProcessEnv,
				force: true,
			}),
		).toEqual({ path: filePath, created: true });
		expect(readFileSync(filePath, "utf-8")).toContain('"rustBindings"');
	});
});
