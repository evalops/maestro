import { Type } from "@sinclair/typebox";
import { extractDocumentText } from "../utils/document-extractor.js";
import { createTool } from "./tool-dsl.js";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const extractDocumentSchema = Type.Object({
	url: Type.String({
		description:
			"HTTP(S) URL of a document (PDF, DOCX, XLSX, PPTX, or text file)",
		minLength: 1,
	}),
	maxChars: Type.Optional(
		Type.Number({
			description: "Maximum characters of extracted text to return",
			minimum: 1,
			maximum: 1_000_000,
		}),
	),
});

export interface ExtractDocumentDetails {
	url: string;
	fileName: string;
	mimeType?: string;
	format: string;
	sizeBytes: number;
	truncated: boolean;
}

function guessFileNameFromUrl(url: URL): string {
	const last = url.pathname.split("/").filter(Boolean).pop();
	return (last && decodeURIComponent(last)) || "document";
}

function parseContentDispositionFileName(header: string | null): string | null {
	if (!header) return null;
	const m =
		header.match(/filename\\*=UTF-8''([^;]+)/i) ??
		header.match(/filename=\"([^\"]+)\"/i) ??
		header.match(/filename=([^;]+)/i);
	if (!m) return null;
	const raw = m[1] || m[0];
	try {
		return decodeURIComponent(raw.trim());
	} catch {
		return raw.trim();
	}
}

export const extractDocumentTool = createTool<
	typeof extractDocumentSchema,
	ExtractDocumentDetails
>({
	name: "extract_document",
	label: "extract_document",
	description:
		"Download a document from a URL and extract its text. Supports PDF, DOCX, XLSX, PPTX, and common text formats. Use this when you need text from a linked document.",
	schema: extractDocumentSchema,
	async run(params, { signal, respond }) {
		const rawUrl = params.url.trim();
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new Error(`Invalid URL: ${rawUrl}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("Only http(s) URLs are supported");
		}

		const response = await fetch(url, { signal });
		if (!response.ok) {
			throw new Error(
				`Unable to download document (${response.status} ${response.statusText})`,
			);
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const size = Number.parseInt(contentLength, 10);
			if (Number.isFinite(size) && size > MAX_DOWNLOAD_BYTES) {
				throw new Error(
					`Document is too large (${(size / 1024 / 1024).toFixed(1)}MB). Maximum supported size is 50MB.`,
				);
			}
		}

		const arrayBuffer = await response.arrayBuffer();
		if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
			throw new Error(
				`Document is too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB). Maximum supported size is 50MB.`,
			);
		}

		const mimeType = response.headers
			.get("content-type")
			?.split(";")[0]
			?.trim();
		const contentDisposition = response.headers.get("content-disposition");
		const fileName =
			parseContentDispositionFileName(contentDisposition) ??
			guessFileNameFromUrl(url);

		const extracted = await extractDocumentText({
			buffer: Buffer.from(arrayBuffer),
			fileName,
			mimeType,
			maxChars: params.maxChars,
		});

		if (!extracted.extractedText && extracted.format === "unknown") {
			throw new Error(
				"Unsupported document format. Supported: PDF (.pdf), Word (.docx), Excel (.xlsx/.xls), PowerPoint (.pptx), and common text files.",
			);
		}

		respond.text(extracted.extractedText || "");
		return respond.detail({
			url: url.toString(),
			fileName,
			mimeType,
			format: extracted.format,
			sizeBytes: extracted.sizeBytes,
			truncated: extracted.truncated,
		});
	},
});
