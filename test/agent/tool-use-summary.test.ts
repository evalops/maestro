import { describe, expect, it } from "vitest";
import { summarizeToolUse } from "../../src/utils/tool-use-summary.js";

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
});
