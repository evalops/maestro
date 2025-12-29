import { Text, visibleWidth } from "@evalops/tui";

const ANSI_STRING_TERMINATORS = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_OSC_SEQUENCE = `(?:\\u001B\\][\\s\\S]*?${ANSI_STRING_TERMINATORS})`;
const ANSI_CSI_SEQUENCE =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_ESCAPE_SEQUENCE = new RegExp(
	`${ANSI_OSC_SEQUENCE}|${ANSI_CSI_SEQUENCE}`,
	"g",
);

export function stripAnsiSequences(text: string): string {
	return text.replace(ANSI_ESCAPE_SEQUENCE, "");
}

function consumeAnsiSequence(text: string, index: number): number {
	if (text[index] !== "\x1B") {
		return index + 1;
	}
	const next = text[index + 1];
	if (next === "[") {
		let cursor = index + 2;
		while (cursor < text.length) {
			const code = text.charCodeAt(cursor);
			if (code >= 0x40 && code <= 0x7e) {
				return cursor + 1;
			}
			cursor++;
		}
		return text.length;
	}
	if (next === "]") {
		let cursor = index + 2;
		while (cursor < text.length) {
			const char = text[cursor];
			if (char === "\x07") {
				return cursor + 1;
			}
			if (char === "\x1B" && text[cursor + 1] === "\\") {
				return cursor + 2;
			}
			cursor++;
		}
		return text.length;
	}
	if (next === "P" || next === "X" || next === "^" || next === "_") {
		const terminator = text.indexOf("\x1B\\", index + 2);
		return terminator === -1 ? text.length : terminator + 2;
	}
	return Math.min(text.length, index + 2);
}

export function padLine(text: string, targetWidth: number): string {
	const padding = Math.max(
		0,
		targetWidth - visibleWidth(stripAnsiSequences(text)),
	);
	return padding === 0 ? text : `${text}${" ".repeat(padding)}`;
}

export function centerText(text: string, targetWidth: number): string {
	const currentWidth = visibleWidth(stripAnsiSequences(text));
	if (currentWidth >= targetWidth) {
		return text;
	}
	const totalPadding = targetWidth - currentWidth;
	const left = Math.floor(totalPadding / 2);
	const right = totalPadding - left;
	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

export function truncateText(text: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	if (visibleWidth(stripAnsiSequences(text)) <= maxWidth) {
		return text;
	}
	let result = "";
	let width = 0;
	for (let i = 0; i < text.length; ) {
		const char = text[i];
		if (char === "\x1B") {
			const nextIndex = consumeAnsiSequence(text, i);
			result += text.slice(i, nextIndex);
			i = nextIndex;
			continue;
		}
		const codePoint = text.codePointAt(i) ?? 0;
		const symbol = String.fromCodePoint(codePoint);
		const symbolWidth = visibleWidth(symbol);
		if (width + symbolWidth > maxWidth - 1) {
			break;
		}
		result += symbol;
		width += symbolWidth;
		i += symbol.length;
	}
	return `${result}…`;
}

export function sanitizeAnsi(text: string): string {
	return stripAnsiSequences(text);
}

/**
 * Helper that wraps arbitrary text to the provided width using the shared Text
 * component. Centralizing this logic keeps modal renderers consistent while
 * documenting the dependency on Text's indentation-aware wrapping.
 */
export function wrapTextBlock(text: string, width: number): string[] {
	const normalizedWidth = Math.max(1, width);
	if (text.length === 0) {
		return [""];
	}
	const renderer = new Text(text, 0, 0);
	return renderer.render(normalizedWidth);
}
