import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComposerRunTimelineResponse } from "@evalops/contracts";
import { safeReadSessionEntries } from "../../session/session-context.js";
import { getAuthSubject } from "../authz.js";
import { getPendingComposerRequests } from "../pending-request-payload.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { createWebSessionManagerForRequest } from "../session-scope.js";
import { buildComposerRunTimeline } from "../session-timeline.js";
import { sessionIdPattern, verifySessionOwnership } from "./sessions.js";

interface SessionTimelineParams {
	id?: string;
}

function requireSessionId(params: SessionTimelineParams): string {
	const sessionId = params.id?.trim();
	if (!sessionId || !sessionIdPattern.test(sessionId)) {
		throw new ApiError(400, "Invalid session id");
	}
	return sessionId;
}

export async function handleSessionTimeline(
	req: IncomingMessage,
	res: ServerResponse,
	params: SessionTimelineParams,
	cors: Record<string, string>,
): Promise<void> {
	try {
		if (req.method !== "GET") {
			res.writeHead(405, cors);
			res.end();
			return;
		}

		const sessionId = requireSessionId(params);
		const sessionManager = createWebSessionManagerForRequest(req, true);
		const session = await sessionManager.loadSession(sessionId);
		if (!session) {
			throw new ApiError(404, "Session not found");
		}

		const subject = getAuthSubject(req);
		if (!verifySessionOwnership(session, subject)) {
			throw new ApiError(403, "Access denied: session belongs to another user");
		}

		const sessionPath = sessionManager.getSessionFileById(sessionId);
		const entries = sessionPath ? safeReadSessionEntries(sessionPath) : [];
		const pendingRequests = getPendingComposerRequests(session.id);
		const responseBody: ComposerRunTimelineResponse = buildComposerRunTimeline({
			sessionId: session.id,
			entries,
			messages: session.messages || [],
			pendingRequests,
		});

		sendJson(res, 200, responseBody, cors, req);
	} catch (error) {
		if (!respondWithApiError(res, error, 500, cors, req)) {
			sendJson(
				res,
				500,
				{ error: "Failed to load session timeline" },
				cors,
				req,
			);
		}
	}
}
