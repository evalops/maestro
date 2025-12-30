/**
 * @fileoverview ScrollContainer - Scrollable viewport for TUI content
 *
 * Provides vertical scrolling for content that exceeds the viewport height.
 * Supports keyboard navigation, sticky scroll (auto-follow), and scroll indicators.
 *
 * ## Key Features
 *
 * - **Viewport clipping**: Only renders visible lines based on scroll offset
 * - **Sticky scroll**: Auto-follows bottom when new content arrives (unless user scrolled up)
 * - **Keyboard navigation**: Page Up/Down, Ctrl+Home/End, arrow keys
 * - **Scroll indicator**: Optional position indicator showing current scroll position
 *
 * ## Usage
 *
 * ```typescript
 * const scroll = new ScrollContainer(chatContent, {
 *   viewportHeight: 20,  // Or dynamically set via setViewportHeight()
 *   stickyScroll: true,
 *   showIndicator: true,
 * });
 *
 * // Handle input for scrolling
 * scroll.handleInput(keyData);
 *
 * // Render visible portion
 * const lines = scroll.render(width);
 * ```
 */

import type { Component } from "../tui.js";

/**
 * Configuration options for ScrollContainer.
 */
export interface ScrollContainerOptions {
	/**
	 * Number of visible lines in the viewport.
	 * If not set, must be provided via setViewportHeight() before rendering.
	 */
	viewportHeight?: number;

	/**
	 * When true, automatically scrolls to bottom when new content is added,
	 * unless the user has manually scrolled up.
	 * @default true
	 */
	stickyScroll?: boolean;

	/**
	 * Show scroll position indicator (e.g., "[42/156]").
	 * @default false
	 */
	showIndicator?: boolean;

	/**
	 * Number of lines to scroll per "page" (Page Up/Down).
	 * If not set, defaults to viewportHeight - 2.
	 */
	pageSize?: number;

	/**
	 * Callback when scroll position changes.
	 * Useful for triggering re-renders in the parent.
	 */
	onScroll?: (offset: number, maxOffset: number) => void;

	/**
	 * Reserve lines at bottom for input/status (not part of scrollable area).
	 * @default 0
	 */
	reservedLines?: number;

	/**
	 * Maximum number of lines kept in scrollback history.
	 * When exceeded, the oldest lines are evicted (FIFO) and scrollOffset is adjusted.
	 * @default 10000
	 */
	maxHistoryLines?: number;

	/**
	 * Show a marker when older scrollback is truncated.
	 * @default true
	 */
	showTruncationMarker?: boolean;

	/**
	 * Base label used for truncation markers.
	 * @default "... scrollback truncated"
	 */
	truncationMarker?: string;
}

/**
 * Scrollable container component for TUI.
 *
 * Wraps child content and provides vertical scrolling with keyboard navigation.
 * The scroll offset determines which portion of the content is visible.
 *
 * IMPORTANT: This component maintains a PERSISTENT HISTORY of all content
 * ever rendered, so even if the child component's content is cleared or
 * trimmed, users can still scroll back to see old content.
 *
 * ```
 * ┌─────────────────────────────────────┐
 * │  Full content history (N lines)     │
 * │  ┌───────────────────────────────┐  │
 * │  │ Visible viewport (M lines)    │  │ ← scrollOffset
 * │  │ Lines [offset, offset + M)    │  │
 * │  └───────────────────────────────┘  │
 * │  ... more content below ...         │
 * └─────────────────────────────────────┘
 * ```
 */
export class ScrollContainer implements Component {
	/** Current scroll offset (first visible line index) */
	private scrollOffset = 0;

	/** When true, auto-scroll to bottom on new content */
	private stickyScroll: boolean;

	/** Whether user has scrolled up (disables sticky until they scroll to bottom) */
	private userScrolledUp = false;

	/** Viewport height in lines */
	private viewportHeight: number;

	/** Lines per page for Page Up/Down */
	private pageSize?: number;

	/** Show scroll indicator */
	private showIndicator: boolean;

	/** Scroll change callback */
	private onScroll?: (offset: number, maxOffset: number) => void;

	/** Reserved lines at bottom */
	private reservedLines: number;

	/**
	 * PERSISTENT content history - all lines ever rendered.
	 * This is the key difference: we keep history even when child content is cleared.
	 */
	private contentHistory: string[] = [];

	/** Track last child render to detect changes */
	private lastChildRenderHash = "";

	/** Last rendered lines from the child component (for diffing/streaming updates). */
	private lastRenderedLines: string[] = [];

	/** Maximum history lines to prevent unbounded memory growth */
	private maxHistoryLines: number;

	/** Whether to show a truncation marker line */
	private showTruncationMarker: boolean;

	/** Marker label used when scrollback is truncated */
	private truncationMarker: string;

	/** Total number of truncated lines */
	private truncatedLines = 0;

	/** The child component to scroll */
	private content: Component;

	constructor(content: Component, options: ScrollContainerOptions = {}) {
		this.content = content;
		this.viewportHeight = options.viewportHeight ?? 20;
		this.stickyScroll = options.stickyScroll ?? true;
		this.showIndicator = options.showIndicator ?? false;
		this.pageSize = options.pageSize;
		this.onScroll = options.onScroll;
		this.reservedLines = options.reservedLines ?? 0;
		// Keep up to 10000 lines of history (~5MB at 500 chars/line)
		this.maxHistoryLines = options.maxHistoryLines ?? 10000;
		this.showTruncationMarker = options.showTruncationMarker ?? true;
		this.truncationMarker =
			options.truncationMarker ?? "... scrollback truncated";
	}

	/**
	 * Updates the viewport height dynamically.
	 * Call this when terminal is resized.
	 */
	setViewportHeight(height: number): void {
		const newHeight = Math.max(1, height - this.reservedLines);
		if (newHeight !== this.viewportHeight) {
			this.viewportHeight = newHeight;
			// Clamp scroll offset to new bounds
			this.clampScrollOffset();
		}
	}

	/**
	 * Sets the content component to scroll.
	 */
	setContent(content: Component): void {
		this.content = content;
	}

	/**
	 * Gets the current scroll offset.
	 */
	getScrollOffset(): number {
		return this.scrollOffset;
	}

	/**
	 * Gets the maximum valid scroll offset.
	 */
	getMaxScrollOffset(): number {
		return Math.max(0, this.contentHistory.length - this.viewportHeight);
	}

	/**
	 * Clears all history. Use when starting a new session.
	 */
	clearHistory(): void {
		this.contentHistory = [];
		this.scrollOffset = 0;
		this.userScrolledUp = false;
		this.lastChildRenderHash = "";
		this.lastRenderedLines = [];
		this.truncatedLines = 0;
	}

	/**
	 * Returns true if currently at the bottom (sticky scroll active).
	 */
	isAtBottom(): boolean {
		return this.scrollOffset >= this.getMaxScrollOffset();
	}

	/**
	 * Scrolls by a relative amount.
	 * Negative = scroll up, positive = scroll down.
	 */
	scrollBy(delta: number): void {
		const oldOffset = this.scrollOffset;
		this.scrollOffset = Math.max(
			0,
			Math.min(this.getMaxScrollOffset(), this.scrollOffset + delta),
		);

		if (this.scrollOffset !== oldOffset) {
			// Track if user scrolled up (disables sticky)
			if (delta < 0) {
				this.userScrolledUp = true;
			}
			// Re-enable sticky if user scrolled to bottom
			if (this.isAtBottom()) {
				this.userScrolledUp = false;
			}
			this.onScroll?.(this.scrollOffset, this.getMaxScrollOffset());
		}
	}

	/**
	 * Scrolls to an absolute offset.
	 */
	scrollTo(offset: number): void {
		const targetOffset = Math.max(
			0,
			Math.min(this.getMaxScrollOffset(), offset),
		);
		if (targetOffset !== this.scrollOffset) {
			this.scrollOffset = targetOffset;
			this.userScrolledUp = !this.isAtBottom();
			this.onScroll?.(this.scrollOffset, this.getMaxScrollOffset());
		}
	}

	/**
	 * Scrolls to the top.
	 */
	scrollToTop(): void {
		this.scrollTo(0);
	}

	/**
	 * Scrolls to the bottom and re-enables sticky scroll.
	 */
	scrollToBottom(): void {
		this.scrollTo(this.getMaxScrollOffset());
		this.userScrolledUp = false;
	}

	/**
	 * Scrolls up by one page.
	 */
	pageUp(): void {
		const page = this.pageSize ?? Math.max(1, this.viewportHeight - 2);
		this.scrollBy(-page);
	}

	/**
	 * Scrolls down by one page.
	 */
	pageDown(): void {
		const page = this.pageSize ?? Math.max(1, this.viewportHeight - 2);
		this.scrollBy(page);
	}

	/**
	 * Scrolls up by half a page.
	 */
	halfPageUp(): void {
		const half = Math.max(1, Math.floor(this.viewportHeight / 2));
		this.scrollBy(-half);
	}

	/**
	 * Scrolls down by half a page.
	 */
	halfPageDown(): void {
		const half = Math.max(1, Math.floor(this.viewportHeight / 2));
		this.scrollBy(half);
	}

	/**
	 * Clamps scroll offset to valid bounds.
	 */
	private clampScrollOffset(): void {
		const maxOffset = this.getMaxScrollOffset();
		if (this.scrollOffset > maxOffset) {
			this.scrollOffset = maxOffset;
		}
	}

	/**
	 * Handles keyboard input for scrolling.
	 *
	 * Supported keys:
	 * - Page Up (\x1b[5~): Scroll up one page
	 * - Page Down (\x1b[6~): Scroll down one page
	 * - Ctrl+Home (\x1b[1;5H): Jump to top
	 * - Ctrl+End (\x1b[1;5F): Jump to bottom
	 * - Ctrl+Up (\x1b[1;5A): Scroll up one line
	 * - Ctrl+Down (\x1b[1;5B): Scroll down one line
	 * - Ctrl+U: Half page up (vim-style)
	 * - Ctrl+D: Half page down (vim-style)
	 *
	 * @returns true if input was handled, false otherwise
	 */
	handleInput(data: string): boolean {
		// Page Up
		if (data === "\x1b[5~") {
			this.pageUp();
			return true;
		}

		// Page Down
		if (data === "\x1b[6~") {
			this.pageDown();
			return true;
		}

		// Ctrl+Home - jump to top
		if (data === "\x1b[1;5H") {
			this.scrollToTop();
			return true;
		}

		// Ctrl+End - jump to bottom
		if (data === "\x1b[1;5F") {
			this.scrollToBottom();
			return true;
		}

		// Ctrl+Up - scroll up one line
		if (data === "\x1b[1;5A") {
			this.scrollBy(-1);
			return true;
		}

		// Ctrl+Down - scroll down one line
		if (data === "\x1b[1;5B") {
			this.scrollBy(1);
			return true;
		}

		// Ctrl+U - half page up (vim-style)
		if (data === "\x15") {
			this.halfPageUp();
			return true;
		}

		// Ctrl+D - half page down (vim-style)
		if (data === "\x04") {
			this.halfPageDown();
			return true;
		}

		// G - jump to bottom (vim-style, capital G)
		if (data === "G") {
			this.scrollToBottom();
			return true;
		}

		// gg - jump to top would need state tracking, skip for now

		return false;
	}

	/**
	 * Renders the visible portion of the content.
	 *
	 * Algorithm:
	 * 1. Render current content from child component
	 * 2. APPEND new content to persistent history (detecting what's new)
	 * 3. Apply sticky scroll if enabled and user hasn't scrolled up
	 * 4. Extract visible lines from HISTORY based on scroll offset
	 * 5. Optionally append scroll indicator
	 */
	render(width: number): string[] {
		// Render current content from child
		const currentLines = this.content.render(width);

		// Create a hash to detect if content changed
		const currentHash = this.hashLines(currentLines);

		// If content changed, update history
		if (currentHash !== this.lastChildRenderHash) {
			this.updateHistory(currentLines);
			this.lastChildRenderHash = currentHash;
		}

		const totalLines = this.contentHistory.length;
		const maxOffset = Math.max(0, totalLines - this.viewportHeight);

		// Apply sticky scroll: auto-follow bottom unless user scrolled up
		if (this.stickyScroll && !this.userScrolledUp) {
			this.scrollOffset = maxOffset;
		}

		// Clamp offset to valid range
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));

		// Extract visible lines FROM HISTORY (not current content!)
		const visibleLines = this.contentHistory.slice(
			this.scrollOffset,
			this.scrollOffset + this.viewportHeight,
		);

		// Only pad with empty lines when content exceeds viewport (scrolling active)
		// This prevents massive empty space when content is small
		if (totalLines > this.viewportHeight) {
			const emptyLine = " ".repeat(width);
			while (visibleLines.length < this.viewportHeight) {
				visibleLines.push(emptyLine);
			}
		}

		// Optionally show scroll indicator
		if (this.showIndicator && totalLines > this.viewportHeight) {
			const indicator = this.renderIndicator(width);
			if (indicator && visibleLines.length > 0) {
				// Replace last line with indicator overlay
				const lastIdx = visibleLines.length - 1;
				visibleLines[lastIdx] = this.overlayIndicator(
					visibleLines[lastIdx],
					indicator,
					width,
				);
			}
		}

		return visibleLines;
	}

	/**
	 * Simple hash of lines for change detection.
	 */
	private hashLines(lines: string[]): string {
		if (lines.length === 0) return "empty";
		let hash = 2166136261;
		for (const line of lines) {
			for (let i = 0; i < line.length; i++) {
				hash ^= line.charCodeAt(i);
				hash = Math.imul(hash, 16777619);
			}
			// Add a separator to reduce collisions across line boundaries.
			hash ^= 10;
			hash = Math.imul(hash, 16777619);
		}
		return `${lines.length}:${hash >>> 0}`;
	}

	/**
	 * Updates the content history with new lines.
	 * Appends new content while preserving old history.
	 */
	private updateHistory(currentLines: string[]): void {
		// Strategy:
		// - Preserve historical lines even if the child clears.
		// - Avoid duplicating lines for streaming updates (last line mutates).
		// - Append only truly new lines when the child grows.

		if (currentLines.length === 0) {
			// Child was cleared; keep history but reset streaming baseline.
			this.lastRenderedLines = [];
			return;
		}

		if (this.lastRenderedLines.length === 0) {
			if (this.contentHistory.length === 0) {
				this.contentHistory = [...currentLines];
			} else {
				this.contentHistory.push(...currentLines);
			}
			this.lastRenderedLines = [...currentLines];
			this.trimHistory();
			return;
		}

		if (this.linesEqual(this.lastRenderedLines, currentLines)) {
			return;
		}

		const lastCount = this.lastRenderedLines.length;
		const prefixLen = this.commonPrefixLength(
			this.lastRenderedLines,
			currentLines,
		);
		const minLen = Math.min(lastCount, currentLines.length);
		const nearContinuous = minLen > 0 && prefixLen >= minLen - 1;

		// Streaming update: replace the tail segment in place to avoid duplicates.
		if (nearContinuous && currentLines.length >= lastCount) {
			const removeCount = Math.min(lastCount, this.contentHistory.length);
			if (removeCount === 0) {
				this.contentHistory.push(...currentLines);
			} else {
				const start = this.contentHistory.length - removeCount;
				const expectedTail = this.lastRenderedLines.slice(-removeCount);
				if (this.endsWithLines(this.contentHistory, expectedTail)) {
					this.contentHistory.splice(start, removeCount, ...currentLines);
				} else {
					const overlap = this.findOverlap(this.contentHistory, currentLines);
					if (overlap > 0) {
						this.contentHistory.push(...currentLines.slice(overlap));
					} else {
						this.contentHistory.push(...currentLines);
					}
				}
			}
			this.lastRenderedLines = [...currentLines];
			this.trimHistory();
			return;
		}

		// Child trimmed the tail of its output; keep history but advance baseline.
		if (this.startsWithLines(this.lastRenderedLines, currentLines)) {
			this.lastRenderedLines = [...currentLines];
			return;
		}

		// If the current lines already match the tail of history, keep history as-is.
		if (this.endsWithLines(this.contentHistory, currentLines)) {
			this.lastRenderedLines = [...currentLines];
			return;
		}

		// Fallback: overlap detection to append only new content when possible.
		const overlap = this.findOverlap(this.contentHistory, currentLines);
		if (overlap > 0) {
			this.contentHistory.push(...currentLines.slice(overlap));
		} else {
			this.contentHistory.push(...currentLines);
		}

		this.lastRenderedLines = [...currentLines];
		this.trimHistory();
	}

	private trimHistory(): void {
		if (this.contentHistory.length > this.maxHistoryLines) {
			const removeCount = this.contentHistory.length - this.maxHistoryLines;
			this.contentHistory.splice(0, removeCount);
			this.scrollOffset = Math.max(0, this.scrollOffset - removeCount);
			this.truncatedLines += removeCount;
			this.applyTruncationMarker();
		}
	}

	private applyTruncationMarker(): void {
		if (!this.showTruncationMarker || this.truncatedLines === 0) return;
		let marker = this.formatTruncationMarker();
		let offsetDelta = 0;
		if (this.contentHistory.length === 0) {
			this.contentHistory.push(marker);
			return;
		}
		const hadMarker = this.isTruncationMarker(this.contentHistory[0]);
		if (hadMarker) {
			this.contentHistory[0] = marker;
		} else {
			this.contentHistory.unshift(marker);
			if (this.scrollOffset > 0) {
				offsetDelta += 1;
			}
		}
		if (this.contentHistory.length > this.maxHistoryLines) {
			const overflow = this.contentHistory.length - this.maxHistoryLines;
			this.contentHistory.splice(1, overflow);
			this.truncatedLines += overflow;
			marker = this.formatTruncationMarker();
			this.contentHistory[0] = marker;
			if (this.scrollOffset > 0) {
				offsetDelta -= overflow;
			}
		}
		if (offsetDelta !== 0 && this.scrollOffset > 0) {
			this.scrollOffset = Math.max(0, this.scrollOffset + offsetDelta);
		}
	}

	private formatTruncationMarker(): string {
		const count = this.truncatedLines.toLocaleString();
		return `${this.truncationMarker} (${count} lines)`;
	}

	private isTruncationMarker(line: string): boolean {
		return line.startsWith(this.truncationMarker);
	}

	private linesEqual(a: string[], b: string[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	private commonPrefixLength(a: string[], b: string[]): number {
		const max = Math.min(a.length, b.length);
		let idx = 0;
		while (idx < max && a[idx] === b[idx]) {
			idx += 1;
		}
		return idx;
	}

	private endsWithLines(history: string[], current: string[]): boolean {
		if (current.length === 0) return true;
		if (current.length > history.length) return false;
		const start = history.length - current.length;
		for (let i = 0; i < current.length; i++) {
			if (history[start + i] !== current[i]) return false;
		}
		return true;
	}

	private startsWithLines(history: string[], current: string[]): boolean {
		if (current.length === 0) return true;
		if (current.length > history.length) return false;
		for (let i = 0; i < current.length; i++) {
			if (history[i] !== current[i]) return false;
		}
		return true;
	}

	/**
	 * Finds how many lines at the end of history match the start of current.
	 * Returns the overlap count.
	 */
	private findOverlap(history: string[], current: string[]): number {
		if (history.length === 0 || current.length === 0) return 0;

		// Look for overlap between end of history and start of current
		// Check up to min(history.length, current.length) lines
		const maxCheck = Math.min(history.length, current.length, 100);

		for (let overlapSize = maxCheck; overlapSize > 0; overlapSize--) {
			const historyEnd = history.slice(-overlapSize);
			const currentStart = current.slice(0, overlapSize);

			let matches = true;
			for (let i = 0; i < overlapSize; i++) {
				if (historyEnd[i] !== currentStart[i]) {
					matches = false;
					break;
				}
			}

			if (matches) {
				return overlapSize;
			}
		}

		return 0;
	}

	/**
	 * Renders the scroll position indicator.
	 */
	private renderIndicator(_width: number): string {
		const total = this.contentHistory.length;
		const current = this.scrollOffset + 1;
		const end = Math.min(this.scrollOffset + this.viewportHeight, total);

		// Show percentage or line numbers based on total size
		if (total > 1000) {
			const percent = Math.round(
				(this.scrollOffset / (total - this.viewportHeight)) * 100,
			);
			return `[${percent}%]`;
		}

		return `[${current}-${end}/${total}]`;
	}

	/**
	 * Overlays the indicator on the right side of a line.
	 */
	private overlayIndicator(
		line: string,
		indicator: string,
		width: number,
	): string {
		// Simple approach: append indicator at end
		// A more sophisticated approach would use ANSI positioning
		const indicatorLen = indicator.length;
		const padding = Math.max(0, width - indicatorLen - 1);

		// Dim the indicator
		const dimIndicator = `\x1b[2m${indicator}\x1b[0m`;

		return `${line.slice(0, padding)} ${dimIndicator}`;
	}
}
