import chalk from "chalk";
import type { Component } from "../tui.js";
import { wrapAnsiLines } from "../utils.js";

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export class SelectList implements Component {
	private items: SelectItem[];
	private filteredItems: SelectItem[];
	private selectedIndex = 0;
	private filter = "";
	private maxVisible: number;

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(items: SelectItem[], maxVisible = 5) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
	}
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
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}
	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(
			0,
			Math.min(index, this.filteredItems.length - 1),
		);
	}
	render(width: number): string[] {
		const lines = [];
		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(chalk.gray("  No matching commands"));
			return lines;
		}
		// Calculate visible range with scrolling
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
	handleInput(keyData: string): void {
		// Up arrow
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.notifySelectionChange();
		}
		// Down arrow
		else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(
				this.filteredItems.length - 1,
				this.selectedIndex + 1,
			);
			this.notifySelectionChange();
		}
		// Enter
		else if (keyData === "\r") {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (keyData === "\x1b" || keyData === "\x03") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}
	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
