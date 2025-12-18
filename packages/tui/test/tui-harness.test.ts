import { describe, expect, it, vi } from "vitest";

import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import { TUI } from "../src/tui.js";
import type { TerminalFeatures } from "../src/utils/terminal-features.js";

class FakeTerminal implements Terminal {
	columns: number;
	rows: number;
	writes: string[] = [];
	private onInput?: (data: string) => void;
	private onResize?: () => void;

	constructor(columns: number, rows: number) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop(): void {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	enterAltScreen(): void {}
	leaveAltScreen(): void {}
	enableBracketedPaste(): void {}
	disableBracketedPaste(): void {}

	triggerInput(data: string): void {
		this.onInput?.(data);
	}

	triggerResize(): void {
		this.onResize?.();
	}
}

const sshFeatures: TerminalFeatures = {
	supportsBracketedPaste: true,
	supportsSyncOutput: false,
	supportsAltScreen: true,
	lowColor: false,
	lowUnicode: false,
	overSsh: true,
};

describe("TUI harness", () => {
	it("throttles renders on resize under SSH-like conditions", async () => {
		vi.useFakeTimers();
		try {
			const term = new FakeTerminal(20, 4);
			const tui = new TUI(term, sshFeatures);
			tui.addChild(new Text("hello", 0, 0));
			tui.start();

			await new Promise((resolve) => process.nextTick(resolve));
			expect(term.writes.length).toBeGreaterThan(0);
			term.writes.length = 0;

			term.columns = 10;
			term.triggerResize();
			expect(term.writes.length).toBe(0);

			vi.advanceTimersByTime(60);
			// Width changes force a full re-render, but we avoid screen/scrollback clears.
			expect(term.writes.join("")).toContain("\x1b[H");
		} finally {
			vi.useRealTimers();
		}
	});

	it("forwards input to focused component", async () => {
		const term = new FakeTerminal(12, 4);
		const tui = new TUI(term, sshFeatures);
		const text = new Text("start", 0, 0) as Text & {
			handleInput: (data: string) => void;
		};
		let received = "";
		text.handleInput = (value: string) => {
			received += value;
		};
		tui.addChild(text);
		tui.setFocus(text);
		tui.start();
		term.triggerInput("a");
		term.triggerInput("b");
		expect(received).toBe("ab");
	});
});
