import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";

export type ExtractedDocumentFormat =
	| "pdf"
	| "docx"
	| "xlsx"
	| "pptx"
	| "text"
	| "unknown";

export interface ExtractDocumentInput {
	buffer: Buffer;
	fileName: string;
	mimeType?: string;
	maxChars?: number;
}

export interface ExtractDocumentOutput {
	extractedText: string;
	format: ExtractedDocumentFormat;
	truncated: boolean;
	sizeBytes: number;
}

const DEFAULT_MAX_CHARS = 200_000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

function clampText(
	text: string,
	maxChars: number,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function detectFormat(
	fileName: string,
	mimeType?: string,
): ExtractedDocumentFormat {
	const lowerName = fileName.toLowerCase();
	const type = (mimeType || "").toLowerCase();

	if (type === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
	if (
		type ===
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		lowerName.endsWith(".docx")
	)
		return "docx";
	if (
		type ===
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
		type === "application/vnd.ms-excel" ||
		lowerName.endsWith(".xlsx") ||
		lowerName.endsWith(".xls")
	)
		return "xlsx";
	if (
		type ===
			"application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		lowerName.endsWith(".pptx")
	)
		return "pptx";
	if (type.startsWith("text/")) return "text";

	const textExtensions = [
		".txt",
		".md",
		".markdown",
		".json",
		".yaml",
		".yml",
		".csv",
		".ts",
		".tsx",
		".js",
		".jsx",
		".html",
		".css",
		".xml",
	];
	if (textExtensions.some((ext) => lowerName.endsWith(ext))) return "text";

	return "unknown";
}

async function extractPptxText(buffer: Buffer): Promise<string> {
	const zip = await JSZip.loadAsync(buffer);

	const slidePaths = Object.keys(zip.files)
		.filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
		.sort((a, b) => {
			const an = Number.parseInt(a.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
			const bn = Number.parseInt(b.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
			return an - bn;
		});

	if (slidePaths.length === 0) {
		return "";
	}

	const parts: string[] = [];
	for (const slidePath of slidePaths) {
		const slideNumber = slidePath.match(/slide(\d+)\.xml/i)?.[1] || "?";
		const xml = await zip.file(slidePath)?.async("string");
		if (!xml) continue;

		const texts = Array.from(xml.matchAll(/<a:t>(.*?)<\/a:t>/g))
			.map((m) => m[1] || "")
			.map((s) =>
				s
					.replaceAll("&lt;", "<")
					.replaceAll("&gt;", ">")
					.replaceAll("&amp;", "&")
					.replaceAll("&quot;", '"')
					.replaceAll("&apos;", "'"),
			)
			.map((s) => s.trim())
			.filter(Boolean);

		if (texts.length === 0) continue;
		parts.push(`# Slide ${slideNumber}\n${texts.join(" ")}`);
	}

	return parts.join("\n\n");
}

export async function extractDocumentText(
	input: ExtractDocumentInput,
): Promise<ExtractDocumentOutput> {
	const { buffer, fileName } = input;
	const maxChars = Math.max(1, input.maxChars ?? DEFAULT_MAX_CHARS);

	if (buffer.byteLength > MAX_INPUT_BYTES) {
		throw new Error(
			`Document is too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum supported size is 50MB.`,
		);
	}

	const format = detectFormat(fileName, input.mimeType);

	let extractedText = "";
	switch (format) {
		case "pdf": {
			const parser = new PDFParse({ data: buffer });
			try {
				const result = await parser.getText();
				extractedText = result.text || "";
			} finally {
				try {
					await parser.destroy();
				} catch {
					// ignore
				}
			}
			break;
		}
		case "docx": {
			const result = await mammoth.extractRawText({ buffer });
			extractedText = result.value || "";
			break;
		}
		case "xlsx": {
			const workbook = XLSX.read(buffer, { type: "buffer" });
			const parts: string[] = [];
			for (const name of workbook.SheetNames || []) {
				const sheet = workbook.Sheets[name];
				if (!sheet) continue;
				const csv = XLSX.utils.sheet_to_csv(sheet, { FS: "\t" });
				const normalized = (csv || "").trim();
				if (!normalized) continue;
				parts.push(`# Sheet: ${name}\n${normalized}`);
			}
			extractedText = parts.join("\n\n");
			break;
		}
		case "pptx": {
			extractedText = await extractPptxText(buffer);
			break;
		}
		case "text": {
			extractedText = buffer.toString("utf8");
			break;
		}
		default: {
			extractedText = "";
			break;
		}
	}

	const { text, truncated } = clampText(extractedText, maxChars);
	return {
		extractedText: text,
		format,
		truncated,
		sizeBytes: buffer.byteLength,
	};
}
