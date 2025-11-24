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

	it("wraps wide characters correctly", () => {
		const wrapped = wrapAnsiLines(["😀😀😀"], 2);
		expect(wrapped.length).toBe(3);
		for (const line of wrapped) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(2);
		}
	});

	it("wraps multiple input lines independently", () => {
		const wrapped = wrapAnsiLines(["abcd", "efgh"], 3);
		expect(wrapped).toEqual(["abc", "d", "efg", "h"]);
	});
});
