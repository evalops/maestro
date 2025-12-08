/**
 * @fileoverview Single-line Text Input Component
 *
 * This module provides a terminal-based single-line text input with
 * horizontal scrolling support. Unlike the multi-line {@link Editor},
 * this component is optimized for short inputs like search queries,
 * file paths, and command arguments.
 *
 * ## Features
 *
 * - **Horizontal Scrolling**: Long text scrolls horizontally
 * - **Cursor Navigation**: Arrow keys, Home/End, Ctrl+A/E
 * - **Standard Editing**: Backspace, Delete, character insertion
 * - **Submit Handling**: Enter key triggers submission
 *
 * ## Visual Representation
 *
 * ```
 * > some long text that scr▌lls horizontally
 *   ^                      ^
 *   prompt                 cursor (inverse video)
 * ```
 *
 * @module components/input
 */

import type { Component } from "../tui.js";
import { visibleWidth } from "../utils.js";

/**
 * Single-line text input component with horizontal scrolling.
 *
 * This component is designed for simple text entry where multi-line
 * support is not needed. It automatically scrolls the viewport when
 * the cursor moves beyond the visible area.
 *
 * ## Keyboard Shortcuts
 *
 * | Key | Action |
 * |-----|--------|
 * | Enter | Submit value |
 * | Backspace | Delete character before cursor |
 * | Delete | Delete character at cursor |
 * | Left/Right | Move cursor |
 * | Ctrl+A | Move to beginning of line |
 * | Ctrl+E | Move to end of line |
 *
 * @example
 * ```typescript
 * const input = new Input();
 * input.onSubmit = (value) => {
 *   console.log('User entered:', value);
 * };
 *
 * // Set initial value
 * input.setValue('/path/to/file');
 *
 * // Get current value
 * const current = input.getValue();
 * ```
 */
export class Input implements Component {
	/** Current input value */
	private value = "";

	/** Cursor position within the value */
	private cursor = 0;

	/**
	 * Callback fired when user presses Enter.
	 * @param value - The current input value
	 */
	onSubmit?: (value: string) => void;

	/**
	 * Gets the current input value.
	 * @returns The current text in the input
	 */
	getValue(): string {
		return this.value;
	}

	/**
	 * Sets the input value programmatically.
	 * The cursor is adjusted to stay within bounds.
	 * @param value - New value to set
	 */
	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	/**
	 * Handles keyboard input for navigation and editing.
	 *
	 * Recognized keys:
	 * - **Enter/Return**: Submit value
	 * - **Backspace**: Delete character before cursor
	 * - **Delete**: Delete character at cursor
	 * - **Left Arrow**: Move cursor left
	 * - **Right Arrow**: Move cursor right
	 * - **Ctrl+A**: Move to beginning
	 * - **Ctrl+E**: Move to end
	 * - **Printable ASCII**: Insert at cursor
	 *
	 * @param data - Raw key data from terminal
	 */
	handleInput(data: string): void {
		// Handle special keys
		if (data === "\r" || data === "\n") {
			// Enter - submit
			if (this.onSubmit) {
				this.onSubmit(this.value);
			}
			return;
		}
		if (data === "\x7f" || data === "\x08") {
			// Backspace
			if (this.cursor > 0) {
				this.value =
					this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
				this.cursor--;
			}
			return;
		}
		if (data === "\x1b[D") {
			// Left arrow
			if (this.cursor > 0) {
				this.cursor--;
			}
			return;
		}
		if (data === "\x1b[C") {
			// Right arrow
			if (this.cursor < this.value.length) {
				this.cursor++;
			}
			return;
		}
		if (data === "\x1b[3~") {
			// Delete
			if (this.cursor < this.value.length) {
				this.value =
					this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
			}
			return;
		}
		if (data === "\x01") {
			// Ctrl+A - beginning of line
			this.cursor = 0;
			return;
		}
		if (data === "\x05") {
			// Ctrl+E - end of line
			this.cursor = this.value.length;
			return;
		}
		// Regular character input
		if (data.length === 1 && data >= " " && data <= "~") {
			this.value =
				this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
			this.cursor++;
		}
	}

	/**
	 * Renders the input to terminal lines.
	 *
	 * The viewport scrolling algorithm keeps the cursor visible by:
	 * 1. Showing everything if it fits
	 * 2. Centering the cursor when text is longer than viewport
	 * 3. Anchoring to start/end when cursor is near boundaries
	 *
	 * The cursor is rendered using inverse video (ANSI SGR 7).
	 *
	 * @param width - Available width for rendering
	 * @returns Array containing a single rendered line
	 */
	render(width: number): string[] {
		// Calculate visible window
		const prompt = "> ";
		const availableWidth = width - prompt.length;
		if (availableWidth <= 0) {
			return [prompt];
		}
		let visibleText = "";
		let cursorDisplay = this.cursor;
		if (this.value.length < availableWidth) {
			// Everything fits (leave room for cursor at end)
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one character for cursor if it's at the end
			const scrollWidth =
				this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const halfWidth = Math.floor(scrollWidth / 2);
			if (this.cursor < halfWidth) {
				// Cursor near start
				visibleText = this.value.slice(0, scrollWidth);
				cursorDisplay = this.cursor;
			} else if (this.cursor > this.value.length - halfWidth) {
				// Cursor near end
				visibleText = this.value.slice(this.value.length - scrollWidth);
				cursorDisplay = scrollWidth - (this.value.length - this.cursor);
			} else {
				// Cursor in middle
				const start = this.cursor - halfWidth;
				visibleText = this.value.slice(start, start + scrollWidth);
				cursorDisplay = halfWidth;
			}
		}
		// Build line with fake cursor
		// Insert cursor character at cursor position
		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = visibleText[cursorDisplay] || " "; // Character at cursor, or space if at end
		const afterCursor = visibleText.slice(cursorDisplay + 1);
		// Use inverse video to show cursor
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = reverse video, ESC[27m = normal
		const textWithCursor = beforeCursor + cursorChar + afterCursor;
		// Calculate visual width
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;
		return [line];
	}
}
