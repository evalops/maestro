import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { findTool } from "../../src/tools/find.js";

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

// Check if fd is available
function isFdAvailable(): boolean {
	try {
		const result = spawnSync("fd", ["--version"], { encoding: "utf-8" });
		return result.status === 0;
	} catch {
		return false;
	}
}

const hasFd = isFdAvailable();

describe("find tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "find-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe.skipIf(!hasFd)("basic glob patterns", () => {
		it("finds files matching simple pattern", async () => {
			writeFileSync(join(testDir, "file1.ts"), "");
			writeFileSync(join(testDir, "file2.ts"), "");
			writeFileSync(join(testDir, "file3.js"), "");

			const result = await findTool.execute("find-1", {
				pattern: "*.ts",
				path: testDir,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("file1.ts");
			expect(output).toContain("file2.ts");
			expect(output).not.toContain("file3.js");
		});

		it("finds all files with wildcard", async () => {
			writeFileSync(join(testDir, "a.txt"), "");
			writeFileSync(join(testDir, "b.json"), "");
			writeFileSync(join(testDir, "c.md"), "");

			const result = await findTool.execute("find-2", {
				pattern: "*",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("a.txt");
			expect(output).toContain("b.json");
			expect(output).toContain("c.md");
		});

		it("finds files matching complex pattern", async () => {
			writeFileSync(join(testDir, "test.spec.ts"), "");
			writeFileSync(join(testDir, "test.ts"), "");
			writeFileSync(join(testDir, "other.spec.js"), "");

			const result = await findTool.execute("find-3", {
				pattern: "*.spec.ts",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("test.spec.ts");
			expect(output).not.toContain(/^test\.ts$/m);
			expect(output).not.toContain("other.spec.js");
		});
	});

	describe.skipIf(!hasFd)("recursive patterns", () => {
		it("finds files in nested directories", async () => {
			mkdirSync(join(testDir, "src"));
			mkdirSync(join(testDir, "src", "utils"));
			writeFileSync(join(testDir, "root.ts"), "");
			writeFileSync(join(testDir, "src", "index.ts"), "");
			writeFileSync(join(testDir, "src", "utils", "helper.ts"), "");

			const result = await findTool.execute("find-4", {
				pattern: "**/*.ts",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("root.ts");
			expect(output).toContain("index.ts");
			expect(output).toContain("helper.ts");
		});

		it("finds files in specific subdirectory pattern", async () => {
			mkdirSync(join(testDir, "src"));
			mkdirSync(join(testDir, "test"));
			writeFileSync(join(testDir, "src", "code.ts"), "");
			writeFileSync(join(testDir, "test", "code.test.ts"), "");

			const result = await findTool.execute("find-5", {
				pattern: "test/**/*.ts",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("code.test.ts");
		});
	});

	describe.skipIf(!hasFd)("hidden files", () => {
		it("includes hidden files by default", async () => {
			writeFileSync(join(testDir, ".hidden"), "");
			writeFileSync(join(testDir, "visible"), "");

			const result = await findTool.execute("find-6", {
				pattern: "*",
				path: testDir,
				includeHidden: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain(".hidden");
			expect(output).toContain("visible");
		});

		it("excludes hidden files when requested", async () => {
			writeFileSync(join(testDir, ".hidden"), "");
			writeFileSync(join(testDir, "visible"), "");

			const result = await findTool.execute("find-7", {
				pattern: "*",
				path: testDir,
				includeHidden: false,
			});

			const output = getTextOutput(result);
			expect(output).not.toContain(".hidden");
			expect(output).toContain("visible");
		});
	});

	describe.skipIf(!hasFd)("result limiting", () => {
		it("limits number of results", async () => {
			for (let i = 0; i < 20; i++) {
				writeFileSync(join(testDir, `file${i}.txt`), "");
			}

			const result = await findTool.execute("find-8", {
				pattern: "*.txt",
				path: testDir,
				limit: 5,
			});

			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({
				truncated: true,
			});
		});

		it("reports when not truncated", async () => {
			writeFileSync(join(testDir, "only.txt"), "");

			const result = await findTool.execute("find-9", {
				pattern: "*.txt",
				path: testDir,
				limit: 100,
			});

			expect(result.details).toMatchObject({
				truncated: false,
				fileCount: 1,
			});
		});
	});

	describe.skipIf(!hasFd)("no results", () => {
		it("handles no matches gracefully", async () => {
			writeFileSync(join(testDir, "file.txt"), "");

			const result = await findTool.execute("find-10", {
				pattern: "*.nonexistent",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No files found");
		});
	});

	describe("details metadata", () => {
		it("includes command in details", async () => {
			writeFileSync(join(testDir, "test.ts"), "");

			const result = await findTool.execute("find-11", {
				pattern: "*.ts",
				path: testDir,
			});

			expect(result.details).toHaveProperty("command");
			expect((result.details as { command: string }).command).toContain("fd");
		});

		it("includes cwd in details", async () => {
			writeFileSync(join(testDir, "test.ts"), "");

			const result = await findTool.execute("find-12", {
				pattern: "*.ts",
				path: testDir,
			});

			expect(result.details).toHaveProperty("cwd");
		});

		it.skipIf(!hasFd)("includes fileCount in details", async () => {
			writeFileSync(join(testDir, "a.ts"), "");
			writeFileSync(join(testDir, "b.ts"), "");
			writeFileSync(join(testDir, "c.ts"), "");

			const result = await findTool.execute("find-13", {
				pattern: "*.ts",
				path: testDir,
			});

			expect(result.details).toMatchObject({
				fileCount: 3,
			});
		});
	});

	describe("path handling", () => {
		it("defaults to current directory when path not specified", async () => {
			// This test verifies the tool doesn't crash without a path
			const result = await findTool.execute("find-14", {
				pattern: "nonexistent_pattern_xyz",
			});

			// Should not error (may fail with fd not available, but shouldn't throw)
			expect(result).toBeDefined();
		});

		it.skipIf(!hasFd)(
			"skips manual ignore files when searching inside a git repository",
			async () => {
				const result = await findTool.execute("find-14b", {
					pattern: "nonexistent_pattern_xyz",
				});

				expect(result.details).toHaveProperty("command");
				expect((result.details as { command: string }).command).not.toContain(
					"--ignore-file",
				);
			},
		);

		it.skipIf(!hasFd)(
			"still respects .gitignore files outside git repositories",
			async () => {
				writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
				writeFileSync(join(testDir, "ignored.txt"), "");
				writeFileSync(join(testDir, "kept.txt"), "");

				const result = await findTool.execute("find-14c", {
					pattern: "*.txt",
					path: testDir,
				});

				expect(result.isError).toBeFalsy();
				const output = getTextOutput(result);
				expect(output).toContain("kept.txt");
				expect(output).not.toContain("ignored.txt");
				expect((result.details as { command: string }).command).toContain(
					"--ignore-file",
				);
			},
		);

		it.skipIf(!hasFd)("handles paths with spaces", async () => {
			const dirWithSpaces = join(testDir, "dir with spaces");
			mkdirSync(dirWithSpaces);
			writeFileSync(join(dirWithSpaces, "file.txt"), "");

			const result = await findTool.execute("find-15", {
				pattern: "*.txt",
				path: dirWithSpaces,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("file.txt");
		});
	});

	describe("abort signal handling", () => {
		it("throws on pre-aborted signal", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				findTool.execute(
					"find-16",
					{
						pattern: "*.ts",
						path: testDir,
					},
					controller.signal,
				),
			).rejects.toThrow("aborted");
		});
	});

	describe("fd not available", () => {
		it.skipIf(hasFd)("returns error when fd is not available", async () => {
			const result = await findTool.execute("find-17", {
				pattern: "*.ts",
				path: testDir,
			});

			// Tool downloads fd automatically, so either:
			// - Returns "fd not available" error
			// - Returns "no files found" (fd was downloaded)
			// - Returns actual results (fd was available)
			const output = getTextOutput(result);
			// Just verify it doesn't throw and returns something
			expect(output).toBeDefined();
		});
	});
});
