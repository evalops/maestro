/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	get columns(): number;
	get rows(): number;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	enterAltScreen?(): void;
	leaveAltScreen?(): void;
	enableBracketedPaste?(): void;
	disableBracketedPaste?(): void;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private bracketedPasteEnabled = false;
	private altScreenActive = false;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		const features = detectTerminalFeatures();

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		if (features.supportsBracketedPaste) {
			this.enableBracketedPaste?.();
		}

		// Set up event handlers
		process.stdin.on("data", this.inputHandler);
		process.stdout.on("resize", this.resizeHandler);
	}

	stop(): void {
		if (this.altScreenActive) {
			this.leaveAltScreen?.();
		}
		this.disableBracketedPaste?.();

		// Remove event handlers
		if (this.inputHandler) {
			process.stdin.removeListener("data", this.inputHandler);
			this.inputHandler = undefined;
		}
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
	}

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	enterAltScreen(): void {
		if (this.altScreenActive) return;
		process.stdout.write("\x1b[?1049h\x1b[?1007h");
		this.altScreenActive = true;
	}

	leaveAltScreen(): void {
		if (!this.altScreenActive) return;
		process.stdout.write("\x1b[?1007l\x1b[?1049l");
		this.altScreenActive = false;
	}

	enableBracketedPaste(): void {
		if (this.bracketedPasteEnabled) return;
		process.stdout.write("\x1b[?2004h");
		this.bracketedPasteEnabled = true;
	}

	disableBracketedPaste(): void {
		if (!this.bracketedPasteEnabled) return;
		process.stdout.write("\x1b[?2004l");
		this.bracketedPasteEnabled = false;
	}
}
import { detectTerminalFeatures } from "./utils/terminal-features.js";
