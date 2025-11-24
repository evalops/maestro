import type { IncomingMessage, ServerResponse } from "node:http";
import type {
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import { SessionManager } from "../../session/manager.js";
import { respondWithApiError, sendJson } from "../server-utils.js";
import { readJsonBody } from "../server-utils.js";
import { convertAppMessagesToComposer } from "../session-serialization.js";

export async function handleSessions(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id?: string },
	cors: Record<string, string>,
) {
	const sessionManager = new SessionManager(true);
	const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;
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
