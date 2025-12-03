/**
 * Minimal TUI implementation with differential rendering
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Terminal } from "./terminal.js";
import { visibleWidth, wrapAnsiLines } from "./utils.js";
import {
	type TerminalFeatures,
	detectTerminalFeatures,
} from "./utils/terminal-features.js";

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
	private overflowedLastRender = false;
	private focusedComponent: Component | null = null;
	private renderRequested = false;
	private cursorRow = 0; // Track where cursor is (0-indexed, relative to our first line)
	private minRenderIntervalMs = 0;
	private lastRenderTs = 0;
	private lastFullRenderTs = 0;
	private renderTimer: NodeJS.Timeout | null = null;
	private features: TerminalFeatures;
	private syncOutput = true;
	private interruptHandler?: () => void;
	private overlayActive = false;
	private wrapCache = new Map<number, Map<string, string[]>>();
	private static readonly MAX_WRAP_CACHE_ENTRIES = 500;

	constructor(
		private terminal: Terminal,
		features?: TerminalFeatures,
	) {
		super();
		this.features = features ?? detectTerminalFeatures();
		this.syncOutput = this.features.supportsSyncOutput;
		if (this.features.overSsh) {
			// Avoid repaint storms on high-latency links (SSH/tmux/mosh).
			this.minRenderIntervalMs = 48;
		}
	}

	setInterruptHandler(handler?: () => void): void {
		this.interruptHandler = handler;
	}

	setMinRenderInterval(ms: number): void {
		this.minRenderIntervalMs = Math.max(0, ms);
	}

	/**
	 * Toggle synchronized output (DECSET 2026) at runtime. Useful for live user toggles
	 * without restarting the TUI. The feature flag still gates support detection.
	 */
	setSyncOutput(enabled: boolean): void {
		this.syncOutput = enabled && this.features.supportsSyncOutput;
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

	requestRender(priority: "normal" | "interactive" = "normal"): void {
		// Interactive requests (e.g., arrow-key navigation) should feel instant even
		// when we're throttling renders for SSH/tmux sessions. We bypass the throttle
		// and collapse any pending timer so the next frame paints immediately.
		const interactive = priority === "interactive";

		if (interactive && this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}

		if (this.renderRequested && !interactive) return;
		this.renderRequested = true;

		const now = Date.now();
		const effectiveMinInterval = interactive ? 0 : this.minRenderIntervalMs;
		const delay = Math.max(0, effectiveMinInterval - (now - this.lastRenderTs));

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
			this.requestRender("interactive");
		}
	}

	private doRender(): void {
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		this.lastRenderTs = Date.now();
		const now = this.lastRenderTs;

		// Render all components and hard-wrap to the viewport so we never exceed the terminal width
		let newLines = this.wrapWithCache(this.render(width), width);

		// Clip to viewport height to prevent the UI from scrolling upward and leaving
		// duplicate input boxes in the scrollback. We always render the bottom-most
		// portion of the layout.
		const isOverflowing = newLines.length > height;
		if (isOverflowing) {
			newLines = newLines.slice(-height);
		}

		// Width changed - need full re-render
		const widthChanged =
			this.previousWidth !== 0 && this.previousWidth !== width;
		const overflowChanged = isOverflowing !== this.overflowedLastRender;
		const shouldFullRender = widthChanged || overflowChanged;
		const overflowRerenderThrottled =
			overflowChanged && now - this.lastFullRenderTs < 32; // ~2 frames at 60Hz

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
			this.overflowedLastRender = isOverflowing;
			this.lastFullRenderTs = now;
			return;
		}

		// Width change or overflow -> full re-render so the editor stays pinned at the bottom
		if (shouldFullRender && !overflowRerenderThrottled) {
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
			this.overflowedLastRender = isOverflowing;
			this.lastFullRenderTs = now;
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
			this.overflowedLastRender = isOverflowing;
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

		// Render from first changed line to end, clearing each line individually to avoid
		// cursor-to-end flashes in buffered terminals (e.g., xterm.js over SSH).
		for (let i = firstChanged; i < newLines.length; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line before writing
			const line = newLines[i];
			if (visibleWidth(line) > width) {
				const crashLogPath = path.join(
					os.homedir(),
					".composer",
					"agent",
					"tui-crash.log",
				);
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== Rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);
				throw new Error(
					`Rendered line ${i} exceeds terminal width. Debug log written to ${crashLogPath}`,
				);
			}
			buffer += line;
		}

		// If we rendered fewer lines than previously, clear the leftovers so stale
		// content cannot flicker before the next full render.
		if (this.previousLines.length > newLines.length) {
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += `\x1b[${extraLines}A`;
		}

		if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output

		// Write entire buffer at once
		this.terminal.write(buffer);

		// Cursor is now at end of last line
		this.cursorRow = newLines.length - 1;
		this.previousLines = newLines;
		this.previousWidth = width;
		this.overflowedLastRender = isOverflowing;
	}

	private wrapWithCache(lines: string[], width: number): string[] {
		if (width <= 0) return [""];
		let cache = this.wrapCache.get(width);
		if (!cache) {
			cache = new Map();
			this.wrapCache.set(width, cache);
		}
		const wrapped: string[] = [];
		for (const line of lines) {
			const key = line ?? "";
			const cached = cache.get(key);
			if (cached) {
				wrapped.push(...cached);
				continue;
			}
			const result = wrapAnsiLines([key], width);
			cache.set(key, result);

			// Prevent unbounded growth per width: drop oldest entries when we exceed the cap.
			if (cache.size > TUI.MAX_WRAP_CACHE_ENTRIES) {
				const oldestKey = cache.keys().next().value as string | undefined;
				if (oldestKey !== undefined) cache.delete(oldestKey);
			}
			wrapped.push(...result);
		}
		// Keep only a small number of width caches to avoid unbounded growth
		if (this.wrapCache.size > 3) {
			const widths = Array.from(this.wrapCache.keys()).sort((a, b) => b - a);
			for (const w of widths.slice(3)) {
				this.wrapCache.delete(w);
			}
		}
		return wrapped;
	}
}
