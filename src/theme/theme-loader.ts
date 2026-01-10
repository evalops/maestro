import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { type ThemeJson, validateThemeJson } from "./theme-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger("theme");

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

export const embeddedThemes: Record<
	"dark" | "light" | "high-contrast",
	ThemeJson
> = {
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

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const loadBuiltinTheme = (name: "dark" | "light"): ThemeJson => {
			for (const dir of getBuiltinThemeCandidateDirs()) {
				const themePath = path.join(dir, `${name}.json`);
				if (!fs.existsSync(themePath)) continue;

				try {
					const parsed = normalizeThemeJson(
						JSON.parse(fs.readFileSync(themePath, "utf-8")) as unknown,
					);
					if (validateThemeJson.Check(parsed)) {
						return parsed as ThemeJson;
					}
					logger.warn("Invalid built-in theme JSON; using embedded theme", {
						themePath,
						name,
					});
				} catch (error) {
					logger.warn(
						"Failed to load built-in theme JSON; using embedded theme",
						{
							themePath,
							name,
							error: error instanceof Error ? error.message : String(error),
						},
					);
				}
			}

			return embeddedThemes[name];
		};

		BUILTIN_THEMES = {
			dark: loadBuiltinTheme("dark"),
			light: loadBuiltinTheme("light"),
		};
	}
	return BUILTIN_THEMES;
}

export function getThemesDir(): string {
	const override = resolveEnvPath(process.env.COMPOSER_THEMES_DIR);
	if (override) return override;
	return path.resolve(getAgentDir(), "themes");
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeThemeJson(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	if (!isRecord(raw.colors)) return raw;

	// pi-mono compatibility / forward-compat:
	// - Composer requires `accentWarm`; fall back to `accent` when missing.
	// - pi-mono includes `thinkingXhigh` and `bashMode` which Composer does not use.
	const {
		bashMode: _bashMode,
		thinkingXhigh: _thinkingXhigh,
		...restColors
	} = raw.colors;

	const colors: Record<string, unknown> = { ...restColors };

	if (colors.accentWarm === undefined && colors.accent !== undefined) {
		colors.accentWarm = colors.accent;
	}

	const setIfMissing = (key: string, fallback: unknown): void => {
		if (colors[key] === undefined && fallback !== undefined) {
			colors[key] = fallback;
		}
	};

	// Ensure thinking-level colors exist (older themes may not specify them).
	setIfMissing(
		"thinkingOff",
		colors.borderMuted ??
			colors.dim ??
			colors.muted ??
			colors.border ??
			colors.accent,
	);
	setIfMissing(
		"thinkingMinimal",
		colors.dim ??
			colors.muted ??
			colors.borderMuted ??
			colors.border ??
			colors.accent,
	);
	setIfMissing(
		"thinkingLow",
		colors.border ?? colors.accent ?? colors.borderAccent,
	);
	setIfMissing(
		"thinkingMedium",
		colors.accent ?? colors.borderAccent ?? colors.border ?? colors.muted,
	);
	setIfMissing(
		"thinkingHigh",
		colors.borderAccent ?? colors.accent ?? colors.border ?? colors.warning,
	);

	return { ...raw, colors };
}

export function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name]!;
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
	const normalized = normalizeThemeJson(json);
	if (!validateThemeJson.Check(normalized)) {
		const errors = Array.from(validateThemeJson.Errors(normalized));
		const errorMessages = errors
			.map((e) => `  - ${e.path}: ${e.message}`)
			.join("\n");
		throw new Error(`Invalid theme ${name}:\n${errorMessages}`);
	}
	return normalized as ThemeJson;
}
