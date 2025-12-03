import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { writeTool } from "../../src/tools/write.js";

// Mock the safe-mode module to avoid plan mode checks in tests
vi.mock("../../src/safety/safe-mode.js", () => ({
	requirePlanCheck: vi.fn(),
	runValidatorsOnSuccess: vi.fn().mockResolvedValue([]),
}));

// Mock LSP diagnostics
vi.mock("../../src/lsp/index.js", () => ({
	collectDiagnostics: vi.fn().mockResolvedValue({}),
}));

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

describe("write tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "write-tool-test-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic file writing", () => {
		it("creates a new file", async () => {
			const filePath = join(testDir, "new-file.txt");

			const result = await writeTool.execute("write-1", {
				path: filePath,
				content: "Hello, World!",
			});

			expect(result.isError).toBeFalsy();
			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe("Hello, World!");
		});

		it("overwrites existing file", async () => {
			const filePath = join(testDir, "existing.txt");
			writeFileSync(filePath, "Old content");

			const result = await writeTool.execute("write-2", {
				path: filePath,
				content: "New content",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("New content");
		});

		it("writes empty content", async () => {
			const filePath = join(testDir, "empty.txt");

			const result = await writeTool.execute("write-3", {
				path: filePath,
				content: "",
			});

			expect(result.isError).toBeFalsy();
			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe("");
		});

		it("preserves unicode content", async () => {
			const filePath = join(testDir, "unicode.txt");
			const content = "Hello 你好 🌍 مرحبا";

			const result = await writeTool.execute("write-4", {
				path: filePath,
				content,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});

		it("preserves newlines and whitespace", async () => {
			const filePath = join(testDir, "whitespace.txt");
			const content = "Line 1\n\n  Line 3\n\tTabbed\n";

			const result = await writeTool.execute("write-5", {
				path: filePath,
				content,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});
	});

	describe("directory creation", () => {
		it("creates parent directories automatically", async () => {
			const filePath = join(testDir, "a", "b", "c", "deep.txt");

			const result = await writeTool.execute("write-6", {
				path: filePath,
				content: "Deep file",
			});

			expect(result.isError).toBeFalsy();
			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe("Deep file");
		});

		it("works with existing directories", async () => {
			const subDir = join(testDir, "existing-dir");
			const filePath = join(subDir, "file.txt");
			require("node:fs").mkdirSync(subDir);

			const result = await writeTool.execute("write-7", {
				path: filePath,
				content: "In existing dir",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("In existing dir");
		});
	});

	describe("backup functionality", () => {
		it("creates backup file by default when overwriting", async () => {
			const filePath = join(testDir, "backup-test.txt");
			const backupPath = `${filePath}.bak`;
			writeFileSync(filePath, "Original content");

			await writeTool.execute("write-8", {
				path: filePath,
				content: "New content",
			});

			expect(existsSync(backupPath)).toBe(true);
			expect(readFileSync(backupPath, "utf-8")).toBe("Original content");
			expect(readFileSync(filePath, "utf-8")).toBe("New content");
		});

		it("can disable backup creation", async () => {
			const filePath = join(testDir, "no-backup.txt");
			const backupPath = `${filePath}.bak`;
			writeFileSync(filePath, "Original");

			await writeTool.execute("write-9", {
				path: filePath,
				content: "New",
				backup: false,
			});

			expect(existsSync(backupPath)).toBe(false);
			expect(readFileSync(filePath, "utf-8")).toBe("New");
		});

		it("does not create backup for new files", async () => {
			const filePath = join(testDir, "brand-new.txt");
			const backupPath = `${filePath}.bak`;

			await writeTool.execute("write-10", {
				path: filePath,
				content: "New file content",
			});

			expect(existsSync(backupPath)).toBe(false);
			expect(existsSync(filePath)).toBe(true);
		});
	});

	describe("output messages", () => {
		it("reports bytes written for new file", async () => {
			const filePath = join(testDir, "bytes.txt");
			const content = "Hello";

			const result = await writeTool.execute("write-11", {
				path: filePath,
				content,
			});

			const output = getTextOutput(result);
			expect(output).toContain("5 bytes");
			expect(output).toContain("created");
		});

		it("reports overwrite for existing file", async () => {
			const filePath = join(testDir, "overwrite-msg.txt");
			writeFileSync(filePath, "Old");

			const result = await writeTool.execute("write-12", {
				path: filePath,
				content: "New content",
			});

			const output = getTextOutput(result);
			expect(output).toContain("overwritten");
		});

		it("reports backup location", async () => {
			const filePath = join(testDir, "backup-msg.txt");
			writeFileSync(filePath, "Original");

			const result = await writeTool.execute("write-13", {
				path: filePath,
				content: "New",
			});

			const output = getTextOutput(result);
			expect(output).toContain("Backup saved to");
			expect(output).toContain(".bak");
		});
	});

	describe("details metadata", () => {
		it("includes previousExists flag for new file", async () => {
			const filePath = join(testDir, "meta-new.txt");

			const result = await writeTool.execute("write-14", {
				path: filePath,
				content: "Content",
			});

			expect(result.details).toMatchObject({
				previousExists: false,
			});
		});

		it("includes previousExists flag for existing file", async () => {
			const filePath = join(testDir, "meta-existing.txt");
			writeFileSync(filePath, "Old");

			const result = await writeTool.execute("write-15", {
				path: filePath,
				content: "New",
			});

			expect(result.details).toMatchObject({
				previousExists: true,
			});
		});

		it("includes bytesWritten", async () => {
			const filePath = join(testDir, "meta-bytes.txt");
			const content = "Hello, World!";

			const result = await writeTool.execute("write-16", {
				path: filePath,
				content,
			});

			expect(result.details).toMatchObject({
				bytesWritten: Buffer.byteLength(content, "utf-8"),
			});
		});

		it("includes backupPath when backup created", async () => {
			const filePath = join(testDir, "meta-backup.txt");
			writeFileSync(filePath, "Old");

			const result = await writeTool.execute("write-17", {
				path: filePath,
				content: "New",
			});

			expect(result.details).toHaveProperty("backupPath");
			expect((result.details as { backupPath: string }).backupPath).toContain(
				".bak",
			);
		});
	});

	describe("diff preview", () => {
		it("includes diff for overwrites by default", async () => {
			const filePath = join(testDir, "diff.txt");
			writeFileSync(filePath, "Line 1\nLine 2");

			const result = await writeTool.execute("write-18", {
				path: filePath,
				content: "Line 1\nModified Line 2",
			});

			expect(result.details).toHaveProperty("diff");
			const diff = (result.details as { diff: string }).diff;
			expect(diff).toContain("-");
			expect(diff).toContain("+");
		});

		it("can disable diff preview", async () => {
			const filePath = join(testDir, "no-diff.txt");
			writeFileSync(filePath, "Old");

			const result = await writeTool.execute("write-19", {
				path: filePath,
				content: "New",
				previewDiff: false,
			});

			// diff may be undefined or not present when disabled
			const diff = (result.details as { diff?: string }).diff;
			expect(diff).toBeUndefined();
		});

		it("no diff for new files", async () => {
			const filePath = join(testDir, "new-no-diff.txt");

			const result = await writeTool.execute("write-20", {
				path: filePath,
				content: "New file",
			});

			// For new files, diff is undefined (no previous content to diff against)
			const diff = (result.details as { diff?: string }).diff;
			expect(diff).toBeUndefined();
		});
	});

	describe("abort signal handling", () => {
		it("respects abort signal", async () => {
			const filePath = join(testDir, "abort.txt");

			const controller = new AbortController();
			controller.abort();

			await expect(
				writeTool.execute(
					"write-21",
					{
						path: filePath,
						content: "Content",
					},
					controller.signal,
				),
			).rejects.toThrow("aborted");
		});
	});

	describe("tilde expansion", () => {
		it("expands ~ in paths", async () => {
			// This test checks that the path expansion doesn't throw
			// and attempts to write to home directory (will likely fail due to permissions
			// or we just check it doesn't error with "invalid path")
			const result = await writeTool.execute("write-22", {
				path: "~/test-write-tool-temp-file-delete-me.txt",
				content: "test",
			});

			// Either succeeds or fails with permission/path error, not "invalid path"
			if (result.isError) {
				const output = getTextOutput(result);
				expect(output).not.toContain("invalid path");
			}
		});
	});

	describe("large content handling", () => {
		it("handles large files", async () => {
			const filePath = join(testDir, "large.txt");
			const content = "x".repeat(1024 * 1024); // 1MB

			const result = await writeTool.execute("write-23", {
				path: filePath,
				content,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});

		it("handles files with many lines", async () => {
			const filePath = join(testDir, "many-lines.txt");
			const lines = Array.from({ length: 10000 }, (_, i) => `Line ${i + 1}`);
			const content = lines.join("\n");

			const result = await writeTool.execute("write-24", {
				path: filePath,
				content,
			});

			expect(result.isError).toBeFalsy();
			const written = readFileSync(filePath, "utf-8");
			expect(written.split("\n")).toHaveLength(10000);
		});
	});

	describe("special characters in paths", () => {
		it("handles spaces in filename", async () => {
			const filePath = join(testDir, "file with spaces.txt");

			const result = await writeTool.execute("write-25", {
				path: filePath,
				content: "Content",
			});

			expect(result.isError).toBeFalsy();
			expect(existsSync(filePath)).toBe(true);
		});

		it("handles special characters in filename", async () => {
			const filePath = join(testDir, "file-with_special.chars!.txt");

			const result = await writeTool.execute("write-26", {
				path: filePath,
				content: "Content",
			});

			expect(result.isError).toBeFalsy();
			expect(existsSync(filePath)).toBe(true);
		});
	});
});
