import { afterEach, describe, expect, it, vi } from "vitest";

describe("document extractor PDF dependency loading", () => {
	afterEach(() => {
		vi.doUnmock("pdf-parse");
		vi.resetModules();
	});

	it("does not load pdf-parse while extracting non-PDF documents", async () => {
		let loadedPdfParse = false;
		vi.doMock("pdf-parse", () => {
			loadedPdfParse = true;
			return {
				PDFParse: class {
					async getText() {
						return { text: "unused" };
					}
					async destroy() {}
				},
			};
		});

		const { extractDocumentText } = await import(
			"../src/utils/document-extractor.js"
		);
		const output = await extractDocumentText({
			buffer: Buffer.from("hello from text", "utf8"),
			fileName: "note.txt",
			mimeType: "text/plain",
		});

		expect(output.extractedText).toContain("hello from text");
		expect(loadedPdfParse).toBe(false);
	});

	it("loads pdf-parse only for native PDF extraction", async () => {
		let loadedPdfParse = false;
		vi.doMock("pdf-parse", () => {
			loadedPdfParse = true;
			return {
				PDFParse: class {
					async getText() {
						return { text: "hello from mocked pdf" };
					}
					async destroy() {}
				},
			};
		});

		const { extractDocumentText } = await import(
			"../src/utils/document-extractor.js"
		);
		const output = await extractDocumentText({
			buffer: Buffer.from("%PDF mocked", "utf8"),
			fileName: "note.pdf",
			mimeType: "application/pdf",
		});

		expect(output.extractedText).toBe("hello from mocked pdf");
		expect(loadedPdfParse).toBe(true);
	});
});
