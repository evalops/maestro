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
			} else {
				// Word wrap
				const words = line.split(" ");
				let currentLine = "";

				for (const word of words) {
					const currentVisible = visibleWidth(currentLine);
					const wordVisible = visibleWidth(word);

					// If word is too long, truncate it
					let finalWord = word;
					if (wordVisible > contentWidth) {
						let truncated = "";
						for (const char of word) {
							if (visibleWidth(truncated + char) > contentWidth) {
								break;
							}
							truncated += char;
						}
						finalWord = truncated;
					}

					if (currentVisible === 0) {
						currentLine = finalWord;
					} else if (
						currentVisible + 1 + visibleWidth(finalWord) <=
						contentWidth
					) {
						currentLine += ` ${finalWord}`;
					} else {
						lines.push(currentLine);
						currentLine = finalWord;
					}
				}
				if (currentLine.length > 0) {
					lines.push(currentLine);
				}
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
