import stringWidth from "string-width";

const ANSI_ESCAPE_RESET = "\x1b[0m";
const ANSI_ESCAPE_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[ -\\/]*[@-~]`,
	"y",
);

/**
 * Calculate the visible width of a string in terminal columns.
 * This correctly handles:
 * - ANSI escape codes (ignored)
 * - Emojis and wide characters (counted as 2 columns)
 * - Combining characters (counted correctly)
 * - Tabs (replaced with 3 spaces for consistent width)
 */
export function visibleWidth(str: string): number {
	// Replace tabs with 3 spaces before measuring
	const normalized = str.replace(/\t/g, "   ");
	return stringWidth(normalized);
}

/**
 * Wrap a single line to the given width while preserving ANSI styling.
 */
export function wrapAnsiLine(line: string, width: number): string[] {
	if (!line || width <= 0) return [""];

	const MAX_VISIBLE_WIDTH = 8192;
	const targetWidth = Math.min(width, MAX_VISIBLE_WIDTH);

	if (visibleWidth(line) <= targetWidth) return [line];

	const wrapped: string[] = [];
	const activeAnsiCodes: string[] = [];
	let currentLine = "";
	let currentLength = 0;

	for (let i = 0; i < line.length; ) {
		ANSI_ESCAPE_PATTERN.lastIndex = i;
		const ansiMatch = ANSI_ESCAPE_PATTERN.exec(line);
		if (ansiMatch && ansiMatch.index === i) {
			const ansiCode = ansiMatch[0];
			currentLine += ansiCode;
			if (ansiCode.endsWith("m")) {
				if (ansiCode === "\x1b[0m" || ansiCode === "\x1b[m") {
					activeAnsiCodes.length = 0;
				} else {
					activeAnsiCodes.push(ansiCode);
				}
			}
			i = ANSI_ESCAPE_PATTERN.lastIndex;
			continue;
		}

		const codePoint = line.codePointAt(i);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		const charWidth = visibleWidth(char);

		if (currentLength + charWidth > targetWidth) {
			if (currentLength > 0) {
				if (activeAnsiCodes.length > 0) {
					wrapped.push(`${currentLine}${ANSI_ESCAPE_RESET}`);
					currentLine = activeAnsiCodes.join("");
				} else {
					wrapped.push(currentLine);
					currentLine = "";
				}
				currentLength = 0;
			}
			// Skip characters that individually exceed the target width
			if (charWidth > targetWidth) {
				i += char.length;
				continue;
			}
		}

		currentLine += char;
		currentLength += charWidth;
		i += char.length;
	}

	if (currentLine) {
		wrapped.push(currentLine);
	}

	return wrapped.length > 0 ? wrapped : [""];
}

/**
 * Wrap each line in an array to the given width using ANSI-aware logic.
 */
export function wrapAnsiLines(lines: string[], width: number): string[] {
	const wrapped: string[] = [];
	for (const line of lines) {
		wrapped.push(...wrapAnsiLine(line ?? "", width));
	}
	return wrapped;
}
