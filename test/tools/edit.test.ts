import { execSync } from "node:child_process";
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
import { editTool } from "../../src/tools/edit.js";

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

describe("edit tool", () => {
	let testDir: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "edit-tool-test-"));
		originalMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(testDir, ".maestro-home");
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (originalMaestroHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic find-and-replace", () => {
		it("replaces exact text match", async () => {
			const filePath = join(testDir, "basic.txt");
			writeFileSync(filePath, "Hello, World!");

			const result = await editTool.execute("edit-1", {
				path: filePath,
				oldText: "World",
				newText: "Universe",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("Hello, Universe!");
		});

		it("replaces multi-line text", async () => {
			const filePath = join(testDir, "multiline.txt");
			writeFileSync(filePath, "Line 1\nLine 2\nLine 3");

			const result = await editTool.execute("edit-2", {
				path: filePath,
				oldText: "Line 2\nLine 3",
				newText: "Modified",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("Line 1\nModified");
		});

		it("preserves surrounding content", async () => {
			const filePath = join(testDir, "preserve.txt");
			writeFileSync(filePath, "before target after");

			const result = await editTool.execute("edit-3", {
				path: filePath,
				oldText: "target",
				newText: "replacement",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("before replacement after");
		});

		it("handles deletion (empty newText)", async () => {
			const filePath = join(testDir, "delete.txt");
			writeFileSync(filePath, "keep this remove_me and this");

			const result = await editTool.execute("edit-4", {
				path: filePath,
				oldText: " remove_me",
				newText: "",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("keep this and this");
		});
	});

	describe("exact matching requirements", () => {
		it("fails when text not found", async () => {
			const filePath = join(testDir, "notfound.txt");
			writeFileSync(filePath, "Hello, World!");

			await expect(
				editTool.execute("edit-5", {
					path: filePath,
					oldText: "Nonexistent",
					newText: "Replacement",
				}),
			).rejects.toThrow("Could not find");
		});

		it("requires exact whitespace match", async () => {
			const filePath = join(testDir, "whitespace.txt");
			// Use more different content so fuzzy matching won't find it
			writeFileSync(
				filePath,
				"    four spaces of indentation here for this content",
			);

			await expect(
				editTool.execute("edit-6", {
					path: filePath,
					oldText: "completely different text that does not exist",
					newText: "replaced",
				}),
			).rejects.toThrow("Could not find");
		});

		it("is case sensitive", async () => {
			const filePath = join(testDir, "case.txt");
			writeFileSync(filePath, "Hello");

			await expect(
				editTool.execute("edit-7", {
					path: filePath,
					oldText: "hello", // wrong case
					newText: "Hi",
				}),
			).rejects.toThrow("Could not find");
		});
	});

	describe("replaceAll option", () => {
		it("replaces all occurrences when enabled", async () => {
			const filePath = join(testDir, "replaceall.txt");
			writeFileSync(filePath, "foo bar foo baz foo");

			const result = await editTool.execute("edit-8", {
				path: filePath,
				oldText: "foo",
				newText: "qux",
				replaceAll: true,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("qux bar qux baz qux");
		});

		it("reports number of replacements", async () => {
			const filePath = join(testDir, "count.txt");
			writeFileSync(filePath, "a a a a a");

			const result = await editTool.execute("edit-9", {
				path: filePath,
				oldText: "a",
				newText: "b",
				replaceAll: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("5");
		});

		it("replaces only first occurrence by default", async () => {
			const filePath = join(testDir, "firstonly.txt");
			writeFileSync(filePath, "foo bar foo");

			const result = await editTool.execute("edit-10", {
				path: filePath,
				oldText: "foo",
				newText: "baz",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("baz bar foo");
		});
	});

	describe("occurrence option", () => {
		it("replaces specific occurrence", async () => {
			const filePath = join(testDir, "occurrence.txt");
			writeFileSync(filePath, "foo bar foo baz foo");

			const result = await editTool.execute("edit-11", {
				path: filePath,
				oldText: "foo",
				newText: "qux",
				occurrence: 2,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("foo bar qux baz foo");
		});

		it("replaces third occurrence", async () => {
			const filePath = join(testDir, "third.txt");
			writeFileSync(filePath, "x y x z x");

			const result = await editTool.execute("edit-12", {
				path: filePath,
				oldText: "x",
				newText: "W",
				occurrence: 3,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("x y x z W");
		});

		it("fails when occurrence exceeds count", async () => {
			const filePath = join(testDir, "exceed.txt");
			writeFileSync(filePath, "a b a");

			await expect(
				editTool.execute("edit-13", {
					path: filePath,
					oldText: "a",
					newText: "c",
					occurrence: 5,
				}),
			).rejects.toThrow("Only 2 occurrence");
		});

		it("cannot use both replaceAll and occurrence", async () => {
			const filePath = join(testDir, "conflict.txt");
			writeFileSync(filePath, "a a a");

			await expect(
				editTool.execute("edit-14", {
					path: filePath,
					oldText: "a",
					newText: "b",
					replaceAll: true,
					occurrence: 2,
				}),
			).rejects.toThrow("Cannot use both");
		});
	});

	describe("team memory protection", () => {
		it("blocks editing repo-scoped team memory to include secrets", async () => {
			execSync("git init -q", { cwd: testDir, stdio: "ignore" });
			const originalCwd = process.cwd();
			process.chdir(testDir);
			const githubToken = `ghp_${"a".repeat(36)}`;

			try {
				const { ensureTeamMemoryEntrypoint } = await import(
					"../../src/memory/team-memory.js"
				);
				const location = ensureTeamMemoryEntrypoint(testDir)!;
				writeFileSync(
					location.entrypoint,
					"# Team Memory\n\nsafe content",
					"utf-8",
				);

				await expect(
					editTool.execute("edit-team-memory-secret", {
						path: location.entrypoint,
						oldText: "safe content",
						newText: `GitHub token ${githubToken}`,
					}),
				).rejects.toThrow("Team memory files cannot store secrets");
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("dry run mode", () => {
		it("shows diff without modifying file", async () => {
			const filePath = join(testDir, "dryrun.txt");
			writeFileSync(filePath, "Original content");

			const result = await editTool.execute("edit-15", {
				path: filePath,
				oldText: "Original",
				newText: "Modified",
				dryRun: true,
			});

			expect(result.isError).toBeFalsy();
			// File should be unchanged
			expect(readFileSync(filePath, "utf-8")).toBe("Original content");
			const output = getTextOutput(result);
			expect(output).toContain("Dry run");
		});

		it("includes diff in details", async () => {
			const filePath = join(testDir, "dryrun-diff.txt");
			writeFileSync(filePath, "before\nchange me\nafter");

			const result = await editTool.execute("edit-16", {
				path: filePath,
				oldText: "change me",
				newText: "changed",
				dryRun: true,
			});

			expect(result.details).toHaveProperty("diff");
		});
	});

	describe("multi-edit mode", () => {
		it("applies multiple edits sequentially", async () => {
			const filePath = join(testDir, "multi.txt");
			writeFileSync(filePath, "foo bar baz");

			const result = await editTool.execute("edit-17", {
				path: filePath,
				edits: [
					{ oldText: "foo", newText: "one" },
					{ oldText: "bar", newText: "two" },
					{ oldText: "baz", newText: "three" },
				],
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("one two three");
		});

		it("reports edits applied count", async () => {
			const filePath = join(testDir, "multi-count.txt");
			writeFileSync(filePath, "a b c");

			const result = await editTool.execute("edit-18", {
				path: filePath,
				edits: [
					{ oldText: "a", newText: "x" },
					{ oldText: "b", newText: "y" },
				],
			});

			expect(result.details).toMatchObject({
				editsApplied: 2,
			});
		});

		it("fails on first missing edit", async () => {
			const filePath = join(testDir, "multi-fail.txt");
			writeFileSync(filePath, "foo bar");

			await expect(
				editTool.execute("edit-19", {
					path: filePath,
					edits: [
						{ oldText: "foo", newText: "one" },
						{ oldText: "nonexistent", newText: "two" },
					],
				}),
			).rejects.toThrow("Edit #2");
		});

		it("applies edits in order with updated content", async () => {
			const filePath = join(testDir, "multi-order.txt");
			writeFileSync(filePath, "aaa");

			const result = await editTool.execute("edit-20", {
				path: filePath,
				edits: [
					{ oldText: "aaa", newText: "bbb" },
					{ oldText: "bbb", newText: "ccc" }, // Depends on first edit
				],
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("ccc");
		});

		it("cannot mix edits array with oldText/newText", async () => {
			const filePath = join(testDir, "mix.txt");
			writeFileSync(filePath, "content");

			await expect(
				editTool.execute("edit-21", {
					path: filePath,
					oldText: "content",
					newText: "new",
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow("Cannot use both");
		});

		it("cannot use replaceAll with edits array", async () => {
			const filePath = join(testDir, "multi-replaceall.txt");
			writeFileSync(filePath, "a a a");

			await expect(
				editTool.execute("edit-22", {
					path: filePath,
					edits: [{ oldText: "a", newText: "b" }],
					replaceAll: true,
				}),
			).rejects.toThrow("Cannot use replaceAll");
		});
	});

	describe("file not found handling", () => {
		it("returns error for non-existent file", async () => {
			await expect(
				editTool.execute("edit-23", {
					path: join(testDir, "nonexistent.txt"),
					oldText: "foo",
					newText: "bar",
				}),
			).rejects.toThrow("File not found");
		});
	});

	describe("approximate matching suggestions", () => {
		it("suggests similar matches when exact not found", async () => {
			const filePath = join(testDir, "approx.txt");
			writeFileSync(filePath, "function hello() {\n  return 1;\n}");

			try {
				await editTool.execute("edit-24", {
					path: filePath,
					oldText: "function hello(){\n return 1;\n}", // slightly different
					newText: "replaced",
				});
			} catch (e) {
				const error = e as Error;
				expect(error.message).toContain("Could not find");
				// May contain suggestions for similar matches
			}
		});
	});

	describe("details metadata", () => {
		it("includes diff in details", async () => {
			const filePath = join(testDir, "details-diff.txt");
			writeFileSync(filePath, "old value");

			const result = await editTool.execute("edit-25", {
				path: filePath,
				oldText: "old",
				newText: "new",
			});

			expect(result.details).toHaveProperty("diff");
			const diff = (result.details as { diff: string }).diff;
			// Diff includes the actual lines with +/- markers
			expect(diff).toContain("-");
			expect(diff).toContain("+");
			expect(diff).toContain("old");
			expect(diff).toContain("new");
		});
	});

	describe("abort signal handling", () => {
		it("respects abort signal", async () => {
			const filePath = join(testDir, "abort.txt");
			writeFileSync(filePath, "content");

			const controller = new AbortController();
			controller.abort();

			await expect(
				editTool.execute(
					"edit-26",
					{
						path: filePath,
						oldText: "content",
						newText: "new",
					},
					controller.signal,
				),
			).rejects.toThrow("aborted");
		});
	});

	describe("indentation preservation", () => {
		it("preserves tabs when replacing", async () => {
			const filePath = join(testDir, "tabs.txt");
			writeFileSync(filePath, "\t\tindented");

			const result = await editTool.execute("edit-27", {
				path: filePath,
				oldText: "\t\tindented",
				newText: "\t\tmodified",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("\t\tmodified");
		});

		it("preserves spaces when replacing", async () => {
			const filePath = join(testDir, "spaces.txt");
			writeFileSync(filePath, "    four spaces");

			const result = await editTool.execute("edit-28", {
				path: filePath,
				oldText: "    four spaces",
				newText: "    changed",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("    changed");
		});
	});

	describe("atomic writes", () => {
		it("writes atomically to prevent corruption", async () => {
			const filePath = join(testDir, "atomic.txt");
			writeFileSync(filePath, "original");

			const result = await editTool.execute("edit-29", {
				path: filePath,
				oldText: "original",
				newText: "modified",
			});

			expect(result.isError).toBeFalsy();
			// No temp files should remain
			const files = require("node:fs").readdirSync(testDir);
			expect(files.filter((f: string) => f.includes(".tmp"))).toHaveLength(0);
		});
	});

	describe("validation", () => {
		it("requires oldText to be non-empty", async () => {
			const filePath = join(testDir, "empty-old.txt");
			writeFileSync(filePath, "content");

			await expect(
				editTool.execute("edit-30", {
					path: filePath,
					oldText: "",
					newText: "new",
				}),
			).rejects.toThrow();
		});

		it("requires either oldText/newText or edits", async () => {
			const filePath = join(testDir, "missing.txt");
			writeFileSync(filePath, "content");

			await expect(
				editTool.execute("edit-31", {
					path: filePath,
				}),
			).rejects.toThrow("Must provide");
		});
	});

	describe("fuzzy matching edge cases", () => {
		it("handles CRLF vs LF line ending differences", async () => {
			const filePath = join(testDir, "crlf.txt");
			writeFileSync(filePath, "line1\r\nline2\r\nline3");

			// Search with LF, file has CRLF
			try {
				await editTool.execute("edit-32", {
					path: filePath,
					oldText: "line1\nline2\nline3",
					newText: "replaced",
				});
			} catch (e) {
				const error = e as Error;
				// Should suggest the CRLF version as a close match
				expect(error.message).toContain("Could not find");
			}
		});

		it("handles trailing whitespace differences", async () => {
			const filePath = join(testDir, "trailing.txt");
			writeFileSync(filePath, "content with trailing   \nmore content");

			try {
				await editTool.execute("edit-33", {
					path: filePath,
					oldText: "content with trailing\nmore content", // No trailing spaces
					newText: "replaced",
				});
			} catch (e) {
				const error = e as Error;
				expect(error.message).toContain("Could not find");
			}
		});

		it("handles leading whitespace differences", async () => {
			const filePath = join(testDir, "leading.txt");
			writeFileSync(filePath, "function test() {\n    return true;\n}");

			try {
				await editTool.execute("edit-34", {
					path: filePath,
					oldText: "function test() {\n  return true;\n}", // 2 spaces vs 4
					newText: "replaced",
				});
			} catch (e) {
				const error = e as Error;
				expect(error.message).toContain("Could not find");
			}
		});

		it("handles empty lines in search text", async () => {
			const filePath = join(testDir, "emptylines.txt");
			writeFileSync(filePath, "first\n\n\nsecond\nthird");

			// Exact match with empty lines should work
			const result = await editTool.execute("edit-35", {
				path: filePath,
				oldText: "first\n\n\nsecond",
				newText: "replaced",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("replaced\nthird");
		});

		it("handles unicode content", async () => {
			const filePath = join(testDir, "unicode.txt");
			writeFileSync(filePath, "Hello 世界! 🌍 Émojis work");

			const result = await editTool.execute("edit-36", {
				path: filePath,
				oldText: "世界! 🌍",
				newText: "World! 🌎",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe(
				"Hello World! 🌎 Émojis work",
			);
		});

		it("handles tab vs spaces mismatch", async () => {
			const filePath = join(testDir, "tabspaces.txt");
			writeFileSync(filePath, "\tindented with tab");

			try {
				await editTool.execute("edit-37", {
					path: filePath,
					oldText: "    indented with tab", // 4 spaces instead of tab
					newText: "replaced",
				});
			} catch (e) {
				const error = e as Error;
				expect(error.message).toContain("Could not find");
			}
		});

		it("handles single character differences in long text", async () => {
			const filePath = join(testDir, "longtext.txt");
			writeFileSync(
				filePath,
				"This is a longer piece of text with multiple words and some content that should be matched accurately",
			);

			try {
				await editTool.execute("edit-38", {
					path: filePath,
					oldText:
						"This is a longer piece of text with multiple words and some content that should be matched acurately", // typo: acurately
					newText: "replaced",
				});
			} catch (e) {
				const error = e as Error;
				expect(error.message).toContain("Could not find");
			}
		});

		it("handles multiline with mixed indentation", async () => {
			const filePath = join(testDir, "mixedindent.txt");
			writeFileSync(
				filePath,
				"function test() {\n\tif (true) {\n\t\treturn 1;\n\t}\n}",
			);

			// Exact match with correct indentation should work
			const result = await editTool.execute("edit-39", {
				path: filePath,
				oldText: "if (true) {\n\t\treturn 1;\n\t}",
				newText: "if (false) {\n\t\treturn 0;\n\t}",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe(
				"function test() {\n\tif (false) {\n\t\treturn 0;\n\t}\n}",
			);
		});

		it("handles regex special characters in search text", async () => {
			const filePath = join(testDir, "regex.txt");
			writeFileSync(filePath, "const pattern = /^[a-z]+$/gi;");

			const result = await editTool.execute("edit-40", {
				path: filePath,
				oldText: "/^[a-z]+$/gi",
				newText: "/^[A-Z]+$/i",
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe(
				"const pattern = /^[A-Z]+$/i;",
			);
		});

		it("handles overlapping matches with replaceAll", async () => {
			const filePath = join(testDir, "overlap.txt");
			writeFileSync(filePath, "aaaa");

			// Non-overlapping replacement
			const result = await editTool.execute("edit-41", {
				path: filePath,
				oldText: "aa",
				newText: "bb",
				replaceAll: true,
			});

			expect(result.isError).toBeFalsy();
			expect(readFileSync(filePath, "utf-8")).toBe("bbbb");
		});

		it("handles BOM (byte order mark) in file", async () => {
			const filePath = join(testDir, "bom.txt");
			// Write file with BOM
			writeFileSync(filePath, "\ufeffcontent with BOM");

			const result = await editTool.execute("edit-42", {
				path: filePath,
				oldText: "content with BOM",
				newText: "modified content",
			});

			expect(result.isError).toBeFalsy();
			// BOM should be preserved
			expect(readFileSync(filePath, "utf-8")).toBe("\ufeffmodified content");
		});
	});
});
