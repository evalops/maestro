/**
 * Minimal TUI implementation with differential rendering
 */
import type { Terminal } from "./terminal.js";
import { visibleWidth, wrapAnsiLines } from "./utils.js";
import { detectTerminalFeatures, type TerminalFeatures } from "./utils/terminal-features.js";

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
	private minRenderIntervalMs = 0;
	private lastRenderTs = 0;
	private renderTimer: NodeJS.Timeout | null = null;
	private features: TerminalFeatures;
	private syncOutput = true;
	private interruptHandler?: () => void;
	private overlayActive = false;

	constructor(private terminal: Terminal, features?: TerminalFeatures) {
		super();
		this.features = features ?? detectTerminalFeatures();
		this.syncOutput = this.features.supportsSyncOutput;
		if (this.features.overSsh) {
			// Avoid repaint storms on high-latency SSH links.
			this.minRenderIntervalMs = 24;
		}
	}

	setInterruptHandler(handler?: () => void): void {
		this.interruptHandler = handler;
	}

	setMinRenderInterval(ms: number): void {
		this.minRenderIntervalMs = Math.max(0, ms);
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

	/**
	 * Render a transient overlay in an alternate screen, then restore the inline view.
	 * Useful for pagers/diffs when running over SSH so scrollback is preserved.
	 */
	renderOverlay(render: (width: number, height: number) => string[]): void {
		if (!this.features.supportsAltScreen || !this.terminal.enterAltScreen) {
			// Fallback: draw inline after clearing. This preserves scrollback even if alt screen unsupported.
			const width = Math.max(1, this.terminal.columns);
			const height = this.terminal.rows;
			const lines = render(width, height);
			let buffer = this.syncOutput ? "\x1b[?2026h" : "";
			buffer += "\x1b[3J\x1b[2J\x1b[H";
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += lines[i];
			}
			if (this.syncOutput) buffer += "\x1b[?2026l";
			this.terminal.write(buffer);
			this.requestRender();
			return;
		}

		this.overlayActive = true;
		this.terminal.enterAltScreen();
		const width = Math.max(1, this.terminal.columns);
		const height = this.terminal.rows;
		const lines = render(width, height);
		let buffer = this.syncOutput ? "\x1b[?2026h" : "";
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) buffer += "\r\n";
			buffer += lines[i];
		}
		if (this.syncOutput) buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
		this.terminal.leaveAltScreen?.();
		this.overlayActive = false;
		this.requestRender();
	}

	stop(): void {
		this.terminal.showCursor();
		this.terminal.stop();
	}

	requestRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		const now = Date.now();
		const delay = Math.max(
			0,
			this.minRenderIntervalMs - (now - this.lastRenderTs),
		);
		if (delay > 0) {
			if (this.renderTimer) {
				return;
			}
			this.renderTimer = setTimeout(() => {
				this.renderTimer = null;
				this.renderRequested = false;
				this.doRender();
			}, delay);
		} else {
			process.nextTick(() => {
				this.renderRequested = false;
				this.doRender();
			});
		}
	}

	private handleInput(data: string): void {
		// Global interrupt path: Ctrl+C or bare Esc should always have an effect.
		if ((data === "\u0003" || data === "\u001b") && this.interruptHandler) {
			this.interruptHandler();
			return;
		}
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
		this.lastRenderTs = Date.now();

		// Render all components to get new lines
		const newLines = this.render(width);

		// Width changed - need full re-render
		const widthChanged =
			this.previousWidth !== 0 && this.previousWidth !== width;

		// First render - just output everything without clearing
		if (this.previousLines.length === 0) {
			let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);

			// After rendering N lines, cursor is at end of last line (line N-1)
			this.cursorRow = newLines.length - 1;
			this.previousLines = newLines;
			this.previousWidth = width;
			return;
		}

		// Width changed - full re-render
		if (widthChanged) {
			let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output
			buffer += "\x1b[3J\x1b[2J\x1b[H"; // Clear scrollback, screen, and home
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output
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
		let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output

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

		if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Cursor is now at end of last line
		this.cursorRow = newLines.length - 1;
		this.previousLines = newLines;
		this.previousWidth = width;
	}
}
