import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@sinclair/typebox";
import { extractDocumentText } from "../utils/document-extractor.js";
import { fetchWithPinnedAddress } from "../utils/fetch-with-pinned-address.js";
import {
	isLocalhostAlias,
	isLoopbackIP,
	isPrivateIP,
	isUnspecifiedIP,
} from "../utils/ip-address-parser.js";
import { createTool } from "./tool-dsl.js";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
	"application/json",
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/xml",
	"application/yaml",
]);

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
	extractor: string;
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

function normalizeUrlHost(url: URL): string {
	return url.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
}

function isBlockedDocumentAddress(address: string): boolean {
	return (
		isLocalhostAlias(address) ||
		isLoopbackIP(address) ||
		isPrivateIP(address) ||
		isUnspecifiedIP(address)
	);
}

function createAbortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

async function lookupDocumentHost(
	host: string,
	signal?: AbortSignal,
): Promise<Array<{ address: string }>> {
	if (isIP(host) !== 0) {
		return [{ address: host }];
	}
	throwIfAborted(signal);
	if (!signal) {
		return lookup(host, { all: true });
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(createAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		lookup(host, { all: true }).then(
			(addresses) => {
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) {
					reject(createAbortError());
					return;
				}
				resolve(addresses);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function resolvePublicDocumentUrl(
	url: URL,
	signal?: AbortSignal,
): Promise<{
	originalHost: string;
	resolvedAddresses: string[];
}> {
	throwIfAborted(signal);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only http(s) URLs are supported");
	}

	const host = normalizeUrlHost(url);
	if (isBlockedDocumentAddress(host)) {
		throw new Error("Blocked document URL host: private or local address");
	}

	const addresses = await lookupDocumentHost(host, signal);
	if (addresses.length === 0) {
		throw new Error(`Unable to resolve document URL host: ${url.hostname}`);
	}
	const resolvedAddresses = addresses.map(({ address }) =>
		address.toLowerCase(),
	);
	for (const address of resolvedAddresses) {
		if (isBlockedDocumentAddress(address)) {
			throw new Error("Blocked document URL host: private or local address");
		}
	}
	return {
		originalHost: host,
		resolvedAddresses,
	};
}

async function fetchDocumentUrl(
	initialUrl: URL,
	signal?: AbortSignal,
): Promise<{ response: Response; finalUrl: URL }> {
	let currentUrl = initialUrl;
	for (
		let redirectCount = 0;
		redirectCount <= MAX_REDIRECTS;
		redirectCount += 1
	) {
		const { originalHost, resolvedAddresses } = await resolvePublicDocumentUrl(
			currentUrl,
			signal,
		);
		const response = await fetchWithPinnedAddress(
			currentUrl.toString(),
			{ redirect: "manual", signal },
			{
				originalHost,
				resolvedAddress: resolvedAddresses[0],
				resolvedAddresses,
			},
		);
		if (response.status < 300 || response.status >= 400) {
			return { response, finalUrl: currentUrl };
		}
		if (redirectCount === MAX_REDIRECTS) {
			await response.body?.cancel();
			throw new Error(
				`Document URL redirected more than ${MAX_REDIRECTS} times`,
			);
		}

		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location) {
			throw new Error(
				`Unable to download document (${response.status} ${response.statusText})`,
			);
		}
		currentUrl = new URL(location, currentUrl);
	}

	throw new Error(`Document URL redirected more than ${MAX_REDIRECTS} times`);
}

function normalizeDocumentMimeType(header: string | null): string | undefined {
	const type = header?.split(";")[0]?.trim().toLowerCase();
	if (!type) return undefined;
	if (type.startsWith("text/")) return type;
	if (ALLOWED_DOCUMENT_MIME_TYPES.has(type)) return type;
	return undefined;
}

export const extractDocumentTool = createTool<
	typeof extractDocumentSchema,
	ExtractDocumentDetails
>({
	name: "extract_document",
	label: "extract_document",
	description:
		"Download a document from a URL and extract its text. Supports PDF, DOCX, XLSX, PPTX, common text formats, and optional MarkItDown-backed Markdown conversion when available. Use this when you need text from a linked document.",
	schema: extractDocumentSchema,
	async run(params, { signal, respond }) {
		const rawUrl = params.url.trim();
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			throw new Error(`Invalid URL: ${rawUrl}`);
		}

		const { response, finalUrl } = await fetchDocumentUrl(url, signal);
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

		const mimeType = normalizeDocumentMimeType(
			response.headers.get("content-type"),
		);
		const contentDisposition = response.headers.get("content-disposition");
		const fileName =
			parseContentDispositionFileName(contentDisposition) ??
			guessFileNameFromUrl(finalUrl);

		const extracted = await extractDocumentText({
			buffer: Buffer.from(arrayBuffer),
			fileName,
			mimeType,
			maxChars: params.maxChars,
			allowMarkitdown: false,
		});

		if (!extracted.extractedText && extracted.format === "unknown") {
			throw new Error(
				"Unsupported document format. Supported: PDF (.pdf), Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and common text files.",
			);
		}

		respond.text(extracted.extractedText || "");
		return respond.detail({
			url: finalUrl.toString(),
			fileName,
			mimeType,
			format: extracted.format,
			extractor: extracted.extractor,
			sizeBytes: extracted.sizeBytes,
			truncated: extracted.truncated,
		});
	},
});
