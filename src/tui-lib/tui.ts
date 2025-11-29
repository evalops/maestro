/**
 * Minimal TUI implementation with differential rendering
 */
import type { Terminal } from "./terminal.js";
import { visibleWidth } from "./utils.js";

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
}

export { visibleWidth };

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

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			lines.push(...child.render(width));
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
export class TUI extends Container {
	private focusedComponent: Component | null = null;
	private renderRequested = false;
	private renderTimer: NodeJS.Timeout | null = null;
	private lastRenderAt = 0;
	private readonly renderMinInterval = 1000 / 60;

	constructor(private terminal: Terminal) {
		super();
	}

	setFocus(component: Component | null): void {
		this.focusedComponent = component;
	}

	start(): void {
		this.terminal.start(
			(data: string) => this.handleInput(data),
			() => this.requestRender(),
		);
		this.terminal.write("\x1b[?1049h\x1b[H\x1b[2J");
		this.terminal.hideCursor();
		this.requestRender();
	}

	stop(): void {
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		this.renderRequested = false;
		this.terminal.showCursor();
		this.terminal.write("\x1b[?1049l");
		this.terminal.stop();
	}

	requestRender(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		if (this.renderTimer) return;
		this.scheduleRender();
	}

	private scheduleRender(): void {
		const now = Date.now();
		const elapsed = now - this.lastRenderAt;
		const delay =
			elapsed >= this.renderMinInterval ? 0 : this.renderMinInterval - elapsed;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			this.renderRequested = false;
			this.lastRenderAt = Date.now();
			this.doRender();
			if (this.renderRequested && !this.renderTimer) {
				this.scheduleRender();
			}
		}, delay);
	}

	private handleInput(data: string): void {
		// Pass input to focused component (including Ctrl+C)
		// The focused component can decide how to handle Ctrl+C
		if (this.focusedComponent?.handleInput) {
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	private doRender(): void {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const newLines = this.render(width);
		const maxLines = height > 0 ? height : newLines.length;
		const linesToRender = newLines.slice(0, maxLines);
		let buffer = "\x1b[H";
		for (let i = 0; i < linesToRender.length; i++) {
			const line = linesToRender[i];
			if (visibleWidth(line) > width) {
				throw new Error(`Rendered line ${i} exceeds terminal width\n\n${line}`);
			}
			if (i > 0) buffer += "\r\n";
			buffer += line;
			buffer += "\x1b[K";
		}
		buffer += "\x1b[J";
		this.terminal.write(buffer);
	}
}
