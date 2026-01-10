/**
 * @fileoverview Layout Components for TUI (Flexbox-like Layout System)
 *
 * This module provides a set of layout primitives inspired by CSS Flexbox,
 * enabling complex terminal UI layouts with automatic sizing and alignment.
 *
 * ## Available Components
 *
 * - **Column**: Vertical stacking (like flex-direction: column)
 * - **Row**: Horizontal layout with weight-based distribution
 * - **Box**: Container with padding, margin, and optional borders
 *
 * ## Layout Algorithm Overview
 *
 * ### Row Layout (Horizontal)
 *
 * 1. Calculate total available width minus gaps
 * 2. Distribute width proportionally by weight
 * 3. Apply min/max constraints
 * 4. Handle overflow by wrapping to new lines (if enabled)
 * 5. Align children vertically within the row
 *
 * ### Box Layout
 *
 * ```
 * ┌─────────────────────────────┐
 * │         margin              │
 * │  ┌─────────────────────┐   │
 * │  │      padding        │   │
 * │  │  ┌───────────────┐  │   │
 * │  │  │    content    │  │   │
 * │  │  └───────────────┘  │   │
 * │  │      padding        │   │
 * │  └─────────────────────┘   │
 * │         margin              │
 * └─────────────────────────────┘
 * ```
 */
import type { Component } from "../tui.js";
import { Container } from "../tui.js";
import { visibleWidth, wrapAnsiLines } from "../utils.js";

/**
 * Base options shared by all layout components.
 */
export interface BaseLayoutOptions {
	/** Spacing between child components (in lines/characters) */
	gap?: number;
}

/**
 * Vertical layout container that stacks children from top to bottom.
 *
 * This is the simplest layout: each child gets the full available width
 * and children are rendered in order with optional gaps between them.
 *
 * @example
 * ```typescript
 * const layout = new Column([
 *   new Text("Header"),
 *   new Text("Content"),
 *   new Text("Footer"),
 * ], { gap: 1 });
 * ```
 */
export class Column extends Container {
	/** Number of blank lines between children */
	private gap: number;

	constructor(children: Component[] = [], opts: BaseLayoutOptions = {}) {
		super();
		this.gap = Math.max(0, opts.gap ?? 0);
		for (const child of children) this.addChild(child);
	}

	/**
	 * Renders all children vertically with gaps.
	 *
	 * @param width - Available width for rendering
	 * @returns Array of rendered lines
	 */
	override render(width: number): string[] {
		const lines: string[] = [];
		const gapLine = " ".repeat(Math.max(0, width));

		this.children.forEach((child, idx) => {
			// Insert gap lines before each child except the first
			if (idx > 0 && this.gap > 0) {
				for (let i = 0; i < this.gap; i++) lines.push(gapLine);
			}
			lines.push(...child.render(width));
		});

		return lines;
	}
}

/**
 * Configuration options for Row layout.
 */
export interface RowOptions extends BaseLayoutOptions {
	/** Weight values for proportional width distribution */
	weights?: number[];
	/** Minimum widths for each child (in characters) */
	minWidths?: number[];
	/** Maximum widths for each child (in characters) */
	maxWidths?: number[];
	/** Vertical alignment of children within the row */
	align?: "start" | "center" | "end";
	/** Horizontal distribution strategy */
	justify?: "start" | "center" | "end" | "space-between";
	/** Whether to wrap to multiple lines if children don't fit */
	wrap?: boolean;
}

/**
 * Per-child layout options for fine-grained control.
 */
export interface LayoutItemOptions {
	/** Override row-level weight for this child */
	weight?: number;
	/** Override row-level minWidth for this child */
	minWidth?: number;
	/** Override row-level maxWidth for this child */
	maxWidth?: number;
	/** Override row-level align for this child */
	alignSelf?: "start" | "center" | "end";
}

/**
 * Horizontal layout container with flexbox-like features.
 *
 * Width distribution algorithm:
 * 1. Subtract total gap space from available width
 * 2. Distribute remaining width proportionally by weight
 * 3. Apply min/max constraints, redistributing overflow
 * 4. If wrap is enabled and content overflows, create new rows
 *
 * @example
 * ```typescript
 * // Two columns with 2:1 ratio
 * const layout = new Row([sidebar, content], {
 *   weights: [1, 2],
 *   gap: 2,
 *   align: 'start',
 * });
 *
 * // Three equal columns with wrapping
 * const grid = new Row([a, b, c, d, e, f], {
 *   wrap: true,
 *   minWidths: [20, 20, 20, 20, 20, 20],
 * });
 * ```
 */
export class Row extends Container {
	/** Horizontal spacing between children */
	private gap: number;

	/** Weight values for proportional sizing */
	private weights?: number[];

	/** Minimum width constraints */
	private minWidths?: number[];

	/** Maximum width constraints */
	private maxWidths?: number[];

	/** Vertical alignment within row */
	private align: "start" | "center" | "end";

	/** Horizontal content distribution */
	private justify: "start" | "center" | "end" | "space-between";

	/** Whether to wrap to multiple lines */
	private wrap: boolean;

	/** Per-child option overrides */
	private childOptions = new Map<Component, LayoutItemOptions>();

	constructor(children: Component[] = [], opts: RowOptions = {}) {
		super();
		this.gap = Math.max(0, opts.gap ?? 1);
		this.weights = opts.weights;
		this.minWidths = opts.minWidths;
		this.maxWidths = opts.maxWidths;
		this.align = opts.align ?? "start";
		this.justify = opts.justify ?? "start";
		this.wrap = opts.wrap ?? false;
		for (const child of children) this.addChild(child);
	}

	/**
	 * Sets per-child layout options, overriding row-level defaults.
	 */
	setChildOptions(child: Component, options: LayoutItemOptions): void {
		this.childOptions.set(child, options);
	}

	/**
	 * Renders the row layout, handling wrapping if enabled.
	 *
	 * The algorithm:
	 * 1. Group children into logical lines based on available width
	 * 2. Each line is rendered independently with proper sizing
	 * 3. Lines are concatenated vertically
	 *
	 * @param width - Available width for the row
	 * @returns Array of rendered lines
	 */
	override render(width: number): string[] {
		if (this.children.length === 0) return ["".padEnd(width, " ")];

		// Track which children go on which line
		type LineEntry = { child: Component; index: number };
		const lines: string[][] = [];
		let currentLine: LineEntry[] = [];
		let currentMinWidth = 0;

		// Commits the current line and starts a new one
		const commitLine = () => {
			if (currentLine.length === 0) return;
			lines.push(this.renderLine(currentLine, width));
			currentLine = [];
			currentMinWidth = 0;
		};

		// Distribute children across lines
		this.children.forEach((child, originalIndex) => {
			const minWidth = this.getMinWidth(child, originalIndex);
			const projected =
				currentLine.length === 0
					? minWidth
					: currentMinWidth + this.gap + minWidth;

			// Check if we need to wrap to a new line
			if (this.wrap && projected > width && currentLine.length > 0) {
				commitLine();
				currentLine.push({ child, index: originalIndex });
				currentMinWidth = minWidth;
			} else {
				currentLine.push({ child, index: originalIndex });
				if (currentLine.length === 1) currentMinWidth = minWidth;
				else currentMinWidth += this.gap + minWidth;
			}
		});
		commitLine();

		// Flatten all lines into a single array
		return lines.flat();
	}

	/**
	 * Resolves weight values, defaulting to 1 for all children
	 * if weights aren't specified or array length mismatches.
	 */
	private resolveWeights(): number[] {
		if (!this.weights || this.weights.length !== this.children.length) {
			return new Array(this.children.length).fill(1);
		}
		return this.weights.map((w) => (w > 0 ? w : 1));
	}

	/**
	 * Gets effective layout options for a child, merging
	 * per-child overrides with row-level defaults.
	 */
	private getChildOptions(child: Component, index: number): LayoutItemOptions {
		const opts = this.childOptions.get(child);
		return {
			weight: opts?.weight ?? this.weights?.[index],
			minWidth: opts?.minWidth ?? this.minWidths?.[index],
			maxWidth: opts?.maxWidth ?? this.maxWidths?.[index],
			alignSelf: opts?.alignSelf,
		};
	}

	/**
	 * Gets the minimum width for a child (at least 1 character).
	 */
	private getMinWidth(child: Component, index: number): number {
		const { minWidth } = this.getChildOptions(child, index);
		return Math.max(1, minWidth ?? 1);
	}

	/**
	 * Renders a single logical line of the row layout.
	 *
	 * This implements the core width distribution algorithm:
	 *
	 * 1. **Calculate available space**: total width minus gaps
	 * 2. **Proportional distribution**: divide by weight ratios
	 * 3. **Apply constraints**: clamp to min/max widths
	 * 4. **Handle remainder**: distribute leftover pixels evenly
	 * 5. **Render children**: each at its assigned width
	 * 6. **Vertical alignment**: pad shorter children
	 * 7. **Horizontal justification**: apply spacing strategy
	 *
	 * @param items - Children to render on this line
	 * @param width - Total available width
	 * @returns Array of rendered lines
	 */
	private renderLine(
		items: Array<{ child: Component; index: number }>,
		width: number,
	): string[] {
		const gapTotal = this.gap * Math.max(0, items.length - 1);
		const availableWidth = Math.max(1, width - gapTotal);

		const weights = items.map(({ child, index }) => {
			const opt = this.getChildOptions(child, index);
			return opt.weight ?? 1;
		});
		const minWidths = items.map(({ child, index }) => {
			const opt = this.getChildOptions(child, index);
			return Math.max(1, opt.minWidth ?? 1);
		});
		const maxWidths = items.map(({ child, index }) => {
			const opt = this.getChildOptions(child, index);
			return opt.maxWidth ?? Number.POSITIVE_INFINITY;
		});

		const totalWeight = weights.reduce((sum, value) => sum + value, 0);
		const assigned: number[] = [];
		let remaining = availableWidth;
		for (let i = 0; i < items.length; i++) {
			const raw = Math.floor((availableWidth * weights[i]) / totalWeight);
			const target = clampValue(raw, minWidths[i], maxWidths[i]);
			const colWidth = Math.max(
				1,
				Math.min(target, remaining - (items.length - i - 1)),
			);
			assigned.push(colWidth);
			remaining -= colWidth;
		}
		let leftover = remaining;
		for (let i = 0; leftover > 0 && i < assigned.length; i++, leftover--) {
			assigned[i] += 1;
		}

		const rendered = items.map(({ child }, idx) => {
			const childLines = child.render(assigned[idx]);
			return childLines.map((line) => padToWidth(line, assigned[idx]));
		});
		const maxHeight = Math.max(...rendered.map((lines) => lines.length));
		const padded = rendered.map((lines, idx) => {
			const filler = " ".repeat(assigned[idx]);
			const deficit = maxHeight - lines.length;
			if (deficit <= 0) return lines;
			const alignSelf = this.getChildOptions(
				items[idx].child,
				items[idx].index,
			).alignSelf;
			const verticalAlign = alignSelf ?? this.align;
			if (verticalAlign === "start") {
				for (let i = 0; i < deficit; i++) lines.push(filler);
			} else if (verticalAlign === "end") {
				for (let i = 0; i < deficit; i++) lines.unshift(filler);
			} else {
				const topPad = Math.floor(deficit / 2);
				const bottomPad = deficit - topPad;
				for (let i = 0; i < topPad; i++) lines.unshift(filler);
				for (let i = 0; i < bottomPad; i++) lines.push(filler);
			}
			return lines;
		});

		const combined: string[] = [];

		const baseGap = this.gap;
		const baseGapTotal = baseGap * Math.max(0, items.length - 1);
		const contentWidth = assigned.reduce((sum, v) => sum + v, 0);
		const extraSpace = Math.max(0, width - contentWidth - baseGapTotal);

		const gapSizes: number[] = [];
		if (this.justify === "space-between" && items.length > 1) {
			const extraPerGap = Math.floor(extraSpace / (items.length - 1));
			let remainder = extraSpace - extraPerGap * (items.length - 1);
			for (let i = 0; i < items.length - 1; i++) {
				const extra = remainder > 0 ? 1 : 0;
				gapSizes.push(baseGap + extraPerGap + extra);
				remainder -= extra;
			}
		} else {
			for (let i = 0; i < items.length - 1; i++) {
				gapSizes.push(baseGap);
			}
		}

		const totalContentWidth =
			contentWidth +
			(gapSizes.length > 0
				? gapSizes.reduce((sum, v) => sum + v, 0)
				: baseGapTotal);

		const remainingSpace = Math.max(0, width - totalContentWidth);
		const leftPad =
			this.justify === "center"
				? Math.floor(remainingSpace / 2)
				: this.justify === "end"
					? remainingSpace
					: 0;

		for (let row = 0; row < maxHeight; row++) {
			let line = " ".repeat(leftPad);
			for (let col = 0; col < padded.length; col++) {
				if (col > 0) {
					line += " ".repeat(gapSizes[col - 1] ?? baseGap);
				}
				line += padded[col][row];
			}
			combined.push(padToWidth(line, width));
		}
		return combined;
	}
}

/**
 * Configuration options for Box layout.
 */
export interface BoxOptions {
	/** Horizontal padding inside the border (left and right) */
	paddingX?: number;
	/** Vertical padding inside the border (top and bottom) */
	paddingY?: number;
	/** Horizontal margin outside the border (left and right) */
	marginX?: number;
	/** Vertical margin outside the border (top and bottom) */
	marginY?: number;
	/** Border style: none, single (+|-), double (║═), or rounded (╭╮╰╯) */
	border?: "none" | "single" | "double" | "rounded";
	/** Spacing between child components */
	gap?: number;
}

/**
 * Container component with padding, margin, and optional border.
 *
 * The Box provides a structured container for grouping content with
 * visual separation. It handles complex nesting of spacing layers:
 *
 * ```
 * ┌── full width ──────────────────────────┐
 * │                margin                   │
 * │  ┌─────────── innerWidth ──────────┐   │
 * │  │           border                │   │
 * │  │  ┌───── contentWidth ───────┐   │   │
 * │  │  │       padding            │   │   │
 * │  │  │  ┌─ paddedWidth ─────┐   │   │   │
 * │  │  │  │   children        │   │   │   │
 * │  │  │  └───────────────────┘   │   │   │
 * │  │  └──────────────────────────┘   │   │
 * │  └─────────────────────────────────┘   │
 * └────────────────────────────────────────┘
 * ```
 *
 * @example
 * ```typescript
 * const panel = new Box([content], {
 *   border: 'rounded',
 *   paddingX: 2,
 *   paddingY: 1,
 *   marginX: 1,
 * });
 * ```
 */
export class Box extends Container {
	private paddingX: number;
	private paddingY: number;
	private marginX: number;
	private marginY: number;
	private border: "none" | "single" | "double" | "rounded";
	private gap: number;

	constructor(children: Component[] = [], options: BoxOptions = {}) {
		super();
		this.paddingX = Math.max(0, options.paddingX ?? 1);
		this.paddingY = Math.max(0, options.paddingY ?? 0);
		this.marginX = Math.max(0, options.marginX ?? 0);
		this.marginY = Math.max(0, options.marginY ?? 0);
		this.border = options.border ?? "single";
		this.gap = Math.max(0, options.gap ?? 0);
		for (const child of children) this.addChild(child);
	}

	handleInput(data: string): void {
		for (const child of this.children) {
			if (child.handleInput) {
				child.handleInput(data);
			}
		}
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const marginLine = " ".repeat(Math.max(0, width));
		for (let i = 0; i < this.marginY; i++) lines.push(marginLine);

		const innerWidth = Math.max(1, width - this.marginX * 2);
		const hasBorder = this.border !== "none";
		const borderSize = hasBorder ? 2 : 0;
		const minContentWidth = hasBorder ? 2 : 1;
		const contentWidth = Math.max(minContentWidth, innerWidth - borderSize);
		const paddedWidth = Math.max(1, contentWidth - this.paddingX * 2);

		const renderChildren = (): string[] => {
			const gapLine = " ".repeat(paddedWidth);
			const childLines: string[] = [];
			this.children.forEach((child, idx) => {
				if (idx > 0 && this.gap > 0) {
					for (let g = 0; g < this.gap; g++) childLines.push(gapLine);
				}
				childLines.push(
					...wrapAnsiLines(child.render(paddedWidth), paddedWidth),
				);
			});
			return childLines;
		};

		const body = renderChildren();
		const leftPad = " ".repeat(this.paddingX);
		const rightPadLength = Math.max(
			0,
			contentWidth - this.paddingX - paddedWidth,
		);
		const rightPad = " ".repeat(rightPadLength);

		const bordered = this.border !== "none";
		const borderChars =
			this.border === "none" ? null : getBorderChars(this.border);
		const applyBorder = (line: string) => {
			if (!bordered || !borderChars) return line;
			return `${borderChars.vertical}${line}${borderChars.vertical}`;
		};

		const padLineWithMargin = (line: string) =>
			" ".repeat(this.marginX) +
			padToWidth(line, innerWidth) +
			" ".repeat(this.marginX);

		const topBorder =
			bordered && borderChars
				? `${borderChars.topLeft}${borderChars.horizontal.repeat(Math.max(0, innerWidth - 2))}${borderChars.topRight}`
				: "";
		const bottomBorder =
			bordered && borderChars
				? `${borderChars.bottomLeft}${borderChars.horizontal.repeat(Math.max(0, innerWidth - 2))}${borderChars.bottomRight}`
				: "";

		if (bordered) {
			lines.push(padLineWithMargin(topBorder));
		}

		for (let i = 0; i < this.paddingY; i++) {
			const padded = applyBorder(leftPad + " ".repeat(paddedWidth) + rightPad);
			lines.push(padLineWithMargin(padded));
		}

		for (const childLine of body) {
			const inner = leftPad + padToWidth(childLine, paddedWidth) + rightPad;
			lines.push(padLineWithMargin(applyBorder(inner)));
		}

		for (let i = 0; i < this.paddingY; i++) {
			const padded = applyBorder(leftPad + " ".repeat(paddedWidth) + rightPad);
			lines.push(padLineWithMargin(padded));
		}

		if (bordered) {
			lines.push(padLineWithMargin(bottomBorder));
		}

		for (let i = 0; i < this.marginY; i++) lines.push(marginLine);

		return lines;
	}
}

/**
 * Pads or truncates a line to exactly the target width.
 *
 * Uses visibleWidth to correctly handle ANSI escape sequences,
 * which don't contribute to visual width.
 *
 * @param line - Input line (may contain ANSI codes)
 * @param targetWidth - Desired visual width
 * @returns Line padded with spaces or truncated
 */
function padToWidth(line: string, targetWidth: number): string {
	const current = visibleWidth(line);
	if (current === targetWidth) return line;
	if (current > targetWidth) {
		return wrapAnsiLines([line], targetWidth)[0] ?? "";
	}
	return line + " ".repeat(targetWidth - current);
}

/**
 * Returns box-drawing characters for the specified border style.
 *
 * Available styles:
 * - **single**: ASCII characters (+, -, |)
 * - **double**: Unicode double lines (╔═╗║╚╝)
 * - **rounded**: Unicode rounded corners (╭─╮│╰╯)
 *
 * @param style - Border style name
 * @returns Object with all corner and edge characters
 */
function getBorderChars(style: "single" | "double" | "rounded"): {
	horizontal: string;
	vertical: string;
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
} {
	if (style === "double") {
		return {
			horizontal: "═",
			vertical: "║",
			topLeft: "╔",
			topRight: "╗",
			bottomLeft: "╚",
			bottomRight: "╝",
		};
	}
	if (style === "rounded") {
		return {
			horizontal: "─",
			vertical: "│",
			topLeft: "╭",
			topRight: "╮",
			bottomLeft: "╰",
			bottomRight: "╯",
		};
	}
	// Default: ASCII single border
	return {
		horizontal: "-",
		vertical: "|",
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
	};
}

/**
 * Clamps a value between minimum and maximum bounds.
 *
 * @param value - Value to clamp
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Clamped value
 */
function clampValue(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
