import { describe, expect, it } from "vitest";
import { embeddedThemes } from "../../src/theme/embedded-themes.js";
import { resolveThemePalette } from "../../src/theme/theme-resolver.js";
import { Theme } from "../../src/theme/theme.js";
import {
	createEditorTheme,
	createMarkdownTheme,
	createSelectListTheme,
} from "../../src/theme/tui-theme-helpers.js";

function buildTheme(): Theme {
	const palette = resolveThemePalette(embeddedThemes.dark, "256color");
	return new Theme(palette.fgColors, palette.bgColors, palette.mode);
}

describe("createMarkdownTheme", () => {
	it("returns all required MarkdownTheme keys", () => {
		const md = createMarkdownTheme(buildTheme());
		const requiredKeys = [
			"heading",
			"link",
			"linkUrl",
			"code",
			"codeBlock",
			"codeBlockBorder",
			"quote",
			"quoteBorder",
			"hr",
			"listBullet",
			"bold",
			"italic",
			"underline",
			"strikethrough",
		];
		for (const key of requiredKeys) {
			expect(md).toHaveProperty(key);
		}
	});

	it("formatters produce strings", () => {
		const md = createMarkdownTheme(buildTheme());
		expect(typeof md.heading("test")).toBe("string");
		expect(typeof md.link("test")).toBe("string");
		expect(typeof md.bold("test")).toBe("string");
		expect(typeof md.italic("test")).toBe("string");
		expect(typeof md.strikethrough("test")).toBe("string");
	});
});

describe("createSelectListTheme", () => {
	it("returns all required SelectListTheme keys", () => {
		const sl = createSelectListTheme(buildTheme());
		const requiredKeys = [
			"selectedPrefix",
			"selectedText",
			"description",
			"scrollInfo",
			"noMatch",
		];
		for (const key of requiredKeys) {
			expect(sl).toHaveProperty(key);
		}
	});

	it("formatters produce strings", () => {
		const sl = createSelectListTheme(buildTheme());
		expect(typeof sl.selectedPrefix("test")).toBe("string");
		expect(typeof sl.description("test")).toBe("string");
	});
});

describe("createEditorTheme", () => {
	it("returns borderColor and selectList", () => {
		const ed = createEditorTheme(buildTheme());
		expect(ed).toHaveProperty("borderColor");
		expect(ed).toHaveProperty("selectList");
	});

	it("borderColor formatter produces a string", () => {
		const ed = createEditorTheme(buildTheme());
		expect(typeof ed.borderColor("test")).toBe("string");
	});

	it("selectList contains required keys", () => {
		const ed = createEditorTheme(buildTheme());
		expect(ed.selectList).toHaveProperty("selectedPrefix");
		expect(ed.selectList).toHaveProperty("selectedText");
	});
});
