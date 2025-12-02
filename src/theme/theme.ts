/**
 * Theme System for Composer
 *
 * Adapted from pi-mono (MIT License)
 * Copyright (c) 2025 Mario Zechner
 * https://github.com/badlogic/pi-mono
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@evalops/tui";
import { type Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import chalk from "chalk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getBuiltinThemeCandidateDirs(): string[] {
	const candidates = [
		__dirname,
		path.resolve(__dirname, "..", "..", "src", "theme"),
		path.resolve(process.cwd(), "src", "theme"),
	];
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const dir of candidates) {
		const normalized = path.resolve(dir);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		dirs.push(normalized);
	}
	return dirs;
}

// ============================================================================
// Types & Schema
// ============================================================================

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (11 colors)
		accent: ColorValueSchema,
		accentWarm: ColorValueSchema, // Warm accent for interactive/actionable elements
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		// Backgrounds & Content Text (7 colors)
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (5 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
	}),
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

const validateThemeJson = TypeCompiler.Compile(ThemeJsonSchema);

const EMBEDDED_THEMES: Record<"dark" | "light" | "high-contrast", ThemeJson> = {
	dark: {
		$schema: "./theme-schema.json",
		name: "dark",
		vars: {
			// Primary palette
			sky: "#7dd3fc",
			amber: "#fbbf24",
			violet: "#c084fc",
			// Semantic colors (softer variants)
			softGreen: "#86efac",
			softRed: "#fca5a5",
			softYellow: "#fde047",
			softBlue: "#93c5fd",
			// Text hierarchy
			textSecondary: "#94a3b8",
			textMuted: "#64748b",
			// Borders
			borderDim: "#334155",
			borderSubtle: "#475569",
			// Legacy/compat
			cyan: "#7dd3fc",
			blue: "#60a5fa",
			green: "#86efac",
			red: "#fca5a5",
			yellow: "#fde047",
			coral: "#fb923c",
			gray: "#94a3b8",
			dimGray: "#64748b",
			darkGray: "#475569",
			accent: "#7dd3fc",
			userMsgBg: "#1e293b",
			toolPendingBg: "#1e293b",
			toolSuccessBg: "#14532d20",
			toolErrorBg: "#7f1d1d20",
		},
		colors: {
			accent: "sky",
			accentWarm: "amber",
			border: "softBlue",
			borderAccent: "sky",
			borderMuted: "borderDim",
			success: "softGreen",
			error: "softRed",
			warning: "softYellow",
			muted: "textSecondary",
			dim: "textMuted",
			text: "",
			userMessageBg: "userMsgBg",
			userMessageText: "",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "textSecondary",
			mdHeading: "amber",
			mdLink: "softBlue",
			mdLinkUrl: "textMuted",
			mdCode: "sky",
			mdCodeBlock: "softGreen",
			mdCodeBlockBorder: "borderSubtle",
			mdQuote: "softBlue",
			mdQuoteBorder: "sky",
			mdHr: "borderSubtle",
			mdListBullet: "sky",
			toolDiffAdded: "softGreen",
			toolDiffRemoved: "softRed",
			toolDiffContext: "textMuted",
			syntaxComment: "textMuted",
			syntaxKeyword: "violet",
			syntaxFunction: "softBlue",
			syntaxVariable: "",
			syntaxString: "softGreen",
			syntaxNumber: "amber",
			syntaxType: "sky",
			syntaxOperator: "",
			syntaxPunctuation: "textSecondary",
			thinkingOff: "borderDim",
			thinkingMinimal: "textMuted",
			thinkingLow: "softBlue",
			thinkingMedium: "sky",
			thinkingHigh: "violet",
		},
	},
	light: {
		$schema: "./theme-schema.json",
		name: "light",
		vars: {
			// Primary palette (darker for light backgrounds)
			sky: "#0284c7",
			amber: "#d97706",
			violet: "#7c3aed",
			// Semantic colors
			softGreen: "#15803d",
			softRed: "#dc2626",
			softYellow: "#ca8a04",
			softBlue: "#2563eb",
			// Text hierarchy
			textSecondary: "#64748b",
			textMuted: "#94a3b8",
			// Borders
			borderDim: "#e2e8f0",
			borderSubtle: "#cbd5e1",
			// Legacy/compat
			teal: "#0d9488",
			blue: "#2563eb",
			green: "#15803d",
			red: "#dc2626",
			yellow: "#ca8a04",
			coral: "#ea580c",
			mediumGray: "#64748b",
			dimGray: "#94a3b8",
			lightGray: "#e2e8f0",
			userMsgBg: "#f1f5f9",
			toolPendingBg: "#f8fafc",
			toolSuccessBg: "#f0fdf4",
			toolErrorBg: "#fef2f2",
		},
		colors: {
			accent: "sky",
			accentWarm: "amber",
			border: "softBlue",
			borderAccent: "sky",
			borderMuted: "borderDim",
			success: "softGreen",
			error: "softRed",
			warning: "softYellow",
			muted: "textSecondary",
			dim: "textMuted",
			text: "",
			userMessageBg: "userMsgBg",
			userMessageText: "",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "textSecondary",
			mdHeading: "amber",
			mdLink: "softBlue",
			mdLinkUrl: "textMuted",
			mdCode: "sky",
			mdCodeBlock: "softGreen",
			mdCodeBlockBorder: "borderSubtle",
			mdQuote: "textSecondary",
			mdQuoteBorder: "borderSubtle",
			mdHr: "borderSubtle",
			mdListBullet: "sky",
			toolDiffAdded: "softGreen",
			toolDiffRemoved: "softRed",
			toolDiffContext: "textMuted",
			syntaxComment: "textMuted",
			syntaxKeyword: "violet",
			syntaxFunction: "softBlue",
			syntaxVariable: "",
			syntaxString: "softGreen",
			syntaxNumber: "amber",
			syntaxType: "sky",
			syntaxOperator: "",
			syntaxPunctuation: "textSecondary",
			thinkingOff: "borderDim",
			thinkingMinimal: "textMuted",
			thinkingLow: "softBlue",
			thinkingMedium: "sky",
			thinkingHigh: "violet",
		},
	},
	"high-contrast": {
		$schema: "./theme-schema.json",
		name: "high-contrast",
		vars: {
			// High contrast primary palette
			brightCyan: "#00ffff",
			brightYellow: "#ffff00",
			brightMagenta: "#ff00ff",
			// High contrast semantic colors
			brightGreen: "#00ff00",
			brightRed: "#ff0000",
			brightWhite: "#ffffff",
			brightBlue: "#0080ff",
			// Text hierarchy - maximum contrast
			textPrimary: "#ffffff",
			textSecondary: "#e0e0e0",
			// Borders - visible
			borderBright: "#808080",
			borderDim: "#404040",
			// Backgrounds
			userMsgBg: "#1a1a2e",
			toolPendingBg: "#1a1a2e",
			toolSuccessBg: "#002200",
			toolErrorBg: "#220000",
		},
		colors: {
			accent: "brightCyan",
			accentWarm: "brightYellow",
			border: "brightBlue",
			borderAccent: "brightCyan",
			borderMuted: "borderBright",
			success: "brightGreen",
			error: "brightRed",
			warning: "brightYellow",
			muted: "textSecondary",
			dim: "textSecondary",
			text: "textPrimary",
			userMessageBg: "userMsgBg",
			userMessageText: "textPrimary",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "textPrimary",
			toolOutput: "textSecondary",
			mdHeading: "brightYellow",
			mdLink: "brightCyan",
			mdLinkUrl: "brightBlue",
			mdCode: "brightCyan",
			mdCodeBlock: "brightGreen",
			mdCodeBlockBorder: "borderBright",
			mdQuote: "textSecondary",
			mdQuoteBorder: "borderBright",
			mdHr: "borderBright",
			mdListBullet: "brightCyan",
			toolDiffAdded: "brightGreen",
			toolDiffRemoved: "brightRed",
			toolDiffContext: "textSecondary",
			syntaxComment: "textSecondary",
			syntaxKeyword: "brightMagenta",
			syntaxFunction: "brightCyan",
			syntaxVariable: "textPrimary",
			syntaxString: "brightGreen",
			syntaxNumber: "brightYellow",
			syntaxType: "brightBlue",
			syntaxOperator: "textPrimary",
			syntaxPunctuation: "textSecondary",
			thinkingOff: "borderDim",
			thinkingMinimal: "textSecondary",
			thinkingLow: "brightBlue",
			thinkingMedium: "brightCyan",
			thinkingHigh: "brightMagenta",
		},
	},
};

export type ThemeColor =
	| "accent"
	| "accentWarm"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "userMessageText"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh";

export type ThemeBg =
	| "userMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// Color Utilities
// ============================================================================

function detectColorMode(): ColorMode {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "truecolor";
	}
	const term = process.env.TERM || "";
	if (term.includes("256color")) {
		return "256color";
	}
	return "256color";
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = Number.parseInt(cleaned.substring(0, 2), 16);
	const g = Number.parseInt(cleaned.substring(2, 4), 16);
	const b = Number.parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

function rgbTo256(r: number, g: number, b: number): number {
	const rIndex = Math.round((r / 255) * 5);
	const gIndex = Math.round((g / 255) * 5);
	const bIndex = Math.round((b / 255) * 5);
	return 16 + 36 * rIndex + 6 * gIndex + bIndex;
}

function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		}
		const index = hexTo256(color);
		return `\x1b[38;5;${index}m`;
	}
	throw new Error(`Invalid color value: ${color}`);
}

function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		}
		const index = hexTo256(color);
		return `\x1b[48;5;${index}m`;
	}
	throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

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

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const loadBuiltinTheme = (name: "dark" | "light"): ThemeJson => {
			for (const dir of getBuiltinThemeCandidateDirs()) {
				const themePath = path.join(dir, `${name}.json`);
				if (fs.existsSync(themePath)) {
					return JSON.parse(fs.readFileSync(themePath, "utf-8")) as ThemeJson;
				}
			}
			return EMBEDDED_THEMES[name];
		};
		BUILTIN_THEMES = {
			dark: loadBuiltinTheme("dark"),
			light: loadBuiltinTheme("light"),
		};
	}
	return BUILTIN_THEMES;
}

function getThemesDir(): string {
	return path.join(os.homedir(), ".composer", "agent", "themes");
}

export function getAvailableThemes(): string[] {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const themesDir = getThemesDir();
	if (fs.existsSync(themesDir)) {
		const files = fs.readdirSync(themesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	}
	return Array.from(themes).sort();
}

function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const themesDir = getThemesDir();
	const themePath = path.join(themesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error}`);
	}
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const errorMessages = errors
			.map((e) => `  - ${e.path}: ${e.message}`)
			.join("\n");
		throw new Error(`Invalid theme ${name}:\n${errorMessages}`);
	}
	return json as ThemeJson;
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode): Theme {
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<
		ThemeColor,
		string | number
	>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<
		ThemeBg,
		string | number
	>;
	const bgColorKeys: Set<string> = new Set([
		"userMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode);
}

function loadTheme(name: string, mode?: ColorMode): Theme {
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

function detectTerminalBackground(): "dark" | "light" {
	const colorfgbg = process.env.COLORFGBG || "";
	if (colorfgbg) {
		const parts = colorfgbg.split(";");
		if (parts.length >= 2) {
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
		return createTheme(EMBEDDED_THEMES.dark, detectColorMode());
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
