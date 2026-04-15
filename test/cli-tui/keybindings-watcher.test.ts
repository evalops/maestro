import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectKeybindingConfig } from "../../src/cli-tui/keybindings-config.js";
import {
	startTuiKeybindingWatcher,
	stopTuiKeybindingWatcher,
} from "../../src/cli-tui/keybindings-watcher.js";
import {
	getTuiKeybindingLabel,
	resetTuiKeybindingConfigCache,
} from "../../src/cli-tui/keybindings.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return {
		...actual,
		watch: vi.fn(),
	};
});

const tempDirs: string[] = [];
const mockWatch = vi.mocked(fs.watch);

function createKeybindingsFile(bindings: Record<string, string>): string {
	const tempDir = mkdtempSync(join(tmpdir(), "maestro-keybindings-watch-"));
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

beforeEach(() => {
	vi.useFakeTimers();
	mockWatch.mockReset();
});

afterEach(() => {
	stopTuiKeybindingWatcher();
	resetTuiKeybindingConfigCache();
	delete process.env.MAESTRO_KEYBINDINGS_FILE;
	while (tempDirs.length > 0) {
		const tempDir = tempDirs.pop();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
	vi.useRealTimers();
});

describe("tui keybindings watcher", () => {
	it("reloads cached bindings after keybindings.json changes", async () => {
		const filePath = createKeybindingsFile({
			"command-palette": "ctrl+p",
			"cycle-model": "ctrl+k",
		});
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;
		resetTuiKeybindingConfigCache();
		expect(getTuiKeybindingLabel("cycle-model")).toBe("Ctrl+K");

		let listener:
			| ((eventType: string, filename: string | Buffer | null) => void)
			| undefined;
		mockWatch.mockImplementation(((_path, callback) => {
			listener = callback as (
				eventType: string,
				filename: string | Buffer | null,
			) => void;
			return {
				close: vi.fn(),
				unref: vi.fn(),
			} as unknown as ReturnType<typeof fs.watch>;
		}) as typeof fs.watch);

		const reports: Array<ReturnType<typeof inspectKeybindingConfig>> = [];
		startTuiKeybindingWatcher({
			onReload: (report) => reports.push(report),
		});

		writeFileSync(
			filePath,
			JSON.stringify({
				version: 1,
				bindings: {
					"external-editor": "shift+left",
				},
			}),
			"utf-8",
		);
		listener?.("change", "keybindings.json");
		await vi.advanceTimersByTimeAsync(100);

		expect(getTuiKeybindingLabel("cycle-model")).toBe("Ctrl+P");
		expect(getTuiKeybindingLabel("external-editor")).toBe("Shift+Left");
		expect(reports).toEqual([inspectKeybindingConfig()]);
	});

	it("ignores unrelated filesystem events", async () => {
		const filePath = createKeybindingsFile({});
		process.env.MAESTRO_KEYBINDINGS_FILE = filePath;

		let listener:
			| ((eventType: string, filename: string | Buffer | null) => void)
			| undefined;
		mockWatch.mockImplementation(((_path, callback) => {
			listener = callback as (
				eventType: string,
				filename: string | Buffer | null,
			) => void;
			return {
				close: vi.fn(),
				unref: vi.fn(),
			} as unknown as ReturnType<typeof fs.watch>;
		}) as typeof fs.watch);

		const onReload = vi.fn();
		startTuiKeybindingWatcher({ onReload });
		listener?.("change", "other-file.json");
		await vi.runAllTimersAsync();

		expect(onReload).not.toHaveBeenCalled();
	});
});
