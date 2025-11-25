/**
 * Minimal TUI implementation with differential rendering
 */
import type { Terminal } from "./terminal.js";
import { visibleWidth } from "./utils.js";

const ANSI_ESCAPE_RESET = "\x1b[0m";
const ANSI_ESCAPE_PATTERN = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[ -\\/]*[@-~]`,
	"y",
);

function wrapLineToWidth(line: string, width: number): string[] {
	if (!line || width <= 0) return [""];
	if (visibleWidth(line) <= width) return [line];

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

		if (currentLength + charWidth > width) {
			// Close current line before adding more characters
			if (activeAnsiCodes.length > 0) {
				wrapped.push(`${currentLine}${ANSI_ESCAPE_RESET}`);
				currentLine = activeAnsiCodes.join("");
			} else {
				wrapped.push(currentLine);
				currentLine = "";
			}
			currentLength = 0;
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

function wrapLinesToWidth(lines: string[], width: number): string[] {
	const wrapped: string[] = [];
	for (const line of lines) {
		wrapped.push(...wrapLineToWidth(line ?? "", width));
	}
	return wrapped;
}

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;
}

export { visibleWidth };

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	private previousLines: string[] = [];
	private previousWidth = 0;
	private focusedComponent: Component | null = null;
	private renderRequested = false;
	private cursorRow = 0; // Track where cursor is (0-indexed, relative to our first line)

	constructor(private terminal: Terminal) {
		super();
	}

	setFocus(component: Component | null): void {
		this.focusedComponent = component;
	}

	start(): void {
		this.terminal.start(
			(data: string) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.hideCursor();
		this.requestRender();
	}

	stop(): void {
		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => {
			this.renderRequested = false;
			this.doRender();
		});
	}

	private handleInput(data: string): void {
		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private doRender(): void {
		const width = Math.max(1, this.terminal.columns);
		const height = this.terminal.rows;

		// Render all components to get new lines
		const newLines = wrapLinesToWidth(this.render(width), width);

		// Width changed - need full re-render
		const widthChanged =
			this.previousWidth !== 0 && this.previousWidth !== width;

		// First render - just output everything without clearing
		if (this.previousLines.length === 0) {
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);

			// After rendering N lines, cursor is at end of last line (line N-1)
			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Width changed - full re-render
		if (widthChanged) {
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);

			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);

		for (let i = 0; i < maxLines; i++) {
			const oldLine =
				i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";
			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}

		// No changes
		if (firstChanged === -1) {
			return;
		}

		// Check if firstChanged is outside the viewport
		const viewportTop = this.cursorRow - height + 1;
		if (firstChanged < viewportTop) {
			// First change is above viewport - need full re-render
			let buffer = "\x1b[?2026h"; // Begin synchronized output
			buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);

			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Render from first changed line to end
		let buffer = "\x1b[?2026h"; // Begin synchronized output

		// Move cursor to first changed line
		const lineDiff = firstChanged - this.cursorRow;
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // Move down
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // Move up
		}
		buffer += "\r"; // Move to column 0
		buffer += "\x1b[J"; // Clear from cursor to end of screen

		// Render from first changed line to end
		for (let i = firstChanged; i < newLines.length; i++) {
			if (i > firstChanged) buffer += "\r\n";
			if (visibleWidth(newLines[i]) > width) {
				throw new Error(
					`Rendered line ${i} exceeds terminal width\n\n${newLines[i]}`,
				);
			}
			buffer += newLines[i];
		}

		buffer += "\x1b[?2026l"; // End synchronized output

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Cursor is now at end of last line
		this.cursorRow = newLines.length - 1;
		this.previousLines = newLines;
		this.previousWidth = width;
	}
}
