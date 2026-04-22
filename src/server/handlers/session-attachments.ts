import type { IncomingMessage, ServerResponse } from "node:http";
import { extractDocumentText } from "../../utils/document-extractor.js";
import {
	buildContentDisposition,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";

const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;
const attachmentIdPattern = /^[a-zA-Z0-9._-]+$/;

function findAttachmentInSession(
	session: { messages?: Array<unknown> },
	attachmentId: string,
): {
	fileName: string;
	mimeType: string;
	contentBase64: string;
	size?: number;
	extractedText?: string;
} | null {
	const messages = Array.isArray(session.messages) ? session.messages : [];
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const maybeAttachments = (msg as { attachments?: unknown }).attachments;
		if (!Array.isArray(maybeAttachments)) continue;

		for (const att of maybeAttachments) {
			if (!att || typeof att !== "object") continue;
			const a = att as {
				id?: unknown;
				fileName?: unknown;
				mimeType?: unknown;
				content?: unknown;
				size?: unknown;
				extractedText?: unknown;
			};
			if (a.id !== attachmentId) continue;
			if (typeof a.fileName !== "string" || !a.fileName) return null;
			if (typeof a.mimeType !== "string" || !a.mimeType) return null;
			if (typeof a.content !== "string" || !a.content) return null;
			return {
				fileName: a.fileName,
				mimeType: a.mimeType,
				contentBase64: a.content,
				size:
					typeof a.size === "number" && Number.isFinite(a.size)
						? a.size
						: undefined,
				extractedText:
					typeof a.extractedText === "string" && a.extractedText.length > 0
						? a.extractedText
						: undefined,
			};
		}
	}
	return null;
}

export async function handleSessionAttachment(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string; attachmentId: string },
	cors: Record<string, string>,
) {
	const sessionManager = createWebSessionManagerForRequest(req, true);

	try {
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		const sessionId = params.id;
		const attachmentId = params.attachmentId;

		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}
		if (!attachmentIdPattern.test(attachmentId)) {
			sendJson(res, 400, { error: "Invalid attachment id" }, cors, req);
			return;
		}

		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			sendJson(res, 404, { error: "Session not found" }, cors, req);
			return;
		}

		const attachment = findAttachmentInSession(session, attachmentId);
		if (!attachment) {
			sendJson(res, 404, { error: "Attachment not found" }, cors, req);
			return;
		}

		const bytes = Buffer.from(attachment.contentBase64, "base64");

		const requestUrl = new URL(req.url || "/", "http://localhost");
		const download = requestUrl.searchParams.get("download");
		const shouldDownload = download === "1" || download === "true";

		res.writeHead(200, {
			"Content-Type": attachment.mimeType,
			"Content-Length": bytes.length,
			"Cache-Control": "private, max-age=3600",
			...(shouldDownload
				? {
						"Content-Disposition": buildContentDisposition(attachment.fileName),
					}
				: {}),
			...cors,
		});
		res.end(bytes);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

export async function handleSessionAttachmentExtract(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string; attachmentId: string },
	cors: Record<string, string>,
) {
	const sessionManager = createWebSessionManagerForRequest(req, true);

	try {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		const sessionId = params.id;
		const attachmentId = params.attachmentId;

		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}
		if (!attachmentIdPattern.test(attachmentId)) {
			sendJson(res, 400, { error: "Invalid attachment id" }, cors, req);
			return;
		}

		const requestUrl = new URL(req.url || "/", "http://localhost");
		const force = requestUrl.searchParams.get("force");
		const shouldForce = force === "1" || force === "true";

		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			sendJson(res, 404, { error: "Session not found" }, cors, req);
			return;
		}

		const attachment = findAttachmentInSession(session, attachmentId);
		if (!attachment) {
			sendJson(res, 404, { error: "Attachment not found" }, cors, req);
			return;
		}

		if (attachment.extractedText && !shouldForce) {
			sendJson(
				res,
				200,
				{
					fileName: attachment.fileName,
					format: "unknown",
					size: attachment.size ?? 0,
					truncated: false,
					extractedText: attachment.extractedText,
					cached: true,
				},
				cors,
				req,
			);
			return;
		}

		const bytes = Buffer.from(attachment.contentBase64, "base64");
		const extracted = await extractDocumentText({
			buffer: bytes,
			fileName: attachment.fileName,
			mimeType: attachment.mimeType,
		});

		const sessionFile = sessionManager.getSessionFileById(sessionId);
		if (sessionFile && typeof extracted.extractedText === "string") {
			try {
				sessionManager.saveAttachmentExtraction(
					sessionFile,
					attachmentId,
					extracted.extractedText,
				);
			} catch {
				// ignore persistence errors; extraction result still returned
			}
		}

		sendJson(
			res,
			200,
			{
				fileName: attachment.fileName,
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
