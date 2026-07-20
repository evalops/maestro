import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type TUI } from "@evalops/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTuiKeybindingConfigCache } from "../../src/cli-tui/keybindings.js";
import { renderStartupAnnouncements } from "../../src/cli-tui/startup-announcements.js";
import { stripAnsiSequences } from "../../src/cli-tui/utils/text-formatting.js";
import { getGlobalInstallCommand } from "../../src/package-metadata.js";

const tempDirs: string[] = [];

function renderAnnouncements(): string {
	const container = new Container();
	const ui = { requestRender: vi.fn() } as unknown as TUI;

	renderStartupAnnouncements({
		container,
		ui,
		updateNotice: {
			currentVersion: "0.10.0",
			latestVersion: "0.11.0",
			isUpdateAvailable: true,
			sourceUrl: "https://example.com/changelog",
		},
		modelScope: [],
	});

	return stripAnsiSequences(container.render(120).join("\n"));
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

describe("renderStartupAnnouncements", () => {
	it("renders the Maestro package name in update instructions", () => {
		const output = renderAnnouncements();

		expect(output).toContain(getGlobalInstallCommand("npm"));
		expect(output).not.toContain("@evalops/composer");
	});

	it("uses the configured cycle-model shortcut label", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-startup-test-"));
		tempDirs.push(tempDir);
		const filePath = join(tempDir, "keybindings.json");
		writeFileSync(
			filePath,
			JSON.stringify({
				version: 1,
				bindings: {
					"cycle-model": "ctrl+k",
					"command-palette": "ctrl+p",
				},
			}),
			"utf-8",
		);
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		resetTuiKeybindingConfigCache();

		const container = new Container();
		const ui = { requestRender: vi.fn() } as unknown as TUI;

		renderStartupAnnouncements({
			container,
			ui,
			modelScope: [{ id: "model-1", name: "Model 1" }],
		});

		const output = stripAnsiSequences(container.render(120).join("\n"));
		expect(output).toContain("Press Ctrl+K to cycle scoped models.");
	});

	it("surfaces invalid keybinding config health in startup announcements", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "maestro-startup-test-"));
		tempDirs.push(tempDir);
		const filePath = join(tempDir, "keybindings.json");
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
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		resetTuiKeybindingConfigCache();

		const container = new Container();
		const ui = { requestRender: vi.fn() } as unknown as TUI;

		renderStartupAnnouncements({
			container,
			ui,
			modelScope: [],
		});

		const output = stripAnsiSequences(container.render(120).join("\n"));
		expect(output).toContain(
			"Keyboard shortcuts config has 1 issue. Run /hotkeys validate.",
		);
	});
});
