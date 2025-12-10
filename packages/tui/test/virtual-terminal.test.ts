import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Text } from "../src/components/text.js";
import { VirtualTerminal } from "../src/testing/virtual-terminal.js";
import { TUI } from "../src/tui.js";
import type { TerminalFeatures } from "../src/utils/terminal-features.js";

const defaultFeatures: TerminalFeatures = {
	supportsBracketedPaste: true,
	supportsSyncOutput: true,
	supportsAltScreen: true,
	lowColor: false,
	lowUnicode: false,
	overSsh: false,
};

describe("VirtualTerminal", () => {
	let term: VirtualTerminal;

	beforeEach(() => {
		term = new VirtualTerminal(40, 10);
	});

	afterEach(() => {
		term.dispose();
	});

	describe("basic operations", () => {
		it("has correct initial dimensions", () => {
			expect(term.columns).toBe(40);
			expect(term.rows).toBe(10);
		});

		it("renders text correctly", async () => {
			const tui = new TUI(term, defaultFeatures);
			tui.addChild(new Text("Hello World", 0, 0));
			tui.start();

			const lines = await term.flushAndGetViewport();
			// xterm.js pads lines to terminal width, so use toContain or trim
			expect(lines[0].trimEnd()).toBe("Hello World");
		});

		it("handles resize events", async () => {
			let resized = false;
			term.start(
				() => {},
				() => {
					resized = true;
				},
			);

			term.resize(60, 20);
			expect(term.columns).toBe(60);
			expect(term.rows).toBe(20);
			expect(resized).toBe(true);
		});

		it("passes input to handler", () => {
			let received = "";
			term.start(
				(data) => {
					received += data;
				},
				() => {},
			);

			term.sendInput("abc");
			term.sendInput("\x1b[A"); // Arrow up
			expect(received).toBe("abc\x1b[A");
		});
	});

	describe("cursor tracking", () => {
		it("tracks cursor position after writes", async () => {
			term.start(
				() => {},
				() => {},
			);
			term.write("Hello");
			await term.flush();

			const pos = term.getCursorPosition();
			expect(pos.x).toBe(5);
			expect(pos.y).toBe(0);
		});

		it("tracks cursor after newlines", async () => {
			term.start(
				() => {},
				() => {},
			);
			term.write("Line 1\r\nLine 2");
			await term.flush();

			const pos = term.getCursorPosition();
			expect(pos.x).toBe(6);
			expect(pos.y).toBe(1);
		});
	});

	describe("TUI integration", () => {
		it("renders multiple components", async () => {
			const tui = new TUI(term, defaultFeatures);
			tui.addChild(new Text("Header", 0, 0));
			tui.addChild(new Text("Content", 0, 0));
			tui.addChild(new Text("Footer", 0, 0));
			tui.start();

			const lines = await term.flushAndGetViewport();
			expect(lines[0].trimEnd()).toBe("Header");
			expect(lines[1].trimEnd()).toBe("Content");
			expect(lines[2].trimEnd()).toBe("Footer");
		});

		it("handles differential updates correctly", async () => {
			const tui = new TUI(term, defaultFeatures);
			const text = new Text("Initial", 0, 0);
			tui.addChild(text);
			tui.start();

			// Wait for initial render (process.nextTick)
			await new Promise((r) => process.nextTick(r));
			let lines = await term.flushAndGetViewport();
			expect(lines[0].trimEnd()).toBe("Initial");

			// Update component
			tui.removeChild(text);
			tui.addChild(new Text("Updated", 0, 0));
			tui.requestRender();

			// Wait for render
			await new Promise((r) => process.nextTick(r));
			lines = await term.flushAndGetViewport();
			expect(lines[0].trimEnd()).toBe("Updated");
		});

		it("clears old content when lines decrease", async () => {
			const tui = new TUI(term, defaultFeatures);
			tui.addChild(new Text("Line 1", 0, 0));
			tui.addChild(new Text("Line 2", 0, 0));
			tui.addChild(new Text("Line 3", 0, 0));
			tui.start();

			await new Promise((r) => process.nextTick(r));
			let lines = await term.flushAndGetViewport();
			expect(lines[0].trimEnd()).toBe("Line 1");
			expect(lines[1].trimEnd()).toBe("Line 2");
			expect(lines[2].trimEnd()).toBe("Line 3");

			// Remove components
			tui.clear();
			tui.addChild(new Text("Only One", 0, 0));
			tui.requestRender();

			await new Promise((r) => process.nextTick(r));
			lines = await term.flushAndGetViewport();
			expect(lines[0].trimEnd()).toBe("Only One");
			// Old lines should be cleared
			expect(lines[1].trim()).toBe("");
			expect(lines[2].trim()).toBe("");
		});
	});

	describe("screen buffer operations", () => {
		it("clears screen correctly", async () => {
			term.start(
				() => {},
				() => {},
			);
			term.write("Some content");
			await term.flush();

			term.clearScreen();
			await term.flush();

			const pos = term.getCursorPosition();
			expect(pos.x).toBe(0);
			expect(pos.y).toBe(0);
		});

		it("resets terminal state", async () => {
			term.start(
				() => {},
				() => {},
			);
			term.write("Content");
			await term.flush();

			term.reset();
			await term.flush();

			const lines = term.getViewport();
			expect(lines[0].trim()).toBe("");
		});
	});
});
