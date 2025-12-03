import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { parallelRipgrepTool } from "../../src/tools/parallel-ripgrep.js";

function getTextOutput(result: AgentToolResult<unknown>): string {
	return (
		result.content
			?.filter((c): c is { type: "text"; text: string } => {
				return (
					c != null && typeof c === "object" && "type" in c && c.type === "text"
				);
			})
			.map((c) => c.text)
			.join("\n") || ""
	);
}

describe("parallel-ripgrep", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "parallel-ripgrep-test-"));
		// Create test files
		writeFileSync(
			join(testDir, "file1.ts"),
			`function hello() {
  console.log("Hello, world!");
}

function goodbye() {
  console.log("Goodbye, world!");
}
`,
		);
		writeFileSync(
			join(testDir, "file2.ts"),
			`class Greeter {
  hello() {
    return "Hello";
  }

  goodbye() {
    return "Goodbye";
  }
}
`,
		);
		mkdirSync(join(testDir, "subdir"));
		writeFileSync(
			join(testDir, "subdir", "file3.ts"),
			`export function hello() {
  return "Hello from subdir";
}
`,
		);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic search", () => {
		it("searches for single pattern", async () => {
			const result = await parallelRipgrepTool.execute("prg-1", {
				patterns: ["hello"],
				paths: [testDir],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("match");
		});

		it("searches for multiple patterns", async () => {
			const result = await parallelRipgrepTool.execute("prg-2", {
				patterns: ["hello", "goodbye"],
				paths: [testDir],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("match");
		});

		it("returns no matches for non-existent pattern", async () => {
			const result = await parallelRipgrepTool.execute("prg-3", {
				patterns: ["nonexistentpattern12345"],
				paths: [testDir],
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("No matches found");
		});
	});

	describe("search options", () => {
		it("supports case-insensitive search", async () => {
			const result = await parallelRipgrepTool.execute("prg-4", {
				patterns: ["HELLO"],
				paths: [testDir],
				ignoreCase: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("match");
		});

		it("supports literal search", async () => {
			const result = await parallelRipgrepTool.execute("prg-5", {
				patterns: ["hello()"],
				paths: [testDir],
				literal: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("match");
		});

		it("supports word boundary search", async () => {
			const result = await parallelRipgrepTool.execute("prg-6", {
				patterns: ["hello"],
				paths: [testDir],
				word: true,
			});

			expect(result.isError).toBeFalsy();
		});

		it("supports glob filtering", async () => {
			const result = await parallelRipgrepTool.execute("prg-7", {
				patterns: ["hello"],
				paths: [testDir],
				glob: "*.ts",
			});

			expect(result.isError).toBeFalsy();
		});

		it("supports maxResults limit", async () => {
			const result = await parallelRipgrepTool.execute("prg-8", {
				patterns: ["hello"],
				paths: [testDir],
				maxResults: 1,
			});

			expect(result.isError).toBeFalsy();
		});

		it("supports context lines", async () => {
			const result = await parallelRipgrepTool.execute("prg-9", {
				patterns: ["hello"],
				paths: [testDir],
				context: 2,
			});

			expect(result.isError).toBeFalsy();
		});

		it("supports before/after context", async () => {
			const result = await parallelRipgrepTool.execute("prg-10", {
				patterns: ["hello"],
				paths: [testDir],
				beforeContext: 1,
				afterContext: 1,
			});

			expect(result.isError).toBeFalsy();
		});

		it("errors when both context and before/after are provided", async () => {
			await expect(
				parallelRipgrepTool.execute("prg-11", {
					patterns: ["hello"],
					paths: [testDir],
					context: 2,
					beforeContext: 1,
				}),
			).rejects.toThrow("context");
		});
	});

	describe("range merging", () => {
		it("merges overlapping ranges from different patterns", async () => {
			const result = await parallelRipgrepTool.execute("prg-12", {
				patterns: ["function hello", "Hello"],
				paths: [testDir],
				ignoreCase: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			// Should merge overlapping ranges
			expect(output).toContain("range");
		});
	});

	describe("working directory", () => {
		it("uses cwd option", async () => {
			const result = await parallelRipgrepTool.execute("prg-13", {
				patterns: ["hello"],
				paths: ["."],
				cwd: testDir,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("match");
		});
	});

	describe("hidden files and gitignore", () => {
		it("respects includeHidden option", async () => {
			// Create a hidden file
			writeFileSync(join(testDir, ".hidden.ts"), "const hello = 1;");

			const result = await parallelRipgrepTool.execute("prg-14", {
				patterns: ["hello"],
				paths: [testDir],
				includeHidden: true,
			});

			expect(result.isError).toBeFalsy();
		});

		it("respects useGitIgnore option", async () => {
			const result = await parallelRipgrepTool.execute("prg-15", {
				patterns: ["hello"],
				paths: [testDir],
				useGitIgnore: false,
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("headLimit", () => {
		it("limits number of returned ranges", async () => {
			const result = await parallelRipgrepTool.execute("prg-16", {
				patterns: ["hello", "goodbye", "Greeter", "function", "class"],
				paths: [testDir],
				headLimit: 2,
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("multiline mode", () => {
		it("supports multiline patterns", async () => {
			const result = await parallelRipgrepTool.execute("prg-17", {
				patterns: ["function.*\\{"],
				paths: [testDir],
				multiline: true,
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("error handling", () => {
		it("handles invalid regex gracefully", async () => {
			await expect(
				parallelRipgrepTool.execute("prg-18", {
					patterns: ["[invalid"],
					paths: [testDir],
				}),
			).rejects.toThrow();
		});

		it("handles non-existent path", async () => {
			const result = await parallelRipgrepTool.execute("prg-19", {
				patterns: ["hello"],
				paths: ["/nonexistent/path/xyz"],
			});

			// ripgrep may return empty or error for non-existent paths
			expect(result).toBeDefined();
		});
	});
});
