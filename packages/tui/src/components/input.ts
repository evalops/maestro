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

import {
	AnsiKeys,
	isAltBackspace,
	isAltLeft,
	isAltRight,
	isArrowLeft,
	isArrowRight,
	isBackspace,
	isCtrlA,
	isCtrlE,
	isCtrlK,
	isCtrlLeft,
	isCtrlRight,
	isCtrlU,
	isCtrlW,
	isDelete,
	isEnter,
} from "../keymap.js";
import type { Component } from "../tui.js";
import {
	getSegmenter,
	isPunctuationChar,
	isWhitespaceChar,
	visibleWidth,
} from "../utils.js";

const segmenter = getSegmenter();

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

	// Bracketed paste mode buffering
	private pasteBuffer = "";
	private isInPaste = false;

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
		let input = data;
		if (!this.isInPaste) {
			const pasteStartIndex = input.indexOf(AnsiKeys.PASTE_START);
			if (pasteStartIndex !== -1) {
				const beforePaste = input.slice(0, pasteStartIndex);
				const afterPaste = input.slice(
					pasteStartIndex + AnsiKeys.PASTE_START.length,
				);

				if (beforePaste) {
					this.handleInput(beforePaste);
				}

				this.isInPaste = true;
				this.pasteBuffer = "";
				input = afterPaste;
			}
		}

		if (this.isInPaste) {
			this.pasteBuffer += input;
			const endIndex = this.pasteBuffer.indexOf(AnsiKeys.PASTE_END);
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				this.handlePaste(pasteContent);
				this.isInPaste = false;

				const remaining = this.pasteBuffer.substring(
					endIndex + AnsiKeys.PASTE_END.length,
				);
				this.pasteBuffer = "";
				if (remaining) {
					this.handleInput(remaining);
				}
			}
			return;
		}

		// Handle special keys
		if (isEnter(input) || input === "\n") {
			// Enter - submit
			if (this.onSubmit) {
				this.onSubmit(this.value);
			}
			return;
		}

		if (isBackspace(input)) {
			// Backspace - delete grapheme before cursor
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
				this.value =
					this.value.slice(0, this.cursor - graphemeLength) +
					this.value.slice(this.cursor);
				this.cursor -= graphemeLength;
			}
			return;
		}

		if (isArrowLeft(input)) {
			// Left arrow - move by one grapheme
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (isArrowRight(input)) {
			// Right arrow - move by one grapheme
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (isDelete(input)) {
			// Delete - delete grapheme at cursor
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
				this.value =
					this.value.slice(0, this.cursor) +
					this.value.slice(this.cursor + graphemeLength);
			}
			return;
		}

		if (isCtrlA(input)) {
			// Ctrl+A - beginning of line
			this.cursor = 0;
			return;
		}

		if (isCtrlE(input)) {
			// Ctrl+E - end of line
			this.cursor = this.value.length;
			return;
		}

		if (isCtrlW(input)) {
			// Ctrl+W - delete word backwards
			this.deleteWordBackwards();
			return;
		}

		if (isAltBackspace(input)) {
			// Option/Alt+Backspace - delete word backwards
			this.deleteWordBackwards();
			return;
		}

		if (isCtrlU(input)) {
			// Ctrl+U - delete from cursor to start of line
			this.value = this.value.slice(this.cursor);
			this.cursor = 0;
			return;
		}

		if (isCtrlK(input)) {
			// Ctrl+K - delete from cursor to end of line
			this.value = this.value.slice(0, this.cursor);
			return;
		}

		if (isCtrlLeft(input) || isAltLeft(input)) {
			this.moveWordBackwards();
			return;
		}

		if (isCtrlRight(input) || isAltRight(input)) {
			this.moveWordForwards();
			return;
		}

		// Regular character input
		const hasControlChars = [...input].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) {
			this.value =
				this.value.slice(0, this.cursor) +
				input +
				this.value.slice(this.cursor);
			this.cursor += input.length;
		}
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) {
			return;
		}

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		this.value =
			this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) {
			return;
		}

		const textBeforeCursor = this.value.slice(0, this.cursor);
		const graphemes = [...segmenter.segment(textBeforeCursor)];

		while (
			graphemes.length > 0 &&
			isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")
		) {
			this.cursor -= graphemes.pop()?.segment.length || 0;
		}

		if (graphemes.length > 0) {
			const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
			if (isPunctuationChar(lastGrapheme)) {
				while (
					graphemes.length > 0 &&
					isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")
				) {
					this.cursor -= graphemes.pop()?.segment.length || 0;
				}
			} else {
				while (
					graphemes.length > 0 &&
					!isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") &&
					!isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "")
				) {
					this.cursor -= graphemes.pop()?.segment.length || 0;
				}
			}
		}
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) {
			return;
		}

		const textAfterCursor = this.value.slice(this.cursor);
		const segments = segmenter.segment(textAfterCursor);
		const iterator = segments[Symbol.iterator]();
		let next = iterator.next();

		while (!next.done && isWhitespaceChar(next.value.segment)) {
			this.cursor += next.value.segment.length;
			next = iterator.next();
		}

		if (!next.done) {
			const firstGrapheme = next.value.segment;
			if (isPunctuationChar(firstGrapheme)) {
				while (!next.done && isPunctuationChar(next.value.segment)) {
					this.cursor += next.value.segment.length;
					next = iterator.next();
				}
			} else {
				while (
					!next.done &&
					!isWhitespaceChar(next.value.segment) &&
					!isPunctuationChar(next.value.segment)
				) {
					this.cursor += next.value.segment.length;
					next = iterator.next();
				}
			}
		}
	}

	private handlePaste(pastedText: string): void {
		const cleanText = pastedText
			.replace(/\r\n/g, "")
			.replace(/\r/g, "")
			.replace(/\n/g, "");
		if (!cleanText) return;

		const prevChar = this.cursor > 0 ? this.value[this.cursor - 1] : "";
		const needsSpace =
			prevChar &&
			/\w/.test(prevChar) &&
			(cleanText.startsWith("/") ||
				cleanText.startsWith("~") ||
				cleanText.startsWith("."));
		const insertText = needsSpace ? ` ${cleanText}` : cleanText;

		this.value =
			this.value.slice(0, this.cursor) +
			insertText +
			this.value.slice(this.cursor);
		this.cursor += insertText.length;
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
