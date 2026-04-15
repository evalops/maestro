import { describe, expect, it } from "vitest";
import { summarizeWebToolCall, summarizeWebToolCalls } from "./tool-summary.js";

describe("tool-summary", () => {
	it("summarizes common file operations", () => {
		expect(
			summarizeWebToolCall("read", { path: "/tmp/project/src/index.ts" }),
		).toBe("Read index.ts");
		expect(
			summarizeWebToolCall("bash", { command: "bun run test -- --runInBand" }),
		).toBe("Ran bun run test -- --runInBand");
	});

	it("summarizes MCP tools with readable labels", () => {
		expect(summarizeWebToolCall("mcp__context7__resolve-library-id")).toBe(
			"Ran resolve library id",
		);
	});

	it("deduplicates repeated tool summaries", () => {
		expect(
			summarizeWebToolCalls([
				{ name: "read", args: { path: "src/app.ts" } },
				{ name: "read", args: { path: "src/app.ts" } },
				{ name: "search", args: { pattern: "handleChat" } },
			]),
		).toEqual(["Read app.ts", 'Searched for "handleChat"']);
	});
});
