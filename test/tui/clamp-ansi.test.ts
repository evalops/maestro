import chalk from "chalk";
import { describe, expect, it } from "vitest";

import { visibleWidth } from "../../packages/tui/src/utils.js";
import { clampAnsiLines } from "../../src/cli-tui/utils/tool-text-utils.js";

describe("clampAnsiLines", () => {
	it("respects max width with wide characters and ellipsis", () => {
		const [line] = clampAnsiLines(["😀😀😀😀"], 4);
		expect(visibleWidth(line)).toBeLessThanOrEqual(4);
		expect(line.endsWith("…")).toBe(true);
	});

	it("keeps content when already within width", () => {
		const [line] = clampAnsiLines(["hi"], 4);
		expect(line).toBe("hi");
	});

	it("handles ANSI-colored strings without bleeding", () => {
		const colored = chalk.green("hello world");
		const [line] = clampAnsiLines([colored], 6);
		expect(visibleWidth(line)).toBeLessThanOrEqual(6);
		const appended = `${line}plain`;
		const strippedTail = stripAnsiMinimal(appended).slice(-5);
		expect(strippedTail).toBe("plain");
	});
});

function stripAnsiMinimal(value: string): string {
	if (!value.includes("\x1b")) return value;
	return value
		.split("\x1b")
		.map((chunk, index) =>
			index === 0 ? chunk : chunk.replace(/^\[[0-9;?]*[ -/]*[@-~]/, ""),
		)
		.join("");
}
