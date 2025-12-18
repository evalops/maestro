import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionManager } from "../../session/manager.js";
import {
	buildContentDisposition,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

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
	const sessionManager = new SessionManager(true);

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
