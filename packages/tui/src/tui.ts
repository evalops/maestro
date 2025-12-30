/**
 * Minimal TUI implementation with differential rendering
 */
import { performance } from "node:perf_hooks";
import type { Terminal } from "./terminal.js";
import { truncateToWidth, visibleWidth, wrapAnsiLines } from "./utils.js";
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

	/**
	 * Optional method to invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 * Components that cache rendered output should clear their caches here.
	 */
	invalidate?(): void;

	/**
	 * Optional lifecycle method called when component is mounted/shown.
	 * Use for subscribing to events, starting timers, etc.
	 */
	onMount?(): void;

	/**
	 * Optional lifecycle method called when component is unmounted/hidden.
	 * Use for unsubscribing from events, stopping timers, cleaning up resources.
	 */
	onUnmount?(): void;

	/**
	 * Optional cleanup method called when component is permanently destroyed.
	 * Alias for onUnmount for compatibility with dispose() pattern.
	 */
	dispose?(): void;
}

/**
 * Helper type for components with full lifecycle support
 */
export interface LifecycleComponent extends Component {
	onMount(): void;
	onUnmount(): void;
}

export { visibleWidth };

export type RenderPath = "first" | "full" | "diff";

export interface RenderStats {
	totalRenders: number;
	totalFullRenders: number;
	totalDiffRenders: number;
	totalRenderMs: number;
	totalBytesWritten: number;
	totalLinesWritten: number;
	lastRenderMs: number;
	lastRenderAt: number;
	lastRenderType: RenderPath;
	lastLinesRendered: number;
	lastLinesWritten: number;
	lastBytesWritten: number;
	wrapCacheHits: number;
	wrapCacheMisses: number;
	avgRenderMs: number;
	wrapCacheHitRate: number;
}

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

	/**
	 * Invalidate all children's cached rendering state.
	 * Call this when theme changes or when all components need to re-render from scratch.
	 */
	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
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
 * TUI - Main class for managing terminal UI with differential rendering.
 *
 * ## Rendering Architecture
 *
 * The TUI uses differential rendering to minimize terminal writes:
 * 1. Components render to string[] lines
 * 2. Lines are wrapped to terminal width (cached)
 * 3. If content exceeds viewport, clip to bottom N lines (overflow)
 * 4. Compare newLines vs previousLines to find changes
 * 5. Only redraw changed lines (or full redraw if layout shifted)
 *
 * ## Render Strategies
 *
 * - **First render**: Write all lines, no clear needed
 * - **Full re-render**: Clear screen + write all (width change, overflow change, shrink)
 * - **Differential**: Move cursor to first changed line, clear+write only changes
 *
 * ## Critical Invariant
 *
 * `previousLines[i]` must always correspond to the same screen position as `newLines[i]`.
 * When overflow state changes, this invariant breaks (clipping shifts indices), so we
 * MUST do a full re-render to reset the mapping.
 */
export class TUI extends Container {
	/**
	 * Lines rendered in the previous frame. Used for diffing to determine what changed.
	 * After overflow clipping, this contains only the visible (bottom N) lines.
	 */
	private previousLines: string[] = [];

	/** Terminal width from the previous render. Used to detect resize. */
	private previousWidth = 0;

	/**
	 * Whether the previous render was clipped due to overflow.
	 * When this changes, line indices shift and we must do a full re-render.
	 */
	private overflowedLastRender = false;

	/** Currently focused component that receives keyboard input. */
	private focusedComponent: Component | null = null;

	/** Flag to coalesce multiple render requests into one. */
	private renderRequested = false;

	/**
	 * Current cursor row position (0-indexed, relative to TUI's first line).
	 * Used to calculate cursor movement for differential rendering.
	 * After each render, this is set to the last line rendered.
	 */
	private cursorRow = 0;

	/** Minimum milliseconds between renders. Higher over SSH to reduce "repaint storms". */
	private minRenderIntervalMs = 0;

	/** Timestamp of the last render (for throttling). */
	private lastRenderTs = 0;

	/** Timestamp of the last full re-render (cleared screen). */
	private lastFullRenderTs = 0;

	/** Timer for throttled render scheduling. */
	private renderTimer: NodeJS.Timeout | null = null;

	/** Detected terminal capabilities (SSH, sync output support, etc). */
	private features: TerminalFeatures;

	/** Whether to use synchronized output (DECSET 2026) to prevent tearing. */
	private syncOutput = true;

	/** Handler called on Ctrl+C or Esc for interrupt behavior. */
	private interruptHandler?: () => void;

	/** Optional callback invoked after each render with the rendered lines. */
	private onRender?: (lines: string[], width: number) => void;

	/** Whether an overlay (alt screen) is currently active. */
	private overlayActive = false;

	/**
	 * Cache for line wrapping results. Map<width, Map<lineContent, wrappedLines[]>>.
	 * Avoids re-wrapping unchanged lines on every render.
	 */
	private wrapCache = new Map<number, Map<string, string[]>>();

	/** Maximum entries per width in the wrap cache to prevent unbounded growth. */
	private static readonly MAX_WRAP_CACHE_ENTRIES = 500;

	private renderStats: Omit<RenderStats, "avgRenderMs" | "wrapCacheHitRate"> = {
		totalRenders: 0,
		totalFullRenders: 0,
		totalDiffRenders: 0,
		totalRenderMs: 0,
		totalBytesWritten: 0,
		totalLinesWritten: 0,
		lastRenderMs: 0,
		lastRenderAt: 0,
		lastRenderType: "first",
		lastLinesRendered: 0,
		lastLinesWritten: 0,
		lastBytesWritten: 0,
		wrapCacheHits: 0,
		wrapCacheMisses: 0,
	};

	/**
	 * When true, disables automatic overflow clipping.
	 * Use this when a ScrollContainer handles viewport clipping.
	 */
	private disableAutoClip = false;

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

	/**
	 * Set a callback to be invoked after each render.
	 * Useful for forwarding rendered content to native TUI.
	 */
	setRenderCallback(callback?: (lines: string[], width: number) => void): void {
		this.onRender = callback;
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

	/**
	 * Disables automatic overflow clipping, allowing a ScrollContainer
	 * to handle viewport management instead.
	 *
	 * When enabled, the TUI will render all content lines without clipping,
	 * expecting the content itself (via ScrollContainer) to manage what's visible.
	 */
	setAutoClip(enabled: boolean): void {
		this.disableAutoClip = !enabled;
	}

	/**
	 * Returns the current terminal dimensions.
	 * Useful for ScrollContainer to know viewport size.
	 */
	getTerminalSize(): { columns: number; rows: number } {
		return {
			columns: this.terminal.columns,
			rows: this.terminal.rows,
		};
	}

	getRenderStats(): RenderStats {
		const totalRenders = this.renderStats.totalRenders;
		const avgRenderMs =
			totalRenders > 0 ? this.renderStats.totalRenderMs / totalRenders : 0;
		const totalCacheLookups =
			this.renderStats.wrapCacheHits + this.renderStats.wrapCacheMisses;
		const wrapCacheHitRate =
			totalCacheLookups > 0
				? this.renderStats.wrapCacheHits / totalCacheLookups
				: 0;
		return {
			...this.renderStats,
			avgRenderMs,
			wrapCacheHitRate,
		};
	}

	resetRenderStats(): void {
		this.renderStats.totalRenders = 0;
		this.renderStats.totalFullRenders = 0;
		this.renderStats.totalDiffRenders = 0;
		this.renderStats.totalRenderMs = 0;
		this.renderStats.totalBytesWritten = 0;
		this.renderStats.totalLinesWritten = 0;
		this.renderStats.lastRenderMs = 0;
		this.renderStats.lastRenderAt = 0;
		this.renderStats.lastRenderType = "first";
		this.renderStats.lastLinesRendered = 0;
		this.renderStats.lastLinesWritten = 0;
		this.renderStats.lastBytesWritten = 0;
		this.renderStats.wrapCacheHits = 0;
		this.renderStats.wrapCacheMisses = 0;
	}

	setFocus(component: Component | null): void {
		this.focusedComponent = component;
	}

	/**
	 * Invalidate all cached rendering state and force a full re-render.
	 *
	 * Call this when:
	 * - Theme changes (colors, styles need to be re-applied)
	 * - Global state changes that affect all components
	 * - After hot-reloading component code
	 *
	 * This clears the TUI's wrap cache and calls invalidate() on all child
	 * components, then triggers a render.
	 */
	invalidateAll(): void {
		// Clear the wrap cache
		this.wrapCache.clear();
		// Reset previous state to force full re-render
		this.previousLines = [];
		this.previousWidth = 0;
		// Invalidate all child components
		super.invalidate();
		// Trigger a render
		this.requestRender();
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
			// Clear only what's needed: home, clear+rewrite lines, then clear the remainder.
			// Avoids blank-frame flashes when synchronized output is unavailable.
			buffer += "\x1b[H";
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				buffer += lines[i];
			}
			buffer += "\x1b[J";
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

	/**
	 * Core rendering method. Chooses between full and differential rendering strategies.
	 *
	 * ## Algorithm Overview
	 *
	 * 1. Render all components to lines, wrap to terminal width
	 * 2. If content exceeds viewport height, clip to bottom N lines (overflow)
	 * 3. Detect if layout changed significantly (width, overflow state, shrink)
	 * 4. If significant change → full re-render (clear screen, write all)
	 * 5. Otherwise → differential render (find changed lines, update only those)
	 *
	 * ## Why Overflow Changes Require Full Re-render
	 *
	 * When overflow state changes, the clipping shifts which lines are visible:
	 *
	 * ```
	 * Before (5 lines, no overflow):    After (15 lines, clipped to 10):
	 * previousLines[0] = actual line 0   newLines[0] = actual line 5 (!)
	 * previousLines[1] = actual line 1   newLines[1] = actual line 6
	 * ...                                ...
	 * ```
	 *
	 * If we did differential rendering, we'd compare previousLines[0] to newLines[0],
	 * but they represent DIFFERENT content positions. The cursor movement would be
	 * wrong, causing duplicated/overlapping content. Hence: always full re-render
	 * when overflow state changes.
	 */
	private doRender(): void {
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		this.lastRenderTs = Date.now();
		const now = this.lastRenderTs;
		const renderStart = performance.now();
		const finalizeRender = (
			renderType: RenderPath,
			buffer: string,
			linesRendered: number,
			linesWritten: number,
		): void => {
			const durationMs = performance.now() - renderStart;
			const bytesWritten = Buffer.byteLength(buffer);
			this.renderStats.totalRenders += 1;
			if (renderType === "full" || renderType === "first") {
				this.renderStats.totalFullRenders += 1;
			} else if (renderType === "diff") {
				this.renderStats.totalDiffRenders += 1;
			}
			this.renderStats.totalRenderMs += durationMs;
			this.renderStats.totalBytesWritten += bytesWritten;
			this.renderStats.totalLinesWritten += linesWritten;
			this.renderStats.lastRenderMs = durationMs;
			this.renderStats.lastRenderAt = now;
			this.renderStats.lastRenderType = renderType;
			this.renderStats.lastLinesRendered = linesRendered;
			this.renderStats.lastLinesWritten = linesWritten;
			this.renderStats.lastBytesWritten = bytesWritten;
		};

		// ─────────────────────────────────────────────────────────────────────────
		// STEP 1: Render components to lines and wrap to terminal width
		// ─────────────────────────────────────────────────────────────────────────
		let newLines = this.wrapWithCache(this.render(width), width);

		// ─────────────────────────────────────────────────────────────────────────
		// OPTIONAL: Forward to external renderer (native TUI)
		// ─────────────────────────────────────────────────────────────────────────
		// If an external render callback is set, invoke it with the rendered lines.
		// This allows the native Rust TUI to handle the actual terminal output.
		if (this.onRender) {
			this.onRender(newLines, width);
		}

		// ─────────────────────────────────────────────────────────────────────────
		// STEP 2: Handle viewport overflow (clip to bottom N lines)
		// ─────────────────────────────────────────────────────────────────────────
		// When content exceeds viewport, we show only the bottom portion.
		// This keeps the input prompt visible and prevents the terminal from
		// scrolling our UI off-screen.
		//
		// If disableAutoClip is true, skip this step - a ScrollContainer is
		// handling viewport management and will only render visible lines.
		const isOverflowing = !this.disableAutoClip && newLines.length > height;
		if (isOverflowing) {
			newLines = newLines.slice(-height);
		}

		// ─────────────────────────────────────────────────────────────────────────
		// STEP 3: Detect significant layout changes requiring full re-render
		// ─────────────────────────────────────────────────────────────────────────
		const widthChanged =
			this.previousWidth !== 0 && this.previousWidth !== width;

		// CRITICAL: When overflow state changes, line indices no longer match
		// between previousLines and newLines. We MUST do a full re-render.
		const overflowChanged = isOverflowing !== this.overflowedLastRender;

		// Shrinking content can be handled in the differential path (we clear stale
		// lines there). Avoid full clears unless layout invariants break.
		const shouldFullRender = widthChanged || overflowChanged;

		// Never throttle when overflow changes - the index mismatch makes
		// differential rendering produce garbled output (see class docstring).
		// This was previously a bug where throttling caused duplicate content.
		const overflowRerenderThrottled = false;

		// ─────────────────────────────────────────────────────────────────────────
		// RENDER PATH A: First render (no previous state)
		// ─────────────────────────────────────────────────────────────────────────
		if (this.previousLines.length === 0) {
			let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += newLines[i];
			}
			if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			finalizeRender("first", buffer, newLines.length, newLines.length);

			// After rendering N lines, cursor is at end of last line (line N-1)
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.overflowedLastRender = isOverflowing;
			this.lastFullRenderTs = now;
			return;
		}

		// ─────────────────────────────────────────────────────────────────────────
		// RENDER PATH B: Full re-render (layout changed significantly)
		// ─────────────────────────────────────────────────────────────────────────
		// Redraw the full viewport from home (without clearing scrollback).
		// Required when: width changed or overflow state changed.
		if (shouldFullRender && !overflowRerenderThrottled) {
			let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output
			// Home, clear+rewrite each line, then clear the remainder.
			// This avoids nuking scrollback and reduces blank-frame flashes when
			// synchronized output is unavailable.
			buffer += "\x1b[H";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				buffer += newLines[i];
			}
			buffer += "\x1b[J";
			if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			finalizeRender("full", buffer, newLines.length, newLines.length);

			this.cursorRow = Math.max(0, newLines.length - 1);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.overflowedLastRender = isOverflowing;
			this.lastFullRenderTs = now;
			return;
		}

		// ─────────────────────────────────────────────────────────────────────────
		// RENDER PATH C: Differential render (only content changed)
		// ─────────────────────────────────────────────────────────────────────────
		// Find the range of lines that changed, then update only those.
		// This is the fast path for streaming updates and minor changes.

		// Step C1: Find first and last changed line indices
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

		// Step C2: Early exit if nothing changed
		if (firstChanged === -1) {
			return;
		}

		// Step C3: Check if changes are within the visible viewport
		// If first change is above viewport (scrolled out), need full re-render
		const viewportTop = this.cursorRow - height + 1;
		if (firstChanged < viewportTop) {
			// First change is above viewport - fall back to full re-render
			let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output
			buffer += "\x1b[H";
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) buffer += "\r\n";
				buffer += "\x1b[2K";
				buffer += newLines[i];
			}
			buffer += "\x1b[J";
			if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output
			this.terminal.write(buffer);
			finalizeRender("full", buffer, newLines.length, newLines.length);

			this.cursorRow = Math.max(0, newLines.length - 1);
			this.previousLines = newLines;
			this.previousWidth = width;
			this.overflowedLastRender = isOverflowing;
			return;
		}

		// Step C4: Differential update - only redraw changed lines
		let buffer = this.syncOutput ? "\x1b[?2026h" : ""; // Begin synchronized output

		// Move cursor from current position to the first changed line.
		// cursorRow tracks where the cursor is; we need to move up or down.
		const lineDiff = firstChanged - this.cursorRow;
		if (lineDiff > 0) {
			buffer += `\x1b[${lineDiff}B`; // CSI n B = Cursor Down n lines
		} else if (lineDiff < 0) {
			buffer += `\x1b[${-lineDiff}A`; // CSI n A = Cursor Up n lines
		}
		buffer += "\r"; // CR = Carriage Return (move to column 0)

		// Step C5: Clear and write each changed line
		// We clear each line individually (not cursor-to-end) to avoid
		// visual flashes in buffered terminals like xterm.js over SSH.
		const renderEnd = Math.max(newLines.length, this.previousLines.length);
		for (let i = firstChanged; i < renderEnd; i++) {
			if (i > firstChanged) buffer += "\r\n";
			buffer += "\x1b[2K"; // Clear current line before writing
			if (i >= newLines.length) {
				// Clear stale line (content shrank); nothing to write.
				continue;
			}
			let line = newLines[i];
			// Safety fallback: if a line somehow exceeds width after wrapping,
			// truncate it gracefully instead of crashing. This shouldn't happen
			// in normal operation, but we handle it to avoid breaking the UI.
			if (visibleWidth(line) > width) {
				line = truncateToWidth(line, width);
				newLines[i] = line; // Update for previousLines tracking
			}
			buffer += line;
		}

		// If we cleared stale lines beyond the new content, move the cursor back up
		// to the last actual content line (or row 0 if the frame is empty).
		const targetCursorRow = Math.max(0, newLines.length - 1);
		if (renderEnd > 0) {
			const endRow = renderEnd - 1;
			const moveUp = endRow - targetCursorRow;
			if (moveUp > 0) {
				buffer += `\x1b[${moveUp}A`; // CSI n A = Cursor Up n lines
			}
		}

		if (this.syncOutput) buffer += "\x1b[?2026l"; // End synchronized output

		// Step C7: Flush the buffer and update state
		// Write entire buffer atomically to minimize visual artifacts
		this.terminal.write(buffer);
		const linesWritten = renderEnd - firstChanged;
		finalizeRender("diff", buffer, newLines.length, linesWritten);

		// Update cursor tracking - cursor ends at the last line of content (or row 0 if empty)
		this.cursorRow = Math.max(0, newLines.length - 1);
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
				this.renderStats.wrapCacheHits += 1;
				wrapped.push(...cached);
				continue;
			}
			this.renderStats.wrapCacheMisses += 1;
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
