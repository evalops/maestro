import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import { eq, lt, sql } from "drizzle-orm";
import { getDb, isDbAvailable } from "../../db/client.js";
import { sharedSessions as sharedSessionsTable } from "../../db/schema.js";
import { SessionManager } from "../../session/manager.js";
import { createLogger } from "../../utils/logger.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";

const logger = createLogger("sessions-handler");
const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;

// Fallback in-memory store when DB not available
const inMemoryShares = new Map<
	string,
	{
		sessionId: string;
		expiresAt: Date;
		maxAccesses: number | null;
		accessCount: number;
	}
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

// ============================================================================
// SHARED SESSION DB OPERATIONS
// ============================================================================

async function createSharedSessionInDb(
	sessionId: string,
	shareToken: string,
	expiresAt: Date,
	maxAccesses: number | null,
): Promise<void> {
	if (!isDbAvailable()) {
		// Fallback to in-memory
		inMemoryShares.set(shareToken, {
			sessionId,
			expiresAt,
			maxAccesses,
			accessCount: 0,
		});
		return;
	}

	const db = getDb();
	await db.insert(sharedSessionsTable).values({
		shareToken,
		sessionId,
		expiresAt,
		maxAccesses,
		accessCount: 0,
	});
}

async function getSharedSessionFromDb(shareToken: string): Promise<{
	sessionId: string;
	expiresAt: Date;
	maxAccesses: number | null;
	accessCount: number;
} | null> {
	if (!isDbAvailable()) {
		// Fallback to in-memory
		const share = inMemoryShares.get(shareToken);
		if (!share) return null;
		return share;
	}

	const db = getDb();
	const [row] = await db
		.select({
			sessionId: sharedSessionsTable.sessionId,
			expiresAt: sharedSessionsTable.expiresAt,
			maxAccesses: sharedSessionsTable.maxAccesses,
			accessCount: sharedSessionsTable.accessCount,
		})
		.from(sharedSessionsTable)
		.where(eq(sharedSessionsTable.shareToken, shareToken))
		.limit(1);

	if (!row) return null;

	return {
		sessionId: row.sessionId,
		expiresAt: row.expiresAt,
		maxAccesses: row.maxAccesses,
		accessCount: row.accessCount,
	};
}

async function incrementShareAccessCount(shareToken: string): Promise<void> {
	if (!isDbAvailable()) {
		const share = inMemoryShares.get(shareToken);
		if (share) share.accessCount++;
		return;
	}

	const db = getDb();
	await db
		.update(sharedSessionsTable)
		.set({ accessCount: sql`${sharedSessionsTable.accessCount} + 1` })
		.where(eq(sharedSessionsTable.shareToken, shareToken));
}

async function deleteExpiredShares(): Promise<number> {
	if (!isDbAvailable()) {
		let deleted = 0;
		const now = new Date();
		for (const [token, share] of inMemoryShares.entries()) {
			if (share.expiresAt < now) {
				inMemoryShares.delete(token);
				deleted++;
			}
		}
		return deleted;
	}

	const db = getDb();
	const result = await db
		.delete(sharedSessionsTable)
		.where(lt(sharedSessionsTable.expiresAt, new Date()))
		.returning({ id: sharedSessionsTable.id });

	return result.length;
}

async function deleteShareByToken(shareToken: string): Promise<void> {
	if (!isDbAvailable()) {
		inMemoryShares.delete(shareToken);
		return;
	}

	const db = getDb();
	await db
		.delete(sharedSessionsTable)
		.where(eq(sharedSessionsTable.shareToken, shareToken));
}

// ============================================================================
// SESSION HANDLERS
// ============================================================================

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

			const sessionPath = sessionManager.getSessionFileById(sessionId);
			if (!sessionPath) {
				sendJson(res, 404, { error: "Session file not found" }, cors, req);
				return;
			}

			// Apply updates - SessionManager supports favorite, title, and tags via meta entries
			if (updates.favorite !== undefined) {
				sessionManager.setSessionFavorite(sessionPath, updates.favorite);
			}
			if (updates.title !== undefined) {
				sessionManager.setSessionTitle(sessionPath, updates.title);
			}
			if (updates.tags !== undefined) {
				sessionManager.setSessionTags(sessionPath, updates.tags);
			}

			// Return the updated values directly (writes are applied synchronously to the file)
			sendJson(
				res,
				200,
				{
					id: sessionId,
					title: updates.title ?? session.title,
					createdAt: session.createdAt,
					updatedAt: new Date().toISOString(),
					messageCount: session.messageCount,
					favorite: updates.favorite ?? session.favorite,
					tags: updates.tags ?? session.tags,
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
		const maxAccesses = options.maxAccesses ?? null; // null = unlimited

		// Generate a share token
		const shareToken = crypto.randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

		// Store in database (or fallback to memory)
		await createSharedSessionInDb(
			sessionId,
			shareToken,
			expiresAt,
			maxAccesses,
		);

		// Cleanup expired shares in background
		deleteExpiredShares().catch((err) => {
			logger.error("Failed to cleanup expired shares", err);
		});

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

		const share = await getSharedSessionFromDb(shareToken);
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

		// Check expiration
		if (share.expiresAt < new Date()) {
			await deleteShareByToken(shareToken);
			sendJson(res, 410, { error: "Share link has expired" }, cors, req);
			return;
		}

		// Check max accesses
		if (share.maxAccesses !== null && share.accessCount >= share.maxAccesses) {
			sendJson(
				res,
				410,
				{ error: "Share link has reached maximum accesses" },
				cors,
				req,
			);
			return;
		}

		// Increment access count
		await incrementShareAccessCount(shareToken);

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

// ============================================================================
// EXPORT HELPERS - Handle complex message structures
// ============================================================================

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: unknown;
	content?: string | ContentBlock[];
	tool_use_id?: string;
	is_error?: boolean;
}

/**
 * Export session to markdown format with full support for complex messages
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
		const role = msg.role === "user" ? "## User" : "## Assistant";
		lines.push(role);
		lines.push("");

		const contentLines = formatMessageContent(msg.content, "markdown");
		lines.push(...contentLines);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Export session to plain text format with full support for complex messages
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
		lines.push("");

		const contentLines = formatMessageContent(msg.content, "text");
		lines.push(...contentLines);
		lines.push("");
		lines.push("-".repeat(40));
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Format message content handling all block types
 */
function formatMessageContent(
	content: unknown,
	format: "markdown" | "text",
): string[] {
	const lines: string[] = [];

	if (typeof content === "string") {
		lines.push(content);
		return lines;
	}

	if (!Array.isArray(content)) {
		return lines;
	}

	for (const block of content as ContentBlock[]) {
		if (!block || typeof block !== "object") continue;

		switch (block.type) {
			case "text":
				if (block.text) {
					lines.push(block.text);
				}
				break;

			case "tool_use":
				if (format === "markdown") {
					lines.push(`### Tool: \`${block.name || "unknown"}\``);
					lines.push("");
					if (block.input) {
						lines.push("```json");
						lines.push(JSON.stringify(block.input, null, 2));
						lines.push("```");
					}
				} else {
					lines.push(`[TOOL CALL: ${block.name || "unknown"}]`);
					if (block.input) {
						lines.push(`Input: ${JSON.stringify(block.input, null, 2)}`);
					}
				}
				lines.push("");
				break;

			case "tool_result":
				if (format === "markdown") {
					lines.push("#### Tool Result");
					if (block.is_error) {
						lines.push("**Error:**");
					}
					lines.push("");
					const resultContent = formatToolResultContent(block.content, format);
					lines.push(...resultContent);
				} else {
					lines.push("[TOOL RESULT]");
					if (block.is_error) {
						lines.push("(Error)");
					}
					const resultContent = formatToolResultContent(block.content, format);
					lines.push(...resultContent);
				}
				lines.push("");
				break;

			case "image":
				if (format === "markdown") {
					lines.push("*[Image content]*");
				} else {
					lines.push("[IMAGE]");
				}
				break;

			case "thinking":
				if (format === "markdown") {
					lines.push("<details>");
					lines.push("<summary>Thinking...</summary>");
					lines.push("");
					if (block.text) {
						lines.push(block.text);
					}
					lines.push("</details>");
				} else {
					lines.push("[THINKING]");
					if (block.text) {
						lines.push(block.text);
					}
					lines.push("[/THINKING]");
				}
				lines.push("");
				break;

			default:
				// Handle unknown block types gracefully
				if (block.text) {
					lines.push(block.text);
				}
		}
	}

	return lines;
}

/**
 * Format tool result content which can be string or nested blocks
 */
function formatToolResultContent(
	content: string | ContentBlock[] | undefined,
	format: "markdown" | "text",
): string[] {
	if (!content) return [];

	if (typeof content === "string") {
		if (format === "markdown") {
			return ["```", content, "```"];
		}
		return [content];
	}

	if (Array.isArray(content)) {
		const lines: string[] = [];
		for (const block of content) {
			if (block.type === "text" && block.text) {
				if (format === "markdown") {
					lines.push("```");
					lines.push(block.text);
					lines.push("```");
				} else {
					lines.push(block.text);
				}
			}
		}
		return lines;
	}

	return [];
}
