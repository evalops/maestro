/**
 * Jupyter Notebook editing tool.
 * Supports reading and editing .ipynb files at the cell level.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { Type } from "@sinclair/typebox";
import { createTool, expandUserPath } from "./tool-dsl.js";

// Jupyter notebook cell types
interface NotebookCell {
	id?: string;
	cell_type: "code" | "markdown" | "raw";
	source: string | string[];
	metadata: Record<string, unknown>;
	execution_count?: number | null;
	outputs?: unknown[];
}

interface NotebookContent {
	cells: NotebookCell[];
	metadata: Record<string, unknown>;
	nbformat: number;
	nbformat_minor: number;
}

const notebookEditSchema = Type.Object({
	path: Type.String({
		description: "Path to the Jupyter notebook file (.ipynb)",
		minLength: 1,
	}),
	cell_id: Type.Optional(
		Type.String({
			description:
				"Cell ID to edit. For insert mode, new cell is inserted after this cell. Omit to insert at beginning.",
		}),
	),
	cell_index: Type.Optional(
		Type.Integer({
			description:
				"Cell index (0-based) to edit. Used if cell_id is not provided.",
			minimum: 0,
		}),
	),
	new_source: Type.String({
		description: "The new source content for the cell",
	}),
	cell_type: Type.Optional(
		Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
			description:
				"Cell type (code or markdown). Required for insert mode, defaults to current type for replace.",
		}),
	),
	edit_mode: Type.Optional(
		Type.Union(
			[Type.Literal("replace"), Type.Literal("insert"), Type.Literal("delete")],
			{
				description:
					"Edit mode: replace (default), insert (add new cell), or delete (remove cell)",
				default: "replace",
			},
		),
	),
});

function normalizeSource(source: string | string[]): string {
	if (Array.isArray(source)) {
		return source.join("");
	}
	return source;
}

function sourceToArray(source: string): string[] {
	// Split preserving newlines as separate elements for proper notebook format
	const lines = source.split("\n");
	return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

function generateCellId(): string {
	// Generate a random cell ID similar to Jupyter's format
	return Math.random().toString(36).substring(2, 10);
}

function findCellIndex(
	cells: NotebookCell[],
	cellId?: string,
	cellIndex?: number,
): number {
	if (cellId !== undefined) {
		const index = cells.findIndex((c) => c.id === cellId);
		if (index === -1) {
			throw new Error(`Cell with ID "${cellId}" not found`);
		}
		return index;
	}
	if (cellIndex !== undefined) {
		if (cellIndex >= cells.length) {
			throw new Error(
				`Cell index ${cellIndex} out of range (notebook has ${cells.length} cells)`,
			);
		}
		return cellIndex;
	}
	return -1; // For insert at beginning
}

function formatCellPreview(cell: NotebookCell, index: number): string {
	const source = normalizeSource(cell.source);
	const preview = source.split("\n").slice(0, 3).join("\n");
	const truncated = source.split("\n").length > 3 ? "..." : "";
	const cellId = cell.id ? ` (id: ${cell.id})` : "";
	return `[${index}] ${cell.cell_type}${cellId}:\n${preview}${truncated}`;
}

type NotebookToolDetails = {
	cellIndex?: number;
	cellId?: string;
	mode?: string;
	totalCells?: number;
};

export const notebookEditTool = createTool<
	typeof notebookEditSchema,
	NotebookToolDetails
>({
	name: "notebook_edit",
	label: "notebook",
	description: `Edit Jupyter notebook (.ipynb) files at the cell level.

Parameters:
- path: Path to the notebook file
- cell_id: ID of the cell to edit (optional, use cell_index if not available)
- cell_index: 0-based index of the cell (used if cell_id not provided)
- new_source: New content for the cell
- cell_type: "code" or "markdown" (required for insert, optional for replace)
- edit_mode: "replace" (default), "insert", or "delete"

Modes:
- replace: Replace cell content (default)
- insert: Insert new cell after specified cell (or at beginning if no cell specified)
- delete: Remove the specified cell (new_source is ignored)

Use 'read' tool first to view notebook structure and get cell IDs/indices.`,
	schema: notebookEditSchema,
	async run(
		{ path, cell_id, cell_index, new_source, cell_type, edit_mode = "replace" },
		{ signal, respond },
	) {
		const throwIfAborted = () => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
		};

		const absolutePath = resolvePath(expandUserPath(path));

		// Validate file extension
		if (extname(absolutePath).toLowerCase() !== ".ipynb") {
			return respond.error(`File must be a Jupyter notebook (.ipynb): ${path}`);
		}

		// Check file exists and is readable/writable
		try {
			await access(absolutePath, constants.R_OK | constants.W_OK);
		} catch {
			if (
				edit_mode === "insert" &&
				cell_id === undefined &&
				cell_index === undefined
			) {
				// Creating new notebook
				const newNotebook: NotebookContent = {
					cells: [
						{
							id: generateCellId(),
							cell_type: cell_type || "code",
							source: sourceToArray(new_source),
							metadata: {},
							execution_count: null,
							outputs: [],
						},
					],
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
				await writeFile(absolutePath, JSON.stringify(newNotebook, null, 1));
				return respond
					.text(
						`Created new notebook with 1 ${cell_type || "code"} cell: ${path}`,
					)
					.detail({ cellIndex: 0, mode: "create", totalCells: 1 });
			}
			return respond.error(`File not found or not writable: ${path}`);
		}

		throwIfAborted();

		// Read and parse notebook
		let notebook: NotebookContent;
		try {
			const content = await readFile(absolutePath, "utf-8");
			notebook = JSON.parse(content) as NotebookContent;
		} catch (err) {
			return respond.error(
				`Failed to parse notebook: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (!notebook.cells || !Array.isArray(notebook.cells)) {
			return respond.error("Invalid notebook format: missing cells array");
		}

		throwIfAborted();

		const cells = notebook.cells;
		let targetIndex: number;
		let resultMessage: string;
		let resultCellId: string | undefined;

		switch (edit_mode) {
			case "replace": {
				if (cell_id === undefined && cell_index === undefined) {
					return respond.error(
						"Must specify cell_id or cell_index for replace mode",
					);
				}
				targetIndex = findCellIndex(cells, cell_id, cell_index);
				const targetCell = cells[targetIndex];
				const newType = cell_type || targetCell.cell_type;

				cells[targetIndex] = {
					...targetCell,
					cell_type: newType,
					source: sourceToArray(new_source),
					// Reset outputs for code cells when content changes
					...(newType === "code" ? { outputs: [], execution_count: null } : {}),
				};
				resultCellId = cells[targetIndex].id;
				resultMessage = `Replaced cell ${targetIndex} in ${path}`;
				break;
			}

			case "insert": {
				if (!cell_type) {
					return respond.error("cell_type is required for insert mode");
				}
				const newCell: NotebookCell = {
					id: generateCellId(),
					cell_type,
					source: sourceToArray(new_source),
					metadata: {},
					...(cell_type === "code"
						? { outputs: [], execution_count: null }
						: {}),
				};

				if (cell_id === undefined && cell_index === undefined) {
					// Insert at beginning
					cells.unshift(newCell);
					targetIndex = 0;
				} else {
					// Insert after specified cell
					const afterIndex = findCellIndex(cells, cell_id, cell_index);
					cells.splice(afterIndex + 1, 0, newCell);
					targetIndex = afterIndex + 1;
				}
				resultCellId = newCell.id;
				resultMessage = `Inserted new ${cell_type} cell at index ${targetIndex} in ${path}`;
				break;
			}

			case "delete": {
				if (cell_id === undefined && cell_index === undefined) {
					return respond.error(
						"Must specify cell_id or cell_index for delete mode",
					);
				}
				targetIndex = findCellIndex(cells, cell_id, cell_index);
				const deletedCell = cells[targetIndex];
				cells.splice(targetIndex, 1);
				resultCellId = deletedCell.id;
				resultMessage = `Deleted cell ${targetIndex} from ${path}`;
				break;
			}

			default:
				return respond.error(`Unknown edit_mode: ${edit_mode}`);
		}

		// Write updated notebook
		await writeFile(absolutePath, JSON.stringify(notebook, null, 1));

		return respond.text(resultMessage).detail({
			cellIndex: targetIndex,
			cellId: resultCellId,
			mode: edit_mode,
			totalCells: cells.length,
		});
	},
});

// Reading notebooks is handled by extending the read tool
// This function can be used to format notebook content for display
export function formatNotebookForDisplay(content: string): string {
	try {
		const notebook = JSON.parse(content) as NotebookContent;
		const lines: string[] = [];

		lines.push(`# Jupyter Notebook (${notebook.cells.length} cells)`);
		lines.push(`# nbformat: ${notebook.nbformat}.${notebook.nbformat_minor}`);
		lines.push("");

		for (const [index, cell] of notebook.cells.entries()) {
			const cellId = cell.id ? ` [id: ${cell.id}]` : "";
			const execCount = cell.execution_count
				? ` In[${cell.execution_count}]`
				: "";

			lines.push(
				"# ═══════════════════════════════════════════════════════════",
			);
			lines.push(`# Cell ${index}: ${cell.cell_type}${cellId}${execCount}`);
			lines.push(
				"# ───────────────────────────────────────────────────────────",
			);

			const source = normalizeSource(cell.source);
			if (cell.cell_type === "markdown") {
				// Show markdown as-is
				lines.push(source);
			} else {
				// Code cells with syntax highlighting hint
				lines.push("```python");
				lines.push(source);
				lines.push("```");
			}

			// Show outputs for code cells
			if (
				cell.cell_type === "code" &&
				cell.outputs &&
				cell.outputs.length > 0
			) {
				lines.push("");
				lines.push("# Output:");
				for (const output of cell.outputs as Array<{
					output_type: string;
					text?: string | string[];
					data?: Record<string, string | string[]>;
					ename?: string;
					evalue?: string;
				}>) {
					if (output.output_type === "stream" && output.text) {
						const text = Array.isArray(output.text)
							? output.text.join("")
							: output.text;
						lines.push(text);
					} else if (output.output_type === "execute_result" && output.data) {
						const textData = output.data["text/plain"];
						if (textData) {
							const text = Array.isArray(textData)
								? textData.join("")
								: textData;
							lines.push(text);
						}
					} else if (output.output_type === "error") {
						lines.push(`ERROR: ${output.ename}: ${output.evalue}`);
					}
				}
			}
			lines.push("");
		}

		return lines.join("\n");
	} catch {
		// If parsing fails, return raw content
		return content;
	}
}

export function isNotebookFile(filePath: string): boolean {
	return extname(filePath).toLowerCase() === ".ipynb";
}
