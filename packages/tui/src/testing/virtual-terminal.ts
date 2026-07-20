/**
 * @fileoverview Virtual Terminal for TUI Testing
 *
 * Provides an xterm.js-based terminal emulator for accurate TUI testing.
 * Unlike simple string-based mocks, this actually processes ANSI escape
 * sequences and maintains proper terminal state.
 *
 * ## Why xterm.js?
 *
 * Simple "record the writes" mocks miss rendering bugs because they don't
 * emulate how terminals actually process escape sequences. xterm.js:
 * - Correctly interprets CSI sequences (cursor movement, clear, colors)
 * - Maintains a real character grid with proper cursor tracking
 * - Handles line wrapping the same way real terminals do
 * - Supports scrollback buffer inspection
 *
 * ## Usage
 *
 * ```typescript
 * import { VirtualTerminal } from "@evalops/tui/testing";
 *
 * const term = new VirtualTerminal(80, 24);
 * const tui = new TUI(term);
 * tui.addChild(new Text("Hello"));
 * tui.start();
 *
 * await term.flush();
 * const viewport = term.getViewport();
 * expect(viewport[0]).toContain("Hello");
 * ```
 */

import type { Terminal as XtermTerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import type { Terminal } from "../terminal.js";

// Extract Terminal class from the module (handles ESM/CJS interop)
const XtermTerminal = xterm.Terminal;

/**
 * Virtual terminal implementation using xterm.js for accurate terminal emulation.
 *
 * This provides a real terminal emulator that processes ANSI sequences correctly,
 * enabling tests to verify actual rendered output rather than raw escape codes.
 */
export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;
	private bracketedPasteEnabled = false;
	private altScreenActive = false;

	/**
	 * Creates a new virtual terminal with the specified dimensions.
	 *
	 * @param columns - Terminal width in characters (default: 80)
	 * @param rows - Terminal height in lines (default: 24)
	 */
	constructor(columns = 80, rows = 24) {
		this._columns = columns;
		this._rows = rows;

		this.xterm = new XtermTerminal({
			cols: columns,
			rows: rows,
			// Disable interactive features for testing
			disableStdin: true,
			allowProposedApi: true,
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Terminal Interface Implementation
	// ─────────────────────────────────────────────────────────────────────────

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal
		this.xterm.write("\x1b[?2004h");
		this.bracketedPasteEnabled = true;
	}

	stop(): void {
		if (this.bracketedPasteEnabled) {
			this.xterm.write("\x1b[?2004l");
			this.bracketedPasteEnabled = false;
		}
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			this.xterm.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			this.xterm.write(`\x1b[${-lines}A`);
		}
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[2J\x1b[H");
	}

	enterAltScreen(): void {
		if (this.altScreenActive) return;
		this.xterm.write("\x1b[?1049h\x1b[?1007h");
		this.altScreenActive = true;
	}

	leaveAltScreen(): void {
		if (!this.altScreenActive) return;
		this.xterm.write("\x1b[?1007l\x1b[?1049l");
		this.altScreenActive = false;
	}

	enableBracketedPaste(): void {
		if (this.bracketedPasteEnabled) return;
		this.xterm.write("\x1b[?2004h");
		this.bracketedPasteEnabled = true;
	}

	disableBracketedPaste(): void {
		if (!this.bracketedPasteEnabled) return;
		this.xterm.write("\x1b[?2004l");
		this.bracketedPasteEnabled = false;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Test-Specific Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Simulates keyboard input being sent to the terminal.
	 *
	 * @param data - The input string (can include escape sequences for special keys)
	 *
	 * @example
	 * ```typescript
	 * term.sendInput("hello");           // Type "hello"
	 * term.sendInput("\x1b[A");          // Arrow up
	 * term.sendInput("\x03");            // Ctrl+C
	 * term.sendInput("\x1b[200~paste\x1b[201~"); // Bracketed paste
	 * ```
	 */
	sendInput(data: string): void {
		if (this.inputHandler) {
			this.inputHandler(data);
		}
	}

	/**
	 * Resizes the terminal and triggers the resize handler.
	 *
	 * @param columns - New terminal width
	 * @param rows - New terminal height
	 */
	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		if (this.resizeHandler) {
			this.resizeHandler();
		}
	}

	/**
	 * Waits for all pending writes to be processed by xterm.js.
	 *
	 * xterm.js processes writes asynchronously, so this must be called
	 * before inspecting the viewport or buffer contents.
	 *
	 * @example
	 * ```typescript
	 * tui.requestRender();
	 * await term.flush();
	 * const lines = term.getViewport();
	 * ```
	 */
	async flush(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.xterm.write("", () => resolve());
		});
	}

	/**
	 * Convenience method: flush pending writes and return the viewport.
	 *
	 * @returns Array of strings representing the visible terminal content
	 */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/**
	 * Returns the visible viewport content (what's currently on screen).
	 *
	 * Note: Call `flush()` first if you've just written data.
	 *
	 * @returns Array of strings, one per visible line (trimmed of trailing whitespace)
	 */
	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Returns the entire scroll buffer including scrollback history.
	 *
	 * @returns Array of all lines in the buffer
	 */
	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Returns the current cursor position.
	 *
	 * @returns Object with x (column) and y (row) coordinates
	 */
	getCursorPosition(): { x: number; y: number } {
		const buffer = this.xterm.buffer.active;
		return {
			x: buffer.cursorX,
			y: buffer.cursorY,
		};
	}

	/**
	 * Clears the terminal viewport (not the scrollback).
	 */
	clear(): void {
		this.xterm.clear();
	}

	/**
	 * Completely resets the terminal state.
	 */
	reset(): void {
		this.xterm.reset();
	}

	/**
	 * Disposes of the xterm.js instance and frees resources.
	 * Call this in test cleanup (afterEach).
	 */
	dispose(): void {
		this.xterm.dispose();
	}
}
