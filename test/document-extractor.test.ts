import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
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
		const wb = XLSX.utils.book_new();
		const ws = XLSX.utils.aoa_to_sheet([
			["Name", "Age"],
			["Alice", 30],
		]);
		XLSX.utils.book_append_sheet(wb, ws, "People");
		const buffer = XLSX.write(wb, {
			type: "buffer",
			bookType: "xlsx",
		}) as Buffer;

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
