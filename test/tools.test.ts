import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import { diffTool } from "../src/tools/diff.js";
import { parseStatusOutput } from "../src/tools/diff.js";
import { editTool } from "../src/tools/edit.js";
import { batchTool, codingTools } from "../src/tools/index.js";
import { listTool } from "../src/tools/list.js";
import { readTool } from "../src/tools/read.js";
import { searchTool } from "../src/tools/search.js";
import { statusTool } from "../src/tools/status.js";
import { todoTool } from "../src/tools/todo.js";
import { writeTool } from "../src/tools/write.js";

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("Composer Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = mkdtempSync(join(tmpdir(), "composer-test-"));
		process.env.COMPOSER_TODO_FILE = join(testDir, "todos.json");
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
		process.env.COMPOSER_TODO_FILE = undefined;
	});

	describe("list tool", () => {
		it("lists directory contents with default options", async () => {
			writeFileSync(join(testDir, "a.txt"), "Hello");
			writeFileSync(join(testDir, "b.md"), "World");

			const result = await listTool.execute("list-call-1", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain("Directory:");
			expect(output).toContain("a.txt");
			expect(output).toContain("b.md");
		});

		it("respects glob patterns and limits", async () => {
			writeFileSync(join(testDir, "match-1.ts"), "");
			writeFileSync(join(testDir, "match-2.ts"), "");
			writeFileSync(join(testDir, "skip.js"), "");

			const result = await listTool.execute("list-call-2", {
				path: testDir,
				pattern: "match-*.ts",
				limit: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Pattern: match-*.ts");
			expect(output).toContain("Results: 1 of 2");
			expect(output).toMatch(/match-\d\.ts/);
			expect(output).not.toContain("skip.js");
		});

		it("includes hidden files when requested", async () => {
			writeFileSync(join(testDir, ".hidden"), "");
			writeFileSync(join(testDir, "visible"), "");

			const result = await listTool.execute("list-call-3", {
				path: testDir,
				includeHidden: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Including hidden files");
			expect(output).toContain(".hidden");
			expect(output).toContain("visible");
		});

		it("supports metadata, sorting, and json format", async () => {
			const older = join(testDir, "a.txt");
			const newerDir = join(testDir, "dir");
			writeFileSync(older, "123");
			mkdirSync(newerDir);

			const result = await listTool.execute("list-call-4", {
				path: testDir,
				includeMetadata: true,
				format: "json",
				sortBy: "type",
				sortDirection: "desc",
			});

			const output = getTextOutput(result);
			const jsonPayload = output.slice(output.indexOf("["));
			const parsed = JSON.parse(jsonPayload);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed[0]).toHaveProperty("type");
			expect(parsed[0]).toHaveProperty("size");
		});

		it("should handle errors in directory access", async () => {
			// Use an invalid path that will cause an error
			const invalidPath = "\0invalid";

			await expect(
				listTool.execute("list-call-5", { path: invalidPath }),
			).rejects.toThrow(/Listing.*failed/);
		});

		it("excludes files matching excludePatterns", async () => {
			const nodeModules = join(testDir, "node_modules");
			const src = join(testDir, "src");
			mkdirSync(nodeModules);
			mkdirSync(src);
			writeFileSync(join(nodeModules, "dep.js"), "");
			writeFileSync(join(src, "app.ts"), "");
			writeFileSync(join(testDir, "readme.md"), "");
			writeFileSync(join(testDir, "debug.log"), "");

			const result = await listTool.execute("list-exclude-1", {
				path: testDir,
				pattern: "**/*",
				excludePatterns: ["node_modules/**", "*.log"],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Excluding: node_modules/**, *.log");
			expect(output).toContain("src/");
			expect(output).toContain("readme.md");
			// node_modules directory itself may appear but contents should be excluded
			expect(output).not.toContain("dep.js");
			expect(output).not.toContain("debug.log");
		});

		it("excludePatterns works with multiple patterns", async () => {
			writeFileSync(join(testDir, "keep.ts"), "");
			writeFileSync(join(testDir, "skip.test.ts"), "");
			writeFileSync(join(testDir, "skip.spec.ts"), "");
			writeFileSync(join(testDir, "build.js"), "");

			const result = await listTool.execute("list-exclude-2", {
				path: testDir,
				excludePatterns: ["*.test.ts", "*.spec.ts"],
			});

			const output = getTextOutput(result);
			expect(output).toContain("keep.ts");
			expect(output).toContain("build.js");
			expect(output).not.toContain("skip.test.ts");
			expect(output).not.toContain("skip.spec.ts");
		});
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Hello, world!");
			expect(output).toContain("Line 3");
			expect(output).toContain("```");
			expect(result.details).toMatchObject({
				startLine: 1,
				endLine: 3,
				totalLines: 3,
			});
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(
				readTool.execute("test-call-2", { path: testFile }),
			).rejects.toThrow("File not found");
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).toContain("500 later lines not shown");
			expect(output).toContain("Use offset=2001 to continue reading");
		});

		it("should truncate long lines and show notice", async () => {
			const testFile = join(testDir, "long-lines.txt");
			const longLine = "a".repeat(3000);
			const content = `Short line\n${longLine}\nAnother short line`;
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Short line");
			expect(output).toContain("Another short line");
			expect(output).toContain("Some lines were truncated to 2000 characters");
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", {
				path: testFile,
				offset: 51,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			expect(result.details).toMatchObject({ startLine: 51, endLine: 100 });
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", {
				path: testFile,
				limit: 10,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).toContain("90 later lines not shown");
			expect(output).toContain("Use offset=11 to continue reading");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).toContain("40 later lines not shown");
			expect(output).toContain("Use offset=61 to continue reading");
			expect(result.details).toMatchObject({ startLine: 41, endLine: 60 });
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(
				readTool.execute("test-call-8", {
					path: testFile,
					offset: 100,
				}),
			).rejects.toThrow(/Offset 100 is beyond end of file.*3 lines total/);
		});

		it("should show both truncation notices when applicable", async () => {
			const testFile = join(testDir, "both-truncations.txt");
			const longLine = "b".repeat(3000);
			const lines = Array.from({ length: 2500 }, (_, i) =>
				i === 500 ? longLine : `Line ${i + 1}`,
			);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Some lines were truncated to 2000 characters");
			expect(output).toContain("500 later lines not shown");
		});

		it("supports tail mode for log-style reads", async () => {
			const testFile = join(testDir, "tail.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-10", {
				path: testFile,
				mode: "tail",
				limit: 5,
				lineNumbers: false,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("| Line");
			expect(output).toContain("Line 46");
			expect(output).toContain("Line 50");
			expect(output).toContain("Showing last 5 line(s)");
		});

		it("supports latin1 encoding for legacy files", async () => {
			const testFile = join(testDir, "latin1.txt");
			// Write bytes that represent latin1 characters (e.g., accented chars)
			const latin1Content = Buffer.from([
				0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0xe8, 0xe0,
			]); // "Hello ééà" in latin1
			writeFileSync(testFile, latin1Content);

			const result = await readTool.execute("test-read-latin1", {
				path: testFile,
				encoding: "latin1",
			});
			const output = getTextOutput(result);

			// latin1 decoding should preserve the high bytes as single characters
			expect(output).toContain("Hello");
			expect(output).toContain("\u00e9"); // é
		});

		it("defaults to utf-8 encoding", async () => {
			const testFile = join(testDir, "utf8.txt");
			const utf8Content = "Hello 世界 🌍";
			writeFileSync(testFile, utf8Content, "utf-8");

			const result = await readTool.execute("test-read-utf8", {
				path: testFile,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Hello 世界 🌍");
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", {
				path: testFile,
				content,
			});

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toMatchObject({
				previousExists: false,
				bytesWritten: content.length,
				diff: undefined,
				backupPath: undefined,
			});
		});

		it("should create parent directories and produce diff + backup metadata", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", {
				path: testFile,
				content,
			});

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(result.details).toMatchObject({
				previousExists: false,
				bytesWritten: content.length,
				diff: undefined,
				backupPath: undefined,
			});

			const updatedContent = "Updated content";
			const secondResult = await writeTool.execute("test-call-4b", {
				path: testFile,
				content: updatedContent,
			});

			expect(secondResult.details).toMatchObject({
				previousExists: true,
				bytesWritten: updatedContent.length,
				diff: expect.stringContaining("-1 Nested content"),
				backupPath: `${testFile}.bak`,
			});
			expect(existsSync(`${testFile}.bak`)).toBe(true);
		});

		it("skips backups and diffs when disabled", async () => {
			const testFile = join(testDir, "write-skip-bak.txt");
			writeFileSync(testFile, "before");

			const result = await writeTool.execute("test-call-4c", {
				path: testFile,
				content: "after",
				backup: false,
				previewDiff: false,
			});

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(existsSync(`${testFile}.bak`)).toBe(false);
			expect(result.details).toMatchObject({
				previousExists: true,
				bytesWritten: "after".length,
				diff: undefined,
				backupPath: undefined,
			});
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				oldText: "world",
				newText: "testing",
			});

			expect(getTextOutput(result)).toContain("Successfully edited");
			expect(result.details).toBeDefined();
			expect(result.details?.diff).toBe("-1 Hello, world!\n+1 Hello, testing!");
		});

		it("includes surrounding context in diff output", async () => {
			const testFile = join(testDir, "context-edit.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\nepsilon");

			const result = await editTool.execute("test-call-ctx", {
				path: testFile,
				oldText: "gamma",
				newText: "gamma-updated",
			});

			expect(result.details?.diff).toBe(
				" 1 alpha\n 2 beta\n-3 gamma\n+3 gamma-updated\n 4 delta\n 5 epsilon",
			);
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					oldText: "nonexistent",
					newText: "testing",
				}),
			).rejects.toThrow("Could not find the exact text");
		});

		it("replaces the first occurrence by default when multiple matches exist", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "foo foo foo");

			await editTool.execute("test-call-7", {
				path: testFile,
				oldText: "foo",
				newText: "bar",
			});

			const updated = readFileSync(testFile, "utf-8");
			expect(updated).toBe("bar foo foo");
		});

		it("supports selecting a specific occurrence", async () => {
			const testFile = join(testDir, "edit-specific.txt");
			writeFileSync(testFile, "foo foo foo");

			await editTool.execute("test-call-7b", {
				path: testFile,
				oldText: "foo",
				newText: "bar",
				occurrence: 2,
			});

			const updated = readFileSync(testFile, "utf-8");
			expect(updated).toBe("foo bar foo");
		});

		it("supports dryRun without touching disk", async () => {
			const testFile = join(testDir, "edit-dry.txt");
			writeFileSync(testFile, "alpha beta");

			const result = await editTool.execute("test-call-7c", {
				path: testFile,
				oldText: "beta",
				newText: "gamma",
				dryRun: true,
			});

			expect(getTextOutput(result)).toContain("Dry run");
			expect(result.details?.diff).toContain("-1 alpha beta");
			const onDisk = readFileSync(testFile, "utf-8");
			expect(onDisk).toBe("alpha beta");
		});

		it("replaces all occurrences when replaceAll is true", async () => {
			const testFile = join(testDir, "edit-replace-all.txt");
			writeFileSync(testFile, "foo foo foo bar foo");

			const result = await editTool.execute("test-call-replace-all", {
				path: testFile,
				oldText: "foo",
				newText: "baz",
				replaceAll: true,
			});

			const updated = readFileSync(testFile, "utf-8");
			expect(updated).toBe("baz baz baz bar baz");
			expect(getTextOutput(result)).toContain("all 4 occurrence(s)");
		});

		it("replaceAll works with dryRun", async () => {
			const testFile = join(testDir, "edit-replace-all-dry.txt");
			writeFileSync(testFile, "cat cat dog cat");

			const result = await editTool.execute("test-call-replace-all-dry", {
				path: testFile,
				oldText: "cat",
				newText: "bird",
				replaceAll: true,
				dryRun: true,
			});

			expect(getTextOutput(result)).toContain("Dry run");
			expect(getTextOutput(result)).toContain("all occurrences");
			const onDisk = readFileSync(testFile, "utf-8");
			expect(onDisk).toBe("cat cat dog cat");
		});

		it("throws error when replaceAll and occurrence are both specified", async () => {
			const testFile = join(testDir, "edit-conflict.txt");
			writeFileSync(testFile, "foo foo foo");

			await expect(
				editTool.execute("test-call-conflict", {
					path: testFile,
					oldText: "foo",
					newText: "bar",
					replaceAll: true,
					occurrence: 2,
				}),
			).rejects.toThrow("Cannot use both replaceAll and occurrence");
		});

		it("replaceAll can delete all occurrences with empty newText", async () => {
			const testFile = join(testDir, "edit-delete-all.txt");
			writeFileSync(testFile, "removeMe keep removeMe keep removeMe end");

			await editTool.execute("test-call-delete-all", {
				path: testFile,
				oldText: "removeMe ",
				newText: "",
				replaceAll: true,
			});

			const updated = readFileSync(testFile, "utf-8");
			expect(updated).toBe("keep keep end");
		});

		it("rejects too many replacements to prevent DoS", async () => {
			const testFile = join(testDir, "edit-many-matches.txt");
			// Create a file with more than 10000 occurrences of "a"
			writeFileSync(testFile, "a".repeat(10001));

			await expect(
				editTool.execute("test-call-too-many", {
					path: testFile,
					oldText: "a",
					newText: "b",
					replaceAll: true,
				}),
			).rejects.toThrow("Too many replacements");
		});

		it("supports edits array for multiple sequential edits", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "const foo = 1;\nconst bar = 2;\nconst baz = 3;");
			const result = await editTool.execute("test-call-multi-edit", {
				path: testFile,
				edits: [
					{ oldText: "const foo = 1", newText: "const foo = 10" },
					{ oldText: "const bar = 2", newText: "const bar = 20" },
				],
			});
			const updated = readFileSync(testFile, "utf-8");
			expect(updated).toBe("const foo = 10;\nconst bar = 20;\nconst baz = 3;");
			expect(getTextOutput(result)).toContain("2 edit(s)");
			expect(result.details?.editsApplied).toBe(2);
		});

		it("edits array fails atomically if any edit fails", async () => {
			const testFile = join(testDir, "edit-multi-fail.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma");
			await expect(
				editTool.execute("test-call-multi-fail", {
					path: testFile,
					edits: [
						{ oldText: "alpha", newText: "ALPHA" },
						{ oldText: "nonexistent", newText: "X" },
					],
				}),
			).rejects.toThrow("Edit #2");
			// File should remain unchanged since the operation failed
			const onDisk = readFileSync(testFile, "utf-8");
			expect(onDisk).toBe("alpha\nbeta\ngamma");
		});

		it("rejects mixing oldText with edits array", async () => {
			const testFile = join(testDir, "edit-mixed.txt");
			writeFileSync(testFile, "test");
			await expect(
				editTool.execute("test-call-mixed", {
					path: testFile,
					oldText: "test",
					newText: "TEST",
					edits: [{ oldText: "test", newText: "TEST" }],
				}),
			).rejects.toThrow("Cannot use both");
		});

		it("edits array allows omitting newText for deletions", async () => {
			const testFile = join(testDir, "edit-delete.txt");
			writeFileSync(testFile, "keep DELETE keep");
			const result = await editTool.execute("test-call-delete", {
				path: testFile,
				edits: [{ oldText: "DELETE " }],
			});
			const updated = readFileSync(testFile, "utf-8");
			expect(updated).toBe("keep keep");
			expect(getTextOutput(result)).toContain("1 edit(s)");
		});

		it("rejects newText provided with edits array", async () => {
			const testFile = join(testDir, "edit-newtext-edits.txt");
			writeFileSync(testFile, "test");
			await expect(
				editTool.execute("test-call-newtext-edits", {
					path: testFile,
					newText: "ignored",
					edits: [{ oldText: "test", newText: "TEST" }],
				}),
			).rejects.toThrow("Cannot use both");
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", {
				command: "echo 'test output'",
			});

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			const result = await bashTool.execute("test-call-9", {
				command: "exit 1",
			});

			expect(getTextOutput(result)).toContain("Command failed");
		});

		it("should respect timeout", async () => {
			const timeoutSeconds = 1;
			const result = await bashTool.execute("test-call-10", {
				command: "sleep 5",
				timeout: timeoutSeconds,
			});

			expect(getTextOutput(result)).toContain(
				`Command timed out after ${timeoutSeconds} seconds`,
			);
		});

		it("should honor the cwd option", async () => {
			const subDir = join(testDir, "nested");
			mkdirSync(subDir);
			const result = await bashTool.execute("test-call-10b", {
				command: "pwd",
				cwd: subDir,
			});

			const normalizedOutput = getTextOutput(result).trim();
			expect(normalizedOutput).toBe(realpathSync(subDir));
		});

		it("should merge custom environment variables", async () => {
			const result = await bashTool.execute("test-call-10c", {
				command: "echo $BASH_TOOL_TEST_VAR",
				env: { BASH_TOOL_TEST_VAR: "from-bash" },
			});

			expect(getTextOutput(result)).toContain("from-bash");
		});
	});

	describe("diff tool", () => {
		const tempFile = join(process.cwd(), "tmp-diff-tool.txt");

		afterEach(() => {
			try {
				execSync(`git reset HEAD -- "${tempFile}"`, { stdio: "ignore" });
			} catch (error) {
				// Ignore reset errors (file may not be staged)
			}
			if (existsSync(tempFile)) {
				rmSync(tempFile, { force: true });
			}
		});

		it("shows staged changes for new files", async () => {
			writeFileSync(tempFile, "diff staged example\n");
			execSync(`git add "${tempFile}"`);

			const result = await diffTool.execute("diff-call-1", {
				staged: true,
				paths: tempFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("diff --git");
			expect(output).toContain("tmp-diff-tool.txt");
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("git diff"),
				}),
			);
		});

		it("shows workspace changes with context", async () => {
			writeFileSync(tempFile, "Original line\n");
			execSync(`git add "${tempFile}"`);
			writeFileSync(tempFile, "Original line\nUpdated line\n");

			const result = await diffTool.execute("diff-call-2", {
				context: 2,
				paths: tempFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Updated line");
			expect(output).toContain("Original line");
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("git diff"),
				}),
			);
		});

		it("reports when no changes are detected", async () => {
			const result = await diffTool.execute("diff-call-3", {
				paths: tempFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain(
				"No changes found for the selected diff options.",
			);
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("git diff"),
				}),
			);
		});

		it("uses --ignore-space-change flag when ignoreWhitespace is true", async () => {
			writeFileSync(tempFile, "line one\nline two\n");
			execSync(`git add "${tempFile}"`);
			writeFileSync(tempFile, "line one\nline   two\n"); // extra spaces

			const result = await diffTool.execute("diff-whitespace", {
				ignoreWhitespace: true,
				paths: tempFile,
			});

			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("--ignore-space-change"),
				}),
			);
		});

		it("uses --ignore-blank-lines flag when ignoreBlankLines is true", async () => {
			writeFileSync(tempFile, "first\nsecond\n");
			execSync(`git add "${tempFile}"`);
			writeFileSync(tempFile, "first\n\n\nsecond\n"); // extra blank lines

			const result = await diffTool.execute("diff-blanklines", {
				ignoreBlankLines: true,
				paths: tempFile,
			});

			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("--ignore-blank-lines"),
				}),
			);
		});

		it("shows structured git status with untracked files", async () => {
			const statusFile = `tmp-diff-status-${Date.now()}.txt`;
			const statusPath = join(process.cwd(), statusFile);
			writeFileSync(statusPath, "status test\n");

			const result = await statusTool.execute("status-1", {
				paths: statusFile,
			});

			const parsed = (result.details as any)?.status ?? {};

			expect(getTextOutput(result)).toContain("Branch:");
			expect(parsed.files).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "untracked", path: statusFile }),
				]),
			);
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("git status --porcelain=v2 -z -b"),
					status: parsed,
				}),
			);

			rmSync(statusPath, { force: true });
		});

		it("omits branch summary flag when disabled", async () => {
			const result = await statusTool.execute("status-2", {
				branchSummary: false,
			});

			const parsed = (result.details as any)?.status ?? {};

			expect(parsed.branch).toBeUndefined();
			expect(getTextOutput(result)).not.toContain("Branch:");
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("git status --porcelain=v2 -z"),
				}),
			);
			expect((result.details as any).command).not.toContain("-b");
		});

		it("captures rename entries in status mode", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-rename-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				execSync("git config user.email test@example.com");
				execSync("git config user.name tester");
				writeFileSync("old.txt", "rename me\n");
				execSync("git add old.txt");
				execSync("git commit -q -m init");
				execSync("git mv old.txt new.txt");

				const result = await statusTool.execute("status-rename", {});

				const parsed = (result.details as any)?.status ?? {};
				const renameEntry = parsed.files.find(
					(f: any) =>
						f.kind === "rename" &&
						f.path === "new.txt" &&
						f.origPath === "old.txt",
				);

				expect(renameEntry).toBeDefined();
				expect(renameEntry?.score).toBe(100);
				expect((result.details as any).command).toContain(
					"git status --porcelain=v2 -z -b",
				);
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("preserves consecutive spaces in rename paths", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-rename-spaces-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				execSync("git config user.email test@example.com");
				execSync("git config user.name tester");
				const oldPath = "old  name.txt";
				const newPath = "new  name.txt";
				writeFileSync(oldPath, "rename me\n");
				execSync(`git add "${oldPath}"`);
				execSync("git commit -q -m init");
				execSync(`git mv "${oldPath}" "${newPath}"`);

				const result = await statusTool.execute("status-rename-spaces", {});
				const parsed = (result.details as any)?.status ?? {};
				const renameEntry = parsed.files.find(
					(f: any) =>
						f.kind === "rename" && f.path === newPath && f.origPath === oldPath,
				);

				expect(renameEntry).toBeDefined();
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("parses unmerged entries", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-unmerged-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				execSync("git config user.email test@example.com");
				execSync("git config user.name tester");
				writeFileSync("file.txt", "base\n");
				execSync("git add file.txt");
				execSync("git commit -q -m base");
				const baseBranch = execSync("git rev-parse --abbrev-ref HEAD")
					.toString()
					.trim();
				execSync("git checkout -b branch-a");
				writeFileSync("file.txt", "branch-a\n");
				execSync("git commit -am change-a");
				execSync(`git checkout ${baseBranch}`);
				writeFileSync("file.txt", "branch-main\n");
				execSync("git commit -am change-main");
				try {
					execSync("git merge branch-a", { stdio: "ignore" });
				} catch {
					// expected merge conflict
				}

				const result = await statusTool.execute("status-unmerged", {});

				const parsed = (result.details as any)?.status ?? {};
				const unmerged = parsed.files.find((f: any) => f.kind === "unmerged");
				expect(unmerged).toBeDefined();
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("parses ignored entries", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-ignored-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				writeFileSync(".gitignore", "*.log\n");
				writeFileSync("app.log", "ignore me\n");

				const result = await statusTool.execute("status-ignored", {
					includeIgnored: true,
				});

				const parsed = (result.details as any)?.status ?? {};
				const ignored = parsed.files.find(
					(f: any) => f.kind === "ignored" && f.path === "app.log",
				);
				expect(ignored).toBeDefined();
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("handles detached HEAD branch info", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-detached-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				execSync("git config user.email test@example.com");
				execSync("git config user.name tester");
				writeFileSync("file.txt", "base\n");
				execSync("git add file.txt");
				execSync("git commit -q -m base");
				execSync("git checkout HEAD~0 --detach", { stdio: "ignore" });

				const result = await statusTool.execute("status-detached", {});

				expect(getTextOutput(result)).toContain("Branch: (detached)");
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("parses filenames with spaces", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-spaces-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				writeFileSync("file with space.txt", "hi\n");

				const result = await statusTool.execute("status-spaces", {
					paths: "file with space.txt",
				});

				const parsed = (result.details as any)?.status ?? {};
				const entry = parsed.files.find(
					(f: any) => f.path === "file with space.txt",
				);
				expect(entry).toBeDefined();
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("throws on unknown status entries", () => {
			expect(() => parseStatusOutput("X mystery\0")).toThrow();
		});

		it("parses copy entries (parser)", () => {
			const raw =
				"2 C. N... 100644 100644 100644 45b983be 45b983be C050 new.txt\0old.txt\0";
			const parsed = parseStatusOutput(raw);
			const entry = parsed.files.find((f: any) => f.path === "new.txt");
			expect(entry).toEqual(
				expect.objectContaining({
					kind: "rename",
					origPath: "old.txt",
					score: 50,
					isCopy: true,
				}),
			);
		});

		it("reports branch names with special characters", async () => {
			const originalCwd = process.cwd();
			const tempRepo = mkdtempSync(join(tmpdir(), "composer-branchchars-"));
			process.chdir(tempRepo);
			try {
				execSync("git init -q");
				execSync("git config user.email test@example.com");
				execSync("git config user.name tester");
				execSync("git checkout -b feature.with+chars");
				writeFileSync("file.txt", "hi\n");

				const result = await statusTool.execute("status-branchchars", {});

				expect(getTextOutput(result)).toContain("feature.with+chars");
			} finally {
				process.chdir(originalCwd);
				execSync(`rm -rf "${tempRepo}"`);
			}
		});

		it("throws on malformed type1 entry", () => {
			expect(() => parseStatusOutput("1 X \0")).toThrow();
		});

		// diff tool no longer supports status mode
	});

	describe("search tool", () => {
		it("finds matches with optional glob and context", async () => {
			const searchFile = join(testDir, "search-fixture.ts");
			writeFileSync(
				searchFile,
				"export function alpha() {}\n// TODO: implement beta\nconst gamma = 42;\n",
			);

			const result = await searchTool.execute("search-call-1", {
				pattern: "beta",
				paths: searchFile,
				glob: "*.ts",
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("search-fixture.ts");
			expect(output).toMatch(/\d+:\/\/ TODO: implement beta/);
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("rg"),
				}),
			);
		});

		it("returns a friendly message when no matches are found", async () => {
			const result = await searchTool.execute("search-call-2", {
				pattern: "no-such-pattern",
				paths: testDir,
				ignoreCase: true,
			});

			expect(getTextOutput(result)).toBe("No matches found.");
			expect(result.details).toEqual(
				expect.objectContaining({
					command: expect.stringContaining("rg"),
				}),
			);
		});

		it("supports includeHidden and json format", async () => {
			const hiddenFile = join(testDir, ".secret.txt");
			writeFileSync(hiddenFile, "needle");

			const result = await searchTool.execute("search-call-3", {
				pattern: "needle",
				paths: testDir,
				includeHidden: true,
				format: "json",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Found 1 match");
			expect(result.details).toMatchObject({ format: "json" });
			expect(result.details?.matches?.[0]?.file).toContain(".secret.txt");
		});

		it("respects cwd paths that include a tilde", async () => {
			const homeScopedDir = mkdtempSync(join(homedir(), "composer-search-"));
			const fixture = join(homeScopedDir, "cwd-file.txt");
			writeFileSync(fixture, "home-needle");
			const tildePath = homeScopedDir.replace(homedir(), "~");

			try {
				const result = await searchTool.execute("search-call-4", {
					pattern: "home-needle",
					cwd: tildePath,
					paths: ".",
				});

				const output = getTextOutput(result);
				expect(output).toContain("cwd-file.txt");
				expect(result.details).toMatchObject({ cwd: homeScopedDir });
			} finally {
				rmSync(homeScopedDir, { recursive: true, force: true });
			}
		});

		it("outputMode: files lists only file paths containing matches", async () => {
			const file1 = join(testDir, "filesonly-a.txt");
			const file2 = join(testDir, "filesonly-b.txt");
			const file3 = join(testDir, "filesonly-c.txt");
			writeFileSync(file1, "has needle here");
			writeFileSync(file2, "no special content");
			writeFileSync(file3, "also has needle");

			const result = await searchTool.execute("search-filesonly", {
				pattern: "needle",
				paths: testDir,
				glob: "filesonly-*.txt",
				outputMode: "files",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Found 2 file(s)");
			expect(output).toContain("filesonly-a.txt");
			expect(output).toContain("filesonly-c.txt");
			expect(output).not.toContain("filesonly-b.txt");
			expect(result.details).toMatchObject({
				format: "files",
				fileCount: 2,
			});
		});

		it("outputMode: count shows match counts per file", async () => {
			const countFile = join(testDir, "count-test.txt");
			writeFileSync(countFile, "foo bar foo\nfoo baz\nbar foo foo");

			const result = await searchTool.execute("search-count", {
				pattern: "foo",
				paths: countFile,
				outputMode: "count",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Found 5 match(es)");
			expect(output).toContain("count-test.txt: 5");
			expect(result.details).toMatchObject({
				format: "count",
				totalMatches: 5,
				fileCount: 1,
			});
		});

		it("invertMatch shows lines NOT matching the pattern", async () => {
			const invertFile = join(testDir, "invert-test.txt");
			writeFileSync(invertFile, "line one\nkeep this\nline two\nkeep also");

			const result = await searchTool.execute("search-invert", {
				pattern: "^line",
				paths: invertFile,
				invertMatch: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("keep this");
			expect(output).toContain("keep also");
			expect(output).not.toContain("line one");
			expect(output).not.toContain("line two");
		});

		it("onlyMatching shows just the matched text", async () => {
			const onlyFile = join(testDir, "only-match.txt");
			writeFileSync(onlyFile, "prefix-target-suffix\nother-target-end");

			const result = await searchTool.execute("search-only", {
				pattern: "target",
				paths: onlyFile,
				onlyMatching: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("target");
			expect(output).not.toContain("prefix");
			expect(output).not.toContain("suffix");
		});

		it("throws when context is used with outputMode: files", async () => {
			await expect(
				searchTool.execute("search-context-files", {
					pattern: "test",
					paths: testDir,
					outputMode: "files",
					context: 2,
				}),
			).rejects.toThrow("Context options can only be used with outputMode");
		});

		it("throws when context: 0 is used with outputMode: count", async () => {
			await expect(
				searchTool.execute("search-context-zero-count", {
					pattern: "test",
					paths: testDir,
					outputMode: "count",
					context: 0,
				}),
			).rejects.toThrow("Context options can only be used with outputMode");
		});

		it("throws when JSON format is used with outputMode: files", async () => {
			await expect(
				searchTool.execute("search-json-files", {
					pattern: "test",
					paths: testDir,
					outputMode: "files",
					format: "json",
				}),
			).rejects.toThrow("JSON format is not supported with outputMode");
		});

		it("throws when JSON format is used with outputMode: count", async () => {
			await expect(
				searchTool.execute("search-json-count", {
					pattern: "test",
					paths: testDir,
					outputMode: "count",
					format: "json",
				}),
			).rejects.toThrow("JSON format is not supported with outputMode");
		});

		it("throws when onlyMatching is used with outputMode: files", async () => {
			await expect(
				searchTool.execute("search-onlymatching-files", {
					pattern: "test",
					paths: testDir,
					outputMode: "files",
					onlyMatching: true,
				}),
			).rejects.toThrow("onlyMatching can only be used with outputMode");
		});

		it("headLimit truncates output in files mode", async () => {
			for (let i = 1; i <= 5; i++) {
				writeFileSync(join(testDir, `headlimit-${i}.txt`), "match content");
			}

			const result = await searchTool.execute("search-headlimit-files", {
				pattern: "match",
				paths: testDir,
				glob: "headlimit-*.txt",
				outputMode: "files",
				headLimit: 2,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Found 5 file(s)");
			expect(output).toContain("showing 2 of 5 files");
			expect(result.details).toMatchObject({
				fileCount: 5,
				truncated: true,
			});
		});

		it("headLimit truncates output in content mode", async () => {
			const multilineFile = join(testDir, "headlimit-content.txt");
			writeFileSync(
				multilineFile,
				"line1 match\nline2 match\nline3 match\nline4 match\nline5 match",
			);

			const result = await searchTool.execute("search-headlimit-content", {
				pattern: "match",
				paths: multilineFile,
				headLimit: 2,
			});

			const output = getTextOutput(result);
			expect(output).toContain("showing 2 of 5 lines");
			expect(result.details).toMatchObject({
				truncated: true,
			});
		});

		it("headLimit truncates output in count mode", async () => {
			for (let i = 1; i <= 4; i++) {
				writeFileSync(join(testDir, `headcount-${i}.txt`), "foo foo foo");
			}

			const result = await searchTool.execute("search-headlimit-count", {
				pattern: "foo",
				paths: testDir,
				glob: "headcount-*.txt",
				outputMode: "count",
				headLimit: 2,
			});

			const output = getTextOutput(result);
			expect(output).toContain("showing 2 of 4 files");
			expect(result.details).toMatchObject({
				fileCount: 4,
				truncated: true,
			});
		});
	});

	describe("todo tool", () => {
		it("produces a summary checklist with default statuses", async () => {
			const result = await todoTool.execute("todo-call-1", {
				goal: "Ship onboarding flow",
				items: [
					{ id: "design", content: "Design onboarding screens" },
					{
						id: "api",
						content: "Implement API endpoints",
						status: "in_progress",
					},
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Goal");
			expect(output).toContain("Progress");
			expect(output).toContain("Checklist");
			expect(output).toMatch(/1\. \[ \] Design onboarding screens/);
			expect(output).toMatch(/2\. \[~\] Implement API endpoints/);
			expect(result.details).toEqual(
				expect.objectContaining({
					pending: 1,
					in_progress: 1,
					completed: 0,
					total: 2,
					items: expect.any(Array),
				}),
			);
		});

		it("includes extended metadata when supplied", async () => {
			const result = await todoTool.execute("todo-call-2", {
				goal: "Stabilize payments pipeline",
				items: [
					{
						id: "payments-audit",
						content: "Audit webhook retries",
						priority: "high",
						status: "in_progress",
						due: "2025-11-20",
						notes: "Coordinate with SRE for failover test",
					},
					{
						id: "payments-metrics",
						content: "Add Grafana alerts",
						priority: "medium",
						status: "completed",
						blockedBy: ["payments-audit"],
					},
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Goal");
			expect(output).toContain("Progress");
			expect(output).toMatch(/Due: 2025-11-20/);
			expect(output).toMatch(/Notes: Coordinate with SRE for failover test/);
			expect(output).toMatch(/Blocked by: "payments-audit"/);
			expect(output).toMatch(/1\. \[~\] Audit webhook retries/);
			expect(output).toMatch(/2\. \[x\] Add Grafana alerts/);
			expect(result.details).toEqual(
				expect.objectContaining({
					pending: 0,
					in_progress: 1,
					completed: 1,
					total: 2,
					items: expect.any(Array),
				}),
			);
		});

		it("parses JSON string payloads", async () => {
			const itemsJson = JSON.stringify(
				[
					{
						id: "struct",
						content: "Review directory structure",
						priority: "high",
					},
					{
						id: "summary",
						content: "Summarize findings",
						status: "completed",
					},
				],
				null,
				2,
			);

			const result = await todoTool.execute("todo-call-3", {
				goal: "Audit repository",
				items: itemsJson,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Goal");
			expect(output).toMatch(/1\. \[ \] Review directory structure/);
			expect(output).toMatch(/2\. \[x\] Summarize findings/);
			expect(result.details).toEqual(
				expect.objectContaining({
					pending: 1,
					in_progress: 0,
					completed: 1,
					total: 2,
					items: expect.any(Array),
				}),
			);
		});

		it("updates existing tasks via ids", async () => {
			const goal = "Launch mobile app";
			await todoTool.execute("todo-call-4", {
				goal,
				items: [
					{ id: "design", content: "Finalize UI mockups", priority: "high" },
					{
						id: "qa",
						content: "Complete regression suite",
						status: "in_progress",
					},
				],
			});

			const updated = await todoTool.execute("todo-call-5", {
				goal,
				updates: [
					{
						id: "design",
						status: "completed",
						notes: "Approved by design team",
					},
					{ id: "qa", status: "completed" },
				],
			});

			const output = getTextOutput(updated);
			expect(output).toMatch(/1\. \[x\] Finalize UI mockups/);
			expect(output).toMatch(/Notes: Approved by design team/);
			expect(output).toMatch(/2\. \[x\] Complete regression suite/);
			expect(updated.details).toEqual(
				expect.objectContaining({
					pending: 0,
					in_progress: 0,
					completed: 2,
					total: 2,
					items: expect.arrayContaining([
						expect.objectContaining({ id: "design", status: "completed" }),
						expect.objectContaining({ id: "qa", status: "completed" }),
					]),
				}),
			);
		});
	});
});
describe("codingTools bundle", () => {
	it("exposes every built-in tool", () => {
		const toolNames = codingTools.map((tool) => tool.name);
		expect(toolNames).toEqual([
			"batch",
			"read",
			"list",
			"search",
			"diff",
			"bash",
			"background_tasks",
			"edit",
			"write",
			"todo",
			"websearch",
			"codesearch",
			"webfetch",
			"status",
			"gh_pr",
			"gh_issue",
			"gh_repo",
		]);
	});

	it("makes status available through batch", async () => {
		const result = await batchTool.execute("batch-status", {
			toolCalls: [{ tool: "status", parameters: {} }],
			mode: "serial",
		});

		const details = result.details as any;
		expect(details?.results?.[0]).toMatchObject({
			tool: "status",
			success: true,
		});
	});
});
