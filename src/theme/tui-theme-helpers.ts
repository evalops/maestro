import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@evalops/tui";
import chalk from "chalk";
import type { Theme } from "./theme.js";

export function createMarkdownTheme(t: Theme): MarkdownTheme {
	return {
		heading: (text: string) => t.fg("mdHeading", text),
		link: (text: string) => t.fg("mdLink", text),
		linkUrl: (text: string) => t.fg("mdLinkUrl", text),
		code: (text: string) => t.fg("mdCode", text),
		codeBlock: (text: string) => t.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => t.fg("mdCodeBlockBorder", text),
		quote: (text: string) => t.fg("mdQuote", text),
		quoteBorder: (text: string) => t.fg("mdQuoteBorder", text),
		hr: (text: string) => t.fg("mdHr", text),
		listBullet: (text: string) => t.fg("mdListBullet", text),
		bold: (text: string) => t.bold(text),
		italic: (text: string) => t.fg("mdQuote", t.italic(text)),
		underline: (text: string) => t.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
	};
}

export function createSelectListTheme(t: Theme): SelectListTheme {
	return {
		selectedPrefix: (text: string) => t.fg("accent", text),
		selectedText: (text: string) => t.fg("accent", text),
		description: (text: string) => t.fg("muted", text),
		scrollInfo: (text: string) => t.fg("muted", text),
		noMatch: (text: string) => t.fg("muted", text),
	};
}

export function createEditorTheme(t: Theme): EditorTheme {
	return {
		borderColor: (text: string) => t.fg("borderMuted", text),
		selectList: createSelectListTheme(t),
	};
}
