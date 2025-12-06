/**
 * Adapter to convert existing TUI components to native RenderNode trees.
 *
 * The existing TUI uses a line-based rendering model where components
 * return string[] from render(). This adapter bridges that to the
 * RenderNode tree structure expected by the Rust TUI.
 */

import type { Component, Container } from "@evalops/tui";
import type {
	Color,
	HistoryLine,
	RenderNode,
	StyledSpan,
	TextStyle,
} from "./protocol.js";

/**
 * Parse ANSI escape codes and convert to StyledSpan array
 */
export function parseAnsiLine(line: string): StyledSpan[] {
	const spans: StyledSpan[] = [];
	let currentStyle: TextStyle = {};
	let currentText = "";

	// ANSI escape sequence regex
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes intentionally use control characters
	const ansiRegex = /\x1b\[([0-9;]*)m/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null = ansiRegex.exec(line);

	while (match !== null) {
		// Add text before this escape sequence
		if (match.index > lastIndex) {
			currentText += line.slice(lastIndex, match.index);
		}

		// If we have text, save it with current style
		if (currentText) {
			spans.push({ text: currentText, style: { ...currentStyle } });
			currentText = "";
		}

		// Parse the escape sequence
		const codes = match[1].split(";").map(Number);
		currentStyle = applyAnsiCodes(currentStyle, codes);

		lastIndex = ansiRegex.lastIndex;
		match = ansiRegex.exec(line);
	}

	// Add remaining text
	if (lastIndex < line.length) {
		currentText += line.slice(lastIndex);
	}

	if (currentText) {
		spans.push({ text: currentText, style: { ...currentStyle } });
	}

	// If no spans, add empty span
	if (spans.length === 0) {
		spans.push({ text: line });
	}

	return spans;
}

/**
 * Apply ANSI codes to style
 */
function applyAnsiCodes(style: TextStyle, codes: number[]): TextStyle {
	const newStyle = { ...style };

	for (const code of codes) {
		if (code === 0) {
			// Reset
			return {};
		}
		if (code === 1) {
			newStyle.bold = true;
		} else if (code === 2) {
			newStyle.dim = true;
		} else if (code === 3) {
			newStyle.italic = true;
		} else if (code === 4) {
			newStyle.underline = true;
		} else if (code === 9) {
			newStyle.strikethrough = true;
		} else if (code === 22) {
			newStyle.bold = false;
			newStyle.dim = false;
		} else if (code === 23) {
			newStyle.italic = false;
		} else if (code === 24) {
			newStyle.underline = false;
		} else if (code === 29) {
			newStyle.strikethrough = false;
		} else if (code >= 30 && code <= 37) {
			newStyle.fg = ansiColorToColor(code - 30);
		} else if (code === 39) {
			newStyle.fg = undefined;
		} else if (code >= 40 && code <= 47) {
			newStyle.bg = ansiColorToColor(code - 40);
		} else if (code === 49) {
			newStyle.bg = undefined;
		} else if (code >= 90 && code <= 97) {
			newStyle.fg = ansiBrightColorToColor(code - 90);
		} else if (code >= 100 && code <= 107) {
			newStyle.bg = ansiBrightColorToColor(code - 100);
		}
	}

	return newStyle;
}

/**
 * Convert ANSI color code (0-7) to Color
 */
function ansiColorToColor(code: number): Color {
	const colors: Color[] = [
		"black",
		"red",
		"green",
		"yellow",
		"blue",
		"magenta",
		"cyan",
		"white",
	];
	return colors[code] ?? "reset";
}

/**
 * Convert ANSI bright color code (0-7) to Color
 */
function ansiBrightColorToColor(code: number): Color {
	const colors: Color[] = [
		"gray",
		"light_red",
		"light_green",
		"light_yellow",
		"light_blue",
		"light_magenta",
		"light_cyan",
		"white",
	];
	return colors[code] ?? "reset";
}

/**
 * Convert a rendered line to a HistoryLine
 */
export function lineToHistoryLine(line: string): HistoryLine {
	return {
		spans: parseAnsiLine(line),
	};
}

/**
 * Convert multiple lines to HistoryLine array
 */
export function linesToHistory(lines: string[]): HistoryLine[] {
	return lines.map(lineToHistoryLine);
}

/**
 * Convert a Component to a RenderNode
 *
 * Since our components are line-based, we convert them to a Column
 * of styled text lines.
 */
export function componentToRenderNode(
	component: Component,
	width: number,
): RenderNode {
	const lines = component.render(width);
	return linesToRenderNode(lines);
}

/**
 * Convert rendered lines to a RenderNode
 */
export function linesToRenderNode(lines: string[]): RenderNode {
	if (lines.length === 0) {
		return { type: "empty" };
	}

	if (lines.length === 1) {
		return {
			type: "styled_text",
			spans: parseAnsiLine(lines[0]),
		};
	}

	// Multiple lines become a column
	return {
		type: "column",
		children: lines.map((line) => ({
			type: "styled_text" as const,
			spans: parseAnsiLine(line),
		})),
		gap: 0,
	};
}

/**
 * Create a text node
 */
export function text(content: string, style?: TextStyle): RenderNode {
	return {
		type: "text",
		content,
		style,
	};
}

/**
 * Create a styled text node with ANSI parsing
 */
export function styledText(content: string): RenderNode {
	return {
		type: "styled_text",
		spans: parseAnsiLine(content),
	};
}

/**
 * Create a column layout
 */
export function column(children: RenderNode[], gap = 0): RenderNode {
	return {
		type: "column",
		children,
		gap,
	};
}

/**
 * Create a row layout
 */
export function row(children: RenderNode[], gap = 0): RenderNode {
	return {
		type: "row",
		children,
		gap,
	};
}

/**
 * Create a box with border
 */
export function box(
	child: RenderNode | undefined,
	options: {
		border?: "none" | "single" | "double" | "rounded" | "heavy";
		title?: string;
		padding?: { top?: number; right?: number; bottom?: number; left?: number };
	} = {},
): RenderNode {
	return {
		type: "box",
		child,
		border: options.border ?? "none",
		title: options.title,
		padding: options.padding,
	};
}

/**
 * Create a scrollable container
 */
export function scroll(
	child: RenderNode,
	offset: number,
	contentHeight: number,
	showScrollbar = true,
): RenderNode {
	return {
		type: "scroll",
		child,
		offset,
		content_height: contentHeight,
		show_scrollbar: showScrollbar,
	};
}

/**
 * Create an input field
 */
export function input(
	value: string,
	cursor: number,
	options: { placeholder?: string; focused?: boolean } = {},
): RenderNode {
	return {
		type: "input",
		value,
		cursor,
		placeholder: options.placeholder,
		focused: options.focused,
	};
}

/**
 * Create a multi-line editor
 */
export function editor(
	lines: string[],
	cursor: [number, number],
	options: { focused?: boolean; scrollOffset?: number } = {},
): RenderNode {
	return {
		type: "editor",
		lines,
		cursor,
		focused: options.focused,
		scroll_offset: options.scrollOffset,
	};
}

/**
 * Create a spacer
 */
export function spacer(size?: number): RenderNode {
	return {
		type: "spacer",
		size,
	};
}

/**
 * Create an empty node
 */
export function empty(): RenderNode {
	return { type: "empty" };
}
