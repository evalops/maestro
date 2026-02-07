import * as fs from "node:fs";
import * as path from "node:path";
import { getThemesDir } from "./theme-loader.js";

export interface ThemeWatcherCallbacks {
	reloadTheme(name: string): void;
	handleThemeDeleted(): void;
}

let themeWatcher: fs.FSWatcher | undefined;
let reloadTimeout: ReturnType<typeof setTimeout> | undefined;
let deleteTimeout: ReturnType<typeof setTimeout> | undefined;
let watcherGeneration = 0;

function clearWatcherTimers(): void {
	if (reloadTimeout) {
		clearTimeout(reloadTimeout);
		reloadTimeout = undefined;
	}
	if (deleteTimeout) {
		clearTimeout(deleteTimeout);
		deleteTimeout = undefined;
	}
}

export function startThemeWatcher(
	currentThemeName: string | undefined,
	callbacks: ThemeWatcherCallbacks,
): void {
	// Stop existing watcher if any
	stopThemeWatcher();
	const generation = watcherGeneration;

	// Only watch if it's a custom theme (not built-in)
	if (
		!currentThemeName ||
		currentThemeName === "dark" ||
		currentThemeName === "light" ||
		currentThemeName === "high-contrast"
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
			if (generation !== watcherGeneration) {
				return;
			}
			if (eventType === "change") {
				// Debounce rapid changes
				clearWatcherTimers();
				reloadTimeout = setTimeout(() => {
					if (generation !== watcherGeneration) {
						return;
					}
					try {
						callbacks.reloadTheme(currentThemeName);
					} catch (error) {
						// Ignore errors (file might be in invalid state while being edited)
					}
				}, 100);
			} else if (eventType === "rename") {
				// File was deleted or renamed - fall back to default theme
				clearWatcherTimers();
				deleteTimeout = setTimeout(() => {
					if (generation !== watcherGeneration) {
						return;
					}
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
	watcherGeneration += 1;
	clearWatcherTimers();
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}
}
