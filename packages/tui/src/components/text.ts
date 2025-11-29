import chalk from "chalk";
import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private text = "",
		private paddingX = 1,
		private paddingY = 1,
		private customBgRgb?: { r: number; g: number; b: number },
	) {}

	setText(text: string): void {
		this.text = text;
		// Invalidate cache
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	setCustomBgRgb(customBgRgb?: { r: number; g: number; b: number }): void {
		this.customBgRgb = customBgRgb;
		// Invalidate cache
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

		// Calculate available width for content
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces
		const normalizedText = this.text.replace(/\t/g, "   ");
		const lines: string[] = [];
		const textLines = normalizedText.split("\n");

		for (const line of textLines) {
			const visibleLineLength = visibleWidth(line);
			if (visibleLineLength <= contentWidth) {
				lines.push(line);
				continue;
			}

			const indentMatch = line.match(/^\s+/);
			const originalIndent = indentMatch?.[0] ?? "";
			let indent = originalIndent;
			const indentWidth = visibleWidth(indent);
			const maxIndentWidth = Math.max(0, contentWidth - 1);
			if (indentWidth > maxIndentWidth) {
				indent = indent.slice(0, maxIndentWidth);
			}
			const content =
				originalIndent.length > 0 ? line.slice(originalIndent.length) : line;
			const tokens = splitLineIntoTokens(content);
			let currentLine = "";
			let needsIndent = indent.length > 0;
			let lineHasContent = false;

			const startNewLine = (): void => {
				currentLine = "";
				needsIndent = indent.length > 0;
				lineHasContent = false;
			};

			const applyIndentIfNeeded = (): void => {
				if (needsIndent) {
					currentLine = indent;
					needsIndent = false;
				}
			};

			const flushCurrentLine = (): void => {
				if (currentLine.length > 0 && lineHasContent) {
					lines.push(currentLine);
				}
				startNewLine();
			};

			startNewLine();

			for (const token of tokens) {
				let remaining = token;
				while (remaining.length > 0) {
					applyIndentIfNeeded();
					const currentVisible = visibleWidth(currentLine);
					const availableWidth = contentWidth - currentVisible;
					if (availableWidth <= 0) {
						flushCurrentLine();
						continue;
					}

					const [chunk, rest] = sliceTokenToWidth(remaining, availableWidth);
					if (chunk.length === 0) {
						flushCurrentLine();
						remaining = rest;
						continue;
					}

					currentLine += chunk;
					if (chunk.trim().length > 0) {
						lineHasContent = true;
					}
					remaining = rest;
					if (remaining.length > 0) {
						flushCurrentLine();
					}
				}
			}

			if (currentLine.length > 0 && lineHasContent) {
				lines.push(currentLine);
			} else if (tokens.length === 0 && indent.length > 0) {
				lines.push(indent);
			}
		}

		// Add padding to each line
		const leftPad = " ".repeat(this.paddingX);
		const paddedLines: string[] = [];

		for (const line of lines) {
			const visibleLength = visibleWidth(line);
			const rightPadLength = Math.max(0, width - this.paddingX - visibleLength);
			const rightPad = " ".repeat(rightPadLength);
			let paddedLine = leftPad + line + rightPad;

			if (this.customBgRgb) {
				paddedLine = chalk.bgRgb(
					this.customBgRgb.r,
					this.customBgRgb.g,
					this.customBgRgb.b,
				)(paddedLine);
			}
			paddedLines.push(paddedLine);
		}

		// Add top and bottom padding
		const emptyLine = " ".repeat(width);
		const createPaddingLine = () => {
			let line = emptyLine;
			if (this.customBgRgb) {
				line = chalk.bgRgb(
					this.customBgRgb.r,
					this.customBgRgb.g,
					this.customBgRgb.b,
				)(line);
			}
			return line;
		};

		const topPadding = Array(this.paddingY).fill(null).map(createPaddingLine);
		const bottomPadding = Array(this.paddingY)
			.fill(null)
			.map(createPaddingLine);

		const result = [...topPadding, ...paddedLines, ...bottomPadding];

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}
}

function splitLineIntoTokens(line: string): string[] {
	const tokens = line.match(/(\s+|\S+)/g);
	return tokens ?? [];
}

function sliceTokenToWidth(input: string, maxWidth: number): [string, string] {
	if (input.length === 0) {
		return ["", ""];
	}
	let chunk = "";
	let consumed = 0;
	for (const char of input) {
		if (visibleWidth(chunk + char) > maxWidth) {
			break;
		}
		chunk += char;
		consumed += char.length;
		if (visibleWidth(chunk) === maxWidth) {
			break;
		}
	}
	if (chunk.length === 0) {
		const [firstChar = ""] = Array.from(input);
		chunk = firstChar;
		consumed = firstChar.length;
	}
	const remainder = input.slice(consumed);
	return [chunk, remainder];
}
