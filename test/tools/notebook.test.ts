import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../src/agent/types.js";
import {
	formatNotebookForDisplay,
	isNotebookFile,
	notebookEditTool,
} from "../../src/tools/notebook.js";

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

// Sample notebook structure
function createTestNotebook(
	cells: Array<{
		id?: string;
		cell_type: "code" | "markdown";
		source: string[];
		outputs?: unknown[];
	}>,
) {
	return {
		cells: cells.map((cell, i) => ({
			id: cell.id || `cell-${i}`,
			cell_type: cell.cell_type,
			source: cell.source,
			metadata: {},
			...(cell.cell_type === "code"
				? { outputs: cell.outputs || [], execution_count: null }
				: {}),
		})),
		metadata: {
			kernelspec: {
				display_name: "Python 3",
				language: "python",
				name: "python3",
			},
		},
		nbformat: 4,
		nbformat_minor: 5,
	};
}

describe("notebook edit tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "notebook-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("replace mode", () => {
		it("replaces cell content by index", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["print('hello')"] },
				{ cell_type: "code", source: ["print('world')"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-1", {
				path: notebookPath,
				cell_index: 0,
				new_source: "print('replaced')",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Replaced cell 0");

			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells[0].source).toContain("print('replaced')");
		});

		it("replaces cell content by ID", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ id: "my-cell-id", cell_type: "code", source: ["original"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-2", {
				path: notebookPath,
				cell_id: "my-cell-id",
				new_source: "modified",
			});

			expect(result.isError).toBeFalsy();
			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells[0].source).toContain("modified");
		});

		it("can change cell type during replace", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["# comment"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-3", {
				path: notebookPath,
				cell_index: 0,
				new_source: "# Markdown Header",
				cell_type: "markdown",
			});

			expect(result.isError).toBeFalsy();
			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells[0].cell_type).toBe("markdown");
		});

		it("errors when cell ID not found", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ id: "existing", cell_type: "code", source: ["x"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			await expect(
				notebookEditTool.execute("nb-4", {
					path: notebookPath,
					cell_id: "nonexistent",
					new_source: "new",
				}),
			).rejects.toThrow("not found");
		});

		it("errors when cell index out of range", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["x"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			await expect(
				notebookEditTool.execute("nb-5", {
					path: notebookPath,
					cell_index: 99,
					new_source: "new",
				}),
			).rejects.toThrow("out of range");
		});
	});

	describe("insert mode", () => {
		it("inserts cell at beginning", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["existing"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-6", {
				path: notebookPath,
				new_source: "new first cell",
				cell_type: "code",
				edit_mode: "insert",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Inserted");
			expect(output).toContain("index 0");

			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells).toHaveLength(2);
			expect(updated.cells[0].source).toContain("new first cell");
		});

		it("inserts cell after specified cell", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ id: "first", cell_type: "code", source: ["first"] },
				{ id: "second", cell_type: "code", source: ["second"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-7", {
				path: notebookPath,
				cell_id: "first",
				new_source: "inserted",
				cell_type: "markdown",
				edit_mode: "insert",
			});

			expect(result.isError).toBeFalsy();
			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells).toHaveLength(3);
			expect(updated.cells[1].source).toContain("inserted");
			expect(updated.cells[1].cell_type).toBe("markdown");
		});

		it("requires cell_type for insert", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["x"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-8", {
				path: notebookPath,
				new_source: "new",
				edit_mode: "insert",
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("cell_type is required");
		});

		it("creates new notebook on insert to non-existent file", async () => {
			const notebookPath = join(testDir, "new.ipynb");

			const result = await notebookEditTool.execute("nb-9", {
				path: notebookPath,
				new_source: "print('hello')",
				cell_type: "code",
				edit_mode: "insert",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Created new notebook");

			const created = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(created.cells).toHaveLength(1);
			expect(created.cells[0].cell_type).toBe("code");
		});
	});

	describe("delete mode", () => {
		it("deletes cell by index", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["first"] },
				{ cell_type: "code", source: ["second"] },
				{ cell_type: "code", source: ["third"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-10", {
				path: notebookPath,
				cell_index: 1,
				new_source: "", // Ignored for delete
				edit_mode: "delete",
			});

			expect(result.isError).toBeFalsy();
			const output = getTextOutput(result);
			expect(output).toContain("Deleted cell 1");

			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells).toHaveLength(2);
		});

		it("deletes cell by ID", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ id: "keep-1", cell_type: "code", source: ["keep"] },
				{ id: "remove", cell_type: "code", source: ["remove"] },
				{ id: "keep-2", cell_type: "code", source: ["keep"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-11", {
				path: notebookPath,
				cell_id: "remove",
				new_source: "",
				edit_mode: "delete",
			});

			expect(result.isError).toBeFalsy();
			const updated = JSON.parse(readFileSync(notebookPath, "utf-8"));
			expect(updated.cells).toHaveLength(2);
			expect(
				updated.cells.find((c: { id: string }) => c.id === "remove"),
			).toBeUndefined();
		});

		it("requires cell_id or cell_index for delete", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ cell_type: "code", source: ["x"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-12", {
				path: notebookPath,
				new_source: "",
				edit_mode: "delete",
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("Must specify cell_id or cell_index");
		});
	});

	describe("validation", () => {
		it("rejects non-ipynb files", async () => {
			const filePath = join(testDir, "test.txt");
			writeFileSync(filePath, "not a notebook");

			const result = await notebookEditTool.execute("nb-13", {
				path: filePath,
				cell_index: 0,
				new_source: "x",
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain(".ipynb");
		});

		it("handles invalid JSON in notebook", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			writeFileSync(notebookPath, "not valid json");

			const result = await notebookEditTool.execute("nb-14", {
				path: notebookPath,
				cell_index: 0,
				new_source: "x",
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("Failed to parse");
		});

		it("handles notebook without cells array", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			writeFileSync(notebookPath, JSON.stringify({ metadata: {} }));

			const result = await notebookEditTool.execute("nb-15", {
				path: notebookPath,
				cell_index: 0,
				new_source: "x",
			});

			expect(result.isError).toBe(true);
			const output = getTextOutput(result);
			expect(output).toContain("Invalid notebook format");
		});
	});

	describe("details metadata", () => {
		it("includes cell index and mode in details", async () => {
			const notebookPath = join(testDir, "test.ipynb");
			const notebook = createTestNotebook([
				{ id: "test-id", cell_type: "code", source: ["x"] },
			]);
			writeFileSync(notebookPath, JSON.stringify(notebook));

			const result = await notebookEditTool.execute("nb-16", {
				path: notebookPath,
				cell_index: 0,
				new_source: "new",
			});

			expect(result.details).toMatchObject({
				cellIndex: 0,
				cellId: "test-id",
				mode: "replace",
				totalCells: 1,
			});
		});
	});
});

describe("formatNotebookForDisplay", () => {
	it("formats code cells with python fence", () => {
		const notebook = JSON.stringify(
			createTestNotebook([{ cell_type: "code", source: ["print('hello')"] }]),
		);

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("Jupyter Notebook");
		expect(formatted).toContain("Cell 0: code");
		expect(formatted).toContain("```python");
		expect(formatted).toContain("print('hello')");
		expect(formatted).toContain("```");
	});

	it("formats markdown cells without fence", () => {
		const notebook = JSON.stringify(
			createTestNotebook([{ cell_type: "markdown", source: ["# Header"] }]),
		);

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("Cell 0: markdown");
		expect(formatted).toContain("# Header");
	});

	it("shows cell IDs", () => {
		const notebook = JSON.stringify(
			createTestNotebook([
				{ id: "custom-id", cell_type: "code", source: ["x"] },
			]),
		);

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("custom-id");
	});

	it("shows execution count", () => {
		const notebook = JSON.stringify({
			cells: [
				{
					cell_type: "code",
					source: ["x"],
					execution_count: 5,
					metadata: {},
					outputs: [],
				},
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		});

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("In[5]");
	});

	it("shows stream output", () => {
		const notebook = JSON.stringify({
			cells: [
				{
					cell_type: "code",
					source: ["print('output')"],
					execution_count: 1,
					metadata: {},
					outputs: [{ output_type: "stream", text: "output\n" }],
				},
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		});

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("Output:");
		expect(formatted).toContain("output");
	});

	it("shows execute_result output", () => {
		const notebook = JSON.stringify({
			cells: [
				{
					cell_type: "code",
					source: ["42"],
					execution_count: 1,
					metadata: {},
					outputs: [
						{
							output_type: "execute_result",
							data: { "text/plain": "42" },
						},
					],
				},
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		});

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("42");
	});

	it("shows error output", () => {
		const notebook = JSON.stringify({
			cells: [
				{
					cell_type: "code",
					source: ["raise ValueError()"],
					execution_count: 1,
					metadata: {},
					outputs: [
						{
							output_type: "error",
							ename: "ValueError",
							evalue: "bad value",
						},
					],
				},
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		});

		const formatted = formatNotebookForDisplay(notebook);

		expect(formatted).toContain("ERROR");
		expect(formatted).toContain("ValueError");
		expect(formatted).toContain("bad value");
	});

	it("returns raw content on parse error", () => {
		const invalid = "not json";
		const formatted = formatNotebookForDisplay(invalid);
		expect(formatted).toBe(invalid);
	});
});

describe("isNotebookFile", () => {
	it("returns true for .ipynb files", () => {
		expect(isNotebookFile("notebook.ipynb")).toBe(true);
		expect(isNotebookFile("/path/to/notebook.ipynb")).toBe(true);
		expect(isNotebookFile("Notebook.IPYNB")).toBe(true);
	});

	it("returns false for non-notebook files", () => {
		expect(isNotebookFile("file.txt")).toBe(false);
		expect(isNotebookFile("file.py")).toBe(false);
		expect(isNotebookFile("file.ipynb.bak")).toBe(false);
	});
});
