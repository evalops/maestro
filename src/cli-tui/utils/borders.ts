import type { Component } from "@evalops/tui";
import { theme } from "../../theme/theme.js";
import type { ThemeColor } from "../../theme/theme.js";

/**
 * Box-drawing character sets for consistent TUI styling.
 *
 * "rounded" - Rounded corners (╭╮╰╯) - default for cards, messages, modals
 * "square"  - Sharp corners (┌┐└┘) - for diagrams, technical content
 * "double"  - Double-line borders (╔╗╚╝) - for urgent modals (approvals)
 */
export type BorderStyle = "rounded" | "square" | "double";

export interface BorderChars {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
	leftT: string;
	rightT: string;
	topT: string;
	bottomT: string;
	cross: string;
}

const ROUNDED_CHARS: BorderChars = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	leftT: "├",
	rightT: "┤",
	topT: "┬",
	bottomT: "┴",
	cross: "┼",
};

const SQUARE_CHARS: BorderChars = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
	leftT: "├",
	rightT: "┤",
	topT: "┬",
	bottomT: "┴",
	cross: "┼",
};

const DOUBLE_CHARS: BorderChars = {
	topLeft: "╔",
	topRight: "╗",
	bottomLeft: "╚",
	bottomRight: "╝",
	horizontal: "═",
	vertical: "║",
	leftT: "╠",
	rightT: "╣",
	topT: "╦",
	bottomT: "╩",
	cross: "╬",
};

/**
 * Get box-drawing characters for a given style.
 */
export function getBorderChars(style: BorderStyle = "rounded"): BorderChars {
	if (style === "square") return SQUARE_CHARS;
	if (style === "double") return DOUBLE_CHARS;
	return ROUNDED_CHARS;
}

/**
 * Build a horizontal line with optional corners.
 */
export function buildHorizontalLine(
	width: number,
	position: "top" | "bottom" | "middle" | "separator",
	style: BorderStyle = "rounded",
): string {
	const chars = getBorderChars(style);
	const innerWidth = Math.max(0, width - 2);

	switch (position) {
		case "top":
			return `${chars.topLeft}${chars.horizontal.repeat(innerWidth)}${chars.topRight}`;
		case "bottom":
			return `${chars.bottomLeft}${chars.horizontal.repeat(innerWidth)}${chars.bottomRight}`;
		case "middle":
			return `${chars.leftT}${chars.horizontal.repeat(innerWidth)}${chars.rightT}`;
		case "separator":
			return chars.horizontal.repeat(width);
	}
}

/**
 * Build a top border line, optionally with a centered or left-aligned title.
 */
export function buildTopLine(
	width: number,
	options: {
		style?: BorderStyle;
		title?: string;
		titleAlign?: "left" | "center";
	} = {},
): string {
	const { style = "rounded", title, titleAlign = "left" } = options;
	const chars = getBorderChars(style);

	if (!title) {
		return buildHorizontalLine(width, "top", style);
	}

	const innerWidth = Math.max(0, width - 2);
	const titleWithPadding = ` ${title} `;

	if (titleWithPadding.length >= innerWidth) {
		// Title too long, truncate
		const truncated = `${titleWithPadding.slice(0, innerWidth - 1)}…`;
		return `${chars.topLeft}${truncated}${chars.topRight}`;
	}

	const remainingWidth = innerWidth - titleWithPadding.length;

	if (titleAlign === "center") {
		const leftDash = Math.floor(remainingWidth / 2);
		const rightDash = remainingWidth - leftDash;
		return `${chars.topLeft}${chars.horizontal.repeat(leftDash)}${titleWithPadding}${chars.horizontal.repeat(rightDash)}${chars.topRight}`;
	}

	// Left-aligned (default)
	return `${chars.topLeft}${titleWithPadding}${chars.horizontal.repeat(remainingWidth)}${chars.topRight}`;
}

/**
 * Build a bottom border line.
 */
export function buildBottomLine(
	width: number,
	style: BorderStyle = "rounded",
): string {
	return buildHorizontalLine(width, "bottom", style);
}

/**
 * Build a separator line (for use between sections within a box).
 */
export function buildSeparatorLine(
	width: number,
	style: BorderStyle = "rounded",
): string {
	return buildHorizontalLine(width, "middle", style);
}

/**
 * Wrap content in vertical borders.
 */
export function wrapWithBorders(
	content: string,
	width: number,
	style: BorderStyle = "rounded",
): string {
	const chars = getBorderChars(style);
	const innerWidth = Math.max(0, width - 4); // Account for "│ " and " │"
	const truncated =
		content.length > innerWidth
			? `${content.slice(0, innerWidth - 1)}…`
			: content;
	const padding = " ".repeat(Math.max(0, innerWidth - truncated.length));
	return `${chars.vertical} ${truncated}${padding} ${chars.vertical}`;
}

/**
 * Apply theme color to a border string.
 */
export function colorBorder(
	borderStr: string,
	color: ThemeColor = "borderMuted",
): string {
	return theme.fg(color, borderStr);
}

/**
 * Build a complete themed top line.
 */
export function themedTopLine(
	width: number,
	options: {
		style?: BorderStyle;
		title?: string;
		titleAlign?: "left" | "center";
		color?: ThemeColor;
	} = {},
): string {
	const { color = "borderMuted", ...rest } = options;
	return colorBorder(buildTopLine(width, rest), color);
}

/**
 * Build a top line with both a left title and a right badge.
 * Used for tool cards to show tool name and status.
 */
export function buildTopLineWithBadge(
	width: number,
	options: {
		style?: BorderStyle;
		title?: string;
		badge?: string;
		badgeColor?: ThemeColor;
		borderColor?: ThemeColor;
	} = {},
): string {
	const {
		style = "square",
		title,
		badge,
		badgeColor = "muted",
		borderColor = "borderMuted",
	} = options;
	const chars = getBorderChars(style);
	const innerWidth = Math.max(0, width - 2);

	if (!title && !badge) {
		return colorBorder(buildHorizontalLine(width, "top", style), borderColor);
	}

	const titlePart = title ? ` ${title} ` : "";
	const badgePart = badge ? ` ${badge} ` : "";

	// Calculate widths
	const titleLen = titlePart.length;
	const badgeLen = badgePart.length;
	const dashesNeeded = Math.max(0, innerWidth - titleLen - badgeLen);

	if (dashesNeeded < 1) {
		// Not enough space, just show title
		return colorBorder(buildTopLine(width, { style, title }), borderColor);
	}

	// Build the line: corner + title + dashes + badge + corner
	const coloredTitle = title ? theme.bold(titlePart) : "";
	const coloredBadge = badge ? theme.fg(badgeColor, badgePart) : "";
	const dashes = theme.fg(borderColor, chars.horizontal.repeat(dashesNeeded));

	return (
		theme.fg(borderColor, chars.topLeft) +
		coloredTitle +
		dashes +
		coloredBadge +
		theme.fg(borderColor, chars.topRight)
	);
}

/**
 * Build a dashed separator line (for visual separation within cards).
 */
export function buildDashedSeparator(
	width: number,
	options: {
		style?: BorderStyle;
		color?: ThemeColor;
	} = {},
): string {
	const { style = "square", color = "borderMuted" } = options;
	const chars = getBorderChars(style);
	const innerWidth = Math.max(0, width - 2);

	// Alternating dash and space pattern
	let pattern = "";
	for (let i = 0; i < innerWidth; i++) {
		pattern += i % 2 === 0 ? chars.horizontal : " ";
	}

	return theme.fg(color, `${chars.leftT}${pattern}${chars.rightT}`);
}

/**
 * Build a complete themed bottom line.
 */
export function themedBottomLine(
	width: number,
	options: {
		style?: BorderStyle;
		color?: ThemeColor;
	} = {},
): string {
	const { style = "rounded", color = "borderMuted" } = options;
	return colorBorder(buildBottomLine(width, style), color);
}

/**
 * Build a complete themed separator line.
 */
export function themedSeparatorLine(
	width: number,
	options: {
		style?: BorderStyle;
		color?: ThemeColor;
	} = {},
): string {
	const { style = "rounded", color = "borderMuted" } = options;
	return colorBorder(buildSeparatorLine(width, style), color);
}

/** Error gutter character */
const ERROR_GUTTER = "┃";

/**
 * Add an error gutter line (red vertical bar) to the left of text.
 * Used for error messages to make them stand out.
 */
export function addErrorGutter(text: string): string {
	const lines = text.split("\n");
	const gutter = theme.fg("error", ERROR_GUTTER);
	return lines.map((line) => `${gutter} ${line}`).join("\n");
}

/**
 * Add a colored gutter line to the left of text.
 */
export function addGutter(text: string, color: ThemeColor): string {
	const lines = text.split("\n");
	const gutter = theme.fg(color, ERROR_GUTTER);
	return lines.map((line) => `${gutter} ${line}`).join("\n");
}

/**
 * Dynamic border component that renders a horizontal line at full viewport width.
 * Useful for lightweight separators in selectors and lists.
 */
export class DynamicBorder implements Component {
	constructor(
		private readonly color: ThemeColor = "border",
		private readonly style: BorderStyle = "rounded",
	) {}

	render(width: number): string[] {
		const chars = getBorderChars(this.style);
		return [theme.fg(this.color, chars.horizontal.repeat(Math.max(1, width)))];
	}
}

/**
 * Box component that renders content within a bordered frame.
 */
export class BorderedBox implements Component {
	constructor(
		private readonly content: Component,
		private readonly options: {
			style?: BorderStyle;
			color?: ThemeColor;
			title?: string;
			titleAlign?: "left" | "center";
		} = {},
	) {}

	render(width: number): string[] {
		const {
			style = "rounded",
			color = "borderMuted",
			title,
			titleAlign,
		} = this.options;
		const lines: string[] = [];

		// Top border
		lines.push(themedTopLine(width, { style, color, title, titleAlign }));

		// Content (rendered without borders, we add them)
		const contentLines = this.content.render(width - 4);
		const chars = getBorderChars(style);
		for (const line of contentLines) {
			const innerWidth = width - 4;
			// Pad line to inner width
			const padded = line.padEnd(innerWidth);
			lines.push(
				`${theme.fg(color, chars.vertical)} ${padded} ${theme.fg(color, chars.vertical)}`,
			);
		}

		// Bottom border
		lines.push(themedBottomLine(width, { style, color }));

		return lines;
	}

	handleInput?(data: string): void {
		if (this.content.handleInput) {
			this.content.handleInput(data);
		}
	}
}
