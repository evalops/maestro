import * as fs from "node:fs";
import * as path from "node:path";
import { getThemesDir } from "./theme-loader.js";

export interface ThemeWatcherCallbacks {
	reloadTheme(name: string): void;
	handleThemeDeleted(): void;
}

let themeWatcher: fs.FSWatcher | undefined;

export function startThemeWatcher(
	currentThemeName: string | undefined,
	callbacks: ThemeWatcherCallbacks,
): void {
	// Stop existing watcher if any
	stopThemeWatcher();

	// Only watch if it's a custom theme (not built-in)
	if (
		!currentThemeName ||
		currentThemeName === "dark" ||
		currentThemeName === "light"
	) {
		return;
	}

	const themesDir = getThemesDir();
	const themeFile = path.join(themesDir, `${currentThemeName}.json`);

	// Only watch if the file exists
	if (!fs.existsSync(themeFile)) {
		return;
	}

	try {
		themeWatcher = fs.watch(themeFile, (eventType) => {
			if (eventType === "change") {
				// Debounce rapid changes
				setTimeout(() => {
					try {
						callbacks.reloadTheme(currentThemeName);
					} catch (error) {
						// Ignore errors (file might be in invalid state while being edited)
					}
				}, 100);
			} else if (eventType === "rename") {
				// File was deleted or renamed - fall back to default theme
				setTimeout(() => {
					if (!fs.existsSync(themeFile)) {
						callbacks.handleThemeDeleted();
						stopThemeWatcher();
					}
				}, 100);
			}
		});
	} catch (error) {
		// Ignore errors starting watcher
	}
}

export function stopThemeWatcher(): void {
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
}
