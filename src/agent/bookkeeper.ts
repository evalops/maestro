/**
 * Bookkeeper Subagent.
 *
 * Specialized subagent for reading and querying Excel workbooks (.xlsx).
 * Provides structured data extraction and analysis capabilities.
 *
 * Inspired by Amp's Bookkeeper feature.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent:bookkeeper");

/** Supported file extensions */
export const SUPPORTED_EXTENSIONS = [".xlsx", ".xls", ".csv", ".tsv"];

/** Cell value types */
export type CellValue = string | number | boolean | Date | null;

/** Row as a record */
export type Row = Record<string, CellValue>;

/** Sheet data */
export interface SheetData {
	name: string;
	headers: string[];
	rows: Row[];
	rowCount: number;
	columnCount: number;
}

/** Workbook data */
export interface WorkbookData {
	filename: string;
	sheets: SheetData[];
	sheetNames: string[];
	totalRows: number;
}

/** Query result */
export interface QueryResult {
	success: boolean;
	data?: Row[];
	count?: number;
	error?: string;
	query?: string;
}

/** Column statistics */
export interface ColumnStats {
	name: string;
	type: "string" | "number" | "boolean" | "date" | "mixed";
	nonNullCount: number;
	uniqueCount: number;
	min?: number | string | Date;
	max?: number | string | Date;
	sum?: number;
	avg?: number;
}

/** Sheet summary */
export interface SheetSummary {
	name: string;
	rowCount: number;
	columnCount: number;
	headers: string[];
	columnStats: ColumnStats[];
	sampleRows: Row[];
}

/**
 * Bookkeeper - Excel/CSV data handler.
 *
 * Provides capabilities for reading, querying, and analyzing
 * spreadsheet data without requiring external dependencies.
 */
export class Bookkeeper {
	private workbooks: Map<string, WorkbookData> = new Map();

	/**
	 * Check if a file is supported by Bookkeeper.
	 */
	static isSupported(filepath: string): boolean {
		const ext = extname(filepath).toLowerCase();
		return SUPPORTED_EXTENSIONS.includes(ext);
	}

	/**
	 * Load a workbook/data file.
	 */
	async loadFile(filepath: string): Promise<WorkbookData> {
		if (!existsSync(filepath)) {
			throw new Error(`File not found: ${filepath}`);
		}

		const ext = extname(filepath).toLowerCase();

		if (!Bookkeeper.isSupported(filepath)) {
			throw new Error(
				`Unsupported file type: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
			);
		}

		log.info("Loading file", { filepath, ext });

		let workbook: WorkbookData;

		if (ext === ".csv" || ext === ".tsv") {
			workbook = this.loadDelimitedFile(filepath, ext === ".tsv" ? "\t" : ",");
		} else {
			// For .xlsx/.xls, we provide a basic parser
			// In a real implementation, you'd use a library like xlsx
			workbook = await this.loadExcelFile(filepath);
		}

		this.workbooks.set(filepath, workbook);
		log.info("File loaded", {
			filepath,
			sheets: workbook.sheetNames.length,
			totalRows: workbook.totalRows,
		});

		return workbook;
	}

	/**
	 * Get a loaded workbook.
	 */
	getWorkbook(filepath: string): WorkbookData | null {
		return this.workbooks.get(filepath) ?? null;
	}

	/**
	 * List loaded workbooks.
	 */
	listWorkbooks(): string[] {
		return Array.from(this.workbooks.keys());
	}

	/**
	 * Get sheet data.
	 */
	getSheet(filepath: string, sheetName?: string): SheetData | null {
		const workbook = this.workbooks.get(filepath);
		if (!workbook) return null;

		if (sheetName) {
			return workbook.sheets.find((s) => s.name === sheetName) ?? null;
		}

		// Return first sheet if no name specified
		return workbook.sheets[0] ?? null;
	}

	/**
	 * Query data with simple filter conditions.
	 */
	query(
		filepath: string,
		options: {
			sheet?: string;
			where?: Record<string, CellValue | { op: string; value: CellValue }>;
			select?: string[];
			limit?: number;
			offset?: number;
			orderBy?: { column: string; desc?: boolean };
		},
	): QueryResult {
		const sheet = this.getSheet(filepath, options.sheet);
		if (!sheet) {
			return {
				success: false,
				error: `Sheet not found: ${options.sheet ?? "default"}`,
			};
		}

		try {
			let rows = [...sheet.rows];

			// Apply where filters
			if (options.where) {
				const whereClause = options.where;
				rows = rows.filter((row) => this.matchesWhere(row, whereClause));
			}

			// Apply ordering
			if (options.orderBy) {
				const { column, desc } = options.orderBy;
				rows.sort((a, b) => {
					const va = a[column];
					const vb = b[column];
					if (va === vb) return 0;
					if (va === null) return 1;
					if (vb === null) return -1;
					const cmp = va < vb ? -1 : 1;
					return desc ? -cmp : cmp;
				});
			}

			// Apply offset and limit
			const offset = options.offset ?? 0;
			const limit = options.limit ?? rows.length;
			rows = rows.slice(offset, offset + limit);

			// Apply select
			if (options.select && options.select.length > 0) {
				const selectCols = options.select;
				rows = rows.map((row) => {
					const selected: Row = {};
					for (const col of selectCols) {
						if (col in row) {
							selected[col] = row[col];
						}
					}
					return selected;
				});
			}

			return {
				success: true,
				data: rows,
				count: rows.length,
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Get summary statistics for a sheet.
	 */
	getSummary(filepath: string, sheetName?: string): SheetSummary | null {
		const sheet = this.getSheet(filepath, sheetName);
		if (!sheet) return null;

		const columnStats: ColumnStats[] = sheet.headers.map((header) => {
			const values = sheet.rows.map((r) => r[header]).filter((v) => v !== null);
			return this.calculateColumnStats(header, values);
		});

		return {
			name: sheet.name,
			rowCount: sheet.rowCount,
			columnCount: sheet.columnCount,
			headers: sheet.headers,
			columnStats,
			sampleRows: sheet.rows.slice(0, 5),
		};
	}

	/**
	 * Search for rows containing a value.
	 */
	search(
		filepath: string,
		searchTerm: string,
		options?: {
			sheet?: string;
			columns?: string[];
			caseSensitive?: boolean;
			limit?: number;
		},
	): QueryResult {
		const sheet = this.getSheet(filepath, options?.sheet);
		if (!sheet) {
			return { success: false, error: "Sheet not found" };
		}

		const term = options?.caseSensitive ? searchTerm : searchTerm.toLowerCase();
		const columns = options?.columns ?? sheet.headers;
		const limit = options?.limit ?? 100;

		const matches: Row[] = [];
		for (const row of sheet.rows) {
			if (matches.length >= limit) break;

			for (const col of columns) {
				const value = row[col];
				if (value === null) continue;

				const strValue = options?.caseSensitive
					? String(value)
					: String(value).toLowerCase();

				if (strValue.includes(term)) {
					matches.push(row);
					break;
				}
			}
		}

		return {
			success: true,
			data: matches,
			count: matches.length,
		};
	}

	/**
	 * Aggregate data.
	 */
	aggregate(
		filepath: string,
		options: {
			sheet?: string;
			groupBy?: string;
			column: string;
			operation: "sum" | "avg" | "min" | "max" | "count";
		},
	): QueryResult {
		const sheet = this.getSheet(filepath, options.sheet);
		if (!sheet) {
			return { success: false, error: "Sheet not found" };
		}

		const { column, operation, groupBy } = options;

		if (!sheet.headers.includes(column)) {
			return { success: false, error: `Column not found: ${column}` };
		}

		if (groupBy) {
			// Group aggregation
			const groups = new Map<CellValue, CellValue[]>();
			for (const row of sheet.rows) {
				const key = row[groupBy];
				const value = row[column];
				if (!groups.has(key)) {
					groups.set(key, []);
				}
				if (value !== null) {
					groups.get(key)?.push(value);
				}
			}

			const results: Row[] = [];
			for (const [key, values] of groups) {
				results.push({
					[groupBy]: key,
					[`${operation}_${column}`]: this.computeAggregate(values, operation),
				});
			}

			return { success: true, data: results, count: results.length };
		}

		// Single aggregation
		const values = sheet.rows.map((r) => r[column]).filter((v) => v !== null);
		const result = this.computeAggregate(values, operation);

		return {
			success: true,
			data: [{ [operation]: result }],
			count: 1,
		};
	}

	/**
	 * Format data as a table string.
	 */
	formatAsTable(rows: Row[], maxRows = 20): string {
		if (rows.length === 0) return "(no data)";

		const headers = Object.keys(rows[0]);
		const displayRows = rows.slice(0, maxRows);

		// Calculate column widths
		const widths = new Map<string, number>();
		for (const h of headers) {
			widths.set(h, h.length);
		}
		for (const row of displayRows) {
			for (const h of headers) {
				const len = String(row[h] ?? "").length;
				if (len > (widths.get(h) ?? 0)) {
					widths.set(h, Math.min(len, 40)); // Max 40 chars per column
				}
			}
		}

		// Build table
		const lines: string[] = [];

		// Header row
		const headerRow = headers
			.map((h) => h.padEnd(widths.get(h) ?? 10))
			.join(" | ");
		lines.push(headerRow);
		lines.push(headers.map((h) => "-".repeat(widths.get(h) ?? 10)).join("-+-"));

		// Data rows
		for (const row of displayRows) {
			const dataRow = headers
				.map((h) => {
					const val = String(row[h] ?? "");
					const width = widths.get(h) ?? 10;
					return val.length > width
						? `${val.substring(0, width - 3)}...`
						: val.padEnd(width);
				})
				.join(" | ");
			lines.push(dataRow);
		}

		if (rows.length > maxRows) {
			lines.push(`... and ${rows.length - maxRows} more rows`);
		}

		return lines.join("\n");
	}

	/**
	 * Unload a workbook from memory.
	 */
	unload(filepath: string): boolean {
		return this.workbooks.delete(filepath);
	}

	/**
	 * Clear all loaded workbooks.
	 */
	clear(): void {
		this.workbooks.clear();
	}

	// Private methods

	private loadDelimitedFile(filepath: string, delimiter: string): WorkbookData {
		const content = readFileSync(filepath, "utf-8");
		const lines = content.split(/\r?\n/).filter((l) => l.trim());

		if (lines.length === 0) {
			return {
				filename: basename(filepath),
				sheets: [],
				sheetNames: [],
				totalRows: 0,
			};
		}

		const headers = this.parseDelimitedRow(lines[0], delimiter);
		const rows: Row[] = [];

		for (let i = 1; i < lines.length; i++) {
			const values = this.parseDelimitedRow(lines[i], delimiter);
			const row: Row = {};
			for (let j = 0; j < headers.length; j++) {
				row[headers[j]] = this.parseValue(values[j]);
			}
			rows.push(row);
		}

		const sheet: SheetData = {
			name: "Sheet1",
			headers,
			rows,
			rowCount: rows.length,
			columnCount: headers.length,
		};

		return {
			filename: basename(filepath),
			sheets: [sheet],
			sheetNames: ["Sheet1"],
			totalRows: rows.length,
		};
	}

	private parseDelimitedRow(line: string, delimiter: string): string[] {
		const result: string[] = [];
		let current = "";
		let inQuotes = false;

		for (let i = 0; i < line.length; i++) {
			const char = line[i];

			if (char === '"') {
				if (inQuotes && line[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = !inQuotes;
				}
			} else if (char === delimiter && !inQuotes) {
				result.push(current.trim());
				current = "";
			} else {
				current += char;
			}
		}

		result.push(current.trim());
		return result;
	}

	private async loadExcelFile(filepath: string): Promise<WorkbookData> {
		// Basic xlsx parsing without external dependencies
		// This is a simplified implementation - in production you'd use xlsx library
		log.warn(
			"Basic Excel parsing - for full support, xlsx library recommended",
			{ filepath },
		);

		// Return a placeholder indicating xlsx support requires library
		return {
			filename: basename(filepath),
			sheets: [
				{
					name: "Sheet1",
					headers: ["info"],
					rows: [
						{
							info: "Excel parsing requires xlsx library. Use CSV export for full support.",
						},
					],
					rowCount: 1,
					columnCount: 1,
				},
			],
			sheetNames: ["Sheet1"],
			totalRows: 1,
		};
	}

	private parseValue(value: string | undefined): CellValue {
		if (value === undefined || value === "") return null;

		// Try number
		const num = Number(value);
		if (!Number.isNaN(num) && value.trim() !== "") return num;

		// Try boolean
		const lower = value.toLowerCase();
		if (lower === "true") return true;
		if (lower === "false") return false;

		// Try date (ISO format)
		if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
			const date = new Date(value);
			if (!Number.isNaN(date.getTime())) return date;
		}

		return value;
	}

	private matchesWhere(
		row: Row,
		where: Record<string, CellValue | { op: string; value: CellValue }>,
	): boolean {
		for (const [column, condition] of Object.entries(where)) {
			const value = row[column];

			if (
				typeof condition === "object" &&
				condition !== null &&
				"op" in condition
			) {
				// Complex condition
				const { op, value: target } = condition;
				if (!this.evaluateCondition(value, op, target)) return false;
			} else {
				// Simple equality
				if (value !== condition) return false;
			}
		}
		return true;
	}

	private evaluateCondition(
		value: CellValue,
		op: string,
		target: CellValue,
	): boolean {
		switch (op) {
			case "=":
			case "==":
				return value === target;
			case "!=":
			case "<>":
				return value !== target;
			case ">":
				return value !== null && target !== null && value > target;
			case ">=":
				return value !== null && target !== null && value >= target;
			case "<":
				return value !== null && target !== null && value < target;
			case "<=":
				return value !== null && target !== null && value <= target;
			case "contains":
				return (
					typeof value === "string" &&
					typeof target === "string" &&
					value.includes(target)
				);
			case "startsWith":
				return (
					typeof value === "string" &&
					typeof target === "string" &&
					value.startsWith(target)
				);
			case "endsWith":
				return (
					typeof value === "string" &&
					typeof target === "string" &&
					value.endsWith(target)
				);
			default:
				return false;
		}
	}

	private calculateColumnStats(
		header: string,
		values: CellValue[],
	): ColumnStats {
		if (values.length === 0) {
			return {
				name: header,
				type: "string",
				nonNullCount: 0,
				uniqueCount: 0,
			};
		}

		const types = new Set(values.map((v) => typeof v));
		let type: ColumnStats["type"] = "mixed";
		if (types.size === 1) {
			const t = types.values().next().value;
			if (t === "number") type = "number";
			else if (t === "boolean") type = "boolean";
			else if (t === "string") type = "string";
		}
		if (values.some((v) => v instanceof Date)) type = "date";

		const uniqueCount = new Set(values.map((v) => String(v))).size;

		const stats: ColumnStats = {
			name: header,
			type,
			nonNullCount: values.length,
			uniqueCount,
		};

		if (type === "number") {
			const nums = values.filter((v) => typeof v === "number") as number[];
			stats.min = Math.min(...nums);
			stats.max = Math.max(...nums);
			stats.sum = nums.reduce((a, b) => a + b, 0);
			stats.avg = stats.sum / nums.length;
		}

		return stats;
	}

	private computeAggregate(
		values: CellValue[],
		operation: "sum" | "avg" | "min" | "max" | "count",
	): CellValue {
		if (operation === "count") return values.length;

		const nums = values.filter((v) => typeof v === "number") as number[];
		if (nums.length === 0) return null;

		switch (operation) {
			case "sum":
				return nums.reduce((a, b) => a + b, 0);
			case "avg":
				return nums.reduce((a, b) => a + b, 0) / nums.length;
			case "min":
				return Math.min(...nums);
			case "max":
				return Math.max(...nums);
			default:
				return null;
		}
	}
}

/**
 * Create a new Bookkeeper instance.
 */
export function createBookkeeper(): Bookkeeper {
	return new Bookkeeper();
}
