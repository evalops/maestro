import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { embeddedThemes } from "./embedded-themes.js";
import { type ThemeJson, validateThemeJson } from "./theme-schema.js";

export { embeddedThemes } from "./embedded-themes.js";

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

let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const loadBuiltinTheme = (
			name: "dark" | "light" | "high-contrast",
		): ThemeJson => {
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
			"high-contrast": loadBuiltinTheme("high-contrast"),
		};
	}
	return BUILTIN_THEMES;
}

export function getThemesDir(): string {
	const override = resolveEnvPath(process.env.MAESTRO_THEMES_DIR);
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
