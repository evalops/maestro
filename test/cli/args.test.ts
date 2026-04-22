import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
	it("parses --task-budget as a positive integer", () => {
		expect(parseArgs(["--task-budget", "500000"]).taskBudget).toBe(500000);
	});

	it("rejects invalid task budgets", () => {
		expect(parseArgs(["--task-budget", "0"]).error).toBe(
			"--task-budget must be a positive integer",
		);
		expect(parseArgs(["--task-budget", "-10"]).error).toBe(
			"--task-budget must be a positive integer",
		);
		expect(parseArgs(["--task-budget", "1.5"]).error).toBe(
			"--task-budget must be a positive integer",
		);
		expect(parseArgs(["--task-budget", "not-a-number"]).error).toBe(
			"--task-budget must be a positive integer",
		);
	});

	it("rejects missing task-budget values", () => {
		expect(parseArgs(["--task-budget"]).error).toBe(
			"--task-budget requires a value",
		);
		expect(parseArgs(["--task-budget", "--model", "test"]).error).toBe(
			"--task-budget requires a value",
		);
	});

	it("treats --mode headless forms as headless invocations", () => {
		expect(parseArgs(["--mode", "headless"])).toMatchObject({
			mode: "headless",
			headless: true,
		});
		expect(parseArgs(["--mode=headless"])).toMatchObject({
			mode: "headless",
			headless: true,
		});
	});

	it("parses export commands and formats", () => {
		expect(
			parseArgs([
				"export",
				"session-123",
				"./session.json",
				"--format",
				"json",
				"--redact-secrets",
			]),
		).toMatchObject({
			command: "export",
			messages: ["session-123", "./session.json"],
			exportFormat: "json",
			redactSecrets: true,
		});
	});

	it("parses import commands", () => {
		expect(parseArgs(["import", "./session.jsonl"])).toMatchObject({
			command: "import",
			messages: ["./session.jsonl"],
		});
	});
});
