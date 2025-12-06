import stringWidth from "string-width";

const ANSI_ESCAPE_RESET = "\x1b[0m";
const ANSI_ESCAPE_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[ -\\/]*[@-~]`,
	"y",
);

// Grapheme segmenter for proper Unicode iteration (handles emojis, ZWJ sequences, etc.)
const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 * This allows surgical resets (e.g., only underline) instead of full resets.
 */
class AnsiCodeTracker {
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"

	process(ansiCode: string): void {
		if (!ansiCode.endsWith("m")) {
			return;
		}

		// Extract the parameters between ESC[ and m
		// Using String.fromCharCode to avoid biome control character warning
		const match = ansiCode.match(
			new RegExp(`${String.fromCharCode(27)}\\[([\\d;]*)m`),
		);
		if (!match) return;

		const params = match[1];
		if (params === "" || params === "0") {
			this.reset();
			return;
		}

		// Parse parameters (can be semicolon-separated)
		const parts = params.split(";");
		let i = 0;
		while (i < parts.length) {
			const code = Number.parseInt(parts[i], 10);

			// Handle 256-color and RGB codes which consume multiple parameters
			if (code === 38 || code === 48) {
				if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
					// 256 color: 38;5;N or 48;5;N
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 3;
					continue;
				}
				if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
					// RGB color: 38;2;R;G;B or 48;2;R;G;B
					const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
					if (code === 38) {
						this.fgColor = colorCode;
					} else {
						this.bgColor = colorCode;
					}
					i += 5;
					continue;
				}
			}

			// Standard SGR codes
			switch (code) {
				case 0:
					this.reset();
					break;
				case 1:
					this.bold = true;
					break;
				case 2:
					this.dim = true;
					break;
				case 3:
					this.italic = true;
					break;
				case 4:
					this.underline = true;
					break;
				case 5:
					this.blink = true;
					break;
				case 7:
					this.inverse = true;
					break;
				case 8:
					this.hidden = true;
					break;
				case 9:
					this.strikethrough = true;
					break;
				case 21:
					this.bold = false;
					break;
				case 22:
					this.bold = false;
					this.dim = false;
					break;
				case 23:
					this.italic = false;
					break;
				case 24:
					this.underline = false;
					break;
				case 25:
					this.blink = false;
					break;
				case 27:
					this.inverse = false;
					break;
				case 28:
					this.hidden = false;
					break;
				case 29:
					this.strikethrough = false;
					break;
				case 39:
					this.fgColor = null;
					break;
				case 49:
					this.bgColor = null;
					break;
				default:
					// Standard foreground colors 30-37, 90-97
					if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
						this.fgColor = String(code);
					}
					// Standard background colors 40-47, 100-107
					else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
						this.bgColor = String(code);
					}
					break;
			}
			i++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		if (codes.length === 0) return "";
		return `\x1b[${codes.join(";")}m`;
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null
		);
	}

	/**
	 * Get reset codes for attributes that need to be turned off at line end.
	 * Specifically targets underline which visually bleeds into padding.
	 * Returns empty string if no problematic attributes are active.
	 *
	 * This is a surgical reset - it only resets underline (which causes visible
	 * artifacts in padding areas) while preserving colors and other styles.
	 */
	getLineEndReset(): string {
		if (this.underline) {
			return "\x1b[24m"; // Underline off only
		}
		return "";
	}
}

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
 * Extract ANSI escape sequences from a string at the given position.
 */
function extractAnsiCode(
	str: string,
	pos: number,
): { code: string; length: number } | null {
	ANSI_ESCAPE_PATTERN.lastIndex = pos;
	const match = ANSI_ESCAPE_PATTERN.exec(str);
	if (match && match.index === pos) {
		return { code: match[0], length: match[0].length };
	}
	return null;
}

/**
 * Parse a line into segments of ANSI codes and graphemes.
 * Uses Intl.Segmenter for proper Unicode grapheme cluster handling
 * (emoji ZWJ sequences like 👨‍👩‍👧‍👦, skin tone modifiers, etc.)
 */
function parseLineSegments(
	line: string,
): Array<{ type: "ansi" | "grapheme"; value: string }> {
	const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];
	let i = 0;

	while (i < line.length) {
		const ansiResult = extractAnsiCode(line, i);
		if (ansiResult) {
			segments.push({ type: "ansi", value: ansiResult.code });
			i += ansiResult.length;
		} else {
			// Find the next ANSI code or end of string
			let end = i;
			while (end < line.length) {
				const nextAnsi = extractAnsiCode(line, end);
				if (nextAnsi) break;
				end++;
			}
			// Segment this non-ANSI portion into graphemes using Intl.Segmenter
			const textPortion = line.slice(i, end);
			for (const seg of graphemeSegmenter.segment(textPortion)) {
				segments.push({ type: "grapheme", value: seg.segment });
			}
			i = end;
		}
	}

	return segments;
}

/**
 * Wrap a single line to the given width while preserving ANSI styling.
 * Uses Intl.Segmenter for proper grapheme handling and AnsiCodeTracker
 * for surgical resets (only resets underline at line breaks, preserving colors).
 */
export function wrapAnsiLine(line: string, width: number): string[] {
	if (!line || width <= 0) return [""];

	const MAX_VISIBLE_WIDTH = 8192;
	const targetWidth = Math.min(width, MAX_VISIBLE_WIDTH);

	if (visibleWidth(line) <= targetWidth) return [line];

	const wrapped: string[] = [];
	const tracker = new AnsiCodeTracker();
	const segments = parseLineSegments(line);

	let currentLine = "";
	let currentLength = 0;

	for (const seg of segments) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		const graphemeWidth = visibleWidth(grapheme);

		// If a single grapheme is too wide for even an empty line, skip it
		if (graphemeWidth > targetWidth) {
			if (currentLength > 0) {
				// Use surgical reset for underline only (prevents bleeding into padding)
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) {
					currentLine += lineEndReset;
				}
				wrapped.push(
					tracker.hasActiveCodes()
						? `${currentLine}${ANSI_ESCAPE_RESET}`
						: currentLine,
				);
				currentLine = tracker.getActiveCodes();
				currentLength = 0;
			}
			continue;
		}

		if (currentLength + graphemeWidth > targetWidth) {
			if (currentLength > 0) {
				// Use surgical reset for underline only
				const lineEndReset = tracker.getLineEndReset();
				if (lineEndReset) {
					currentLine += lineEndReset;
				}
				if (tracker.hasActiveCodes()) {
					wrapped.push(`${currentLine}${ANSI_ESCAPE_RESET}`);
					currentLine = tracker.getActiveCodes();
				} else {
					wrapped.push(currentLine);
					currentLine = "";
				}
				currentLength = 0;
			}
		}

		currentLine += grapheme;
		currentLength += graphemeWidth;
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
