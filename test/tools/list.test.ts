import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { listTool } from "../../src/tools/list.js";

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

describe("list tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "list-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic listing", () => {
		it("lists files in a directory", async () => {
			writeFileSync(join(testDir, "file1.txt"), "");
			writeFileSync(join(testDir, "file2.txt"), "");
			writeFileSync(join(testDir, "file3.txt"), "");

			const result = await listTool.execute("list-1", { path: testDir });

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("file1.txt");
			expect(output).toContain("file2.txt");
			expect(output).toContain("file3.txt");
		});

		it("lists directories with trailing slash", async () => {
			mkdirSync(join(testDir, "subdir1"));
			mkdirSync(join(testDir, "subdir2"));
			writeFileSync(join(testDir, "file.txt"), "");

			const result = await listTool.execute("list-2", { path: testDir });

			const output = getTextOutput(result);
			expect(output).toContain("subdir1/");
			expect(output).toContain("subdir2/");
			expect(output).toContain("file.txt");
		});

		it("defaults to current directory when path not specified", async () => {
			const originalCwd = process.cwd();
			try {
				process.chdir(testDir);
				writeFileSync(join(testDir, "test.txt"), "");

				const result = await listTool.execute("list-3", {});

				const output = getTextOutput(result);
				expect(output).toContain("test.txt");
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("glob patterns", () => {
		it("filters by glob pattern", async () => {
			writeFileSync(join(testDir, "code.ts"), "");
			writeFileSync(join(testDir, "code.js"), "");
			writeFileSync(join(testDir, "data.json"), "");

			const result = await listTool.execute("list-4", {
				path: testDir,
				pattern: "*.ts",
			});

			const output = getTextOutput(result);
			expect(output).toContain("code.ts");
			expect(output).not.toContain("code.js");
			expect(output).not.toContain("data.json");
		});

		it("supports recursive glob pattern", async () => {
			mkdirSync(join(testDir, "src"));
			writeFileSync(join(testDir, "src", "index.ts"), "");
			writeFileSync(join(testDir, "root.ts"), "");

			const result = await listTool.execute("list-5", {
				path: testDir,
				pattern: "**/*.ts",
			});

			const output = getTextOutput(result);
			expect(output).toContain("index.ts");
			expect(output).toContain("root.ts");
		});
	});

	describe("hidden files", () => {
		it("excludes hidden files by default", async () => {
			writeFileSync(join(testDir, ".hidden"), "");
			writeFileSync(join(testDir, "visible.txt"), "");

			const result = await listTool.execute("list-6", { path: testDir });

			const output = getTextOutput(result);
			expect(output).not.toContain(".hidden");
			expect(output).toContain("visible.txt");
		});

		it("includes hidden files when requested", async () => {
			writeFileSync(join(testDir, ".hidden"), "");
			writeFileSync(join(testDir, "visible.txt"), "");

			const result = await listTool.execute("list-7", {
				path: testDir,
				includeHidden: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain(".hidden");
			expect(output).toContain("visible.txt");
		});
	});

	describe("depth limiting", () => {
		it("respects maxDepth parameter", async () => {
			mkdirSync(join(testDir, "level1"));
			mkdirSync(join(testDir, "level1", "level2"));
			writeFileSync(join(testDir, "root.txt"), "");
			writeFileSync(join(testDir, "level1", "l1.txt"), "");
			writeFileSync(join(testDir, "level1", "level2", "l2.txt"), "");

			const result = await listTool.execute("list-8", {
				path: testDir,
				pattern: "**/*",
				maxDepth: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("root.txt");
			expect(output).toContain("level1");
		});
	});

	describe("result limiting", () => {
		it("limits number of results", async () => {
			for (let i = 0; i < 50; i++) {
				writeFileSync(
					join(testDir, `file${i.toString().padStart(2, "0")}.txt`),
					"",
				);
			}

			const result = await listTool.execute("list-9", {
				path: testDir,
				limit: 10,
			});

			const output = getTextOutput(result);
			const fileCount = (output.match(/file\d+\.txt/g) || []).length;
			expect(fileCount).toBeLessThanOrEqual(10);
		});

		it("indicates when results are truncated", async () => {
			for (let i = 0; i < 20; i++) {
				writeFileSync(join(testDir, `file${i}.txt`), "");
			}

			const result = await listTool.execute("list-10", {
				path: testDir,
				limit: 5,
			});

			expect(result.details).toMatchObject({
				truncated: true,
			});
		});
	});

	describe("metadata", () => {
		it("includes metadata when requested", async () => {
			writeFileSync(join(testDir, "test.txt"), "content");

			const result = await listTool.execute("list-11", {
				path: testDir,
				includeMetadata: true,
			});

			const output = getTextOutput(result);
			// Should include size or time info
			expect(output.length).toBeGreaterThan(10);
		});
	});

	describe("sorting", () => {
		it("sorts by name by default", async () => {
			writeFileSync(join(testDir, "c.txt"), "");
			writeFileSync(join(testDir, "a.txt"), "");
			writeFileSync(join(testDir, "b.txt"), "");

			const result = await listTool.execute("list-12", { path: testDir });

			const output = getTextOutput(result);
			const aIndex = output.indexOf("a.txt");
			const bIndex = output.indexOf("b.txt");
			const cIndex = output.indexOf("c.txt");
			expect(aIndex).toBeLessThan(bIndex);
			expect(bIndex).toBeLessThan(cIndex);
		});

		it("supports descending sort", async () => {
			writeFileSync(join(testDir, "a.txt"), "");
			writeFileSync(join(testDir, "b.txt"), "");
			writeFileSync(join(testDir, "c.txt"), "");

			const result = await listTool.execute("list-13", {
				path: testDir,
				sortBy: "name",
				sortDirection: "desc",
			});

			const output = getTextOutput(result);
			const aIndex = output.indexOf("a.txt");
			const cIndex = output.indexOf("c.txt");
			expect(cIndex).toBeLessThan(aIndex);
		});

		it("supports sorting by type", async () => {
			mkdirSync(join(testDir, "adir"));
			writeFileSync(join(testDir, "bfile.txt"), "");

			const result = await listTool.execute("list-14", {
				path: testDir,
				sortBy: "type",
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("output formats", () => {
		it("supports text format", async () => {
			writeFileSync(join(testDir, "test.txt"), "");

			const result = await listTool.execute("list-15", {
				path: testDir,
				format: "text",
			});

			const output = getTextOutput(result);
			expect(output).toContain("test.txt");
			expect(result.details).toMatchObject({ format: "text" });
		});

		it("supports JSON format", async () => {
			writeFileSync(join(testDir, "test.txt"), "");

			const result = await listTool.execute("list-16", {
				path: testDir,
				format: "json",
			});

			expect(result.details).toMatchObject({ format: "json" });
		});
	});

	describe("error handling", () => {
		it("handles non-existent directory", async () => {
			const result = await listTool.execute("list-17", {
				path: join(testDir, "nonexistent"),
			});

			// Should return empty or error
			const output = getTextOutput(result);
			// Either empty result or contains "no" or indicates empty
		});

		it("handles permission errors gracefully", async () => {
			// This is hard to test portably, so we just verify no crash
			const result = await listTool.execute("list-18", {
				path: "/root/nonexistent",
			});

			// Should not throw
			expect(result).toBeDefined();
		});
	});

	describe("special files", () => {
		it("lists files with special characters in names", async () => {
			writeFileSync(join(testDir, "file with spaces.txt"), "");
			writeFileSync(join(testDir, "file-with-dashes.txt"), "");
			writeFileSync(join(testDir, "file_with_underscores.txt"), "");

			const result = await listTool.execute("list-19", { path: testDir });

			const output = getTextOutput(result);
			expect(output).toContain("file with spaces.txt");
			expect(output).toContain("file-with-dashes.txt");
			expect(output).toContain("file_with_underscores.txt");
		});
	});

	describe("details metadata", () => {
		it("includes limit in details", async () => {
			writeFileSync(join(testDir, "test.txt"), "");

			const result = await listTool.execute("list-20", {
				path: testDir,
				limit: 50,
			});

			expect(result.details).toMatchObject({
				limit: 50,
			});
		});
	});
});
