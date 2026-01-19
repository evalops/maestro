/**
 * @fileoverview Session Management HTTP Handlers
 *
 * This module provides REST API endpoints for managing Composer sessions,
 * including CRUD operations, session sharing, and export functionality.
 *
 * ## Endpoints
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | `/api/sessions` | List all sessions with pagination |
 * | GET | `/api/sessions/:id` | Get a specific session with messages |
 * | POST | `/api/sessions` | Create a new session |
 * | PATCH | `/api/sessions/:id` | Update session metadata (title, tags, favorite) |
 * | DELETE | `/api/sessions/:id` | Delete a session |
 * | POST | `/api/sessions/:id/share` | Generate a shareable link |
 * | GET | `/api/sessions/shared/:token` | Access a shared session |
 * | POST | `/api/sessions/:id/export` | Export session in various formats |
 *
 * ## Session Sharing
 *
 * Sessions can be shared via time-limited, access-limited tokens:
 * - Configurable expiration (default 24h, max 1 week)
 * - Optional access count limits
 * - Rate limiting to prevent brute-force attacks
 * - Atomic access counting to prevent race conditions
 *
 * ## Storage
 *
 * - Session data: JSONL files in `~/.composer/agent/sessions/`
 * - Share tokens: PostgreSQL (with in-memory fallback)
 * - Rate limits: Redis (with in-memory fallback)
 *
 * @module web/handlers/sessions
 */
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { getDb, isDbAvailable } from "../../db/client.js";
import { sharedSessions as sharedSessionsTable } from "../../db/schema.js";
import { createLogger } from "../../utils/logger.js";
import { getAuthSubject } from "../authz.js";
import { RateLimiter } from "../rate-limiter.js";
import {
	buildContentDisposition,
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import {
	createSessionManagerForRequest,
	createSessionManagerForScope,
	decodeScopedSessionId,
	encodeScopedSessionId,
	resolveSessionScope,
} from "../session-scope.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";

const logger = createLogger("sessions-handler");
const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;
const attachmentIdPattern = /^[a-zA-Z0-9._-]+$/;

/**
 * Verify that the authenticated subject has access to the session.
 * Prevents IDOR attacks by checking session ownership fields.
 *
 * Returns true if access is allowed, false otherwise.
 */
function verifySessionOwnership(
	session: Record<string, unknown>,
	subject: string,
	scope?: string | null,
): boolean {
	// Check explicit owner field
	if (typeof session.owner === "string" && session.owner) {
		return session.owner === subject;
	}

	// Check subject field (for API-created sessions)
	if (typeof session.subject === "string" && session.subject) {
		return session.subject === subject;
	}

	// For sessions without ownership info:
	// If sessions are scoped by auth subject, directory isolation already applies.
	if (scope) return true;

	// In strict mode (multi-user), deny access to prevent IDOR attacks.
	// Sessions created via CLI don't have ownership info, but API access
	// should be restricted in hosted environments.
	const strictMode = process.env.COMPOSER_STRICT_SESSION_ACCESS !== "false";
	return !strictMode;
}

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

// ============================================================================
// RATE LIMITING (uses Redis when COMPOSER_REDIS_URL is configured)
// ============================================================================

const shareRateLimiter = new RateLimiter(
	{
		windowMs: Number(process.env.COMPOSER_SHARE_RATE_LIMIT_WINDOW_MS ?? 60_000),
		max: Number(process.env.COMPOSER_SHARE_RATE_LIMIT_MAX ?? 10),
	},
	"share",
);

/**
 * Check if a client IP is rate limited for share access.
 * Uses Redis when configured, falls back to in-memory.
 * Exported for testing.
 */
export async function checkShareRateLimit(clientIp: string): Promise<{
	allowed: boolean;
	retryAfterSeconds?: number;
}> {
	const result = await shareRateLimiter.checkAsync(clientIp);
	if (!result.allowed) {
		const retryAfterSeconds = Math.ceil((result.reset - Date.now()) / 1000);
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, retryAfterSeconds),
		};
	}
	return { allowed: true };
}

/**
 * Reset rate limit state for a client IP. Exported for testing.
 */
export async function resetShareRateLimit(clientIp?: string): Promise<void> {
	await shareRateLimiter.reset(clientIp);
}

/**
 * Stop the rate limiter cleanup. Call during graceful shutdown.
 */
export function stopShareRateLimiter(): void {
	shareRateLimiter.stop();
}

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
	maxAccesses?: number | null;
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

/**
 * Atomically try to access a shared session.
 * Returns the session ID if access is allowed, null otherwise.
 * This prevents race conditions by doing the check and increment in one operation.
 */
async function tryAccessShare(shareToken: string): Promise<{
	allowed: boolean;
	sessionId?: string;
	reason?: "not_found" | "expired" | "max_accesses";
}> {
	if (!isDbAvailable()) {
		const share = inMemoryShares.get(shareToken);
		if (!share) return { allowed: false, reason: "not_found" };
		if (share.expiresAt < new Date()) {
			inMemoryShares.delete(shareToken);
			return { allowed: false, reason: "expired" };
		}
		if (share.maxAccesses !== null && share.accessCount >= share.maxAccesses) {
			return { allowed: false, reason: "max_accesses" };
		}
		share.accessCount++;
		return { allowed: true, sessionId: share.sessionId };
	}

	const db = getDb();
	const now = new Date();

	// Atomically increment access count only if:
	// 1. Token exists
	// 2. Not expired
	// 3. Under max accesses (or no limit)
	const result = await db
		.update(sharedSessionsTable)
		.set({ accessCount: sql`${sharedSessionsTable.accessCount} + 1` })
		.where(
			and(
				eq(sharedSessionsTable.shareToken, shareToken),
				gt(sharedSessionsTable.expiresAt, now),
				or(
					sql`${sharedSessionsTable.maxAccesses} IS NULL`,
					lt(sharedSessionsTable.accessCount, sharedSessionsTable.maxAccesses),
				),
			),
		)
		.returning({
			sessionId: sharedSessionsTable.sessionId,
		});

	if (result.length > 0 && result[0]) {
		return { allowed: true, sessionId: result[0].sessionId };
	}

	// Access denied - determine why
	const share = await getSharedSessionFromDb(shareToken);
	if (!share) return { allowed: false, reason: "not_found" };
	if (share.expiresAt < now) return { allowed: false, reason: "expired" };
	return { allowed: false, reason: "max_accesses" };
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
	const sessionManager = createSessionManagerForRequest(req, true);
	const sessionId = params.id;
	const url = new URL(req.url || "/api/sessions", "http://localhost");
	const limitParam = url.searchParams.get("limit");
	const offsetParam = url.searchParams.get("offset");
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	const offset = offsetParam ? Number.parseInt(offsetParam, 10) : undefined;

	try {
		if (req.method === "GET" && !sessionId) {
			const sessions = await sessionManager.listSessions({
				limit,
				offset,
			});
			const sessionList: ComposerSessionSummary[] = sessions.map((s) => ({
				id: s.id,
				title: s.title || `Session ${s.id.slice(0, 8)}`,
				createdAt: s.createdAt || new Date().toISOString(),
				updatedAt: s.updatedAt || new Date().toISOString(),
				messageCount: s.messageCount || 0,
				favorite: s.favorite,
				tags: s.tags,
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

			// Verify session ownership to prevent IDOR attacks
			const subject = getAuthSubject(req);
			if (!verifySessionOwnership(session, subject, resolveSessionScope(req))) {
				sendJson(
					res,
					403,
					{ error: "Access denied: session belongs to another user" },
					cors,
					req,
				);
				return;
			}

			const responseBody: ComposerSession = {
				id: session.id,
				title: session.title,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messageCount: session.messageCount,
				favorite: session.favorite,
				tags: session.tags,
				messages: convertAppMessagesToComposer(session.messages || [], {
					includeAttachmentContent: false,
				}),
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
				favorite: false,
				tags: undefined,
				messages: convertAppMessagesToComposer(session.messages || [], {
					includeAttachmentContent: false,
				}),
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

			// Verify session ownership to prevent IDOR attacks
			const subject = getAuthSubject(req);
			if (!verifySessionOwnership(session, subject, resolveSessionScope(req))) {
				sendJson(
					res,
					403,
					{ error: "Access denied: session belongs to another user" },
					cors,
					req,
				);
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

			// Load session to verify ownership before deletion
			const session = await sessionManager.loadSession(sessionId);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" }, cors, req);
				return;
			}

			// Verify session ownership to prevent IDOR attacks
			const subject = getAuthSubject(req);
			if (!verifySessionOwnership(session, subject, resolveSessionScope(req))) {
				sendJson(
					res,
					403,
					{ error: "Access denied: session belongs to another user" },
					cors,
					req,
				);
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
	const sessionManager = createSessionManagerForRequest(req, true);
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

		// Verify session ownership to prevent sharing others' sessions
		const subject = getAuthSubject(req);
		if (!verifySessionOwnership(session, subject, resolveSessionScope(req))) {
			sendJson(
				res,
				403,
				{ error: "Access denied: session belongs to another user" },
				cors,
				req,
			);
			return;
		}

		const options = await readJsonBody<SessionShareOptions>(req);
		const expiresInHours = Math.min(options.expiresInHours ?? 24, 168); // Max 1 week
		const maxAccesses =
			options.maxAccesses === null
				? null // explicit unlimited
				: Math.max(1, options.maxAccesses ?? 100); // default finite, clamp minimum

		// Generate a share token
		const shareToken = crypto.randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

		const scope = resolveSessionScope(req);
		const scopedSessionId = encodeScopedSessionId(scope, sessionId);

		// Store in database (or fallback to memory)
		await createSharedSessionInDb(
			scopedSessionId,
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
				webShareUrl: `/share/${shareToken}`,
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
	const shareToken = params.token;

	try {
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		// Rate limit share access to prevent brute-force attacks
		const clientIp =
			(req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
			req.socket.remoteAddress ||
			"unknown";
		const rateLimit = await checkShareRateLimit(clientIp);
		if (!rateLimit.allowed) {
			res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds ?? 60));
			sendJson(
				res,
				429,
				{
					error: "Too many requests",
					retryAfter: rateLimit.retryAfterSeconds,
				},
				cors,
				req,
			);
			return;
		}

		// Atomic check and increment to prevent race conditions
		const accessResult = await tryAccessShare(shareToken);
		if (!accessResult.allowed) {
			switch (accessResult.reason) {
				case "not_found":
					sendJson(
						res,
						404,
						{ error: "Share link not found or expired" },
						cors,
						req,
					);
					return;
				case "expired":
					await deleteShareByToken(shareToken);
					sendJson(res, 410, { error: "Share link has expired" }, cors, req);
					return;
				case "max_accesses":
					sendJson(
						res,
						410,
						{ error: "Share link has reached maximum accesses" },
						cors,
						req,
					);
					return;
			}
		}

		const { scope, sessionId } = decodeScopedSessionId(
			accessResult.sessionId as string,
		);
		const sessionManager = createSessionManagerForScope(scope, true);
		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			sendJson(res, 404, { error: "Session not found" }, cors, req);
			return;
		}

		// Return a read-only view of the session
		const responseBody: ComposerSession = {
			// Don't leak the underlying session id through share links; treat token as the public id.
			id: `shared:${shareToken}`,
			title: session.title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			messageCount: session.messageCount,
			messages: convertAppMessagesToComposer(session.messages || [], {
				includeAttachmentContent: false,
			}),
		};

		sendJson(res, 200, { ...responseBody, isShared: true }, cors, req);
	} catch (error) {
		respondWithApiError(res, error, 500, cors, req);
	}
}

/**
 * Fetch a shared session attachment by token (for lazy-loaded attachment content).
 *
 * This does NOT increment accessCount (unlike handleSharedSession), so users
 * can fetch attachments after opening the shared session even when maxAccesses
 * is low (e.g., 1).
 */
export async function handleSharedSessionAttachment(
	req: IncomingMessage,
	res: ServerResponse,
	params: { token: string; attachmentId: string },
	cors: Record<string, string>,
) {
	const shareToken = params.token;
	const attachmentId = params.attachmentId;

	try {
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "Method not allowed" }, cors, req);
			return;
		}

		if (!attachmentIdPattern.test(attachmentId)) {
			sendJson(res, 400, { error: "Invalid attachment id" }, cors, req);
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
		if (share.expiresAt < new Date()) {
			await deleteShareByToken(shareToken);
			sendJson(res, 410, { error: "Share link has expired" }, cors, req);
			return;
		}

		const { scope, sessionId } = decodeScopedSessionId(share.sessionId);
		const sessionManager = createSessionManagerForScope(scope, true);
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

/**
 * Handle session export
 */
export async function handleSessionExport(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id: string },
	cors: Record<string, string>,
) {
	const sessionManager = createSessionManagerForRequest(req, true);
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

		// Verify session ownership to prevent exporting others' sessions
		const subject = getAuthSubject(req);
		if (!verifySessionOwnership(session, subject, resolveSessionScope(req))) {
			sendJson(
				res,
				403,
				{ error: "Access denied: session belongs to another user" },
				cors,
				req,
			);
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
						messages: convertAppMessagesToComposer(messages, {
							includeAttachmentContent: true,
						}),
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
			"Content-Disposition": buildContentDisposition(filename),
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
	arguments?: unknown;
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
		const role =
			msg.role === "user"
				? "## User"
				: msg.role === "toolResult"
					? "## Tool Result"
					: "## Assistant";
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
		const role =
			msg.role === "user"
				? "USER:"
				: msg.role === "toolResult"
					? "TOOL RESULT:"
					: "ASSISTANT:";
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

			case "toolCall":
				if (format === "markdown") {
					lines.push(`### Tool: \`${block.name || "unknown"}\``);
					if (block.arguments) {
						lines.push("");
						lines.push("```json");
						lines.push(JSON.stringify(block.arguments, null, 2));
						lines.push("```");
					}
				} else {
					lines.push(`[TOOL CALL: ${block.name || "unknown"}]`);
					if (block.arguments) {
						lines.push(`Args: ${JSON.stringify(block.arguments, null, 2)}`);
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
