import { describe, expect, it } from "vitest";

import { Markdown } from "../../packages/tui/src/components/markdown.js";
import { visibleWidth } from "../../packages/tui/src/utils.js";

const stripAnsi = (value: string): string =>
	value.replaceAll(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g"),
		"",
	);

describe("Markdown tables", () => {
	it("wraps and truncates cells to stay within the available width", () => {
		const markdown = `
| Multi-Provider | VeryLongColumnName | Short |
| --- | --- | --- |
| Anthropic | ExampleContentThatShouldBeTruncated | ok |
| OpenAI | AnotherVeryLongCellThatWillNeedClamping | fine |
`.trim();

		const renderer = new Markdown(
			markdown,
			undefined,
			undefined,
			undefined,
			1,
			0,
		);
		const width = 26; // Small width to force clamping

		const lines = renderer.render(width).map(stripAnsi);

		// All lines should respect the provided width
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Header/rows should still render three columns (two separators => three cells)
		const header = lines.find((line) => line.startsWith("│"));
		expect(header?.split("│").length ?? 0).toBeGreaterThanOrEqual(4); // left border + 3 cells + right border
	});

	it("keeps column count stable when shrinking many columns", () => {
		const headerCells = Array.from({ length: 12 }, (_, i) => `Col${i + 1}`);
		const rowCells = headerCells.map(() => "verylongvalue");
		const markdown = `| ${headerCells.join(" | ")} |
| ${headerCells.map(() => "---").join(" | ")} |
| ${rowCells.join(" | ")} |`;

		const renderer = new Markdown(
			markdown,
			undefined,
			undefined,
			undefined,
			1,
			0,
		);
		const width = 32; // Forces aggressive shrinking

		const lines = renderer.render(width).map(stripAnsi);
		const dataRow = lines.find(
			(line) => line.startsWith("│") && line.includes("Col1"),
		);
		expect(dataRow).toBeDefined();
		expect(visibleWidth(dataRow ?? "")).toBeLessThanOrEqual(width);
		// Ensure we didn't drop columns: count separators
		const separatorCount = (dataRow?.match(/│/g) ?? []).length;
		// left + right borders plus 12 cells -> 13 separators
		expect(separatorCount).toBeGreaterThanOrEqual(13);
	});

	it("does not break ANSI sequences when truncating", () => {
		const esc = String.fromCharCode(27);
		const markdown = `
| Styled | Data |
| --- | --- |
| **bold-text-with-color** | plain |
| ${esc}[2Jcursor-move | plain |
| 😀 emoji | plain |
`.trim();

		const renderer = new Markdown(
			markdown,
			undefined,
			undefined,
			undefined,
			1,
			0,
		);
		const width = 20;

		const lines = renderer.render(width);
		for (const line of lines) {
			expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
			// No partial escape codes (covers color and cursor movement like ESC[2J)
			const trailingEscape = new RegExp(
				`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*$`,
			);
			expect(line).not.toMatch(trailingEscape);
		}
	});
});
