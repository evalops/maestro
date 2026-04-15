/**
 * Theme System for Composer
 *
 * Adapted from pi-mono (MIT License)
 * Copyright (c) 2025 Mario Zechner
 * https://github.com/badlogic/pi-mono
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@evalops/tui";
import chalk from "chalk";
import {
	type ColorMode,
	bgAnsi,
	detectColorMode,
	fgAnsi,
} from "./color-utils.js";
import { embeddedThemes, loadThemeJson } from "./theme-loader.js";
import { resolveThemePalette } from "./theme-resolver.js";
import type { ThemeBg, ThemeColor, ThemeJson } from "./theme-schema.js";
import { startThemeWatcher } from "./theme-watcher.js";
import {
	createEditorTheme,
	createMarkdownTheme,
	createSelectListTheme,
} from "./tui-theme-helpers.js";

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
let onThemeChangeCallback: (() => void) | undefined;

function getWatcherCallbacks() {
	return {
		reloadTheme(name: string) {
			theme = loadTheme(name);
			if (onThemeChangeCallback) {
				onThemeChangeCallback();
			}
		},
		handleThemeDeleted() {
			currentThemeName = "dark";
			theme = loadTheme("dark");
			if (onThemeChangeCallback) {
				onThemeChangeCallback();
			}
		},
	};
}

export function initTheme(themeName?: string): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		theme = loadTheme(name);
		startThemeWatcher(currentThemeName, getWatcherCallbacks());
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
		startThemeWatcher(currentThemeName, getWatcherCallbacks());
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

export { stopThemeWatcher } from "./theme-watcher.js";

// ============================================================================
// TUI Helpers (delegating to pure functions)
// ============================================================================

export function getMarkdownTheme(): MarkdownTheme {
	return createMarkdownTheme(theme);
}

export function getSelectListTheme(): SelectListTheme {
	return createSelectListTheme(theme);
}

export function getEditorTheme(): EditorTheme {
	return createEditorTheme(theme);
}
