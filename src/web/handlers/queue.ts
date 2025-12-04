import type { IncomingMessage, ServerResponse } from "node:http";
import { loadUiState, saveUiState } from "../../tui/ui-state.js";
import { getAuthSubject, requireApiAuth, requireCsrf } from "../authz.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";
import {
	getSessionQueue,
	loadQueueState,
	saveQueueState,
} from "../stores/queue-store.js";
import {
	getSessionUiState,
	loadWebUiState,
	saveWebUiState,
} from "../stores/ui-store.js";
import { checkSessionRateLimitAsync } from "../utils/session-rate-limit.js";

const MAX_QUEUE_ITEMS = 50;

function assertSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
		throw new Error("Invalid sessionId format");
	}
}

function getQueueState(sessionKey: string) {
	const uiState = loadUiState();
	const webState = loadWebUiState();
	const perSession = getSessionUiState(webState, sessionKey);
	const state = loadQueueState();
	const sessionState = getSessionQueue(
		state,
		sessionKey,
		perSession.queueMode ?? uiState.queueMode ?? "all",
	);
	saveQueueState(state);
	saveWebUiState(webState);
	return sessionState;
}

export async function handleQueue(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		if (!requireApiAuth(req, res, corsHeaders)) return;
		const url = new URL(
			req.url || "/api/queue",
			`http://${req.headers.host || "localhost"}`,
		);
		const action = url.searchParams.get("action") || "list";
		const sessionId = url.searchParams.get("sessionId");

		if (!sessionId) {
			sendJson(
				res,
				400,
				{ error: "sessionId query parameter is required" },
				corsHeaders,
			);
			return;
		}
		const subject = getAuthSubject(req);
		const sessionKey = `${subject}:${sessionId}`;
		try {
			assertSessionId(sessionId);
			const rate = await checkSessionRateLimitAsync(sessionKey);
			if (!rate.allowed) {
				sendJson(
					res,
					429,
					{ error: "Too many requests for this session" },
					corsHeaders,
				);
				return;
			}
			const queueState = getQueueState(sessionKey);
			if (action === "list") {
				sendJson(
					res,
					200,
					{
						mode: queueState.mode,
						pending: queueState.pending,
						count: queueState.pending.length,
					},
					corsHeaders,
				);
			} else if (action === "status") {
				sendJson(
					res,
					200,
					{
						mode: queueState.mode,
						pendingCount: queueState.pending.length,
						enabled: queueState.mode === "all",
					},
					corsHeaders,
				);
			} else {
				sendJson(
					res,
					400,
					{ error: "Invalid action. Use list or status." },
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		if (!requireApiAuth(req, res, corsHeaders)) return;
		if (!requireCsrf(req, res, corsHeaders)) return;
		try {
			const data = await readJsonBody<{
				action: string;
				mode?: "one" | "all";
				id?: number;
				sessionId?: string;
			}>(req);
			const { action } = data;
			if (!data.sessionId) {
				sendJson(res, 400, { error: "sessionId is required" }, corsHeaders);
				return;
			}

			assertSessionId(data.sessionId);
			const subject = getAuthSubject(req);
			const sessionKey = `${subject}:${data.sessionId}`;
			const rate = await checkSessionRateLimitAsync(sessionKey);
			if (!rate.allowed) {
				sendJson(
					res,
					429,
					{ error: "Too many requests for this session" },
					corsHeaders,
				);
				return;
			}

			const queueState = getQueueState(sessionKey);

			if (action === "mode" && data.mode) {
				if (!["one", "all"].includes(data.mode)) {
					sendJson(
						res,
						400,
						{ error: "Mode must be 'one' or 'all'" },
						corsHeaders,
					);
					return;
				}
				queueState.mode = data.mode;
				saveUiState({ queueMode: data.mode });
				sendJson(
					res,
					200,
					{
						success: true,
						mode: queueState.mode,
						message: `Queue mode set to ${data.mode}`,
					},
					corsHeaders,
				);
			} else if (action === "cancel" && data.id) {
				const index = queueState.pending.findIndex((p) => p.id === data.id);
				if (index === -1) {
					sendJson(
						res,
						404,
						{ error: `No queued prompt #${data.id} to cancel` },
						corsHeaders,
					);
					return;
				}
				const removed = queueState.pending.splice(index, 1)[0];
				sendJson(
					res,
					200,
					{
						success: true,
						message: `Cancelled queued prompt #${data.id}`,
						removed,
					},
					corsHeaders,
				);
			} else {
				if (queueState.pending.length >= MAX_QUEUE_ITEMS) {
					sendJson(
						res,
						429,
						{ error: `Queue is full (limit ${MAX_QUEUE_ITEMS})` },
						corsHeaders,
					);
					return;
				}
				sendJson(
					res,
					400,
					{
						error:
							"Invalid action. Use mode or cancel with appropriate parameters.",
					},
					corsHeaders,
				);
			}
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
