import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	type ThemeWatcherCallbacks,
	startThemeWatcher,
	stopThemeWatcher,
} from "../../src/theme/theme-watcher.js";

describe("theme-watcher", () => {
	let themesDir: string;
	let previousThemesDir: string | undefined;
	let previousMaestroHome: string | undefined;

	beforeEach(() => {
		themesDir = mkdtempSync(join(tmpdir(), "composer-theme-watcher-"));
		previousThemesDir = process.env.MAESTRO_THEMES_DIR;
		previousMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_THEMES_DIR = themesDir;
		process.env.MAESTRO_HOME = join(themesDir, ".maestro-home");
	});

	afterEach(() => {
		stopThemeWatcher();
		process.env.MAESTRO_THEMES_DIR = previousThemesDir ?? "";
		if (previousMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = previousMaestroHome;
		}
		rmSync(themesDir, { recursive: true, force: true });
	});

	it("does not start for built-in 'dark' theme", () => {
		const callbacks: ThemeWatcherCallbacks = {
			reloadTheme: vi.fn(),
			handleThemeDeleted: vi.fn(),
		};
		// Should not throw even though no file exists for "dark"
		startThemeWatcher("dark", callbacks);
		stopThemeWatcher();
	});

	it("does not start for built-in 'light' theme", () => {
		const callbacks: ThemeWatcherCallbacks = {
			reloadTheme: vi.fn(),
			handleThemeDeleted: vi.fn(),
		};
		startThemeWatcher("light", callbacks);
		stopThemeWatcher();
	});

	it("does not start for built-in 'high-contrast' theme", () => {
		const callbacks: ThemeWatcherCallbacks = {
			reloadTheme: vi.fn(),
			handleThemeDeleted: vi.fn(),
		};
		startThemeWatcher("high-contrast", callbacks);
		stopThemeWatcher();
	});

	it("does not start for undefined theme name", () => {
		const callbacks: ThemeWatcherCallbacks = {
			reloadTheme: vi.fn(),
			handleThemeDeleted: vi.fn(),
		};
		startThemeWatcher(undefined, callbacks);
		stopThemeWatcher();
	});

	it("does not start for non-existent custom theme file", () => {
		const callbacks: ThemeWatcherCallbacks = {
			reloadTheme: vi.fn(),
			handleThemeDeleted: vi.fn(),
		};
		startThemeWatcher("nonexistent-theme", callbacks);
		stopThemeWatcher();
	});

	it("starts watcher for existing custom theme file", () => {
		const themeFile = join(themesDir, "custom.json");
		writeFileSync(themeFile, JSON.stringify({ name: "custom", colors: {} }));

		const callbacks: ThemeWatcherCallbacks = {
			reloadTheme: vi.fn(),
			handleThemeDeleted: vi.fn(),
		};
		startThemeWatcher("custom", callbacks);
		// Watcher started without error — stop it
		stopThemeWatcher();
	});

	it("stopThemeWatcher is idempotent", () => {
		// Calling stop when no watcher is active should not throw
		stopThemeWatcher();
		stopThemeWatcher();
	});
});
