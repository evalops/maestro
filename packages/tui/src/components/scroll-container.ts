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
 * ```
 * ┌─────────────────────────────────────┐
 * │  Full content (N lines)             │
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

	/** Cached content lines from last render (for scroll calculations) */
	private lastContentLines: string[] = [];

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
		return Math.max(0, this.lastContentLines.length - this.viewportHeight);
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
	 * 1. Render full content from child component
	 * 2. Apply sticky scroll if enabled and user hasn't scrolled up
	 * 3. Extract visible lines based on scroll offset
	 * 4. Optionally append scroll indicator
	 */
	render(width: number): string[] {
		// Render full content
		const allLines = this.content.render(width);
		this.lastContentLines = allLines;

		const totalLines = allLines.length;
		const maxOffset = Math.max(0, totalLines - this.viewportHeight);

		// Apply sticky scroll: auto-follow bottom unless user scrolled up
		if (this.stickyScroll && !this.userScrolledUp) {
			this.scrollOffset = maxOffset;
		}

		// Clamp offset to valid range
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));

		// Extract visible lines
		const visibleLines = allLines.slice(
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
	 * Renders the scroll position indicator.
	 */
	private renderIndicator(width: number): string {
		const total = this.lastContentLines.length;
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
