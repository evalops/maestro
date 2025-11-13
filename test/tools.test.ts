import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";
import { diffTool } from "../src/tools/diff.js";
import { editTool } from "../src/tools/edit.js";
import { listTool } from "../src/tools/list.js";
import { readTool } from "../src/tools/read.js";
import { searchTool } from "../src/tools/search.js";
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
		testDir = join(tmpdir(), `composer-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
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
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			expect(getTextOutput(result)).not.toContain("more lines not shown");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			const result = await readTool.execute("test-call-2", { path: testFile });

			expect(getTextOutput(result)).toContain("Error");
			expect(getTextOutput(result)).toContain("File not found");
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("500 more lines not shown");
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
			expect(output.split("\n")[1].length).toBe(2000);
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

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			expect(output).not.toContain("more lines not shown");
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
			expect(output).not.toContain("Line 11");
			expect(output).toContain("90 more lines not shown");
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

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("40 more lines not shown");
			expect(output).toContain("Use offset=61 to continue reading");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-8", {
				path: testFile,
				offset: 100,
			});
			const output = getTextOutput(result);

			expect(output).toContain("Error: Offset 100 is beyond end of file");
			expect(output).toContain("3 lines total");
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
			expect(output).toContain("500 more lines not shown");
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
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", {
				path: testFile,
				content,
			});

			expect(getTextOutput(result)).toContain("Successfully wrote");
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

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
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

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					oldText: "foo",
					newText: "bar",
				}),
			).rejects.toThrow("Found 3 occurrences");
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
	});

	describe("todo tool", () => {
		it("produces a summary checklist with default statuses", async () => {
			const result = await todoTool.execute("todo-call-1", {
				goal: "Ship onboarding flow",
				items: [
					{ content: "Design onboarding screens" },
					{ content: "Implement API endpoints", status: "in_progress" },
				],
			});

			const output = getTextOutput(result);
			expect(output).toContain("Goal: Ship onboarding flow");
			expect(output).toContain("Summary:");
			expect(output).toContain("Pending: 1");
			expect(output).toContain("In Progress: 1");
			expect(output).toContain("Completed: 0");
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
			expect(output).toContain("(ID: payments-audit)");
			expect(output).toContain("(Priority: High)");
			expect(output).toContain("Due: 2025-11-20");
			expect(output).toContain("Notes: Coordinate with SRE for failover test");
			expect(output).toContain('Blocked by: "payments-audit"');
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
					{ content: "Review directory structure", priority: "high" },
					{ content: "Summarize findings", status: "completed" },
				],
				null,
				2,
			);

			const result = await todoTool.execute("todo-call-3", {
				goal: "Audit repository",
				items: itemsJson,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Goal: Audit repository");
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
