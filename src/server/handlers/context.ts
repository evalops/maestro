import type { IncomingMessage, ServerResponse } from "node:http";
import { getAuthSubject, requireApiAuth } from "../authz.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { createSessionManagerForRequest } from "../session-scope.js";
import { redactPii } from "../utils/redact.js";
import { checkSessionRateLimitAsync } from "../utils/session-rate-limit.js";
import {
	approximateTokensFromJson,
	approximateTokensFromText,
} from "../utils/token-estimator.js";

function assertSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
		throw new Error("Invalid sessionId format");
	}
}

/**
 * Check if a user has access to a session.
 *
 * In multi-user deployments, sessions should only be accessible by their owner.
 * This function verifies ownership by checking if the session belongs to the
 * authenticated user's scope.
 *
 * Session ownership is determined by:
 * 1. If session has an explicit 'owner' field, it must match the subject
 * 2. If session has a 'subject' field (API-created sessions), it must match
 * 3. Otherwise, access is denied for API requests in strict mode (prevents IDOR)
 *
 * Note: Current sessions don't store owner info, so this defaults to denying
 * access in strict mode. Set MAESTRO_STRICT_SESSION_ACCESS=false for backwards
 * compatibility in single-user deployments.
 */
function verifySessionOwnership(
	session: Record<string, unknown>,
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

export async function handleContext(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method !== "GET") {
		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
		return;
	}
	if (!(await requireApiAuth(req, res, corsHeaders))) return;

	const url = new URL(req.url || "/api/context", `http://${req.headers.host}`);
	const sessionId = url.searchParams.get("sessionId");

	try {
		if (!sessionId) {
			sendJson(
				res,
				400,
				{ error: "sessionId query parameter is required" },
				corsHeaders,
			);
			return;
		}

		assertSessionId(sessionId);
		const subject = getAuthSubject(req);
		const sessionKey = `${subject}:${sessionId}`;
		const rate = await checkSessionRateLimitAsync(sessionKey);
		if (!rate.allowed) {
			sendJson(res, 429, { error: "Too many context requests" }, corsHeaders);
			return;
		}
		const sessionManager = createSessionManagerForRequest(req, false);
		const sessionFile = sessionManager.getSessionFileById(sessionId);
		if (!sessionFile) {
			sendJson(
				res,
				404,
				{ error: `Session not found: ${sessionId}` },
				corsHeaders,
			);
			return;
		}

		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			sendJson(
				res,
				404,
				{ error: "Session file exists but could not be loaded" },
				corsHeaders,
			);
			return;
		}

		// Verify session ownership to prevent IDOR attacks
		if (!verifySessionOwnership(session, subject)) {
			sendJson(
				res,
				403,
				{ error: "Access denied: session belongs to another user" },
				corsHeaders,
			);
			return;
		}

		const items = session.messages.map(
			(msg: { role: string; content?: unknown }, index: number) => ({
				type: msg.role,
				index,
				tokenEstimate: approximateTokensFromJson(msg),
				snippet:
					typeof msg.content === "string"
						? redactPii(msg.content).slice(0, 160)
						: "",
			}),
		);

		const totalTokens = items.reduce(
			(sum: number, item: { tokenEstimate: number }) =>
				sum + item.tokenEstimate,
			0,
		);

		sendJson(
			res,
			200,
			{
				sessionId,
				items,
				totalTokens,
				messageCount: session.messages.length,
			},
			corsHeaders,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}
