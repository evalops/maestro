import chalk from "chalk";
import { describe, expect, it } from "vitest";
import { visibleWidth, wrapAnsiLines } from "../packages/tui/src/utils.js";

describe("wrapAnsiLines", () => {
	it("wraps ANSI-colored text without losing styles", () => {
		const red = chalk.red("abcdef");
		const wrapped = wrapAnsiLines([red], 4);
		expect(wrapped.length).toBe(2);
		expect(visibleWidth(wrapped[0])).toBeLessThanOrEqual(4);
		expect(visibleWidth(wrapped[1])).toBeLessThanOrEqual(4);
		// Ensure reset is present on wrapped segment
		expect(wrapped[0]).toMatch(new RegExp(`${String.fromCharCode(27)}\\[0m$`));
	});

	it("preserves active ANSI across wrapped segments", () => {
		const styled = `${chalk.bold.red("abcd")}${chalk.bold.red("ef")}`;
		const wrapped = wrapAnsiLines([styled], 3);
		expect(wrapped.length).toBeGreaterThan(1);
		// First line should end with reset
		expect(wrapped[0]).toMatch(new RegExp(`${String.fromCharCode(27)}\\[0m$`));
		// Second line should still contain styling (either leading ansi or chars with active style)
		const hasLeadingAnsi = new RegExp(
			`^${String.fromCharCode(27)}\\[0-9;]*m`,
		).test(wrapped[1]);
		const containsStyledChar =
			wrapped[1].includes("\x1b[31m") || wrapped[1].includes("\x1b[1m");
		expect(hasLeadingAnsi || containsStyledChar).toBe(true);
	});

	it("wraps wide characters correctly", () => {
		const wrapped = wrapAnsiLines(["😀😀😀"], 2);
		expect(wrapped.length).toBe(3);
		for (const line of wrapped) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(2);
		}
	});

	it("handles tabs by normalizing to spaces before measurement", () => {
		const wrapped = wrapAnsiLines(["\t1234"], 3);
		expect(wrapped.length).toBeGreaterThan(1);
	});

	it("returns an empty string when width is zero or negative", () => {
		expect(wrapAnsiLines(["abc"], 0)).toEqual([""]);
		expect(wrapAnsiLines(["abc"], -5)).toEqual([""]);
	});

	it("skips characters wider than the target width", () => {
		const wrapped = wrapAnsiLines(["😀"], 1);
		for (const line of wrapped) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}
	});

	it("wraps multiple input lines independently", () => {
		const wrapped = wrapAnsiLines(["abcd", "efgh"], 3);
		expect(wrapped).toEqual(["abc", "d", "efg", "h"]);
	});
});
