import chalk from "chalk";
import { describe, expect, it } from "vitest";

import {
	truncateToWidth,
	visibleWidth,
	wrapAnsiLine,
	wrapAnsiLines,
} from "../src/utils.js";

chalk.level = 3;

const SAMPLE_STRINGS = [
	"plain",
	"tabs\tand text",
	"emoji 😊 block",
	chalk.red("colored text"),
	chalk.bold(`multi${chalk.underline(" style")}`),
	"wide — dash",
];

describe("visibleWidth", () => {
	it("counts emojis and ansi correctly", () => {
		expect(visibleWidth("A😊B")).toBe(4);
		expect(visibleWidth(chalk.blue("hi"))).toBe(2);
	});
});

describe("wrapAnsiLine", () => {
	it("never exceeds target width across sample corpus", () => {
		for (const source of SAMPLE_STRINGS) {
			for (let width = 1; width <= 12; width++) {
				const wrapped = wrapAnsiLine(source, width);
				for (const line of wrapped) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("keeps ansi state across line breaks", () => {
		const colored = chalk.red("colorful line");
		const wrapped = wrapAnsiLine(colored, 6);
		expect(wrapped.length).toBeGreaterThan(1);
		expect(wrapped[0]!.endsWith("\u001b[0m")).toBe(true);
		expect(wrapped[1]!.startsWith("\u001b[31m")).toBe(true);
	});
});

describe("wrapAnsiLines", () => {
	it("wraps multiple lines", () => {
		const lines = wrapAnsiLines(["first line", "second"], 5);
		const widths = lines.map((line) => visibleWidth(line));
		for (const width of widths) {
			expect(width).toBeLessThanOrEqual(5);
		}
	});
});

describe("truncateToWidth", () => {
	it("returns line unchanged if within width", () => {
		expect(truncateToWidth("hello", 10)).toBe("hello");
		expect(truncateToWidth("hi", 2)).toBe("hi");
	});

	it("truncates with ellipsis when exceeding width", () => {
		const result = truncateToWidth("hello world", 8);
		expect(visibleWidth(result)).toBeLessThanOrEqual(8);
		expect(result).toContain("\u2026"); // ellipsis
	});

	it("preserves ANSI codes and adds reset when truncating styled text", () => {
		const styled = chalk.red("hello world");
		const result = truncateToWidth(styled, 8);
		expect(visibleWidth(result)).toBeLessThanOrEqual(8);
		expect(result).toContain("\u2026");
		// Should end with reset after ellipsis
		expect(result.endsWith("\x1b[0m")).toBe(true);
	});

	it("handles emojis correctly", () => {
		const result = truncateToWidth("hello 😊 world", 8);
		expect(visibleWidth(result)).toBeLessThanOrEqual(8);
	});

	it("returns empty string for zero width", () => {
		expect(truncateToWidth("hello", 0)).toBe("");
	});
});
