/**
 * Color Utilities for Terminal Rendering
 *
 * Pure functions for color conversion and ANSI escape code generation.
 * Supports both truecolor (24-bit) and 256-color terminal modes.
 *
 * ## Color Formats
 *
 * - Hex: "#ff0000" (6-digit RGB)
 * - 256-color index: 0-255
 * - Empty string: Reset to default
 *
 * ## ANSI Escape Codes
 *
 * - Truecolor foreground: \x1b[38;2;R;G;Bm
 * - Truecolor background: \x1b[48;2;R;G;Bm
 * - 256-color foreground: \x1b[38;5;INDEXm
 * - 256-color background: \x1b[48;5;INDEXm
 *
 * @module theme/color-utils
 */

/**
 * Terminal color mode.
 * - truecolor: 24-bit RGB support (16 million colors)
 * - 256color: 256-color palette (standard xterm)
 */
export type ColorMode = "truecolor" | "256color";

/**
 * Color value that can be a hex string, 256-color index, or variable reference.
 * - Hex: "#ff0000"
 * - Index: 0-255
 * - Variable: "primary" (resolved by resolveVarRefs)
 * - Empty: "" (reset to default)
 */
export type ColorValue = string | number;

/**
 * RGB color components.
 */
export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

/**
 * Detect terminal color mode from environment variables.
 *
 * Checks COLORTERM for truecolor/24bit support, then falls back
 * to checking TERM for 256color. Defaults to 256color if uncertain.
 *
 * @returns Detected color mode
 */
export function detectColorMode(): ColorMode {
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

/**
 * Parse a hex color string to RGB components.
 *
 * @param hex - Hex color string (e.g., "#ff0000" or "ff0000")
 * @returns RGB color object
 * @throws Error if hex format is invalid
 *
 * @example
 * hexToRgb("#ff0000") // { r: 255, g: 0, b: 0 }
 * hexToRgb("#00ff00") // { r: 0, g: 255, b: 0 }
 */
export function hexToRgb(hex: string): RgbColor {
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

/**
 * Convert RGB values to a 256-color palette index.
 *
 * Uses the 6x6x6 color cube (indices 16-231) by mapping each
 * component to one of 6 levels (0-5).
 *
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns 256-color palette index (16-231)
 *
 * @example
 * rgbTo256(255, 0, 0) // 196 (bright red)
 * rgbTo256(0, 255, 0) // 46 (bright green)
 */
export function rgbTo256(r: number, g: number, b: number): number {
	const rIndex = Math.round((r / 255) * 5);
	const gIndex = Math.round((g / 255) * 5);
	const bIndex = Math.round((b / 255) * 5);
	return 16 + 36 * rIndex + 6 * gIndex + bIndex;
}

/**
 * Convert a hex color to a 256-color palette index.
 *
 * @param hex - Hex color string (e.g., "#ff0000")
 * @returns 256-color palette index
 *
 * @example
 * hexTo256("#ff0000") // 196
 */
export function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

/**
 * Generate ANSI escape sequence for foreground color.
 *
 * @param color - Hex string, 256-color index, or empty string for reset
 * @param mode - Terminal color mode
 * @returns ANSI escape sequence
 * @throws Error if color format is invalid
 *
 * @example
 * fgAnsi("#ff0000", "truecolor") // "\x1b[38;2;255;0;0m"
 * fgAnsi(196, "256color") // "\x1b[38;5;196m"
 * fgAnsi("", "truecolor") // "\x1b[39m" (reset)
 */
export function fgAnsi(color: string | number, mode: ColorMode): string {
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

/**
 * Generate ANSI escape sequence for background color.
 *
 * @param color - Hex string, 256-color index, or empty string for reset
 * @param mode - Terminal color mode
 * @returns ANSI escape sequence
 * @throws Error if color format is invalid
 *
 * @example
 * bgAnsi("#ff0000", "truecolor") // "\x1b[48;2;255;0;0m"
 * bgAnsi(196, "256color") // "\x1b[48;5;196m"
 * bgAnsi("", "truecolor") // "\x1b[49m" (reset)
 */
export function bgAnsi(color: string | number, mode: ColorMode): string {
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

/**
 * Resolve variable references in color values.
 *
 * Theme files can use variable references like "primary" instead of
 * raw hex values. This function resolves those references recursively.
 *
 * @param value - Color value (may be a variable reference)
 * @param vars - Variable name to value mapping
 * @param visited - Set of already-visited variables (for cycle detection)
 * @returns Resolved color value (hex string or 256-color index)
 * @throws Error if variable not found or circular reference detected
 *
 * @example
 * const vars = { primary: "#ff0000", accent: "primary" };
 * resolveVarRefs("accent", vars) // "#ff0000"
 */
export function resolveVarRefs(
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

/**
 * Resolve all color values in a color map.
 *
 * Takes a record of color names to values (which may include variable
 * references) and returns a record with all references resolved.
 *
 * @param colors - Record of color names to values
 * @param vars - Optional variable definitions for resolving references
 * @returns Record with all color values resolved
 *
 * @example
 * const colors = { text: "primary", bg: "#000000" };
 * const vars = { primary: "#ffffff" };
 * resolveThemeColors(colors, vars)
 * // { text: "#ffffff", bg: "#000000" }
 */
export function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}
