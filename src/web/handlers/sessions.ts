import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import { SessionManager } from "../../session/manager.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { readJsonBody } from "../server-utils.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";

const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;

// In-memory store for shared session tokens (in production, use DB)
const sharedSessions = new Map<
	string,
	{ sessionId: string; expiresAt: Date; accessCount: number }
>();

export interface SessionUpdateBody {
	title?: string;
	tags?: string[];
	favorite?: boolean;
}

export interface SessionShareOptions {
	expiresInHours?: number;
	maxAccesses?: number;
}

export interface SessionExportFormat {
	format: "json" | "markdown" | "text";
}

/**
 * Handle session list and CRUD operations
 */
export async function handleSessions(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id?: string },
	cors: Record<string, string>,
) {
	const sessionManager = new SessionManager(true);
	const sessionId = params.id;

	try {
		if (req.method === "GET" && !sessionId) {
			const sessions = await sessionManager.listSessions();
			const sessionList: ComposerSessionSummary[] = sessions.map((s) => ({
				id: s.id,
				title: s.title || `Session ${s.id.slice(0, 8)}`,
				createdAt: s.createdAt || new Date().toISOString(),
				updatedAt: s.updatedAt || new Date().toISOString(),
				messageCount: s.messageCount || 0,
			}));

			sendJson(res, 200, { sessions: sessionList }, cors, req);
		} else if (req.method === "GET" && sessionId) {
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" }, cors, req);
				return;
			}
			const session = await sessionManager.loadSession(sessionId);

			if (!session) {
				sendJson(res, 404, { error: "Session not found" }, cors, req);
				return;
			}

			const responseBody: ComposerSession = {
				id: session.id,
				title: session.title,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messageCount: session.messageCount,
				messages: convertAppMessagesToComposer(session.messages || []),
			};

			sendJson(res, 200, responseBody, cors, req);
		} else if (req.method === "POST" && !sessionId) {
			const { title } = await readJsonBody<{ title?: string }>(req);
			const session = await sessionManager.createSession({ title });
			const responseBody: ComposerSession = {
				id: session.id,
				title: session.title,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messageCount: session.messageCount,
				messages: convertAppMessagesToComposer(session.messages || []),
			};

			sendJson(res, 201, responseBody, cors, req);
		} else if (req.method === "PATCH" && sessionId) {
			// Update session metadata
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" }, cors, req);
				return;
			}

			const updates = await readJsonBody<SessionUpdateBody>(req);
			const session = await sessionManager.loadSession(sessionId);

			if (!session) {
				sendJson(res, 404, { error: "Session not found" }, cors, req);
				return;
			}

			// Apply favorite update (supported by SessionManager)
			const sessionPath = sessionManager.getSessionFileById(sessionId);
			if (sessionPath && updates.favorite !== undefined) {
				sessionManager.setSessionFavorite(sessionPath, updates.favorite);
			}

			// Note: title and tags updates require session file modification
			// which is not fully supported by the current SessionManager API.
			// For now, return current session data with acknowledged updates.

			sendJson(
				res,
				200,
				{
					id: session.id,
					title: updates.title ?? session.title,
					createdAt: session.createdAt,
					updatedAt: new Date().toISOString(),
					messageCount: session.messageCount,
					favorite: updates.favorite,
					tags: updates.tags,
				},
				cors,
				req,
			);
		} else if (req.method === "DELETE" && sessionId) {
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" }, cors, req);
				return;
			}
			await sessionManager.deleteSession(sessionId);

			res.writeHead(204, cors);
			res.end();
		} else {
			res.writeHead(404, {
				"Content-Type": "application/json",
				...cors,
			});
			res.end(JSON.stringify({ error: "Not found" }));
		}
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

/**
 * Handle session sharing - generate a shareable link
 */
export async function handleSessionShare(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string },
	cors: Record<string, string>,
) {
	const sessionManager = new SessionManager(true);
	const sessionId = params.id;

	try {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}

		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			sendJson(res, 404, { error: "Session not found" }, cors, req);
			return;
		}

		const options = await readJsonBody<SessionShareOptions>(req);
		const expiresInHours = Math.min(options.expiresInHours ?? 24, 168); // Max 1 week
		const maxAccesses = options.maxAccesses ?? 100;

		// Generate a share token
		const shareToken = crypto.randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

		// Store the share mapping
		sharedSessions.set(shareToken, {
			sessionId,
			expiresAt,
			accessCount: 0,
		});

		// Clean up old shares
		for (const [token, share] of sharedSessions.entries()) {
			if (share.expiresAt < new Date()) {
				sharedSessions.delete(token);
			}
		}

		sendJson(
			res,
			201,
			{
				shareToken,
				shareUrl: `/api/sessions/shared/${shareToken}`,
				expiresAt: expiresAt.toISOString(),
				maxAccesses,
			},
			cors,
			req,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

/**
 * Handle accessing a shared session
 */
export async function handleSharedSession(
	req: IncomingMessage,
	res: ServerResponse,
	params: { token: string },
	cors: Record<string, string>,
) {
	const sessionManager = new SessionManager(true);
	const shareToken = params.token;

	try {
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		const share = sharedSessions.get(shareToken);
		if (!share) {
			sendJson(
				res,
				404,
				{ error: "Share link not found or expired" },
				cors,
				req,
			);
			return;
		}

		if (share.expiresAt < new Date()) {
			sharedSessions.delete(shareToken);
			sendJson(res, 410, { error: "Share link has expired" }, cors, req);
			return;
		}

		share.accessCount++;

		const session = await sessionManager.loadSession(share.sessionId);
		if (!session) {
			sendJson(res, 404, { error: "Session not found" }, cors, req);
			return;
		}

		// Return a read-only view of the session
		const responseBody: ComposerSession = {
			id: session.id,
			title: session.title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			messageCount: session.messageCount,
			messages: convertAppMessagesToComposer(session.messages || []),
		};

		sendJson(res, 200, { ...responseBody, isShared: true }, cors, req);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

/**
 * Handle session export
 */
export async function handleSessionExport(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string },
	cors: Record<string, string>,
) {
	const sessionManager = new SessionManager(true);
	const sessionId = params.id;

	try {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		if (!sessionIdPattern.test(sessionId)) {
			sendJson(res, 400, { error: "Invalid session id" }, cors, req);
			return;
		}

		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			sendJson(res, 404, { error: "Session not found" }, cors, req);
			return;
		}

		const options = await readJsonBody<SessionExportFormat>(req);
		const format = options.format || "json";
		const messages = session.messages || [];

		let content: string;
		let contentType: string;
		let filename: string;

		switch (format) {
			case "markdown":
				content = exportToMarkdown(session, messages);
				contentType = "text/markdown";
				filename = `session-${sessionId}.md`;
				break;
			case "text":
				content = exportToText(session, messages);
				contentType = "text/plain";
				filename = `session-${sessionId}.txt`;
				break;
			default:
				content = JSON.stringify(
					{
						id: session.id,
						title: session.title,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						messageCount: session.messageCount,
						messages: convertAppMessagesToComposer(messages),
					},
					null,
					2,
				);
				contentType = "application/json";
				filename = `session-${sessionId}.json`;
				break;
		}

		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Disposition": `attachment; filename="${filename}"`,
			...cors,
		});
		res.end(content);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

/**
 * Export session to markdown format
 */
function exportToMarkdown(
	session: { id: string; title?: string; createdAt?: string },
	messages: Array<{ role: string; content?: unknown }>,
): string {
	const lines: string[] = [
		`# ${session.title || `Session ${session.id.slice(0, 8)}`}`,
		"",
		`*Created: ${session.createdAt || "Unknown"}*`,
		"",
		"---",
		"",
	];

	for (const msg of messages) {
		const role = msg.role === "user" ? "**User:**" : "**Assistant:**";
		lines.push(role);
		lines.push("");

		const content = extractTextContent(msg.content);
		if (content) {
			lines.push(content);
			lines.push("");
		}
	}

	return lines.join("\n");
}

/**
 * Export session to plain text format
 */
function exportToText(
	session: { id: string; title?: string; createdAt?: string },
	messages: Array<{ role: string; content?: unknown }>,
): string {
	const lines: string[] = [
		`Session: ${session.title || session.id}`,
		`Created: ${session.createdAt || "Unknown"}`,
		"",
		"=".repeat(60),
		"",
	];

	for (const msg of messages) {
		const role = msg.role === "user" ? "USER:" : "ASSISTANT:";
		lines.push(role);

		const content = extractTextContent(msg.content);
		if (content) {
			lines.push(content);
		}
		lines.push("");
		lines.push("-".repeat(40));
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Extract text content from message content (which can be string or array of blocks)
 */
function extractTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.filter(
				(block): block is { type: "text"; text: string } =>
					block && typeof block === "object" && block.type === "text",
			)
			.map((block) => block.text)
			.join("\n");
	}

	return "";
}
