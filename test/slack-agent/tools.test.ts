/**
 * Tests for slack-agent tools (bash, read, write, edit, attach)
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type SandboxConfig,
	createExecutor,
} from "../../packages/slack-agent/src/sandbox.js";
import { createBashTool } from "../../packages/slack-agent/src/tools/bash.js";
import { createEditTool } from "../../packages/slack-agent/src/tools/edit.js";
import { createReadTool } from "../../packages/slack-agent/src/tools/read.js";
import { createWriteTool } from "../../packages/slack-agent/src/tools/write.js";

describe("slack-agent tools", () => {
	let testDir: string;
	const config: SandboxConfig = { type: "host" };
	const executor = createExecutor(config);

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`slack-agent-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("bash tool", () => {
		it("has correct metadata", () => {
			const tool = createBashTool(executor);
			expect(tool.name).toBe("bash");
			expect(tool.description).toContain("bash command");
		});

		it("executes simple commands", async () => {
			const tool = createBashTool(executor);
			const result = await tool.execute("test-id", {
				label: "Test echo",
				command: "echo hello world",
			});

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as { text: string }).text.trim()).toBe(
				"hello world",
			);
		});

		it("returns (no output) for empty stdout", async () => {
			const tool = createBashTool(executor);
			const result = await tool.execute("test-id", {
				label: "Test true",
				command: "true",
			});

			expect((result.content[0] as { text: string }).text).toBe("(no output)");
		});

		it("throws error for failed commands", async () => {
			const tool = createBashTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Test failure",
					command: "exit 1",
				}),
			).rejects.toThrow("exited with code 1");
		});

		it("includes both stdout and stderr in error message", async () => {
			const tool = createBashTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Test stderr",
					command: "echo error >&2 && exit 1",
				}),
			).rejects.toThrow("error");
		});

		it("combines stdout and stderr in output", async () => {
			const tool = createBashTool(executor);
			const result = await tool.execute("test-id", {
				label: "Test combined",
				command: "echo out && echo err >&2",
			});

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("out");
			expect(text).toContain("err");
		});

		it("respects timeout parameter", async () => {
			const tool = createBashTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Test timeout",
					command: "sleep 10",
					timeout: 0.1,
				}),
			).rejects.toThrow("timed out");
		});

		it("respects abort signal", async () => {
			const tool = createBashTool(executor);
			const controller = new AbortController();
			controller.abort();

			await expect(
				tool.execute(
					"test-id",
					{ label: "Test abort", command: "sleep 10" },
					controller.signal,
				),
			).rejects.toThrow("aborted");
		});
	});

	describe("read tool", () => {
		it("has correct metadata", () => {
			const tool = createReadTool(executor);
			expect(tool.name).toBe("read");
			expect(tool.description).toContain("Read");
		});

		it("reads text file contents", async () => {
			const filePath = join(testDir, "test.txt");
			writeFileSync(filePath, "Hello, World!\nLine 2\nLine 3");

			const tool = createReadTool(executor);
			const result = await tool.execute("test-id", {
				label: "Read test file",
				path: filePath,
			});

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Hello, World!");
			expect(text).toContain("Line 2");
			expect(text).toContain("Line 3");
		});

		it("reads with offset and limit", async () => {
			const filePath = join(testDir, "lines.txt");
			const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join(
				"\n",
			);
			writeFileSync(filePath, lines);

			const tool = createReadTool(executor);
			const result = await tool.execute("test-id", {
				label: "Read with offset",
				path: filePath,
				offset: 3,
				limit: 2,
			});

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Line 3");
			expect(text).toContain("Line 4");
			expect(text).not.toContain("Line 1");
			expect(text).not.toContain("Line 5");
		});

		it("throws error for non-existent file", async () => {
			const tool = createReadTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Read missing",
					path: join(testDir, "nonexistent.txt"),
				}),
			).rejects.toThrow();
		});

		it("truncates very long lines", async () => {
			const filePath = join(testDir, "long.txt");
			const longLine = "x".repeat(5000);
			writeFileSync(filePath, longLine);

			const tool = createReadTool(executor);
			const result = await tool.execute("test-id", {
				label: "Read long file",
				path: filePath,
			});

			const text = (result.content[0] as { text: string }).text;
			expect(text.length).toBeLessThan(5000);
			expect(text).toContain("truncated");
		});

		it("indicates remaining lines not shown", async () => {
			const filePath = join(testDir, "many-lines.txt");
			const lines = Array.from(
				{ length: 3000 },
				(_, i) => `Line ${i + 1}`,
			).join("\n");
			writeFileSync(filePath, lines);

			const tool = createReadTool(executor);
			const result = await tool.execute("test-id", {
				label: "Read many lines",
				path: filePath,
			});

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("more lines not shown");
			expect(text).toContain("offset=");
		});

		it("reads image files as base64", async () => {
			const filePath = join(testDir, "test.png");
			// Create a minimal valid PNG (1x1 transparent pixel)
			const pngData = Buffer.from([
				0x89,
				0x50,
				0x4e,
				0x47,
				0x0d,
				0x0a,
				0x1a,
				0x0a, // PNG signature
				0x00,
				0x00,
				0x00,
				0x0d, // IHDR length
				0x49,
				0x48,
				0x44,
				0x52, // IHDR
				0x00,
				0x00,
				0x00,
				0x01, // width
				0x00,
				0x00,
				0x00,
				0x01, // height
				0x08,
				0x06,
				0x00,
				0x00,
				0x00, // bit depth, color type, etc
				0x1f,
				0x15,
				0xc4,
				0x89, // CRC
				0x00,
				0x00,
				0x00,
				0x0a, // IDAT length
				0x49,
				0x44,
				0x41,
				0x54, // IDAT
				0x78,
				0x9c,
				0x63,
				0x00,
				0x01,
				0x00,
				0x00,
				0x05,
				0x00,
				0x01,
				0x0d,
				0x0a,
				0x2d,
				0xb4, // CRC
				0x00,
				0x00,
				0x00,
				0x00, // IEND length
				0x49,
				0x45,
				0x4e,
				0x44, // IEND
				0xae,
				0x42,
				0x60,
				0x82, // CRC
			]);
			writeFileSync(filePath, pngData);

			const tool = createReadTool(executor);
			const result = await tool.execute("test-id", {
				label: "Read image",
				path: filePath,
			});

			expect(result.content).toHaveLength(2);
			expect(result.content[0].type).toBe("text");
			expect(result.content[1].type).toBe("image");
			expect((result.content[1] as { mimeType: string }).mimeType).toBe(
				"image/png",
			);
		});
	});

	describe("write tool", () => {
		it("has correct metadata", () => {
			const tool = createWriteTool(executor);
			expect(tool.name).toBe("write");
			expect(tool.description).toContain("Write");
		});

		it("creates new file with content", async () => {
			const filePath = join(testDir, "new-file.txt");

			const tool = createWriteTool(executor);
			const result = await tool.execute("test-id", {
				label: "Create file",
				path: filePath,
				content: "Hello, World!",
			});

			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe("Hello, World!");
			expect((result.content[0] as { text: string }).text).toContain(
				"Successfully wrote",
			);
			expect((result.content[0] as { text: string }).text).toContain(
				"13 bytes",
			);
		});

		it("overwrites existing file", async () => {
			const filePath = join(testDir, "existing.txt");
			writeFileSync(filePath, "Original content");

			const tool = createWriteTool(executor);
			await tool.execute("test-id", {
				label: "Overwrite file",
				path: filePath,
				content: "New content",
			});

			expect(readFileSync(filePath, "utf-8")).toBe("New content");
		});

		it("creates parent directories", async () => {
			const filePath = join(testDir, "a", "b", "c", "deep-file.txt");

			const tool = createWriteTool(executor);
			await tool.execute("test-id", {
				label: "Create deep file",
				path: filePath,
				content: "Deep content",
			});

			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe("Deep content");
		});

		it("handles special characters in content", async () => {
			const filePath = join(testDir, "special.txt");
			const content =
				"Hello 'world' with \"quotes\" and $variables and `backticks`";

			const tool = createWriteTool(executor);
			await tool.execute("test-id", {
				label: "Write special chars",
				path: filePath,
				content,
			});

			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});

		it("handles multiline content", async () => {
			const filePath = join(testDir, "multiline.txt");
			const content = "Line 1\nLine 2\nLine 3";

			const tool = createWriteTool(executor);
			await tool.execute("test-id", {
				label: "Write multiline",
				path: filePath,
				content,
			});

			expect(readFileSync(filePath, "utf-8")).toBe(content);
		});

		it("handles empty content", async () => {
			const filePath = join(testDir, "empty.txt");

			const tool = createWriteTool(executor);
			await tool.execute("test-id", {
				label: "Write empty",
				path: filePath,
				content: "",
			});

			expect(existsSync(filePath)).toBe(true);
			expect(readFileSync(filePath, "utf-8")).toBe("");
		});
	});

	describe("edit tool", () => {
		it("has correct metadata", () => {
			const tool = createEditTool(executor);
			expect(tool.name).toBe("edit");
			expect(tool.description).toContain("Edit");
		});

		it("replaces exact text", async () => {
			const filePath = join(testDir, "edit.txt");
			writeFileSync(filePath, "Hello, World!");

			const tool = createEditTool(executor);
			const result = await tool.execute("test-id", {
				label: "Edit text",
				path: filePath,
				oldText: "World",
				newText: "Universe",
			});

			expect(readFileSync(filePath, "utf-8")).toBe("Hello, Universe!");
			expect((result.content[0] as { text: string }).text).toContain(
				"Successfully replaced",
			);
		});

		it("includes diff in details", async () => {
			const filePath = join(testDir, "diff.txt");
			writeFileSync(filePath, "Line 1\nLine 2\nLine 3");

			const tool = createEditTool(executor);
			const result = await tool.execute("test-id", {
				label: "Edit with diff",
				path: filePath,
				oldText: "Line 2",
				newText: "Changed Line",
			});

			expect(result.details).toBeDefined();
			expect((result.details as { diff: string }).diff).toContain("-");
			expect((result.details as { diff: string }).diff).toContain("+");
		});

		it("throws error for non-existent file", async () => {
			const tool = createEditTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Edit missing",
					path: join(testDir, "nonexistent.txt"),
					oldText: "foo",
					newText: "bar",
				}),
			).rejects.toThrow();
		});

		it("throws error when text not found", async () => {
			const filePath = join(testDir, "no-match.txt");
			writeFileSync(filePath, "Hello, World!");

			const tool = createEditTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Edit no match",
					path: filePath,
					oldText: "NotFound",
					newText: "Replacement",
				}),
			).rejects.toThrow("Could not find the exact text");
		});

		it("throws error for ambiguous match (multiple occurrences)", async () => {
			const filePath = join(testDir, "ambiguous.txt");
			writeFileSync(filePath, "foo bar foo baz foo");

			const tool = createEditTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Edit ambiguous",
					path: filePath,
					oldText: "foo",
					newText: "qux",
				}),
			).rejects.toThrow("Found 3 occurrences");
		});

		it("throws error when replacement produces no change", async () => {
			const filePath = join(testDir, "no-change.txt");
			writeFileSync(filePath, "Hello, World!");

			const tool = createEditTool(executor);

			await expect(
				tool.execute("test-id", {
					label: "Edit no change",
					path: filePath,
					oldText: "Hello",
					newText: "Hello",
				}),
			).rejects.toThrow("No changes made");
		});

		it("handles multiline replacements", async () => {
			const filePath = join(testDir, "multiline-edit.txt");
			writeFileSync(filePath, "function foo() {\n  return 1;\n}");

			const tool = createEditTool(executor);
			await tool.execute("test-id", {
				label: "Edit multiline",
				path: filePath,
				oldText: "function foo() {\n  return 1;\n}",
				newText: "function foo() {\n  return 42;\n}",
			});

			expect(readFileSync(filePath, "utf-8")).toBe(
				"function foo() {\n  return 42;\n}",
			);
		});

		it("preserves surrounding content", async () => {
			const filePath = join(testDir, "preserve.txt");
			writeFileSync(filePath, "before\ntarget\nafter");

			const tool = createEditTool(executor);
			await tool.execute("test-id", {
				label: "Edit preserve",
				path: filePath,
				oldText: "target",
				newText: "replaced",
			});

			expect(readFileSync(filePath, "utf-8")).toBe("before\nreplaced\nafter");
		});

		it("handles special characters", async () => {
			const filePath = join(testDir, "special-edit.txt");
			writeFileSync(filePath, "const x = 'hello';");

			const tool = createEditTool(executor);
			await tool.execute("test-id", {
				label: "Edit special",
				path: filePath,
				oldText: "'hello'",
				newText: "'world'",
			});

			expect(readFileSync(filePath, "utf-8")).toBe("const x = 'world';");
		});
	});
});
