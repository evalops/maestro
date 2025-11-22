import chalk from "chalk";
import { type Token, type Tokens, marked } from "marked";
import { renderMermaidDiagram } from "../mermaid-renderer.js";
import {
	highlightCodeLines,
	highlightInlineCode,
} from "../style/code-highlighter.js";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
}

type Color =
	| "black"
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "cyan"
	| "white"
	| "gray"
	| "bgBlack"
	| "bgRed"
	| "bgGreen"
	| "bgYellow"
	| "bgBlue"
	| "bgMagenta"
	| "bgCyan"
	| "bgWhite"
	| "bgGray";

export class Markdown implements Component {
	private text: string;
	private bgColor?: Color;
	private fgColor?: Color;
	private customBgRgb?: { r: number; g: number; b: number };
	private paddingX: number;
	private paddingY: number;
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	private theme?: MarkdownTheme;
	private applyTheme<K extends keyof MarkdownTheme>(
		key: K,
		text: string,
		defaultStyle: (text: string) => string,
	): string {
		if (this.theme) {
			return this.theme[key](text);
		}
		return defaultStyle(text);
	}

	private preserveSyntaxColors(
		text: string,
		applyTheme?: (text: string) => string,
		fallback?: (text: string) => string,
	): string {
		if (ANSI_ESCAPE_REGEX.test(text)) {
			return text;
		}
		if (applyTheme) {
			return applyTheme(text);
		}
		if (fallback) {
			return fallback(text);
		}
		return text;
	}

	constructor(
		text = "",
		bgColor?: Color,
		fgColor?: Color,
		customBgRgb?: { r: number; g: number; b: number },
		paddingX = 1,
		paddingY = 1,
		theme?: MarkdownTheme,
	) {
		this.text = text;
		this.bgColor = bgColor;
		this.fgColor = fgColor;
		this.customBgRgb = customBgRgb;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
	}
	setText(text: string): void {
		this.text = text;
		// Invalidate cache when text changes
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
	setBgColor(bgColor?: Color): void {
		this.bgColor = bgColor;
		// Invalidate cache when color changes
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
	setFgColor(fgColor?: Color): void {
		this.fgColor = fgColor;
		// Invalidate cache when color changes
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
	setCustomBgRgb(customBgRgb?: { r: number; g: number; b: number }): void {
		this.customBgRgb = customBgRgb;
		// Invalidate cache when color changes
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
	render(width: number): string[] {
		// Check cache
		if (
			this.cachedLines &&
			this.cachedText === this.text &&
			this.cachedWidth === width
		) {
			return this.cachedLines;
		}
		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}
		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = this.text.replace(/\t/g, "   ");
		// Parse markdown to HTML-like tokens
		const tokens = marked.lexer(normalizedText);
		// Convert tokens to styled terminal output
		const renderedLines = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			renderedLines.push(...tokenLines);
		}
		// Wrap lines to fit content width
		const wrappedLines = [];
		for (const line of renderedLines) {
			wrappedLines.push(...this.wrapLine(line, contentWidth));
		}
		// Add padding and apply colors
		const leftPad = " ".repeat(this.paddingX);
		const paddedLines = [];
		for (const line of wrappedLines) {
			// Calculate visible length
			const visibleLength = visibleWidth(line);
			// Right padding to fill to width (accounting for left padding and content)
			const rightPadLength = Math.max(0, width - this.paddingX - visibleLength);
			const rightPad = " ".repeat(rightPadLength);
			// Add left padding, content, and right padding
			let paddedLine = leftPad + line + rightPad;
			// Apply foreground color if specified
			if (this.fgColor) {
				paddedLine = chalk[this.fgColor](paddedLine);
			}
			// Apply background color if specified
			if (this.customBgRgb) {
				paddedLine = chalk.bgRgb(
					this.customBgRgb.r,
					this.customBgRgb.g,
					this.customBgRgb.b,
				)(paddedLine);
			} else if (this.bgColor) {
				paddedLine = chalk[this.bgColor](paddedLine);
			}
			paddedLines.push(paddedLine);
		}
		// Add top padding (empty lines)
		const emptyLine = " ".repeat(width);
		const topPadding = [];
		for (let i = 0; i < this.paddingY; i++) {
			let emptyPaddedLine = emptyLine;
			if (this.customBgRgb) {
				emptyPaddedLine = chalk.bgRgb(
					this.customBgRgb.r,
					this.customBgRgb.g,
					this.customBgRgb.b,
				)(emptyPaddedLine);
			} else if (this.bgColor) {
				emptyPaddedLine = chalk[this.bgColor](emptyPaddedLine);
			}
			topPadding.push(emptyPaddedLine);
		}
		// Add bottom padding (empty lines)
		const bottomPadding = [];
		for (let i = 0; i < this.paddingY; i++) {
			let emptyPaddedLine = emptyLine;
			if (this.customBgRgb) {
				emptyPaddedLine = chalk.bgRgb(
					this.customBgRgb.r,
					this.customBgRgb.g,
					this.customBgRgb.b,
				)(emptyPaddedLine);
			} else if (this.bgColor) {
				emptyPaddedLine = chalk[this.bgColor](emptyPaddedLine);
			}
			bottomPadding.push(emptyPaddedLine);
		}
		// Combine top padding, content, and bottom padding
		const result = [...topPadding, ...paddedLines, ...bottomPadding];
		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;
		return result.length > 0 ? result : [""];
	}
	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
	): string[] {
		const lines = [];
		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;
				const headingText = this.renderInlineTokens(token.tokens || []);
				const headingContent =
					headingLevel <= 2 ? headingText : headingPrefix + headingText;
				const headingLine = this.applyTheme(
					"heading",
					headingContent,
					(text) => {
						if (headingLevel === 1) {
							return chalk.bold.underline.yellow(text);
						}
						if (headingLevel === 2) {
							return chalk.bold.yellow(text);
						}
						return chalk.bold(text);
					},
				);
				lines.push(headingLine);
				lines.push(""); // Add spacing after headings
				break;
			}
			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || []);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (
					nextTokenType &&
					nextTokenType !== "list" &&
					nextTokenType !== "space"
				) {
					lines.push("");
				}
				break;
			}
			case "code": {
				if (token.lang?.toLowerCase() === "mermaid") {
					const diagram = renderMermaidDiagram(token.text, width);
					if (diagram) {
						lines.push(...diagram);
						lines.push("");
						break;
					}
				}
				const highlighted = highlightCodeLines(token.text, token.lang);
				const theme = this.theme;
				const label = token.lang || "";
				lines.push(
					this.applyTheme("codeBlockBorder", `\`\`\`${label}`, (text) =>
						chalk.gray(text),
					),
				);
				for (const codeLine of highlighted) {
					const styledLine = this.preserveSyntaxColors(
						codeLine,
						theme ? (value) => theme.codeBlock(value) : undefined,
					);
					lines.push(chalk.dim("  ") + styledLine);
				}
				lines.push(
					this.applyTheme("codeBlockBorder", "```", (text) => chalk.gray(text)),
				);
				lines.push("");
				break;
			}
			case "list": {
				if ("items" in token && Array.isArray(token.items)) {
					const listLines = this.renderList(token as Tokens.List, 0);
					lines.push(...listLines);
				}
				break;
			}
			case "table": {
				if ("header" in token && "rows" in token) {
					const tableLines = this.renderTable(token as Tokens.Table);
					lines.push(...tableLines);
				}
				break;
			}
			case "blockquote": {
				const quoteText = this.renderInlineTokens(token.tokens || []);
				const quoteLines = quoteText.split("\n");
				for (const quoteLine of quoteLines) {
					const border = this.applyTheme("quoteBorder", "│ ", (text) =>
						chalk.gray(text),
					);
					const text = this.applyTheme("quote", quoteLine, (value) =>
						chalk.italic(value),
					);
					lines.push(border + text);
				}
				lines.push(""); // Add spacing after blockquotes
				break;
			}
			case "hr":
				lines.push(
					this.applyTheme("hr", "─".repeat(Math.min(width, 80)), (text) =>
						chalk.gray(text),
					),
				);
				lines.push(""); // Add spacing after horizontal rules
				break;
			case "html":
				// Skip HTML for terminal output
				break;
			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;
			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}
		return lines;
	}
	private renderInlineTokens(tokens: Token[]): string {
		let result = "";
		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens);
					} else {
						result += token.text;
					}
					break;
				case "strong":
					result += this.applyTheme(
						"bold",
						this.renderInlineTokens(token.tokens || []),
						(text) => chalk.bold(text),
					);
					break;
				case "em": {
					const text = this.renderInlineTokens(token.tokens || []);
					result += this.applyTheme("italic", text, (value) =>
						chalk.italic(value),
					);
					break;
				}
				case "codespan": {
					const highlighted = highlightInlineCode(token.text);
					const theme = this.theme;
					const styledInline = this.preserveSyntaxColors(
						highlighted,
						theme ? (value) => theme.code(value) : undefined,
					);
					result += styledInline;
					break;
				}
				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || []);
					// If link text matches href, only show the link once
					if (linkText === token.href) {
						result += this.applyTheme("link", linkText, (text) =>
							chalk.underline.blue(text),
						);
					} else {
						const renderedLink = this.applyTheme("link", linkText, (text) =>
							chalk.underline.blue(text),
						);
						const renderedUrl = this.applyTheme(
							"linkUrl",
							` (${token.href})`,
							(text) => chalk.gray(text),
						);
						result += renderedLink + renderedUrl;
					}
					break;
				}
				case "br":
					result += "\n";
					break;
				case "del":
					result += this.applyTheme(
						"strikethrough",
						this.renderInlineTokens(token.tokens || []),
						(text) => chalk.strikethrough(text),
					);
					break;
				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += token.text;
					}
			}
		}
		return result;
	}
	private wrapLine(line: string, width: number): string[] {
		// Handle ANSI escape codes properly when wrapping
		const wrapped = [];
		// Handle undefined or null lines
		if (!line) {
			return [""];
		}
		// Split by newlines first - wrap each line individually
		const splitLines = line.split("\n");
		for (const splitLine of splitLines) {
			const visibleLength = visibleWidth(splitLine);
			if (visibleLength <= width) {
				wrapped.push(splitLine);
				continue;
			}
			// This line needs wrapping
			wrapped.push(...this.wrapSingleLine(splitLine, width));
		}
		return wrapped.length > 0 ? wrapped : [""];
	}
	private wrapSingleLine(line: string, width: number): string[] {
		const wrapped = [];
		// Track active ANSI codes to preserve them across wrapped lines
		const activeAnsiCodes = [];
		let currentLine = "";
		let currentLength = 0;
		let i = 0;
		while (i < line.length) {
			if (line[i] === "\x1b" && line[i + 1] === "[") {
				// ANSI escape sequence - parse and track it
				let j = i + 2;
				while (j < line.length && line[j] && !/[mGKHJ]/.test(line[j])) {
					j++;
				}
				if (j < line.length) {
					const ansiCode = line.substring(i, j + 1);
					currentLine += ansiCode;
					// Track styling codes (ending with 'm')
					if (line[j] === "m") {
						// Reset code
						if (ansiCode === "\x1b[0m" || ansiCode === "\x1b[m") {
							activeAnsiCodes.length = 0;
						} else {
							// Add to active codes (replacing similar ones)
							activeAnsiCodes.push(ansiCode);
						}
					}
					i = j + 1;
				} else {
					// Incomplete ANSI sequence at end - don't include it
					break;
				}
			} else {
				// Regular character - extract full grapheme cluster
				// Handle multi-byte characters (emoji, surrogate pairs, etc.)
				let char = "";
				let charByteLength = 0;
				// Check for surrogate pair (emoji and other multi-byte chars)
				const codePoint = line.charCodeAt(i);
				if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < line.length) {
					// High surrogate - get the pair
					char = line.substring(i, i + 2);
					charByteLength = 2;
				} else {
					// Regular character
					char = line[i];
					charByteLength = 1;
				}
				const charWidth = visibleWidth(char);
				// Check if adding this character would exceed width
				if (currentLength + charWidth > width) {
					// Need to wrap - close current line with reset if needed
					if (activeAnsiCodes.length > 0) {
						wrapped.push(`${currentLine}\x1b[0m`);
						// Start new line with active codes
						currentLine = activeAnsiCodes.join("");
					} else {
						wrapped.push(currentLine);
						currentLine = "";
					}
					currentLength = 0;
				}
				currentLine += char;
				currentLength += charWidth;
				i += charByteLength;
			}
		}
		if (currentLine) {
			wrapped.push(currentLine);
		}
		return wrapped.length > 0 ? wrapped : [""];
	}
	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		const startIndex = (() => {
			if (typeof token.start === "number" && Number.isFinite(token.start)) {
				return token.start;
			}
			if (typeof token.start === "string") {
				const parsed = Number.parseInt(token.start, 10);
				if (!Number.isNaN(parsed)) {
					return parsed;
				}
			}
			return 1;
		})();
		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const checkbox = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
			const marker = token.ordered ? `${startIndex + i}. ` : "- ";
			const bullet = this.applyTheme("listBullet", marker + checkbox, (text) =>
				chalk.cyan(text),
			);
			const itemLines = this.renderListItem(item.tokens || [], depth + 1);
			let renderedFirstLine = false;
			for (const line of itemLines) {
				if (!renderedFirstLine && !line.nested) {
					lines.push(indent + bullet + line.content);
					renderedFirstLine = true;
					continue;
				}
				if (!renderedFirstLine && line.nested) {
					lines.push(indent + bullet);
					renderedFirstLine = true;
				}
				if (line.nested) {
					lines.push(line.content);
				} else {
					lines.push(`${indent}  ${line.content}`);
				}
			}
			if (!renderedFirstLine) {
				lines.push(indent + bullet);
			}
		}
		return lines;
	}

	private renderListItem(
		tokens: Token[],
		depth: number,
	): { content: string; nested: boolean }[] {
		const lines: { content: string; nested: boolean }[] = [];
		for (const token of tokens) {
			if (
				token.type === "list" &&
				"items" in token &&
				Array.isArray(token.items)
			) {
				const nestedLines = this.renderList(token as Tokens.List, depth);
				for (const line of nestedLines) {
					lines.push({ content: line, nested: true });
				}
			} else if (token.type === "text") {
				const text =
					token.tokens && token.tokens.length > 0
						? this.renderInlineTokens(token.tokens)
						: token.text || "";
				lines.push({ content: text, nested: false });
			} else if (token.type === "paragraph") {
				const text = this.renderInlineTokens(token.tokens || []);
				lines.push({ content: text, nested: false });
			} else if (token.type === "code") {
				lines.push({
					content: this.applyTheme(
						"codeBlockBorder",
						`\`\`\`${token.lang || ""}`,
						(text) => chalk.gray(text),
					),
					nested: false,
				});
				const codeLines = token.text.split("\n");
				const theme = this.theme;
				for (const codeLine of codeLines) {
					const styledLine = this.preserveSyntaxColors(
						codeLine,
						theme ? (value) => theme.codeBlock(value) : undefined,
						(value) => chalk.green(value),
					);
					lines.push({ content: chalk.dim("  ") + styledLine, nested: false });
				}
				lines.push({
					content: this.applyTheme("codeBlockBorder", "```", (text) =>
						chalk.gray(text),
					),
					nested: false,
				});
			} else {
				const text = this.renderInlineTokens([token]);
				if (text) {
					lines.push({ content: text, nested: false });
				}
			}
		}
		return lines;
	}
	/**
	 * Render a table
	 */
	private renderTable(token: Tokens.Table): string[] {
		const lines: string[] = [];
		// Calculate column widths
		const columnWidths: number[] = [];
		// Check header
		for (let i = 0; i < token.header.length; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || []);
			const width = visibleWidth(headerText);
			columnWidths[i] = Math.max(columnWidths[i] || 0, width);
		}
		// Check rows
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || []);
				const width = visibleWidth(cellText);
				columnWidths[i] = Math.max(columnWidths[i] || 0, width);
			}
		}
		// Limit column widths to reasonable max
		const maxColWidth = 40;
		for (let i = 0; i < columnWidths.length; i++) {
			columnWidths[i] = Math.min(columnWidths[i], maxColWidth);
		}
		// Render header
		const headerCells = token.header.map(
			(cell: Tokens.TableCell, i: number) => {
				const text = this.renderInlineTokens(cell.tokens || []);
				return chalk.bold(text.padEnd(columnWidths[i]));
			},
		);
		lines.push(`│ ${headerCells.join(" │ ")} │`);
		// Render separator
		const separatorCells = columnWidths.map((width) => "─".repeat(width));
		lines.push(`├─${separatorCells.join("─┼─")}─┤`);
		// Render rows
		for (const row of token.rows) {
			const rowCells = row.map((cell: Tokens.TableCell, i: number) => {
				const text = this.renderInlineTokens(cell.tokens || []);
				const visWidth = visibleWidth(text);
				const padding = " ".repeat(Math.max(0, columnWidths[i] - visWidth));
				return text + padding;
			});
			lines.push(`│ ${rowCells.join(" │ ")} │`);
		}
		lines.push(""); // Add spacing after table
		return lines;
	}
}
