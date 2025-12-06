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

	/** Maximum history lines to prevent unbounded memory growth */
	private maxHistoryLines: number;

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
		this.maxHistoryLines = 10000;
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

		// Pad with empty lines if content is shorter than viewport
		const emptyLine = " ".repeat(width);
		while (visibleLines.length < this.viewportHeight) {
			visibleLines.push(emptyLine);
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
		// Use length + first/last line content as a quick hash
		if (lines.length === 0) return "empty";
		const first = lines[0]?.slice(0, 50) ?? "";
		const last = lines[lines.length - 1]?.slice(0, 50) ?? "";
		return `${lines.length}:${first}:${last}`;
	}

	/**
	 * Updates the content history with new lines.
	 * Appends new content while preserving old history.
	 */
	private updateHistory(currentLines: string[]): void {
		// Strategy: Replace history with current content, but this loses old content
		// Better strategy: Append only NEW lines at the end

		// For now, simple approach: if current content is longer than what we had
		// at the end of history, append the new lines
		// If current content is completely different (e.g., after clear),
		// we keep the old history and append new content after a separator

		if (this.contentHistory.length === 0) {
			// First render - just use current content
			this.contentHistory = [...currentLines];
		} else {
			// Check if current content looks like a continuation or a reset
			// If the child was cleared, currentLines will be short/empty
			// In that case, we keep history and might add a separator

			if (currentLines.length === 0) {
				// Child was cleared, keep history as-is
				return;
			}

			// Check if current content overlaps with end of history
			const overlap = this.findOverlap(this.contentHistory, currentLines);

			if (overlap > 0) {
				// Content overlaps - append only the new part
				const newLines = currentLines.slice(overlap);
				this.contentHistory.push(...newLines);
			} else if (currentLines.length > 0) {
				// No overlap - this is new content, append it
				// (This happens after chatContainer.clear())
				this.contentHistory.push(...currentLines);
			}
		}

		// Trim history if too long
		if (this.contentHistory.length > this.maxHistoryLines) {
			const removeCount = this.contentHistory.length - this.maxHistoryLines;
			this.contentHistory.splice(0, removeCount);
			// Adjust scroll offset if we removed lines above it
			this.scrollOffset = Math.max(0, this.scrollOffset - removeCount);
		}
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
