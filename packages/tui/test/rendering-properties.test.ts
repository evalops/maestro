import { describe, expect, it } from "vitest";

import fc from "fast-check";

import { VirtualTerminal } from "../src/testing/virtual-terminal.js";
import type { Component } from "../src/tui.js";
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

class DynamicLines implements Component {
	private lines: string[] = [];

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
}

type Action =
	| { type: "setLines"; lines: string[] }
	| { type: "resize"; columns: number; rows: number };

describe("TUI rendering (property-based)", () => {
	it("keeps the viewport consistent with the last rendered frame", async () => {
		const safeCharArb = fc.constantFrom(
			..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
			..." .,;:!?/\\|_-+*()[]{}<>@#$%^&=~'\"",
			"—",
			"•",
			"…",
			"→",
			"←",
			"≤",
			"≥",
			"≈",
			"π",
			"λ",
			"中",
			"文",
			"語",
			"漢",
			"字",
			"😀",
			"🚀",
			"🧪",
			"💡",
		);
		const safeLineArb = fc
			.array(safeCharArb, { minLength: 0, maxLength: 80 })
			.map((chars) => chars.join(""));

		const actionArb = fc.oneof(
			fc.record({
				type: fc.constant("setLines" as const),
				lines: fc.array(
					// Avoid newline/control chars; keep comparisons stable across xterm.js.
					safeLineArb,
					{ minLength: 0, maxLength: 30 },
				),
			}),
			fc.record({
				type: fc.constant("resize" as const),
				columns: fc.integer({ min: 10, max: 80 }),
				rows: fc.integer({ min: 3, max: 25 }),
			}),
		) as fc.Arbitrary<Action>;

		await fc.assert(
			fc.asyncProperty(
				fc.array(actionArb, { minLength: 1, maxLength: 25 }),
				async (actions) => {
					const term = new VirtualTerminal(40, 10);
					try {
						const component = new DynamicLines();
						const tui = new TUI(term, defaultFeatures);
						tui.addChild(component);

						let lastFrameLines: string[] = [];
						tui.setRenderCallback((lines) => {
							lastFrameLines = lines;
						});

						tui.start();
						await new Promise((r) => process.nextTick(r));
						await term.flush();

						for (const action of actions) {
							if (action.type === "setLines") {
								component.setLines(action.lines);
								tui.requestRender();
							} else {
								term.resize(action.columns, action.rows);
							}

							await new Promise((r) => process.nextTick(r));
							const viewport = await term.flushAndGetViewport();

							// TUI auto-clips to the bottom of the viewport when overflow occurs.
							const expected =
								lastFrameLines.length > term.rows
									? lastFrameLines.slice(-term.rows)
									: lastFrameLines;

							for (let i = 0; i < term.rows; i++) {
								const actual = (viewport[i] ?? "").trimEnd();
								const exp = (expected[i] ?? "").trimEnd();
								expect(actual).toBe(exp);
							}
						}
					} finally {
						term.dispose();
					}
				},
			),
			{
				numRuns: 30,
				// Avoid rare extremely slow cases (CI variability).
				interruptAfterTimeLimit: 10_000,
			},
		);
	});
});
