import { describe, expect, it } from "vitest";
import {
	formatCommandHelp,
	parseCommandArguments,
	shouldShowHelp,
} from "../src/tui/commands/argument-parser.js";

describe("command argument parser", () => {
	it("parses enum arguments and validates choices", () => {
		const result = parseCommandArguments("week", [
			{ name: "period", type: "enum", choices: ["week", "month"] },
		]);
		expect(result).toEqual({ ok: true, args: { period: "week" } });
	});

	it("reports errors for invalid enum options", () => {
		const result = parseCommandArguments("year", [
			{ name: "period", type: "enum", choices: ["week"] },
		]);
		if (result.ok) {
			throw new Error("Expected parser to fail");
		}
		expect(result.errors[0]).toContain("must be one of");
	});

	it("detects help tokens", () => {
		expect(shouldShowHelp("help")).toBe(true);
		expect(shouldShowHelp("--help")).toBe(true);
		expect(shouldShowHelp("status")).toBe(false);
	});

	it("formats help output with usage and examples", () => {
		const help = formatCommandHelp({
			name: "cost",
			description: "Show usage summary",
			usage: "/cost [today|week]",
			examples: ["/cost today"],
			tags: ["usage"],
			arguments: [
				{
					name: "period",
					type: "enum",
					choices: ["today", "week"],
					description: "Time range",
				},
			],
		});
		expect(help).toContain("/cost");
		expect(help).toContain("Usage:");
		expect(help).toContain("Arguments:");
	});
});
