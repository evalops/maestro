import type { IncomingMessage, ServerResponse } from "node:http";
import { loadUiState, saveUiState } from "../../tui/ui-state.js";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

const sessionZenState = new Map<string, boolean>();
const DEFAULT_SESSION_KEY = "default";

function getSessionKey(sessionId?: string) {
	return sessionId && /^[A-Za-z0-9._-]+$/.test(sessionId)
		? sessionId
		: DEFAULT_SESSION_KEY;
}

export async function handleZen(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		try {
			const url = new URL(
				req.url || "/api/zen",
				`http://${req.headers.host || "localhost"}`,
			);
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
			const sessionKey = getSessionKey(sessionId);
			const state = loadUiState();
			const enabled = sessionZenState.get(sessionKey) ?? state.zenMode ?? false;
			sendJson(res, 200, { enabled }, corsHeaders);
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const url = new URL(
				req.url || "/api/zen",
				`http://${req.headers.host || "localhost"}`,
			);
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
			const sessionKey = getSessionKey(sessionId);
			const data = await readJsonBody<{ enabled?: boolean }>(req);
			const currentState = loadUiState();
			const currentValue =
				sessionZenState.get(sessionKey) ?? currentState.zenMode ?? false;
			const newEnabled =
				typeof data.enabled === "boolean" ? data.enabled : !currentValue;
			sessionZenState.set(sessionKey, newEnabled);
			if (sessionKey === DEFAULT_SESSION_KEY) {
				saveUiState({ zenMode: newEnabled });
			}
			sendJson(
				res,
				200,
				{
					success: true,
					enabled: newEnabled,
					message: newEnabled ? "Zen mode enabled" : "Zen mode disabled",
				},
				corsHeaders,
			);
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	sendJson(res, 405, { error: "Method not allowed" }, corsHeaders);
}
