import { describe, expect, it } from "vitest";
import {
	clampToolOutput,
	formatToolOutputTruncation,
} from "../../src/cli-tui/utils/tool-text-utils.js";

describe("tool output clamp", () => {
	it("clamps by line count", () => {
		const output = ["one", "two", "three", "four"].join("\n");
		const result = clampToolOutput(output, { maxLines: 2, maxChars: 0 });
		expect(result.text).toBe("one\ntwo");
		expect(result.omittedLines).toBe(2);
		expect(result.omittedChars).toBe(0);
		const banner = formatToolOutputTruncation(result);
		expect(banner).toContain("2 lines");
	});

	it("clamps by char count", () => {
		const output = "abcdefghij";
		const result = clampToolOutput(output, { maxLines: 0, maxChars: 6 });
		expect(result.text).toBe("abcdef");
		expect(result.omittedChars).toBe(4);
		expect(result.omittedLines).toBe(0);
		const banner = formatToolOutputTruncation(result);
		expect(banner).toContain("4 chars");
	});

	it("reports both line and char truncation when both apply", () => {
		const output = ["one", "two", "three", "four"].join("\n");
		const result = clampToolOutput(output, { maxLines: 2, maxChars: 5 });
		expect(result.text).toBe("one\nt");
		expect(result.omittedLines).toBe(2);
		expect(result.omittedChars).toBe(2);
		const banner = formatToolOutputTruncation(result) ?? "";
		expect(banner).toContain("2 lines");
		expect(banner).toContain("2 chars");
	});

	it("returns null banner when not truncated", () => {
		const result = clampToolOutput("ok", { maxLines: 10, maxChars: 10 });
		expect(result.truncated).toBe(false);
		expect(formatToolOutputTruncation(result)).toBeNull();
	});
});
