/**
 * Native TUI Bridge
 *
 * Bridges the existing TUI rendering system with the Rust native TUI.
 * When native TUI is available, renders are forwarded to it; otherwise
 * falls back to the standard terminal rendering.
 */

import type { Component, Container } from "@evalops/tui";
import { componentToRenderNode, keyToAnsi, linesToHistory } from "./index.js";
import { NativeTuiLauncher } from "./launcher.js";
import type { CursorPosition, HistoryLine, RenderNode } from "./protocol.js";

export interface NativeTuiBridgeOptions {
	/** Path to the Rust binary (optional, will search) */
	binaryPath?: string;
	/** Called when a key is pressed */
	onInput?: (data: string) => void;
	/** Called when text is pasted */
	onPaste?: (text: string) => void;
	/** Called when terminal is resized */
	onResize?: (width: number, height: number) => void;
	/** Called when focus changes */
	onFocus?: (focused: boolean) => void;
	/** Called on errors */
	onError?: (message: string) => void;
}

/**
 * Bridge between the existing TUI system and the native Rust TUI.
 *
 * Usage:
 * ```typescript
 * const bridge = new NativeTuiBridge({
 *   onInput: (data) => editor.handleInput(data),
 *   onPaste: (text) => editor.insertText(text),
 * });
 *
 * await bridge.start();
 *
 * // Render a component
 * bridge.render(myComponent, 80);
 *
 * // Push lines to scrollback
 * bridge.pushHistory(["Line 1", "Line 2"]);
 *
 * // Stop when done
 * bridge.stop();
 * ```
 */
export class NativeTuiBridge {
	private launcher: NativeTuiLauncher;
	private options: NativeTuiBridgeOptions;
	private started = false;

	constructor(options: NativeTuiBridgeOptions = {}) {
		this.options = options;
		this.launcher = new NativeTuiLauncher(options.binaryPath);

		// Set up event handlers
		this.launcher.on("key", (key, modifiers) => {
			const ansi = keyToAnsi(key, modifiers);
			if (ansi && this.options.onInput) {
				this.options.onInput(ansi);
			}
		});

		this.launcher.on("paste", (text) => {
			this.options.onPaste?.(text);
		});

		this.launcher.on("resize", (width, height) => {
			this.options.onResize?.(width, height);
		});

		this.launcher.on("focus", (focused) => {
			this.options.onFocus?.(focused);
		});

		this.launcher.on("error", (message) => {
			this.options.onError?.(message);
		});
	}

	/**
	 * Start the native TUI
	 */
	async start(): Promise<void> {
		await this.launcher.start();
		this.started = true;
	}

	/**
	 * Stop the native TUI
	 */
	stop(): void {
		this.launcher.stop();
		this.started = false;
	}

	/**
	 * Check if native TUI is running
	 */
	isRunning(): boolean {
		return this.started && this.launcher.isReady();
	}

	/**
	 * Get terminal size
	 */
	getSize(): { width: number; height: number } {
		return this.launcher.getSize();
	}

	/**
	 * Render a component to the native TUI
	 */
	renderComponent(
		component: Component,
		width: number,
		cursor?: CursorPosition,
	): void {
		if (!this.isRunning()) return;

		const node = componentToRenderNode(component, width);
		this.launcher.render(node, cursor);
	}

	/**
	 * Render a RenderNode directly
	 */
	render(node: RenderNode, cursor?: CursorPosition): void {
		if (!this.isRunning()) return;
		this.launcher.render(node, cursor);
	}

	/**
	 * Push lines to terminal scrollback
	 */
	pushHistory(lines: string[]): void {
		if (!this.isRunning()) return;

		const historyLines = linesToHistory(lines);
		this.launcher.pushHistory(historyLines);
	}

	/**
	 * Push pre-formatted history lines
	 */
	pushHistoryLines(lines: HistoryLine[]): void {
		if (!this.isRunning()) return;
		this.launcher.pushHistory(lines);
	}

	/**
	 * Send a desktop notification
	 */
	notify(message: string): void {
		if (!this.isRunning()) return;
		this.launcher.notify(message);
	}

	/**
	 * Request exit with code
	 */
	exit(code = 0): void {
		this.launcher.exit(code);
	}

	/**
	 * Check if native TUI is available (binary exists)
	 */
	static isAvailable(): boolean {
		return NativeTuiLauncher.isAvailable();
	}
}

/**
 * Create a native TUI bridge if available, otherwise return null
 */
export function createNativeTuiBridge(
	options: NativeTuiBridgeOptions = {},
): NativeTuiBridge | null {
	if (!NativeTuiBridge.isAvailable()) {
		return null;
	}
	return new NativeTuiBridge(options);
}
