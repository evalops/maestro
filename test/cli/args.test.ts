import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
	it("parses --task-budget as a positive integer", () => {
		expect(parseArgs(["--task-budget", "500000"]).taskBudget).toBe(500000);
	});

	it("ignores invalid task budgets", () => {
		expect(parseArgs(["--task-budget", "0"]).taskBudget).toBeUndefined();
		expect(parseArgs(["--task-budget", "-10"]).taskBudget).toBeUndefined();
		expect(parseArgs(["--task-budget", "1.5"]).taskBudget).toBeUndefined();
		expect(
			parseArgs(["--task-budget", "not-a-number"]).taskBudget,
		).toBeUndefined();
	});
});
