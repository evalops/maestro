import type { IncomingMessage, ServerResponse } from "node:http";
import { extractDocumentText } from "../../utils/document-extractor.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

interface ExtractAttachmentBody {
	fileName: string;
	mimeType?: string;
	contentBase64: string;
	maxChars?: number;
}

export async function handleAttachmentExtract(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
) {
	try {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		// Allow large JSON payloads (base64 content); enforce actual byte limits in extractor.
		const body = await readJsonBody<Partial<ExtractAttachmentBody>>(
			req,
			80 * 1024 * 1024,
		);

		const fileName =
			typeof body.fileName === "string" ? body.fileName.trim() : "";
		const mimeType =
			typeof body.mimeType === "string" ? body.mimeType.trim() : undefined;
		const contentBase64 =
			typeof body.contentBase64 === "string" ? body.contentBase64.trim() : "";
		const maxChars =
			typeof body.maxChars === "number" && Number.isFinite(body.maxChars)
				? body.maxChars
				: undefined;

		if (!fileName) {
			sendJson(res, 400, { error: "fileName is required" }, cors, req);
			return;
		}
		if (!contentBase64) {
			sendJson(res, 400, { error: "contentBase64 is required" }, cors, req);
			return;
		}

		let buffer: Buffer;
		try {
			buffer = Buffer.from(contentBase64, "base64");
		} catch {
			sendJson(res, 400, { error: "Invalid base64 content" }, cors, req);
			return;
		}

		const extracted = await extractDocumentText({
			buffer,
			fileName,
			mimeType,
			maxChars,
		});

		if (!extracted.extractedText && extracted.format === "unknown") {
			sendJson(res, 400, { error: "Unsupported document format" }, cors, req);
			return;
		}

		sendJson(
			res,
			200,
			{
				fileName,
				format: extracted.format,
				size: extracted.sizeBytes,
				truncated: extracted.truncated,
				extractedText: extracted.extractedText,
			},
			cors,
			req,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}
