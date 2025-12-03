import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Bookkeeper,
	SUPPORTED_EXTENSIONS,
	createBookkeeper,
} from "../../src/agent/bookkeeper.js";

describe("agent/bookkeeper", () => {
	let bookkeeper: Bookkeeper;
	let testDir: string;

	beforeEach(() => {
		bookkeeper = new Bookkeeper();
		testDir = join(tmpdir(), `bookkeeper-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		bookkeeper.clear();
		try {
			rmSync(testDir, { recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("isSupported", () => {
		it("returns true for supported extensions", () => {
			expect(Bookkeeper.isSupported("data.csv")).toBe(true);
			expect(Bookkeeper.isSupported("data.tsv")).toBe(true);
			expect(Bookkeeper.isSupported("data.xlsx")).toBe(true);
			expect(Bookkeeper.isSupported("data.xls")).toBe(true);
		});

		it("returns false for unsupported extensions", () => {
			expect(Bookkeeper.isSupported("data.json")).toBe(false);
			expect(Bookkeeper.isSupported("data.txt")).toBe(false);
			expect(Bookkeeper.isSupported("data.pdf")).toBe(false);
		});
	});

	describe("loadFile - CSV", () => {
		it("loads a simple CSV file", async () => {
			const csvPath = join(testDir, "test.csv");
			writeFileSync(csvPath, "name,age,city\nAlice,30,NYC\nBob,25,LA\n");

			const workbook = await bookkeeper.loadFile(csvPath);

			expect(workbook.sheets).toHaveLength(1);
			expect(workbook.sheets[0].headers).toEqual(["name", "age", "city"]);
			expect(workbook.sheets[0].rowCount).toBe(2);
			expect(workbook.totalRows).toBe(2);
		});

		it("parses numeric values", async () => {
			const csvPath = join(testDir, "nums.csv");
			writeFileSync(csvPath, "id,value\n1,100\n2,200.5\n");

			const workbook = await bookkeeper.loadFile(csvPath);
			const rows = workbook.sheets[0].rows;

			expect(rows[0].id).toBe(1);
			expect(rows[0].value).toBe(100);
			expect(rows[1].value).toBe(200.5);
		});

		it("parses boolean values", async () => {
			const csvPath = join(testDir, "bools.csv");
			writeFileSync(csvPath, "active,verified\ntrue,false\nTRUE,FALSE\n");

			const workbook = await bookkeeper.loadFile(csvPath);
			const rows = workbook.sheets[0].rows;

			expect(rows[0].active).toBe(true);
			expect(rows[0].verified).toBe(false);
		});

		it("handles quoted values with commas", async () => {
			const csvPath = join(testDir, "quoted.csv");
			writeFileSync(csvPath, 'name,address\n"Smith, John","123 Main St"\n');

			const workbook = await bookkeeper.loadFile(csvPath);
			const rows = workbook.sheets[0].rows;

			expect(rows[0].name).toBe("Smith, John");
			expect(rows[0].address).toBe("123 Main St");
		});

		it("handles empty values as null", async () => {
			const csvPath = join(testDir, "empty.csv");
			writeFileSync(csvPath, "a,b,c\n1,,3\n");

			const workbook = await bookkeeper.loadFile(csvPath);
			const rows = workbook.sheets[0].rows;

			expect(rows[0].a).toBe(1);
			expect(rows[0].b).toBeNull();
			expect(rows[0].c).toBe(3);
		});
	});

	describe("loadFile - TSV", () => {
		it("loads a TSV file", async () => {
			const tsvPath = join(testDir, "test.tsv");
			writeFileSync(tsvPath, "name\tage\nAlice\t30\n");

			const workbook = await bookkeeper.loadFile(tsvPath);

			expect(workbook.sheets[0].headers).toEqual(["name", "age"]);
			expect(workbook.sheets[0].rows[0].name).toBe("Alice");
		});
	});

	describe("loadFile - errors", () => {
		it("throws for non-existent file", async () => {
			await expect(
				bookkeeper.loadFile("/nonexistent/file.csv"),
			).rejects.toThrow("File not found");
		});

		it("throws for unsupported file type", async () => {
			const txtPath = join(testDir, "test.txt");
			writeFileSync(txtPath, "hello");

			await expect(bookkeeper.loadFile(txtPath)).rejects.toThrow(
				"Unsupported file type",
			);
		});
	});

	describe("getWorkbook / listWorkbooks", () => {
		it("retrieves loaded workbook", async () => {
			const csvPath = join(testDir, "test.csv");
			writeFileSync(csvPath, "a,b\n1,2\n");

			await bookkeeper.loadFile(csvPath);

			const workbook = bookkeeper.getWorkbook(csvPath);
			expect(workbook).not.toBeNull();
			expect(workbook?.totalRows).toBe(1);
		});

		it("returns null for unloaded workbook", () => {
			expect(bookkeeper.getWorkbook("/not/loaded.csv")).toBeNull();
		});

		it("lists all loaded workbooks", async () => {
			const csv1 = join(testDir, "a.csv");
			const csv2 = join(testDir, "b.csv");
			writeFileSync(csv1, "x\n1\n");
			writeFileSync(csv2, "y\n2\n");

			await bookkeeper.loadFile(csv1);
			await bookkeeper.loadFile(csv2);

			const list = bookkeeper.listWorkbooks();
			expect(list).toHaveLength(2);
			expect(list).toContain(csv1);
			expect(list).toContain(csv2);
		});
	});

	describe("query", () => {
		let csvPath: string;

		beforeEach(async () => {
			csvPath = join(testDir, "data.csv");
			writeFileSync(
				csvPath,
				"name,age,city,active\nAlice,30,NYC,true\nBob,25,LA,true\nCharlie,35,NYC,false\n",
			);
			await bookkeeper.loadFile(csvPath);
		});

		it("returns all rows without filters", () => {
			const result = bookkeeper.query(csvPath, {});
			expect(result.success).toBe(true);
			expect(result.count).toBe(3);
		});

		it("filters by simple equality", () => {
			const result = bookkeeper.query(csvPath, {
				where: { city: "NYC" },
			});
			expect(result.success).toBe(true);
			expect(result.count).toBe(2);
		});

		it("filters by comparison operator", () => {
			const result = bookkeeper.query(csvPath, {
				where: { age: { op: ">", value: 28 } },
			});
			expect(result.success).toBe(true);
			expect(result.count).toBe(2); // Alice (30) and Charlie (35)
		});

		it("selects specific columns", () => {
			const result = bookkeeper.query(csvPath, {
				select: ["name", "age"],
			});
			expect(result.success).toBe(true);
			expect(Object.keys(result.data?.[0])).toEqual(["name", "age"]);
		});

		it("limits results", () => {
			const result = bookkeeper.query(csvPath, { limit: 2 });
			expect(result.count).toBe(2);
		});

		it("offsets results", () => {
			const result = bookkeeper.query(csvPath, { offset: 1, limit: 1 });
			expect(result.count).toBe(1);
			expect(result.data?.[0].name).toBe("Bob");
		});

		it("orders by column ascending", () => {
			const result = bookkeeper.query(csvPath, {
				orderBy: { column: "age" },
			});
			expect(result.data?.[0].name).toBe("Bob"); // 25
			expect(result.data?.[2].name).toBe("Charlie"); // 35
		});

		it("orders by column descending", () => {
			const result = bookkeeper.query(csvPath, {
				orderBy: { column: "age", desc: true },
			});
			expect(result.data?.[0].name).toBe("Charlie"); // 35
			expect(result.data?.[2].name).toBe("Bob"); // 25
		});

		it("returns error for non-existent sheet", () => {
			const result = bookkeeper.query(csvPath, { sheet: "NoSuchSheet" });
			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});
	});

	describe("search", () => {
		let csvPath: string;

		beforeEach(async () => {
			csvPath = join(testDir, "search.csv");
			writeFileSync(
				csvPath,
				"title,description\nHello World,A greeting\nGoodbye World,A farewell\nHello Again,Another greeting\n",
			);
			await bookkeeper.loadFile(csvPath);
		});

		it("searches across all columns", () => {
			const result = bookkeeper.search(csvPath, "Hello");
			expect(result.success).toBe(true);
			expect(result.count).toBe(2);
		});

		it("searches specific columns", () => {
			const result = bookkeeper.search(csvPath, "greeting", {
				columns: ["description"],
			});
			expect(result.count).toBe(2);
		});

		it("performs case-insensitive search by default", () => {
			const result = bookkeeper.search(csvPath, "hello");
			expect(result.count).toBe(2);
		});

		it("performs case-sensitive search when requested", () => {
			const result = bookkeeper.search(csvPath, "hello", {
				caseSensitive: true,
			});
			expect(result.count).toBe(0);
		});

		it("limits search results", () => {
			const result = bookkeeper.search(csvPath, "World", { limit: 1 });
			expect(result.count).toBe(1);
		});
	});

	describe("aggregate", () => {
		let csvPath: string;

		beforeEach(async () => {
			csvPath = join(testDir, "sales.csv");
			writeFileSync(
				csvPath,
				"product,region,sales\nWidget,North,100\nWidget,South,150\nGadget,North,200\nGadget,South,250\n",
			);
			await bookkeeper.loadFile(csvPath);
		});

		it("computes sum", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "sales",
				operation: "sum",
			});
			expect(result.success).toBe(true);
			expect(result.data?.[0].sum).toBe(700);
		});

		it("computes average", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "sales",
				operation: "avg",
			});
			expect(result.data?.[0].avg).toBe(175);
		});

		it("computes min", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "sales",
				operation: "min",
			});
			expect(result.data?.[0].min).toBe(100);
		});

		it("computes max", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "sales",
				operation: "max",
			});
			expect(result.data?.[0].max).toBe(250);
		});

		it("computes count", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "sales",
				operation: "count",
			});
			expect(result.data?.[0].count).toBe(4);
		});

		it("groups by column", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "sales",
				operation: "sum",
				groupBy: "product",
			});
			expect(result.count).toBe(2);
			const widget = result.data?.find((r) => r.product === "Widget");
			const gadget = result.data?.find((r) => r.product === "Gadget");
			expect(widget?.sum_sales).toBe(250);
			expect(gadget?.sum_sales).toBe(450);
		});

		it("returns error for non-existent column", () => {
			const result = bookkeeper.aggregate(csvPath, {
				column: "nonexistent",
				operation: "sum",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});
	});

	describe("getSummary", () => {
		it("returns sheet summary with stats", async () => {
			const csvPath = join(testDir, "summary.csv");
			writeFileSync(csvPath, "name,score\nAlice,90\nBob,85\nCharlie,95\n");
			await bookkeeper.loadFile(csvPath);

			const summary = bookkeeper.getSummary(csvPath);

			expect(summary).not.toBeNull();
			expect(summary?.rowCount).toBe(3);
			expect(summary?.columnCount).toBe(2);
			expect(summary?.headers).toEqual(["name", "score"]);
			expect(summary?.sampleRows).toHaveLength(3);

			const scoreStats = summary?.columnStats.find((c) => c.name === "score");
			expect(scoreStats?.type).toBe("number");
			expect(scoreStats?.min).toBe(85);
			expect(scoreStats?.max).toBe(95);
			expect(scoreStats?.avg).toBe(90);
		});

		it("returns null for unloaded file", () => {
			expect(bookkeeper.getSummary("/not/loaded.csv")).toBeNull();
		});
	});

	describe("formatAsTable", () => {
		it("formats rows as ASCII table", () => {
			const rows = [
				{ name: "Alice", age: 30 },
				{ name: "Bob", age: 25 },
			];

			const table = bookkeeper.formatAsTable(rows);

			expect(table).toContain("name");
			expect(table).toContain("age");
			expect(table).toContain("Alice");
			expect(table).toContain("30");
			expect(table).toContain("|");
			expect(table).toContain("-");
		});

		it("truncates to max rows", () => {
			const rows = Array.from({ length: 30 }, (_, i) => ({ id: i }));
			const table = bookkeeper.formatAsTable(rows, 10);

			expect(table).toContain("... and 20 more rows");
		});

		it("handles empty data", () => {
			expect(bookkeeper.formatAsTable([])).toBe("(no data)");
		});
	});

	describe("unload / clear", () => {
		it("unloads a specific workbook", async () => {
			const csvPath = join(testDir, "test.csv");
			writeFileSync(csvPath, "x\n1\n");
			await bookkeeper.loadFile(csvPath);

			expect(bookkeeper.unload(csvPath)).toBe(true);
			expect(bookkeeper.getWorkbook(csvPath)).toBeNull();
		});

		it("clears all workbooks", async () => {
			const csv1 = join(testDir, "a.csv");
			const csv2 = join(testDir, "b.csv");
			writeFileSync(csv1, "x\n1\n");
			writeFileSync(csv2, "y\n2\n");
			await bookkeeper.loadFile(csv1);
			await bookkeeper.loadFile(csv2);

			bookkeeper.clear();

			expect(bookkeeper.listWorkbooks()).toHaveLength(0);
		});
	});

	describe("createBookkeeper", () => {
		it("creates a new Bookkeeper instance", () => {
			const bk = createBookkeeper();
			expect(bk).toBeInstanceOf(Bookkeeper);
		});
	});

	describe("SUPPORTED_EXTENSIONS", () => {
		it("includes expected extensions", () => {
			expect(SUPPORTED_EXTENSIONS).toContain(".csv");
			expect(SUPPORTED_EXTENSIONS).toContain(".tsv");
			expect(SUPPORTED_EXTENSIONS).toContain(".xlsx");
			expect(SUPPORTED_EXTENSIONS).toContain(".xls");
		});
	});
});
