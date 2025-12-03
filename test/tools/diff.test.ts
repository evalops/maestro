import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { diffTool } from "../../src/tools/diff.js";
import { parseStatusOutput } from "../../src/tools/diff.js";

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

// Helper to run git commands in test directory
function git(testDir: string, ...args: string[]): string {
	return execSync(`git ${args.join(" ")}`, {
		cwd: testDir,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

describe("diff tool", () => {
	let testDir: string;
	let originalCwd: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "diff-tool-test-"));
		originalCwd = process.cwd();

		// Initialize git repo
		git(testDir, "init");
		git(testDir, "config", "user.email", "test@test.com");
		git(testDir, "config", "user.name", "Test");

		// Create initial commit
		writeFileSync(join(testDir, "file.txt"), "initial content\n");
		git(testDir, "add", ".");
		git(testDir, "commit", "-m", "initial");

		// Change to test directory for diff tool
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic diff", () => {
		it("shows working tree changes", async () => {
			writeFileSync(join(testDir, "file.txt"), "modified content\n");

			const result = await diffTool.execute("diff-1", {});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("-initial content");
			expect(output).toContain("+modified content");
		});

		it("shows no changes message when clean", async () => {
			const result = await diffTool.execute("diff-2", {});

			const output = getTextOutput(result);
			expect(output).toContain("No changes");
		});

		it("includes file path in diff output", async () => {
			writeFileSync(join(testDir, "file.txt"), "changed\n");

			const result = await diffTool.execute("diff-3", {});

			const output = getTextOutput(result);
			expect(output).toContain("file.txt");
		});
	});

	describe("staged changes", () => {
		it("shows staged changes with staged option", async () => {
			writeFileSync(join(testDir, "file.txt"), "staged content\n");
			git(testDir, "add", "file.txt");

			const result = await diffTool.execute("diff-4", {
				staged: true,
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("-initial content");
			expect(output).toContain("+staged content");
		});

		it("shows nothing when no staged changes", async () => {
			writeFileSync(join(testDir, "file.txt"), "unstaged\n");
			// Don't stage the changes

			const result = await diffTool.execute("diff-5", {
				staged: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No changes");
		});
	});

	describe("revision range", () => {
		it("shows diff for specific range", async () => {
			// Make another commit
			writeFileSync(join(testDir, "file.txt"), "second commit\n");
			git(testDir, "add", ".");
			git(testDir, "commit", "-m", "second");

			const result = await diffTool.execute("diff-6", {
				range: "HEAD~1..HEAD",
			});

			const output = getTextOutput(result);
			expect(output).toContain("-initial content");
			expect(output).toContain("+second commit");
		});

		it("shows diff against HEAD", async () => {
			writeFileSync(join(testDir, "file.txt"), "working changes\n");

			const result = await diffTool.execute("diff-7", {
				range: "HEAD",
			});

			const output = getTextOutput(result);
			expect(output).toContain("-initial content");
			expect(output).toContain("+working changes");
		});
	});

	describe("context lines", () => {
		it("shows custom context lines", async () => {
			const content = [
				"line 1",
				"line 2",
				"line 3",
				"line 4",
				"change me",
				"line 6",
				"line 7",
				"line 8",
			].join("\n");
			writeFileSync(join(testDir, "file.txt"), `${content}\n`);
			git(testDir, "add", ".");
			git(testDir, "commit", "-m", "multi-line");

			writeFileSync(
				join(testDir, "file.txt"),
				`${content.replace("change me", "changed")}\n`,
			);

			const result = await diffTool.execute("diff-8", {
				context: 1,
			});

			const output = getTextOutput(result);
			// With context=1, should show limited surrounding lines
			expect(output).toContain("changed");
		});
	});

	describe("stat option", () => {
		it("includes stat summary when requested", async () => {
			writeFileSync(join(testDir, "file.txt"), "modified\n");

			const result = await diffTool.execute("diff-9", {
				stat: true,
			});

			const output = getTextOutput(result);
			// Stat output includes insertions/deletions info
			expect(output).toContain("file.txt");
		});
	});

	describe("name-only option", () => {
		it("shows only filenames when nameOnly is true", async () => {
			writeFileSync(join(testDir, "file.txt"), "changed\n");
			writeFileSync(join(testDir, "new.txt"), "new file\n");
			git(testDir, "add", "new.txt");

			const result = await diffTool.execute("diff-10", {
				nameOnly: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("file.txt");
			// Should not contain diff content
			expect(output).not.toContain("@@");
		});
	});

	describe("ignore whitespace options", () => {
		it("ignores whitespace changes when requested", async () => {
			writeFileSync(join(testDir, "file.txt"), "content  here\n");
			git(testDir, "add", ".");
			git(testDir, "commit", "-m", "spaces");

			// Only add more spaces
			writeFileSync(join(testDir, "file.txt"), "content    here\n");

			const result = await diffTool.execute("diff-11", {
				ignoreWhitespace: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("No changes");
		});
	});

	describe("path filtering", () => {
		it("filters by single path", async () => {
			writeFileSync(join(testDir, "file.txt"), "changed\n");
			writeFileSync(join(testDir, "other.txt"), "other\n");

			const result = await diffTool.execute("diff-12", {
				paths: "file.txt",
			});

			const output = getTextOutput(result);
			expect(output).toContain("file.txt");
			expect(output).not.toContain("other.txt");
		});

		it("filters by multiple paths", async () => {
			mkdirSync(join(testDir, "src"));
			writeFileSync(join(testDir, "file.txt"), "changed\n");
			writeFileSync(join(testDir, "other.txt"), "other\n");
			writeFileSync(join(testDir, "src", "code.ts"), "code\n");

			const result = await diffTool.execute("diff-13", {
				paths: ["file.txt", "src/code.ts"],
			});

			const output = getTextOutput(result);
			expect(output).toContain("file.txt");
			expect(output).not.toContain("other.txt");
		});
	});

	describe("validation", () => {
		it("throws when both wordDiff and nameOnly are set", async () => {
			await expect(
				diffTool.execute("diff-14", {
					wordDiff: true,
					nameOnly: true,
				}),
			).rejects.toThrow("Cannot request both");
		});
	});

	describe("details metadata", () => {
		it("includes command in details", async () => {
			writeFileSync(join(testDir, "file.txt"), "changed\n");

			const result = await diffTool.execute("diff-15", {});

			expect(result.details).toHaveProperty("command");
			const command = (result.details as { command: string }).command;
			expect(command).toContain("git diff");
		});
	});
});

describe("parseStatusOutput", () => {
	describe("branch parsing", () => {
		it("parses branch head", () => {
			const output = "# branch.head main\0";
			const result = parseStatusOutput(output);

			expect(result.branch?.head).toBe("main");
		});

		it("parses branch upstream", () => {
			const output = "# branch.upstream origin/main\0";
			const result = parseStatusOutput(output);

			expect(result.branch?.upstream).toBe("origin/main");
		});

		it("parses branch oid", () => {
			const output = "# branch.oid abc123def456\0";
			const result = parseStatusOutput(output);

			expect(result.branch?.oid).toBe("abc123def456");
		});

		it("parses ahead/behind counts", () => {
			const output = "# branch.ab +2 -1\0";
			const result = parseStatusOutput(output);

			expect(result.branch?.ahead).toBe(2);
			expect(result.branch?.behind).toBe(1);
		});
	});

	describe("file status parsing", () => {
		it("parses modified file", () => {
			// Format: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			// Regex: /^1\s+(\S{2})\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/
			// That's 5 fields after XY, then the path
			const output = "1 .M N... 100644 100644 100644 abc123 file.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files).toHaveLength(1);
			expect(result.files[0]).toMatchObject({
				kind: "change",
				path: "file.txt",
				worktreeStatus: "modified",
			});
		});

		it("parses added file", () => {
			const output = "1 A. N... 000000 100644 100644 000000 newfile.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files[0]).toMatchObject({
				kind: "change",
				path: "newfile.txt",
				indexStatus: "added",
			});
		});

		it("parses deleted file", () => {
			const output = "1 D. N... 100644 000000 000000 abc123 deleted.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files[0]).toMatchObject({
				kind: "change",
				path: "deleted.txt",
				indexStatus: "deleted",
			});
		});

		it("parses untracked file", () => {
			const output = "? untracked.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files[0]).toMatchObject({
				kind: "untracked",
				path: "untracked.txt",
			});
		});

		it("parses ignored file", () => {
			const output = "! ignored.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files[0]).toMatchObject({
				kind: "ignored",
				path: "ignored.txt",
			});
		});

		it("parses renamed file", () => {
			// Format: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
			// Regex allows 5-7 fields between sub and score
			const output =
				"2 R. N... 100644 100644 100644 abc123 abc123 R100 newname.txt\0oldname.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files[0]).toMatchObject({
				kind: "rename",
				path: "newname.txt",
				origPath: "oldname.txt",
				score: 100,
			});
		});

		it("parses unmerged file", () => {
			// Format: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <path>
			// Regex: /^u\s+(\S{2})\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/
			// That's 6 fields after XY, then the path
			const output =
				"u UU N... 100644 100644 100644 100644 abc12345 conflict.txt\0";
			const result = parseStatusOutput(output);

			expect(result.files[0]).toMatchObject({
				kind: "unmerged",
				path: "conflict.txt",
			});
		});

		it("parses multiple files", () => {
			const output = [
				"1 .M N... 100644 100644 100644 abc123 modified.txt",
				"? new.txt",
				"! ignored.txt",
			].join("\0");
			const result = parseStatusOutput(`${output}\0`);

			expect(result.files).toHaveLength(3);
		});
	});

	describe("empty output", () => {
		it("handles empty string", () => {
			const result = parseStatusOutput("");

			expect(result.files).toHaveLength(0);
		});

		it("handles only branch info", () => {
			const output = "# branch.head main\0# branch.oid abc123\0";
			const result = parseStatusOutput(output);

			expect(result.branch?.head).toBe("main");
			expect(result.files).toHaveLength(0);
		});
	});
});
