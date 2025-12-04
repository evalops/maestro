import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionManager } from "../../session/manager.js";
import { respondWithApiError, sendJson } from "../server-utils.js";

function assertSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
		throw new Error("Invalid sessionId format");
	}
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
		const sessionManager = new SessionManager(false);
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

		const items = session.messages.map(
			(msg: { role: string }, index: number) => ({
				type: msg.role,
				index,
				tokenEstimate: Math.round(JSON.stringify(msg).length / 4),
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
