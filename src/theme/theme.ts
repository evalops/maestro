/**
 * Theme System for Composer
 *
 * Adapted from pi-mono (MIT License)
 * Copyright (c) 2025 Mario Zechner
 * https://github.com/badlogic/pi-mono
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@evalops/tui";
import chalk from "chalk";
import {
	type ColorMode,
	bgAnsi,
	detectColorMode,
	fgAnsi,
} from "./color-utils.js";
import { embeddedThemes, getThemesDir, loadThemeJson } from "./theme-loader.js";
import { resolveThemePalette } from "./theme-resolver.js";
import type { ThemeBg, ThemeColor, ThemeJson } from "./theme-schema.js";

// ============================================================================
// Types & Schema
// ============================================================================

export type { ThemeBg, ThemeColor } from "./theme-schema.js";
export { getAvailableThemes } from "./theme-loader.js";

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
	) {
		this.mode = mode;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [
			ThemeColor,
			string | number,
		][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [
			ThemeBg,
			string | number,
		][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(
		level: "off" | "minimal" | "low" | "medium" | "high",
	): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}
}

// ============================================================================
// Theme Loading
// ============================================================================

function createTheme(themeJson: ThemeJson, mode?: ColorMode): Theme {
	const palette = resolveThemePalette(themeJson, mode);
	return new Theme(palette.fgColors, palette.bgColors, palette.mode);
}

function loadTheme(name: string, mode?: ColorMode): Theme {
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

function detectTerminalBackground(): "dark" | "light" {
	const colorfgbg = process.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2 && parts[1] !== undefined) {
			const bg = Number.parseInt(parts[1], 10);
			if (!Number.isNaN(bg)) {
				const result = bg < 8 ? "dark" : "light";
				return result;
			}
		}
	}
	return "dark";
}

function getDefaultTheme(): string {
	return detectTerminalBackground();
}

// ============================================================================
// Global Theme Instance
// ============================================================================

function loadInitialTheme(): Theme {
	try {
		return loadTheme("dark");
	} catch (error) {
		return createTheme(embeddedThemes.dark, detectColorMode());
	}
}

// Initialize theme with dark as default
export let theme: Theme = loadInitialTheme();
let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let onThemeChangeCallback: (() => void) | undefined;

export function initTheme(themeName?: string): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		theme = loadTheme(name);
		startThemeWatcher();
	} catch (error) {
		// Theme is invalid - fall back to dark theme silently
		currentThemeName = "dark";
		theme = loadTheme("dark");
		// Don't start watcher for fallback theme
	}
}

export function setTheme(name: string): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		theme = loadTheme(name);
		startThemeWatcher();
		return { success: true };
	} catch (error) {
		// Theme is invalid - fall back to dark theme
		currentThemeName = "dark";
		theme = loadTheme("dark");
		// Don't start watcher for fallback theme
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

export function getCurrentThemeName(): string {
	return currentThemeName ?? "dark";
}

function startThemeWatcher(): void {
	// Stop existing watcher if any
	if (themeWatcher) {
		themeWatcher.close();
		themeWatcher = undefined;
	}

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
						// Reload the theme
						theme = loadTheme(currentThemeName ?? "dark");
						// Notify callback (to invalidate UI)
						if (onThemeChangeCallback) {
							onThemeChangeCallback();
						}
					} catch (error) {
						// Ignore errors (file might be in invalid state while being edited)
					}
				}, 100);
			} else if (eventType === "rename") {
				// File was deleted or renamed - fall back to default theme
				setTimeout(() => {
					if (!fs.existsSync(themeFile)) {
						currentThemeName = "dark";
						theme = loadTheme("dark");
						if (themeWatcher) {
							themeWatcher.close();
							themeWatcher = undefined;
						}
						if (onThemeChangeCallback) {
							onThemeChangeCallback();
						}
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

// ============================================================================
// TUI Helpers
// ============================================================================

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.fg("mdQuote", theme.italic(text)),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}
