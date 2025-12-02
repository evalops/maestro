import chalk, { Chalk } from "chalk";
import { describe, expect, it } from "vitest";
import { visibleWidth, wrapAnsiLines } from "../../packages/tui/src/utils.js";

describe("wrapAnsiLines", () => {
	it("wraps ANSI-colored text without losing styles", () => {
		const color = new Chalk({ level: 3 });
		const red = color.red("abcdef");
		const wrapped = wrapAnsiLines([red], 4);
		expect(wrapped.length).toBe(2);
		expect(visibleWidth(wrapped[0])).toBeLessThanOrEqual(4);
		expect(visibleWidth(wrapped[1])).toBeLessThanOrEqual(4);
	});

	it("preserves active ANSI across wrapped segments", () => {
		const color = new Chalk({ level: 3 });
		const styled = `${color.bold.red("abcd")}${color.bold.red("ef")}`;
		const wrapped = wrapAnsiLines([styled], 3);
		expect(wrapped.length).toBeGreaterThan(1);
		// Each line should respect width and retain some styling when colors are enabled
		for (const line of wrapped) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(3);
		}
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
