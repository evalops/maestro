import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ColorMode,
	bgAnsi,
	detectColorMode,
	fgAnsi,
	hexTo256,
	hexToRgb,
	resolveThemeColors,
	resolveVarRefs,
	rgbTo256,
} from "../../src/theme/color-utils.js";

describe("hexToRgb", () => {
	it("parses hex with hash prefix", () => {
		expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
		expect(hexToRgb("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
		expect(hexToRgb("#0000ff")).toEqual({ r: 0, g: 0, b: 255 });
	});

	it("parses hex without hash prefix", () => {
		expect(hexToRgb("ff0000")).toEqual({ r: 255, g: 0, b: 0 });
		expect(hexToRgb("ffffff")).toEqual({ r: 255, g: 255, b: 255 });
		expect(hexToRgb("000000")).toEqual({ r: 0, g: 0, b: 0 });
	});

	it("parses mixed case hex", () => {
		expect(hexToRgb("#aAbBcC")).toEqual({ r: 170, g: 187, b: 204 });
		expect(hexToRgb("AABBCC")).toEqual({ r: 170, g: 187, b: 204 });
	});

	it("throws on invalid hex length", () => {
		expect(() => hexToRgb("#fff")).toThrow("Invalid hex color: #fff");
		expect(() => hexToRgb("#fffffff")).toThrow("Invalid hex color: #fffffff");
		expect(() => hexToRgb("")).toThrow("Invalid hex color: ");
	});

	it("throws on invalid hex characters", () => {
		expect(() => hexToRgb("#gggggg")).toThrow("Invalid hex color: #gggggg");
		expect(() => hexToRgb("#zz0000")).toThrow("Invalid hex color: #zz0000");
	});
});

describe("rgbTo256", () => {
	it("converts black", () => {
		expect(rgbTo256(0, 0, 0)).toBe(16); // First color in 6x6x6 cube
	});

	it("converts white", () => {
		expect(rgbTo256(255, 255, 255)).toBe(231); // Last color in 6x6x6 cube
	});

	it("converts primary colors", () => {
		expect(rgbTo256(255, 0, 0)).toBe(196); // Red
		expect(rgbTo256(0, 255, 0)).toBe(46); // Green
		expect(rgbTo256(0, 0, 255)).toBe(21); // Blue
	});

	it("converts mid-range colors", () => {
		expect(rgbTo256(128, 128, 128)).toBe(145); // Gray
	});
});

describe("hexTo256", () => {
	it("converts hex to 256-color index", () => {
		expect(hexTo256("#ff0000")).toBe(196);
		expect(hexTo256("#00ff00")).toBe(46);
		expect(hexTo256("#0000ff")).toBe(21);
	});

	it("handles hex without hash", () => {
		expect(hexTo256("ff0000")).toBe(196);
	});
});

describe("fgAnsi", () => {
	it("returns reset code for empty string", () => {
		expect(fgAnsi("", "truecolor")).toBe("\x1b[39m");
		expect(fgAnsi("", "256color")).toBe("\x1b[39m");
	});

	it("returns 256-color code for number", () => {
		expect(fgAnsi(196, "truecolor")).toBe("\x1b[38;5;196m");
		expect(fgAnsi(196, "256color")).toBe("\x1b[38;5;196m");
	});

	it("returns truecolor code for hex in truecolor mode", () => {
		expect(fgAnsi("#ff0000", "truecolor")).toBe("\x1b[38;2;255;0;0m");
		expect(fgAnsi("#00ff00", "truecolor")).toBe("\x1b[38;2;0;255;0m");
	});

	it("converts hex to 256-color in 256color mode", () => {
		expect(fgAnsi("#ff0000", "256color")).toBe("\x1b[38;5;196m");
	});

	it("throws on invalid color", () => {
		expect(() => fgAnsi("invalid", "truecolor")).toThrow(
			"Invalid color value: invalid",
		);
	});
});

describe("bgAnsi", () => {
	it("returns reset code for empty string", () => {
		expect(bgAnsi("", "truecolor")).toBe("\x1b[49m");
		expect(bgAnsi("", "256color")).toBe("\x1b[49m");
	});

	it("returns 256-color code for number", () => {
		expect(bgAnsi(196, "truecolor")).toBe("\x1b[48;5;196m");
		expect(bgAnsi(196, "256color")).toBe("\x1b[48;5;196m");
	});

	it("returns truecolor code for hex in truecolor mode", () => {
		expect(bgAnsi("#ff0000", "truecolor")).toBe("\x1b[48;2;255;0;0m");
	});

	it("converts hex to 256-color in 256color mode", () => {
		expect(bgAnsi("#ff0000", "256color")).toBe("\x1b[48;5;196m");
	});

	it("throws on invalid color", () => {
		expect(() => bgAnsi("invalid", "truecolor")).toThrow(
			"Invalid color value: invalid",
		);
	});
});

describe("resolveVarRefs", () => {
	it("returns hex values unchanged", () => {
		expect(resolveVarRefs("#ff0000", {})).toBe("#ff0000");
	});

	it("returns numeric values unchanged", () => {
		expect(resolveVarRefs(196, {})).toBe(196);
	});

	it("returns empty string unchanged", () => {
		expect(resolveVarRefs("", {})).toBe("");
	});

	it("resolves single variable reference", () => {
		const vars = { primary: "#ff0000" };
		expect(resolveVarRefs("primary", vars)).toBe("#ff0000");
	});

	it("resolves chained variable references", () => {
		const vars = {
			primary: "#ff0000",
			accent: "primary",
			highlight: "accent",
		};
		expect(resolveVarRefs("highlight", vars)).toBe("#ff0000");
	});

	it("resolves variable to numeric value", () => {
		const vars = { primary: 196 };
		expect(resolveVarRefs("primary", vars)).toBe(196);
	});

	it("throws on missing variable", () => {
		expect(() => resolveVarRefs("missing", {})).toThrow(
			"Variable reference not found: missing",
		);
	});

	it("throws on circular reference", () => {
		const vars = {
			a: "b",
			b: "a",
		};
		expect(() => resolveVarRefs("a", vars)).toThrow(
			"Circular variable reference detected: a",
		);
	});

	it("throws on self-referential variable", () => {
		const vars = { self: "self" };
		expect(() => resolveVarRefs("self", vars)).toThrow(
			"Circular variable reference detected: self",
		);
	});
});

describe("resolveThemeColors", () => {
	it("resolves all colors in a record", () => {
		const colors = {
			text: "primary",
			bg: "#000000",
			accent: 196,
		};
		const vars = { primary: "#ffffff" };
		expect(resolveThemeColors(colors, vars)).toEqual({
			text: "#ffffff",
			bg: "#000000",
			accent: 196,
		});
	});

	it("handles empty vars", () => {
		const colors = {
			text: "#ffffff",
			bg: "#000000",
		};
		expect(resolveThemeColors(colors)).toEqual({
			text: "#ffffff",
			bg: "#000000",
		});
	});

	it("handles empty colors", () => {
		expect(resolveThemeColors({})).toEqual({});
	});
});

describe("detectColorMode", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns truecolor when COLORTERM is truecolor", () => {
		process.env.COLORTERM = "truecolor";
		expect(detectColorMode()).toBe("truecolor");
	});

	it("returns truecolor when COLORTERM is 24bit", () => {
		process.env.COLORTERM = "24bit";
		expect(detectColorMode()).toBe("truecolor");
	});

	it("returns 256color when TERM contains 256color", () => {
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.COLORTERM;
		process.env.TERM = "xterm-256color";
		expect(detectColorMode()).toBe("256color");
	});

	it("defaults to 256color when no color info", () => {
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.COLORTERM;
		// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
		delete process.env.TERM;
		expect(detectColorMode()).toBe("256color");
	});
});
