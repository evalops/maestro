import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { shimmerText } from "../src/tui/utils/shimmer.js";

const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, "g");

function stripAnsi(value: string): string {
	return value.replace(ANSI_REGEX, "");
}

describe("shimmerText", () => {
	beforeAll(() => {
		chalk.level = 3;
	});

	it("preserves the original text content", () => {
		const input = "Composer";
		const styled = shimmerText(input, { time: 0, sweepSeconds: 1 });
		expect(stripAnsi(styled)).toBe(input);
	});

	it("changes styling as time progresses", () => {
		const input = "Responding";
		const commonOptions = {
			padding: 0,
			bandWidth: 4,
			sweepSeconds: 1,
		} as const;
		const now = shimmerText(input, { time: 0, ...commonOptions });
		const later = shimmerText(input, { time: 0.25, ...commonOptions });
		expect(now).not.toBe(later);
	});

	it("clamps sweep duration to avoid division by zero", () => {
		const input = "Hi";
		expect(() => shimmerText(input, { sweepSeconds: 0 })).not.toThrow();
		const styled = shimmerText(input, { sweepSeconds: 0 });
		expect(stripAnsi(styled)).toBe(input);
	});
});
