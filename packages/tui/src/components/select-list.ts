/**
 * @fileoverview Interactive Selection List Component
 *
 * This module provides a scrollable, filterable selection list for TUI.
 * It's commonly used for autocomplete dropdowns, command palettes, and
 * menu selections.
 *
 * ## Features
 *
 * - **Keyboard Navigation**: Up/Down arrows, Enter to select, Escape to cancel
 * - **Filtering**: Case-insensitive substring matching
 * - **Scrolling**: Viewport scrolling with centered selection
 * - **Descriptions**: Optional secondary text for each item
 *
 * ## Visual Representation
 *
 * ```
 * ● Selected Item        Description here
 * ○ Unselected Item      Another description
 * ○ Another Item         More info
 *   (2/10)               <- Scroll indicator
 * ```
 */
import chalk from "chalk";
import type { Component } from "../tui.js";
import { wrapAnsiLines } from "../utils.js";

/**
 * Represents a single selectable item in the list.
 */
export interface SelectItem {
	/** Value returned when item is selected */
	value: string;
	/** Display text (falls back to value if not provided) */
	label: string;
	/** Optional secondary text shown next to the label */
	description?: string;
}

/**
 * Theming functions for customizing list appearance.
 */
export interface SelectListTheme {
	/** Styles the selection indicator (● or ○) */
	selectedPrefix: (text: string) => string;
	/** Styles the selected item's text */
	selectedText: (text: string) => string;
	/** Styles description text */
	description: (text: string) => string;
	/** Styles the scroll position indicator */
	scrollInfo: (text: string) => string;
	/** Styles the "no matches" message */
	noMatch: (text: string) => string;
}

/**
 * Interactive scrollable selection list component.
 *
 * This component manages:
 * - A list of selectable items
 * - Filter-based searching
 * - Keyboard-driven selection
 * - Viewport scrolling for long lists
 *
 * ## State Machine
 *
 * The list can be in one of these states:
 * - **Empty**: No items match the filter (shows "No matching" message)
 * - **Selecting**: User is navigating items
 * - **Selected**: User pressed Enter (triggers onSelect callback)
 * - **Cancelled**: User pressed Escape (triggers onCancel callback)
 *
 * @example
 * ```typescript
 * const list = new SelectList([
 *   { value: 'foo', label: 'Foo', description: 'The foo command' },
 *   { value: 'bar', label: 'Bar', description: 'The bar command' },
 * ], 5);
 *
 * list.onSelect = (item) => console.log('Selected:', item.value);
 * list.onCancel = () => console.log('Cancelled');
 *
 * list.setFilter('fo'); // Filters to show only "Foo"
 * ```
 */
export class SelectList implements Component {
	/** Original unfiltered items */
	private items: SelectItem[];

	/** Items after filter is applied */
	private filteredItems: SelectItem[];

	/** Current selection index in filteredItems */
	private selectedIndex = 0;

	/** Current filter string */
	private filter = "";

	/** Maximum number of visible items before scrolling */
	private maxVisible: number;

	/** Callback when user selects an item (Enter key) */
	onSelect?: (item: SelectItem) => void;

	/** Callback when user cancels selection (Escape key) */
	onCancel?: () => void;

	/** Callback when selection changes (arrow keys) */
	onSelectionChange?: (item: SelectItem) => void;

	/**
	 * Creates a new selection list.
	 *
	 * @param items - Available items to select from
	 * @param maxVisible - Maximum items shown before scrolling (default: 5)
	 */
	constructor(items: SelectItem[], maxVisible = 5) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
	}
	/**
	 * Applies a filter to the item list.
	 *
	 * Filtering is case-insensitive and matches substrings within the value.
	 * Selection is reset to the first item when the filter changes.
	 *
	 * @param filter - Filter string (empty string shows all items)
	 */
	setFilter(filter: string): void {
		this.filter = filter;
		if (!filter) {
			this.filteredItems = this.items;
		} else {
			const lower = filter.toLowerCase();
			this.filteredItems = this.items.filter((item) =>
				item.value.toLowerCase().includes(lower),
			);
		}
		// Reset selection when filter changes to avoid stale selection
		this.selectedIndex = 0;
	}

	/**
	 * Programmatically sets the selection index.
	 * The index is clamped to valid bounds.
	 */
	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(
			0,
			Math.min(index, this.filteredItems.length - 1),
		);
	}

	/**
	 * Renders the selection list to terminal lines.
	 *
	 * The viewport scrolling algorithm:
	 * 1. Try to center the selected item in the viewport
	 * 2. Don't scroll past the beginning or end of the list
	 * 3. Show scroll indicators when content extends beyond viewport
	 *
	 * @param width - Available width for rendering
	 * @returns Array of rendered lines
	 */
	render(width: number): string[] {
		const lines = [];

		// Handle empty state
		if (this.filteredItems.length === 0) {
			lines.push(chalk.gray("  No matching commands"));
			return lines;
		}

		// Calculate visible range with centered scrolling
		// The selected item should be in the middle of the viewport when possible
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				this.filteredItems.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + this.maxVisible,
			this.filteredItems.length,
		);

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			let line = "";
			if (isSelected) {
				// Use radio button indicator for selection
				const prefix = chalk.cyan("● ");
				const prefixWidth = 2; // "● " is 2 characters visually
				const displayValue = item.label || item.value;
				if (item.description && width > 40) {
					// Calculate how much space we have for value + description
					const maxValueLength = Math.min(displayValue.length, 30);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));
					// Calculate remaining space for description using visible widths
					const descriptionStart =
						prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 for safety
					if (remainingWidth > 10) {
						const truncatedDesc = item.description.substring(0, remainingWidth);
						line =
							prefix +
							chalk.cyan(truncatedValue) +
							chalk.gray(spacing + truncatedDesc);
					} else {
						// Not enough space for description
						const maxWidth = width - prefixWidth - 2;
						line = prefix + chalk.cyan(displayValue.substring(0, maxWidth));
					}
				} else {
					// No description or not enough width
					const maxWidth = width - prefixWidth - 2;
					line = prefix + chalk.cyan(displayValue.substring(0, maxWidth));
				}
			} else {
				const displayValue = item.label || item.value;
				const prefix = chalk.gray("○ ");
				const prefixWidth = 2; // "○ " is 2 characters visually
				if (item.description && width > 40) {
					// Calculate how much space we have for value + description
					const maxValueLength = Math.min(displayValue.length, 30);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));
					// Calculate remaining space for description
					const descriptionStart =
						prefixWidth + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 for safety
					if (remainingWidth > 10) {
						const truncatedDesc = item.description.substring(0, remainingWidth);
						line =
							prefix + truncatedValue + chalk.gray(spacing + truncatedDesc);
					} else {
						// Not enough space for description
						const maxWidth = width - prefixWidth - 2;
						line = prefix + displayValue.substring(0, maxWidth);
					}
				} else {
					// No description or not enough width
					const maxWidth = width - prefixWidth - 2;
					line = prefix + displayValue.substring(0, maxWidth);
				}
			}
			lines.push(line);
		}
		// Add scroll indicators if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			// Truncate if too long for terminal
			const maxWidth = width - 2;
			const truncated = scrollText.substring(0, maxWidth);
			const scrollInfo = chalk.gray(truncated);
			lines.push(scrollInfo);
		}
		return wrapAnsiLines(lines, width);
	}
	/**
	 * Handles keyboard input for navigation and selection.
	 *
	 * Recognized keys:
	 * - **Up Arrow** (\x1b[A): Move selection up
	 * - **Down Arrow** (\x1b[B): Move selection down
	 * - **Enter** (\r): Confirm selection
	 * - **Escape** (\x1b) or **Ctrl+C** (\x03): Cancel
	 *
	 * @param keyData - Raw key data from terminal
	 */
	handleInput(keyData: string): void {
		// Up arrow - move selection up
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.notifySelectionChange();
		}
		// Down arrow - move selection down
		else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(
				this.filteredItems.length - 1,
				this.selectedIndex + 1,
			);
			this.notifySelectionChange();
		}
		// Enter - confirm selection
		else if (keyData === "\r") {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C - cancel
		else if (keyData === "\x1b" || keyData === "\x03") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/**
	 * Notifies listeners when selection changes via arrow keys.
	 */
	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	/**
	 * Returns the currently selected item.
	 *
	 * @returns Selected item, or null if no items match the filter
	 */
	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
