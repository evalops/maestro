import { describe, expect, it } from "vitest";
import {
	describeToolActivity,
	summarizeToolBatch,
	summarizeToolUse,
} from "../../src/utils/tool-use-summary.js";

describe("summarizeToolUse", () => {
	it("summarizes file reads by basename", () => {
		expect(
			summarizeToolUse("read", {
				file_path:
					"/Users/jonathanhaas/Documents/Projects/maestro/package.json",
			}),
		).toBe("Read package.json");
	});

	it("summarizes bash commands with the command text", () => {
		expect(
			summarizeToolUse("bash", {
				command: "npm test -- --runInBand",
			}),
		).toBe("Ran npm test -- --runInBand");
	});

	it("summarizes search-style tools with quoted patterns", () => {
		expect(
			summarizeToolUse("grep", {
				pattern: "TODO: tighten this logic",
			}),
		).toBe('Searched for "TODO: tighten this logic"');
	});

	it("summarizes web search queries", () => {
		expect(
			summarizeToolUse("search_query", {
				query: "maestro nx monorepo",
			}),
		).toBe('Searched web for "maestro nx monorepo"');
	});

	it("falls back to a humanized tool name", () => {
		expect(summarizeToolUse("mcp__github__search_issues", {})).toBe(
			"Ran search issues",
		);
	});

	it("uses tool-provided summary labels when available", () => {
		expect(
			summarizeToolUse(
				"todo",
				{ goal: "Ship hooks", items: [{ content: "wire runtime hooks" }] },
				{
					getToolUseSummary: (args) => `Planned tasks for ${String(args.goal)}`,
				},
			),
		).toBe("Planned tasks for Ship hooks");
	});

	it("uses present-tense activity labels for running tools", () => {
		expect(
			describeToolActivity("read", {
				file_path:
					"/Users/jonathanhaas/Documents/Projects/maestro/package.json",
			}),
		).toBe("Reading package.json");
	});

	it("uses tool-provided activity descriptions when available", () => {
		expect(
			describeToolActivity(
				"background_tasks",
				{ action: "start" },
				{
					getActivityDescription: () => "Starting background task",
				},
			),
		).toBe("Starting background task");
	});

	it("summarizes tool batches into a compact one-line label", () => {
		expect(
			summarizeToolBatch([
				{ toolName: "read", args: { path: "src/app.ts" } },
				{ toolName: "grep", args: { pattern: "TODO" } },
				{ toolName: "bash", args: { command: "bun test" } },
			]),
		).toEqual({
			summary: 'Read app.ts, Searched for "TODO", Ran bun test',
			summaryLabels: ["Read app.ts", 'Searched for "TODO"', "Ran bun test"],
			callsSucceeded: 3,
			callsFailed: 0,
		});
	});

	it("tracks succeeded and failed calls in a batch summary", () => {
		expect(
			summarizeToolBatch([
				{ toolName: "read", args: { path: "README.md" } },
				{ toolName: "read", args: { path: "README.md" }, isError: true },
			]),
		).toEqual({
			summary: "Read README.md",
			summaryLabels: ["Read README.md"],
			callsSucceeded: 1,
			callsFailed: 1,
		});
	});

	it("shows overflow when the final label does not fit", () => {
		const batch = summarizeToolBatch([
			{ toolName: "read", args: { path: "README.md" } },
			{
				toolName: "bash",
				args: {
					command:
						"bun run a-command-with-a-long-name-that-will-overflow-the-summary",
				},
			},
		]);

		expect(batch.summary).toBe("Read README.md +1 more");
		expect(batch.summaryLabels).toHaveLength(2);
		expect(batch.summaryLabels[0]).toBe("Read README.md");
	});
});
