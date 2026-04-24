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
 * | GET | `/api/sessions/:id/timeline` | Get a redacted run timeline |
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
 * - Session data: JSONL files in `~/.maestro/agent/sessions/`
 * - Share tokens: PostgreSQL (with in-memory fallback)
 * - Rate limits: Redis (with in-memory fallback)
 *
 * @module web/handlers/sessions
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import {
	scanOutboundSensitiveContent,
	summarizeOutboundSensitiveFindings,
} from "../../safety/outbound-secret-preflight.js";
import { safeReadSessionEntries } from "../../session/session-context.js";
import type { SessionEntry } from "../../session/types.js";
import { createLogger } from "../../utils/logger.js";
import { getAuthSubject } from "../authz.js";
import { isHostedSessionManager } from "../hosted-session-manager.js";
import { getPendingServerRequestPayload } from "../pending-request-payload.js";
import {
	buildContentDisposition,
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import {
	createWebSessionManagerForRequest,
	createWebSessionManagerForScope,
	decodeScopedSessionId,
	encodeScopedSessionId,
	resolveSessionScope,
} from "../session-scope.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";
import { exportToMarkdown, exportToText } from "./session-export-formatters.js";
import {
	type SessionExportFormat,
	type SessionShareOptions,
	type SessionUpdateBody,
	checkShareRateLimit,
	createSharedSessionInDb,
	deleteExpiredShares,
	deleteShareByToken,
	getSharedSessionFromDb,
	tryAccessShare,
} from "./session-share-store.js";

export {
	checkShareRateLimit,
	resetShareRateLimit,
	stopShareRateLimiter,
} from "./session-share-store.js";
export type {
	SessionExportFormat,
	SessionShareOptions,
	SessionUpdateBody,
} from "./session-share-store.js";

const logger = createLogger("sessions-handler");
export const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;
const attachmentIdPattern = /^[a-zA-Z0-9._-]+$/;

function sendSensitiveContentBlockedResponse(
	req: IncomingMessage,
	res: ServerResponse,
	cors: Record<string, string>,
	action: "export" | "share",
	findings: ReturnType<typeof summarizeOutboundSensitiveFindings>,
): void {
	sendJson(
		res,
		409,
		{
			error: `Sensitive content detected. Review and confirm before continuing with this ${action}.`,
			code: "sensitive_content_detected",
			details: findings,
		},
		cors,
		req,
	);
}

/**
 * Verify that the authenticated subject has access to the session.
 * Prevents IDOR attacks by checking session ownership fields.
 *
 * Returns true if access is allowed, false otherwise.
 */
export function verifySessionOwnership(
	session: { owner?: unknown; subject?: unknown },
	subject: string,
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
	// In strict mode (multi-user), deny access to prevent IDOR attacks.
	// Sessions created via CLI don't have ownership info, but API access
	// should be restricted in hosted environments.
	const strictMode = process.env.MAESTRO_STRICT_SESSION_ACCESS !== "false";
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

async function resolveSharedSessionAccess(
	req: IncomingMessage,
	res: ServerResponse,
	shareToken: string,
	cors: Record<string, string>,
): Promise<string | null> {
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
		return null;
	}

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
				return null;
			case "expired":
				await deleteShareByToken(shareToken);
				sendJson(res, 410, { error: "Share link has expired" }, cors, req);
				return null;
			case "max_accesses":
				sendJson(
					res,
					410,
					{ error: "Share link has reached maximum accesses" },
					cors,
					req,
				);
				return null;
		}
	}

	return accessResult.sessionId ?? null;
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
	const sessionManager = createWebSessionManagerForRequest(req, true);
	const sessionId = params.id;
	const url = new URL(req.url || "/api/sessions", "http://localhost");
	const limitParam = url.searchParams.get("limit");
	const offsetParam = url.searchParams.get("offset");
	const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	const parsedOffset = offsetParam
		? Number.parseInt(offsetParam, 10)
		: undefined;
	const limit =
		typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
			? Math.max(1, parsedLimit)
			: undefined;
	const offset =
		typeof parsedOffset === "number" && Number.isFinite(parsedOffset)
			? Math.max(0, parsedOffset)
			: undefined;

	try {
		if (req.method === "GET" && !sessionId) {
			const subject = getAuthSubject(req);
			const paginationRequested =
				typeof limit === "number" || typeof offset === "number";
			const sessions = (
				await sessionManager.listSessions(
					paginationRequested ? undefined : { limit, offset },
				)
			).filter((s) => verifySessionOwnership(s, subject));
			const pagedSessions = paginationRequested
				? sessions.slice(
						offset ?? 0,
						(offset ?? 0) + (limit ?? sessions.length),
					)
				: sessions;
			const sessionList: ComposerSessionSummary[] = pagedSessions.map((s) => ({
				id: s.id,
				title: s.title || `Session ${s.id.slice(0, 8)}`,
				resumeSummary: s.resumeSummary,
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
			if (!verifySessionOwnership(session, subject)) {
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
				resumeSummary: session.resumeSummary,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messageCount: session.messageCount,
				favorite: session.favorite,
				tags: session.tags,
				messages: convertAppMessagesToComposer(session.messages || [], {
					includeAttachmentContent: false,
				}),
				...getPendingServerRequestPayload(session.id),
			};

			sendJson(res, 200, responseBody, cors, req);
		} else if (req.method === "POST" && !sessionId) {
			const { title } = await readJsonBody<{ title?: string }>(req);
			const session = await sessionManager.createSession({ title });
			const responseBody: ComposerSession = {
				id: session.id,
				title: session.title,
				resumeSummary: session.resumeSummary,
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
			if (!verifySessionOwnership(session, subject)) {
				sendJson(
					res,
					403,
					{ error: "Access denied: session belongs to another user" },
					cors,
					req,
				);
				return;
			}

			if (isHostedSessionManager(sessionManager)) {
				await sessionManager.updateSessionMetadata(sessionId, updates);
			} else {
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
			if (!verifySessionOwnership(session, subject)) {
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
	const sessionManager = createWebSessionManagerForRequest(req, true);
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
		if (!verifySessionOwnership(session, subject)) {
			sendJson(
				res,
				403,
				{ error: "Access denied: session belongs to another user" },
				cors,
				req,
			);
			return;
		}

		const options = await readJsonBody<
			SessionShareOptions & { allowSensitiveContent?: boolean }
		>(req);
		const expiresInHours = Math.min(options.expiresInHours ?? 24, 168); // Max 1 week
		const maxAccesses =
			options.maxAccesses === null
				? null // explicit unlimited
				: Math.max(1, options.maxAccesses ?? 100); // default finite, clamp minimum

		if (!options.allowSensitiveContent) {
			const scan = scanOutboundSensitiveContent({
				title: session.title,
				messages: session.messages || [],
			});
			if (scan.blockingFindings.length > 0) {
				sendSensitiveContentBlockedResponse(
					req,
					res,
					cors,
					"share",
					summarizeOutboundSensitiveFindings(scan.blockingFindings),
				);
				return;
			}
		}

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

		const resolvedSessionId = await resolveSharedSessionAccess(
			req,
			res,
			shareToken,
			cors,
		);
		if (!resolvedSessionId) {
			return;
		}

		const { scope, sessionId } = decodeScopedSessionId(resolvedSessionId);
		const sessionManager = createWebSessionManagerForScope(scope, true);
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
			resumeSummary: session.resumeSummary,
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

		const resolvedSessionId = await resolveSharedSessionAccess(
			req,
			res,
			shareToken,
			cors,
		);
		if (!resolvedSessionId) {
			return;
		}

		const { scope, sessionId } = decodeScopedSessionId(resolvedSessionId);
		const sessionManager = createWebSessionManagerForScope(scope, true);
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
	const sessionManager = createWebSessionManagerForRequest(req, true);
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
		if (!verifySessionOwnership(session, subject)) {
			sendJson(
				res,
				403,
				{ error: "Access denied: session belongs to another user" },
				cors,
				req,
			);
			return;
		}

		const options = await readJsonBody<
			SessionExportFormat & { allowSensitiveContent?: boolean }
		>(req);
		const format = options.format || "json";
		const messages = session.messages || [];
		let jsonlEntries: SessionEntry[] | null | undefined = undefined;
		let jsonlSessionFile: string | null = null;
		if (format === "jsonl") {
			if (isHostedSessionManager(sessionManager)) {
				jsonlEntries = await sessionManager.loadEntries(sessionId);
				if (!jsonlEntries) {
					sendJson(res, 404, { error: "Session not found" }, cors, req);
					return;
				}
			} else {
				jsonlSessionFile = sessionManager.getSessionFileById(sessionId);
				if (!jsonlSessionFile) {
					sendJson(res, 404, { error: "Session file not found" }, cors, req);
					return;
				}
				jsonlEntries = safeReadSessionEntries(jsonlSessionFile);
				if (!jsonlEntries) {
					return;
				}
			}
		}

		if (!options.allowSensitiveContent) {
			const scan = scanOutboundSensitiveContent({
				title: session.title,
				messages: format === "jsonl" ? (jsonlEntries ?? []) : messages,
			});
			if (scan.blockingFindings.length > 0) {
				sendSensitiveContentBlockedResponse(
					req,
					res,
					cors,
					"export",
					summarizeOutboundSensitiveFindings(scan.blockingFindings),
				);
				return;
			}
		}

		let content: string;
		let contentType: string;
		let filename: string;

		switch (format) {
			case "jsonl": {
				if (isHostedSessionManager(sessionManager)) {
					content = `${(jsonlEntries ?? []).map((entry) => JSON.stringify(entry)).join("\n")}\n`;
				} else {
					if (!jsonlSessionFile) {
						sendJson(res, 404, { error: "Session file not found" }, cors, req);
						return;
					}
					content = readFileSync(jsonlSessionFile, "utf8");
				}
				contentType = "application/x-ndjson";
				filename = `session-${sessionId}.jsonl`;
				break;
			}
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
