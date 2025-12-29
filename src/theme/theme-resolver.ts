import {
	type ColorMode,
	detectColorMode,
	resolveThemeColors,
} from "./color-utils.js";
import type { ThemeBg, ThemeColor, ThemeJson } from "./theme-schema.js";

export interface ResolvedThemePalette {
	fgColors: Record<ThemeColor, string | number>;
	bgColors: Record<ThemeBg, string | number>;
	mode: ColorMode;
}

export function resolveThemePalette(
	themeJson: ThemeJson,
	mode?: ColorMode,
): ResolvedThemePalette {
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
	return { fgColors, bgColors, mode: colorMode };
}
