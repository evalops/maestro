import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractDocumentText } from "../src/utils/document-extractor.js";

describe("extractDocumentText", () => {
	it("extracts text files", async () => {
		const out = await extractDocumentText({
			buffer: Buffer.from("hello\nworld\n", "utf8"),
			fileName: "notes.txt",
			mimeType: "text/plain",
		});
		expect(out.format).toBe("text");
		expect(out.extractedText).toContain("hello");
		expect(out.truncated).toBe(false);
	});

	it("extracts xlsx files into tab-separated text", async () => {
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
		expect(out.extractedText).toContain("# Sheet: People");
		expect(out.extractedText).toContain("Alice");
	});

	it("returns unknown for unsupported formats", async () => {
		const out = await extractDocumentText({
			buffer: Buffer.from([0, 1, 2, 3]),
			fileName: "blob.bin",
			mimeType: "application/octet-stream",
		});
		expect(out.format).toBe("unknown");
		expect(out.extractedText).toBe("");
	});
});
