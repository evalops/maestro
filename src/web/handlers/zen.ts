import type { IncomingMessage, ServerResponse } from "node:http";
import {
	readJsonBody,
	respondWithApiError,
	sendJson,
} from "../server-utils.js";

// Zen mode state - in production this would be per-session/user
let zenModeState = false;

export async function handleZen(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	if (req.method === "GET") {
		try {
			sendJson(res, 200, { enabled: zenModeState }, corsHeaders);
		} catch (error) {
			respondWithApiError(res, error, 500, corsHeaders, req);
		}
		return;
	}

	if (req.method === "POST") {
		try {
			const data = await readJsonBody<{ enabled?: boolean }>(req);
			if (typeof data.enabled === "boolean") {
				zenModeState = data.enabled;
				sendJson(
					res,
					200,
					{
						success: true,
						enabled: zenModeState,
						message: zenModeState ? "Zen mode enabled" : "Zen mode disabled",
					},
					corsHeaders,
				);
			} else {
				// Toggle
				zenModeState = !zenModeState;
				sendJson(
					res,
					200,
					{
						success: true,
						enabled: zenModeState,
						message: zenModeState ? "Zen mode enabled" : "Zen mode disabled",
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
