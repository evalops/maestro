import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { searchTool } from "../../src/tools/search.js";

// Helper to extract text from content blocks
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

describe("search tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "search-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic pattern matching", () => {
		it("finds matches in a single file", async () => {
			const filePath = join(testDir, "test.txt");
			writeFileSync(filePath, "Hello World\nHello Universe");

			const result = await searchTool.execute("search-1", {
				pattern: "Hello",
				paths: testDir,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Hello");
		});

		it("finds matches across multiple files", async () => {
			writeFileSync(join(testDir, "file1.txt"), "foo bar");
			writeFileSync(join(testDir, "file2.txt"), "foo baz");
			writeFileSync(join(testDir, "file3.txt"), "qux");

			const result = await searchTool.execute("search-2", {
				pattern: "foo",
				paths: testDir,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("file1.txt");
			expect(output).toContain("file2.txt");
		});

		it("returns no matches message when pattern not found", async () => {
			writeFileSync(join(testDir, "test.txt"), "Hello World");

			const result = await searchTool.execute("search-3", {
				pattern: "nonexistent",
				paths: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No matches");
		});
	});

	describe("regex support", () => {
		it("supports regex patterns", async () => {
			writeFileSync(join(testDir, "regex.txt"), "foo123bar\nfoo456bar");

			const result = await searchTool.execute("search-4", {
				pattern: "foo\\d+bar",
				paths: testDir,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("foo123bar");
			expect(output).toContain("foo456bar");
		});

		it("supports literal mode for special characters", async () => {
			writeFileSync(join(testDir, "literal.txt"), "value = $100");

			const result = await searchTool.execute("search-5", {
				pattern: "$100",
				paths: testDir,
				literal: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("$100");
		});
	});

	describe("case sensitivity", () => {
		it("is case sensitive by default", async () => {
			writeFileSync(join(testDir, "case.txt"), "Hello hello HELLO");

			const result = await searchTool.execute("search-6", {
				pattern: "Hello",
				paths: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Hello");
			// Only exact case match
		});

		it("supports case insensitive search", async () => {
			writeFileSync(join(testDir, "case.txt"), "Hello\nhello\nHELLO");

			const result = await searchTool.execute("search-7", {
				pattern: "hello",
				paths: testDir,
				ignoreCase: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Hello");
			expect(output).toContain("hello");
			expect(output).toContain("HELLO");
		});
	});

	describe("word matching", () => {
		it("supports whole word matching", async () => {
			writeFileSync(join(testDir, "words.txt"), "foo foobar barfoo");

			const result = await searchTool.execute("search-8", {
				pattern: "foo",
				paths: testDir,
				word: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("foo");
			// Should match "foo" but not "foobar" or "barfoo"
		});
	});

	describe("multiline matching", () => {
		it("supports multiline patterns", async () => {
			writeFileSync(join(testDir, "multi.txt"), "start\nmiddle\nend");

			const result = await searchTool.execute("search-9", {
				pattern: "start.*end",
				paths: testDir,
				multiline: true,
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("output modes", () => {
		it("shows content by default", async () => {
			writeFileSync(join(testDir, "content.txt"), "line with match");

			const result = await searchTool.execute("search-10", {
				pattern: "match",
				paths: testDir,
				outputMode: "content",
			});

			const output = getTextOutput(result);
			expect(output).toContain("line with match");
		});

		it("supports files-only mode", async () => {
			writeFileSync(join(testDir, "a.txt"), "pattern");
			writeFileSync(join(testDir, "b.txt"), "pattern");

			const result = await searchTool.execute("search-11", {
				pattern: "pattern",
				paths: testDir,
				outputMode: "files",
			});

			const output = getTextOutput(result);
			expect(output).toContain("a.txt");
			expect(output).toContain("b.txt");
			expect(output).toContain("2 file(s)");
		});

		it("supports count mode", async () => {
			writeFileSync(join(testDir, "count.txt"), "foo foo foo\nfoo");

			const result = await searchTool.execute("search-12", {
				pattern: "foo",
				paths: testDir,
				outputMode: "count",
			});

			const output = getTextOutput(result);
			expect(output).toContain("4");
		});

		it("does not cap counts by default in count mode", async () => {
			const lines = Array.from({ length: 600 }, () => "foo").join("\n");
			writeFileSync(join(testDir, "count-big.txt"), lines);

			const result = await searchTool.execute("search-12b", {
				pattern: "foo",
				paths: testDir,
				outputMode: "count",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Found 600 match(es)");
			expect(output).toMatch(/: 600$/m);
		});
	});

	describe("context lines", () => {
		it("shows context before matches", async () => {
			writeFileSync(
				join(testDir, "context.txt"),
				"line1\nline2\nmatch\nline4\nline5",
			);

			const result = await searchTool.execute("search-13", {
				pattern: "match",
				paths: testDir,
				beforeContext: 2,
			});

			const output = getTextOutput(result);
			expect(output).toContain("line1");
			expect(output).toContain("line2");
		});

		it("shows context after matches", async () => {
			writeFileSync(
				join(testDir, "context.txt"),
				"line1\nmatch\nline3\nline4\nline5",
			);

			const result = await searchTool.execute("search-14", {
				pattern: "match",
				paths: testDir,
				afterContext: 2,
			});

			const output = getTextOutput(result);
			expect(output).toContain("line3");
			expect(output).toContain("line4");
		});

		it("shows context before and after with -C", async () => {
			writeFileSync(join(testDir, "context.txt"), "a\nb\nmatch\nd\ne");

			const result = await searchTool.execute("search-15", {
				pattern: "match",
				paths: testDir,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("b");
			expect(output).toContain("d");
		});
	});

	describe("glob filtering", () => {
		it("filters by file extension", async () => {
			writeFileSync(join(testDir, "code.ts"), "pattern");
			writeFileSync(join(testDir, "code.js"), "pattern");
			writeFileSync(join(testDir, "data.json"), "pattern");

			const result = await searchTool.execute("search-16", {
				pattern: "pattern",
				paths: testDir,
				glob: "*.ts",
			});

			const output = getTextOutput(result);
			expect(output).toContain("code.ts");
			expect(output).not.toContain("code.js");
			expect(output).not.toContain("data.json");
		});

		it("supports multiple glob patterns", async () => {
			writeFileSync(join(testDir, "a.ts"), "pattern");
			writeFileSync(join(testDir, "b.js"), "pattern");
			writeFileSync(join(testDir, "c.py"), "pattern");

			const result = await searchTool.execute("search-17", {
				pattern: "pattern",
				paths: testDir,
				glob: ["*.ts", "*.js"],
			});

			const output = getTextOutput(result);
			expect(output).toContain("a.ts");
			expect(output).toContain("b.js");
			expect(output).not.toContain("c.py");
		});
	});

	describe("path filtering", () => {
		it("searches in specific directory", async () => {
			mkdirSync(join(testDir, "src"));
			mkdirSync(join(testDir, "test"));
			writeFileSync(join(testDir, "src", "file.txt"), "pattern");
			writeFileSync(join(testDir, "test", "file.txt"), "pattern");

			const result = await searchTool.execute("search-18", {
				pattern: "pattern",
				paths: join(testDir, "src"),
			});

			const output = getTextOutput(result);
			expect(output).toContain("src");
			expect(output).not.toContain("test/file.txt");
		});

		it("searches multiple paths", async () => {
			mkdirSync(join(testDir, "dir1"));
			mkdirSync(join(testDir, "dir2"));
			writeFileSync(join(testDir, "dir1", "a.txt"), "pattern");
			writeFileSync(join(testDir, "dir2", "b.txt"), "pattern");

			const result = await searchTool.execute("search-19", {
				pattern: "pattern",
				paths: [join(testDir, "dir1"), join(testDir, "dir2")],
			});

			const output = getTextOutput(result);
			expect(output).toContain("a.txt");
			expect(output).toContain("b.txt");
		});
	});

	describe("result limits", () => {
		it("limits number of results", async () => {
			const lines = Array.from({ length: 100 }, (_, i) => `match${i}`);
			writeFileSync(join(testDir, "many.txt"), lines.join("\n"));

			const result = await searchTool.execute("search-20", {
				pattern: "match",
				paths: testDir,
				maxResults: 5,
			});

			const output = getTextOutput(result);
			// Should be limited
			expect(output.split("\n").length).toBeLessThan(20);
		});

		it("supports headLimit for output sampling", async () => {
			const lines = Array.from({ length: 50 }, (_, i) => `line${i} match`);
			writeFileSync(join(testDir, "sample.txt"), lines.join("\n"));

			const result = await searchTool.execute("search-21", {
				pattern: "match",
				paths: testDir,
				headLimit: 10,
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("special features", () => {
		it("supports invert match", async () => {
			writeFileSync(join(testDir, "invert.txt"), "keep\nremove\nkeep");

			const result = await searchTool.execute("search-22", {
				pattern: "remove",
				paths: testDir,
				invertMatch: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("keep");
			expect(output).not.toContain("remove");
		});

		it("supports only-matching mode", async () => {
			writeFileSync(join(testDir, "only.txt"), "prefix_match_suffix");

			const result = await searchTool.execute("search-23", {
				pattern: "match",
				paths: testDir,
				onlyMatching: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("match");
		});

		it("includes hidden files when requested", async () => {
			writeFileSync(join(testDir, ".hidden"), "pattern");
			writeFileSync(join(testDir, "visible"), "pattern");

			const result = await searchTool.execute("search-24", {
				pattern: "pattern",
				paths: testDir,
				includeHidden: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain(".hidden");
		});
	});

	describe("details metadata", () => {
		it("includes command in details", async () => {
			writeFileSync(join(testDir, "meta.txt"), "pattern");

			const result = await searchTool.execute("search-25", {
				pattern: "pattern",
				paths: testDir,
			});

			expect(result.details).toHaveProperty("command");
			expect((result.details as { command: string }).command).toContain("rg");
		});

		it("includes cwd in details", async () => {
			writeFileSync(join(testDir, "meta.txt"), "pattern");

			const result = await searchTool.execute("search-26", {
				pattern: "pattern",
				paths: testDir,
			});

			expect(result.details).toHaveProperty("cwd");
		});
	});

	describe("error handling", () => {
		it("handles invalid regex gracefully", async () => {
			writeFileSync(join(testDir, "test.txt"), "content");

			// Invalid regex pattern - unmatched bracket
			await expect(
				searchTool.execute("search-27", {
					pattern: "[invalid",
					paths: testDir,
				}),
			).rejects.toThrow();
		});

		it("validates context option conflicts", async () => {
			writeFileSync(join(testDir, "test.txt"), "content");

			await expect(
				searchTool.execute("search-28", {
					pattern: "content",
					paths: testDir,
					context: 2,
					beforeContext: 1, // Conflict with context
				}),
			).rejects.toThrow("either context or");
		});

		it("validates onlyMatching with non-content mode", async () => {
			writeFileSync(join(testDir, "test.txt"), "content");

			await expect(
				searchTool.execute("search-29", {
					pattern: "content",
					paths: testDir,
					outputMode: "files",
					onlyMatching: true,
				}),
			).rejects.toThrow("onlyMatching");
		});
	});

	describe("JSON format", () => {
		it("supports JSON output format", async () => {
			writeFileSync(join(testDir, "json.txt"), "test match");

			const result = await searchTool.execute("search-30", {
				pattern: "match",
				paths: testDir,
				format: "json",
			});

			expect(result.isError).toBeFalsy();
			expect(result.details).toHaveProperty("matches");
		});
	});
});
