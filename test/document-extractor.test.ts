import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocumentText } from "../src/utils/document-extractor.js";

describe("extractDocumentText", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("extracts text files", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const out = await extractDocumentText({
			buffer: Buffer.from("hello\nworld\n", "utf8"),
			fileName: "notes.txt",
			mimeType: "text/plain",
		});
		expect(out.format).toBe("text");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toContain("hello");
		expect(out.truncated).toBe(false);
	});

	it("extracts xlsx files into tab-separated text", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet("People");
		worksheet.addRow(["Name", "Age"]);
		worksheet.addRow(["Alice", 30]);
		const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

		const out = await extractDocumentText({
			buffer,
			fileName: "people.xlsx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});

		expect(out.format).toBe("xlsx");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toContain("# Sheet: People");
		expect(out.extractedText).toContain("Alice");
	});

	it("returns unknown for unsupported formats", async () => {
		process.env.MAESTRO_MARKITDOWN = "0";
		const out = await extractDocumentText({
			buffer: Buffer.from([0, 1, 2, 3]),
			fileName: "blob.bin",
			mimeType: "application/octet-stream",
		});
		expect(out.format).toBe("unknown");
		expect(out.extractor).toBe("native");
		expect(out.extractedText).toBe("");
	});

	it("uses MarkItDown CLI output when a configured converter is available", async () => {
		const dir = await mkdtemp(join(tmpdir(), "maestro-markitdown-test-"));
		try {
			const script = join(dir, "fake-markitdown.mjs");
			await writeFile(
				script,
				"process.stdout.write('# Converted by MarkItDown\\n\\nBody text from fake CLI');",
				"utf8",
			);
			process.env.MAESTRO_MARKITDOWN_CMD = process.execPath;
			process.env.MAESTRO_MARKITDOWN_ARGS = script;

			const out = await extractDocumentText({
				buffer: Buffer.from(
					"<html><body><h1>Ignored native HTML</h1></body></html>",
				),
				fileName: "brief.html",
				mimeType: "text/html",
			});

			expect(out.format).toBe("text");
			expect(out.extractor).toBe("markitdown");
			expect(out.extractedText).toContain("# Converted by MarkItDown");
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
