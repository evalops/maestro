import type { Component } from "../tui.js";
import { Container } from "../tui.js";
import { visibleWidth, wrapAnsiLines } from "../utils.js";

/**
 * Shared options for layout primitives.
 */
export interface BaseLayoutOptions {
	gap?: number;
}

/**
 * Stacks children vertically with optional gaps.
 */
export class Column extends Container {
	private gap: number;

	constructor(children: Component[] = [], opts: BaseLayoutOptions = {}) {
		super();
		this.gap = Math.max(0, opts.gap ?? 0);
		for (const child of children) this.addChild(child);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const gapLine = " ".repeat(Math.max(0, width));
		this.children.forEach((child, idx) => {
			if (idx > 0 && this.gap > 0) {
				for (let i = 0; i < this.gap; i++) lines.push(gapLine);
			}
			lines.push(...child.render(width));
		});
		return lines;
	}
}

/**
 * Options for the Row layout.
 */
export interface RowOptions extends BaseLayoutOptions {
	weights?: number[];
	minWidths?: number[];
	maxWidths?: number[];
	align?: "start" | "center" | "end";
	justify?: "start" | "center" | "end" | "space-between";
	wrap?: boolean;
}

export interface LayoutItemOptions {
	weight?: number;
	minWidth?: number;
	maxWidth?: number;
	alignSelf?: "start" | "center" | "end";
}

/**
 * Places children horizontally, distributing width by weights.
 */
export class Row extends Container {
	private gap: number;
	private weights?: number[];
	private minWidths?: number[];
	private maxWidths?: number[];
	private align: "start" | "center" | "end";
	private justify: "start" | "center" | "end" | "space-between";
	private wrap: boolean;
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

	setChildOptions(child: Component, options: LayoutItemOptions): void {
		this.childOptions.set(child, options);
	}

	render(width: number): string[] {
		if (this.children.length === 0) return ["".padEnd(width, " ")];

		const lines: string[][] = [];
		let currentLine: Component[] = [];
		let currentMinWidth = 0;

		const commitLine = () => {
			if (currentLine.length === 0) return;
			lines.push(this.renderLine(currentLine, width));
			currentLine = [];
			currentMinWidth = 0;
		};

		for (const child of this.children) {
			const minWidth = this.getMinWidth(child, currentLine.length);
			const projected =
				currentLine.length === 0
					? minWidth
					: currentMinWidth + this.gap + minWidth;

			if (this.wrap && projected > width && currentLine.length > 0) {
				commitLine();
				currentLine.push(child);
				currentMinWidth = minWidth;
			} else {
				currentLine.push(child);
				if (currentLine.length === 1) currentMinWidth = minWidth;
				else currentMinWidth += this.gap + minWidth;
			}
		}
		commitLine();

		return lines.flat();
	}

	private resolveWeights(): number[] {
		if (!this.weights || this.weights.length !== this.children.length) {
			return new Array(this.children.length).fill(1);
		}
		return this.weights.map((w) => (w > 0 ? w : 1));
	}

	private getChildOptions(child: Component, index: number): LayoutItemOptions {
		const opts = this.childOptions.get(child);
		return {
			weight: opts?.weight ?? this.weights?.[index],
			minWidth: opts?.minWidth ?? this.minWidths?.[index],
			maxWidth: opts?.maxWidth ?? this.maxWidths?.[index],
			alignSelf: opts?.alignSelf,
		};
	}

	private getMinWidth(child: Component, index: number): number {
		const { minWidth } = this.getChildOptions(child, index);
		return Math.max(1, minWidth ?? 1);
	}

	private renderLine(children: Component[], width: number): string[] {
		const gapTotal = this.gap * Math.max(0, children.length - 1);
		const availableWidth = Math.max(1, width - gapTotal);

		const weights = children.map((child, idx) => {
			const opt = this.getChildOptions(child, idx);
			return opt.weight ?? 1;
		});
		const minWidths = children.map((child, idx) => {
			const opt = this.getChildOptions(child, idx);
			return Math.max(1, opt.minWidth ?? 1);
		});
		const maxWidths = children.map((child, idx) => {
			const opt = this.getChildOptions(child, idx);
			return opt.maxWidth ?? Number.POSITIVE_INFINITY;
		});

		const totalWeight = weights.reduce((sum, value) => sum + value, 0);
		const assigned: number[] = [];
		let remaining = availableWidth;
		for (let i = 0; i < children.length; i++) {
			const raw = Math.floor((availableWidth * weights[i]) / totalWeight);
			const target = clampValue(raw, minWidths[i], maxWidths[i]);
			const colWidth = Math.max(
				1,
				Math.min(target, remaining - (children.length - i - 1)),
			);
			assigned.push(colWidth);
			remaining -= colWidth;
		}
		let leftover = remaining;
		for (let i = 0; leftover > 0 && i < assigned.length; i++, leftover--) {
			assigned[i] += 1;
		}

		const rendered = children.map((child, idx) => {
			const childLines = child.render(assigned[idx]);
			return childLines.map((line) => padToWidth(line, assigned[idx]));
		});
		const maxHeight = Math.max(...rendered.map((lines) => lines.length));
		const padded = rendered.map((lines, idx) => {
			const filler = " ".repeat(assigned[idx]);
			const deficit = maxHeight - lines.length;
			if (deficit <= 0) return lines;
			const alignSelf = this.getChildOptions(children[idx], idx).alignSelf;
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
		const baseGapTotal = baseGap * Math.max(0, children.length - 1);
		const contentWidth = assigned.reduce((sum, v) => sum + v, 0);
		const extraSpace = Math.max(0, width - contentWidth - baseGapTotal);

		const gapSizes: number[] = [];
		if (this.justify === "space-between" && children.length > 1) {
			const extraPerGap = Math.floor(extraSpace / (children.length - 1));
			let remainder = extraSpace - extraPerGap * (children.length - 1);
			for (let i = 0; i < children.length - 1; i++) {
				const extra = remainder > 0 ? 1 : 0;
				gapSizes.push(baseGap + extraPerGap + extra);
				remainder -= extra;
			}
		} else {
			for (let i = 0; i < children.length - 1; i++) {
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
 * Options for the Box layout.
 */
export interface BoxOptions {
	paddingX?: number;
	paddingY?: number;
	marginX?: number;
	marginY?: number;
	border?: "none" | "single" | "double" | "rounded";
	gap?: number;
}

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

	render(width: number): string[] {
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
			contentWidth - this.paddingX - paddedWidth - this.paddingX,
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

function padToWidth(line: string, targetWidth: number): string {
	const current = visibleWidth(line);
	if (current === targetWidth) return line;
	if (current > targetWidth) {
		return wrapAnsiLines([line], targetWidth)[0] ?? "";
	}
	return line + " ".repeat(targetWidth - current);
}

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
	return {
		horizontal: "-",
		vertical: "|",
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
	};
}

function clampValue(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
