/**
 * @fileoverview Terminal Abstraction Layer for TUI Rendering
 *
 * This module provides a clean abstraction over the Node.js terminal APIs,
 * encapsulating raw mode setup, ANSI escape sequence generation, and
 * terminal state management.
 *
 * ## Design Rationale
 *
 * The Terminal interface enables:
 * 1. **Testability**: Mock terminals can be injected for unit testing
 * 2. **Portability**: Different implementations for different environments
 * 3. **State Encapsulation**: Proper cleanup and restoration on exit
 *
 * ## ANSI Escape Sequences Used
 *
 * This module uses the following control sequences:
 * - CSI n A/B: Cursor up/down by n lines
 * - CSI ? 25 l/h: Hide/show cursor (DECTCEM)
 * - CSI K: Erase to end of line (EL)
 * - CSI J: Erase to end of screen (ED)
 * - CSI 2J: Erase entire screen
 * - CSI H: Cursor home (1,1)
 * - CSI ? 1049 h/l: Alternate screen buffer (DECSET/DECRST)
 * - CSI ? 2004 h/l: Bracketed paste mode
 * - CSI ? 1007 h/l: Alternate scroll mode
 */

/**
 * Abstract terminal interface for TUI rendering.
 *
 * Implementations must handle:
 * - Raw mode setup and teardown
 * - Input event routing
 * - Cursor control
 * - Screen clearing
 *
 * Optional features (may return undefined):
 * - Alternate screen buffer
 * - Bracketed paste mode
 */
export interface Terminal {
	/** Initialize terminal and begin receiving input/resize events */
	start(onInput: (data: string) => void, onResize: () => void): void;

	/** Restore terminal state and stop event handling */
	stop(): void;

	/** Write raw output to the terminal */
	write(data: string): void;

	/** Current terminal width in columns */
	get columns(): number;

	/** Current terminal height in rows */
	get rows(): number;

	/** Move cursor up (negative) or down (positive) by n lines */
	moveBy(lines: number): void;

	/** Hide the cursor (for clean rendering) */
	hideCursor(): void;

	/** Show the cursor (restore after rendering) */
	showCursor(): void;

	/** Clear from cursor to end of current line */
	clearLine(): void;

	/** Clear from cursor to end of screen */
	clearFromCursor(): void;

	/** Clear entire screen and move cursor home */
	clearScreen(): void;

	/** Switch to alternate screen buffer (optional) */
	enterAltScreen?(): void;

	/** Return from alternate screen buffer (optional) */
	leaveAltScreen?(): void;

	/** Enable bracketed paste mode (optional) */
	enableBracketedPaste?(): void;

	/** Disable bracketed paste mode (optional) */
	disableBracketedPaste?(): void;
}

/**
 * Real terminal implementation using Node.js process.stdin/stdout.
 *
 * This class manages the terminal lifecycle:
 *
 * ## Startup (start())
 * 1. Saves current raw mode state for later restoration
 * 2. Enables raw mode to receive individual keystrokes
 * 3. Sets UTF-8 encoding for proper Unicode handling
 * 4. Enables bracketed paste if supported
 * 5. Registers input and resize event handlers
 *
 * ## Shutdown (stop())
 * 1. Exits alternate screen if active
 * 2. Disables bracketed paste
 * 3. Removes event handlers to prevent memory leaks
 * 4. Restores original raw mode state
 *
 * ## Raw Mode
 *
 * In raw mode, stdin delivers data byte-by-byte without line buffering.
 * This is essential for handling special keys (arrows, Ctrl combinations)
 * and providing responsive UI feedback.
 *
 * ## Bracketed Paste
 *
 * When enabled, pasted text is wrapped in escape sequences:
 * `\x1b[200~` ... pasted content ... `\x1b[201~`
 *
 * This allows the TUI to distinguish between typed and pasted input,
 * enabling features like multi-line paste handling.
 */
export class ProcessTerminal implements Terminal {
	/** Original raw mode state to restore on stop() */
	private wasRaw = false;

	/** Registered input event handler (for cleanup) */
	private inputHandler?: (data: string) => void;

	/** Registered resize event handler (for cleanup) */
	private resizeHandler?: () => void;

	/** Whether bracketed paste mode is currently enabled */
	private bracketedPasteEnabled = false;

	/** Whether we're currently in the alternate screen buffer */
	private altScreenActive = false;

	/**
	 * Initializes the terminal for TUI operation.
	 *
	 * @param onInput - Callback for each keystroke/paste event
	 * @param onResize - Callback when terminal dimensions change
	 */
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		const features = detectTerminalFeatures();

		// Save and modify terminal state
		// This is critical for proper cleanup - we restore this in stop()
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste for better paste handling
		if (features.supportsBracketedPaste) {
			this.enableBracketedPaste?.();
		}

		// Register event listeners
		process.stdin.on("data", this.inputHandler);
		process.stdout.on("resize", this.resizeHandler);
	}

	/**
	 * Restores terminal to its original state.
	 *
	 * This should always be called when the TUI exits, even on crashes.
	 * Consider using a cleanup handler or signal listener to ensure this runs.
	 */
	stop(): void {
		// Exit alternate screen first (restores scroll buffer)
		if (this.altScreenActive) {
			this.leaveAltScreen?.();
		}
		this.disableBracketedPaste?.();

		// Remove event handlers to prevent memory leaks and stale callbacks
		if (this.inputHandler) {
			process.stdin.removeListener("data", this.inputHandler);
			this.inputHandler = undefined;
		}
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Restore original raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	/** Writes raw data to stdout without any processing */
	write(data: string): void {
		process.stdout.write(data);
	}

	/** Returns terminal width, defaulting to 80 if unavailable */
	get columns(): number {
		return process.stdout.columns || 80;
	}

	/** Returns terminal height, defaulting to 24 if unavailable */
	get rows(): number {
		return process.stdout.rows || 24;
	}

	/**
	 * Moves cursor vertically by the specified number of lines.
	 *
	 * Uses CSI A (up) or CSI B (down) sequences.
	 *
	 * @param lines - Positive for down, negative for up, 0 for no movement
	 */
	moveBy(lines: number): void {
		if (lines > 0) {
			// CSI n B - Cursor Down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// CSI n A - Cursor Up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no-op
	}

	/**
	 * Hides the cursor using DECTCEM.
	 * Use during rendering to prevent cursor flicker.
	 */
	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	/**
	 * Shows the cursor using DECTCEM.
	 * Call after rendering is complete.
	 */
	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	/**
	 * Erases from cursor to end of line (EL 0).
	 * Useful for updating lines without leaving artifacts.
	 */
	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	/**
	 * Erases from cursor to end of screen (ED 0).
	 * Useful for clearing content below the current render area.
	 */
	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	/**
	 * Clears entire screen and moves cursor to home position.
	 * Combines ED 2 (clear all) with CUP (cursor home).
	 */
	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H");
	}

	/**
	 * Switches to the alternate screen buffer.
	 *
	 * The alternate buffer:
	 * - Preserves the original terminal content
	 * - Provides a clean slate for full-screen TUI
	 * - Restores original content on exit
	 *
	 * Also enables alternate scroll mode (1007) for proper mouse wheel behavior.
	 */
	enterAltScreen(): void {
		if (this.altScreenActive) return;
		// 1049: alternate screen buffer, 1007: alternate scroll mode
		process.stdout.write("\x1b[?1049h\x1b[?1007h");
		this.altScreenActive = true;
	}

	/**
	 * Returns from alternate screen buffer to normal buffer.
	 * The original terminal content is restored.
	 */
	leaveAltScreen(): void {
		if (!this.altScreenActive) return;
		// Disable in reverse order
		process.stdout.write("\x1b[?1007l\x1b[?1049l");
		this.altScreenActive = false;
	}

	/**
	 * Enables bracketed paste mode.
	 *
	 * When enabled, pasted text is wrapped:
	 * ESC[200~ + pasted text + ESC[201~
	 *
	 * This allows the application to handle pasted text differently
	 * from typed input (e.g., inserting all at once, handling newlines).
	 */
	enableBracketedPaste(): void {
		if (this.bracketedPasteEnabled) return;
		process.stdout.write("\x1b[?2004h");
		this.bracketedPasteEnabled = true;
	}

	/**
	 * Disables bracketed paste mode.
	 * Pasted text will be delivered as if it were typed.
	 */
	disableBracketedPaste(): void {
		if (!this.bracketedPasteEnabled) return;
		process.stdout.write("\x1b[?2004l");
		this.bracketedPasteEnabled = false;
	}
}

import { detectTerminalFeatures } from "./utils/terminal-features.js";
