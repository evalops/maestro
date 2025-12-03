import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import { readTool } from "../../src/tools/read.js";

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

// Helper to check if result contains an image
function hasImageContent(result: AgentToolResult<unknown>): boolean {
	return (
		result.content?.some(
			(c) =>
				c != null && typeof c === "object" && "type" in c && c.type === "image",
		) ?? false
	);
}

describe("read tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "read-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("basic text file reading", () => {
		it("reads a simple text file", async () => {
			const filePath = join(testDir, "simple.txt");
			writeFileSync(filePath, "Hello, World!");

			const result = await readTool.execute("read-1", { path: filePath });

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Hello, World!");
		});

		it("reads a file with multiple lines", async () => {
			const filePath = join(testDir, "multiline.txt");
			writeFileSync(filePath, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("read-2", { path: filePath });

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2");
			expect(output).toContain("Line 3");
		});

		it("includes line numbers by default", async () => {
			const filePath = join(testDir, "numbered.txt");
			writeFileSync(filePath, "First\nSecond\nThird");

			const result = await readTool.execute("read-3", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toMatch(/1\s*\|\s*First/);
			expect(output).toMatch(/2\s*\|\s*Second/);
			expect(output).toMatch(/3\s*\|\s*Third/);
		});

		it("can disable line numbers", async () => {
			const filePath = join(testDir, "no-numbers.txt");
			writeFileSync(filePath, "Content");

			const result = await readTool.execute("read-4", {
				path: filePath,
				lineNumbers: false,
			});

			const output = getTextOutput(result);
			expect(output).not.toMatch(/\d+\s*\|/);
		});

		it("wraps output in code fence by default", async () => {
			const filePath = join(testDir, "fenced.ts");
			writeFileSync(filePath, "const x = 1;");

			const result = await readTool.execute("read-5", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toMatch(/^```ts/m);
			expect(output).toMatch(/```$/m);
		});

		it("can disable code fence wrapping", async () => {
			const filePath = join(testDir, "unfenced.txt");
			writeFileSync(filePath, "Plain text");

			const result = await readTool.execute("read-6", {
				path: filePath,
				wrapInCodeFence: false,
			});

			const output = getTextOutput(result);
			expect(output).not.toContain("```");
		});
	});

	describe("file not found handling", () => {
		it("returns error for non-existent file", async () => {
			const result = await readTool.execute("read-7", {
				path: join(testDir, "nonexistent.txt"),
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("File not found");
		});

		it("handles paths with double slashes", async () => {
			// Node's path.resolve normalizes double slashes, so this just tests
			// that the file is not found (double slashes don't break path handling)
			const result = await readTool.execute("read-8", {
				path: join(testDir, "path//double.txt"),
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("File not found");
		});
	});

	describe("pagination with offset and limit", () => {
		it("reads from specific offset", async () => {
			const filePath = join(testDir, "offset.txt");
			writeFileSync(filePath, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");

			const result = await readTool.execute("read-9", {
				path: filePath,
				offset: 3,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Line 3");
			expect(output).toContain("Line 4");
			expect(output).toContain("Line 5");
			expect(output).toContain("2 earlier lines not shown");
		});

		it("limits number of lines read", async () => {
			const filePath = join(testDir, "limit.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(filePath, lines.join("\n"));

			const result = await readTool.execute("read-10", {
				path: filePath,
				limit: 5,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Line 1");
			expect(output).toContain("Line 5");
			expect(output).not.toContain("Line 6");
			expect(output).toContain("later lines not shown");
		});

		it("combines offset and limit", async () => {
			const filePath = join(testDir, "offset-limit.txt");
			const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(filePath, lines.join("\n"));

			const result = await readTool.execute("read-11", {
				path: filePath,
				offset: 5,
				limit: 3,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Line 5");
			expect(output).toContain("Line 6");
			expect(output).toContain("Line 7");
			expect(output).not.toContain("Line 4");
			expect(output).not.toContain("Line 8");
		});

		it("returns error when offset is beyond file length", async () => {
			const filePath = join(testDir, "short.txt");
			writeFileSync(filePath, "Just one line");

			const result = await readTool.execute("read-12", {
				path: filePath,
				offset: 100,
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("beyond end of file");
		});
	});

	describe("reading modes", () => {
		it("supports head mode", async () => {
			const filePath = join(testDir, "head.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(filePath, lines.join("\n"));

			const result = await readTool.execute("read-13", {
				path: filePath,
				mode: "head",
				limit: 5,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Line 1");
			expect(output).toContain("Line 5");
			expect(output).not.toContain("Line 6");
			expect(output).toContain("first");
		});

		it("supports tail mode", async () => {
			const filePath = join(testDir, "tail.txt");
			const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(filePath, lines.join("\n"));

			const result = await readTool.execute("read-14", {
				path: filePath,
				mode: "tail",
				limit: 5,
			});

			const output = getTextOutput(result);
			expect(output).toContain("Line 46");
			expect(output).toContain("Line 50");
			expect(output).not.toContain("Line 45");
			expect(output).toContain("last");
		});
	});

	describe("encoding support", () => {
		it("reads utf-8 by default", async () => {
			const filePath = join(testDir, "utf8.txt");
			writeFileSync(filePath, "Hello 你好 🌍", "utf-8");

			const result = await readTool.execute("read-15", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toContain("Hello 你好 🌍");
		});

		it("supports latin1 encoding", async () => {
			const filePath = join(testDir, "latin1.txt");
			writeFileSync(filePath, Buffer.from([0xc0, 0xe9, 0xf1]), "latin1");

			const result = await readTool.execute("read-16", {
				path: filePath,
				encoding: "latin1",
			});

			expect(result.isError).toBeFalsy();
		});
	});

	describe("language detection", () => {
		it("detects TypeScript", async () => {
			const filePath = join(testDir, "code.ts");
			writeFileSync(filePath, "const x: number = 1;");

			const result = await readTool.execute("read-17", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toContain("```ts");
		});

		it("detects JavaScript", async () => {
			const filePath = join(testDir, "code.js");
			writeFileSync(filePath, "const x = 1;");

			const result = await readTool.execute("read-18", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toContain("```javascript");
		});

		it("detects Python", async () => {
			const filePath = join(testDir, "code.py");
			writeFileSync(filePath, "x = 1");

			const result = await readTool.execute("read-19", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toContain("```python");
		});

		it("allows language override", async () => {
			const filePath = join(testDir, "override.txt");
			writeFileSync(filePath, "SELECT * FROM table");

			const result = await readTool.execute("read-20", {
				path: filePath,
				language: "sql",
			});

			const output = getTextOutput(result);
			expect(output).toContain("```sql");
		});
	});

	describe("binary file handling", () => {
		it("detects binary files", async () => {
			const filePath = join(testDir, "binary.bin");
			writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0xff]));

			const result = await readTool.execute("read-21", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toContain("Binary file detected");
		});

		it("can return binary as base64", async () => {
			const filePath = join(testDir, "binary64.bin");
			writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02]));

			const result = await readTool.execute("read-22", {
				path: filePath,
				asBase64: true,
			});

			const output = getTextOutput(result);
			expect(output).toContain("base64");
		});
	});

	describe("image file handling", () => {
		it("reads PNG files as images", async () => {
			const filePath = join(testDir, "test.png");
			// Minimal valid PNG header
			const pngHeader = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			]);
			writeFileSync(filePath, pngHeader);

			const result = await readTool.execute("read-23", { path: filePath });

			expect(result.isError).toBeFalsy();
			expect(hasImageContent(result)).toBe(true);
		});

		it("reads JPEG files as images", async () => {
			const filePath = join(testDir, "test.jpg");
			// Minimal JPEG header
			const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
			writeFileSync(filePath, jpegHeader);

			const result = await readTool.execute("read-24", { path: filePath });

			expect(result.isError).toBeFalsy();
			expect(hasImageContent(result)).toBe(true);
		});
	});

	describe("line truncation", () => {
		it("truncates very long lines", async () => {
			const filePath = join(testDir, "long-line.txt");
			const longLine = "x".repeat(3000);
			writeFileSync(filePath, longLine);

			const result = await readTool.execute("read-25", { path: filePath });

			const output = getTextOutput(result);
			expect(output).toContain("truncated");
			expect(output.length).toBeLessThan(longLine.length + 500);
		});
	});

	describe("tilde expansion", () => {
		it("expands ~ in paths", async () => {
			// This test checks that the path expansion doesn't throw
			// We can't easily test actual home directory expansion
			const result = await readTool.execute("read-26", {
				path: "~/nonexistent-file-for-test.txt",
			});

			// Should attempt to read from home, not literally "~/"
			expect(result.isError).toBe(true);
			// The error should be file not found, not invalid path
			expect(getTextOutput(result)).toContain("File not found");
		});
	});

	describe("details metadata", () => {
		it("includes line count in details", async () => {
			const filePath = join(testDir, "metadata.txt");
			writeFileSync(filePath, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("read-27", { path: filePath });

			expect(result.details).toMatchObject({
				totalLines: 3,
			});
		});

		it("includes start and end line in details", async () => {
			const filePath = join(testDir, "range.txt");
			const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(filePath, lines.join("\n"));

			const result = await readTool.execute("read-28", {
				path: filePath,
				offset: 5,
				limit: 3,
			});

			expect(result.details).toMatchObject({
				startLine: 5,
				endLine: 7,
				totalLines: 20,
			});
		});

		it("includes mode in details", async () => {
			const filePath = join(testDir, "mode.txt");
			writeFileSync(filePath, "Content");

			const result = await readTool.execute("read-29", {
				path: filePath,
				mode: "tail",
			});

			expect(result.details).toMatchObject({
				mode: "tail",
			});
		});
	});

	describe("abort signal handling", () => {
		it("respects abort signal", async () => {
			const filePath = join(testDir, "abort.txt");
			writeFileSync(filePath, "Content");

			const controller = new AbortController();
			controller.abort();

			await expect(
				readTool.execute("read-30", { path: filePath }, controller.signal),
			).rejects.toThrow("aborted");
		});
	});

	describe("notebook files", () => {
		it("reads Jupyter notebook files", async () => {
			const filePath = join(testDir, "notebook.ipynb");
			const notebook = {
				cells: [
					{
						cell_type: "code",
						source: ["print('hello')"],
						outputs: [],
					},
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 0,
			};
			writeFileSync(filePath, JSON.stringify(notebook));

			const result = await readTool.execute("read-31", { path: filePath });

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("print");
		});
	});

	describe("relative paths", () => {
		it("handles relative paths", async () => {
			const filePath = join(testDir, "relative.txt");
			writeFileSync(filePath, "Relative content");

			// Change to testDir temporarily
			const originalCwd = process.cwd();
			try {
				process.chdir(testDir);
				const result = await readTool.execute("read-32", {
					path: "./relative.txt",
				});

				expect(result.isError).toBeFalsy();
				const output = getTextOutput(result);
				expect(output).toContain("Relative content");
			} finally {
				process.chdir(originalCwd);
			}
		});
	});
});
